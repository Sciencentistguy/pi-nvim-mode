-- pi-nvim-mode bootstrap. Executed via nvim_exec_lua right after the UI attaches.
-- Neovim was started with --clean --noplugin, so nothing from the user's config is loaded.
local user_init, start_insert = ...
-- Channel 0 broadcasts to every attached channel; pi is the only one.
local chan = 0

local api, fn = vim.api, vim.fn

-- Keep only nvim's own runtime on 'runtimepath'. This drops even system-wide XDG dirs, so no
-- ftplugin/after/colors file outside the nvim installation can ever be sourced.
local function own_runtime(paths)
	local runtime = vim.env.VIMRUNTIME or ""
	local kept = {}
	for _, p in ipairs(vim.split(paths, ",", { plain = true })) do
		if (runtime ~= "" and vim.startswith(p, runtime)) or p:match("/lib/nvim$") then kept[#kept + 1] = p end
	end
	return table.concat(kept, ",")
end
vim.o.runtimepath = own_runtime(vim.o.runtimepath)
vim.o.packpath = own_runtime(vim.o.packpath)

local o = vim.o
o.swapfile = false
o.undofile = false
o.shada = ""
o.backup = false
o.writebackup = false
o.modeline = false
o.exrc = false
o.secure = true
o.more = false
o.showmode = false
o.ruler = false
o.showcmd = true
o.laststatus = 0
o.showtabline = 0
o.cmdheight = 0
o.number = false
o.signcolumn = "no"
o.foldenable = false
o.wrap = true
o.linebreak = true
o.breakindent = false
o.scrolloff = 0
o.sidescrolloff = 0
o.mouse = ""
o.clipboard = ""
o.hlsearch = true
o.incsearch = true
o.ignorecase = false
o.smartcase = false
o.expandtab = true
o.tabstop = 4
o.shiftwidth = 4
o.softtabstop = 4
o.belloff = "all"
o.shortmess = "filnxtToOFIcCsSWaq"
o.fillchars = "eob: "
o.textwidth = 0
o.spell = false

-- The prompt buffer: `:w` submits instead of writing a file.
local buf = api.nvim_get_current_buf()
api.nvim_buf_set_name(buf, "pi://prompt")
vim.bo[buf].buftype = "acwrite"
vim.bo[buf].bufhidden = "hide"
vim.bo[buf].swapfile = false

local M = {}
_G.PiNvimMode = M

local function utf16(line, byte)
	if byte <= 0 then return 0 end
	if byte >= #line then return vim.str_utfindex(line, "utf-16") end
	return vim.str_utfindex(line, "utf-16", byte, false)
end

local function bytecol(line, idx)
	if idx <= 0 then return 0 end
	local len = vim.str_utfindex(line, "utf-16")
	if idx >= len then return #line end
	return vim.str_byteindex(line, "utf-16", idx, false)
end

-- Returns selection ranges as { line, startUtf16, endUtf16 } (end exclusive, 0-based lines).
local function visual_ranges(mode, lines)
	local v = fn.getpos("v")
	local c = fn.getpos(".")
	local ok, region = pcall(fn.getregionpos, v, c, { type = mode, eol = true })
	if not ok then return {} end
	local out = {}
	for _, pair in ipairs(region) do
		local s, e = pair[1], pair[2]
		local lnum = s[2]
		local line = lines[lnum] or ""
		local sb = math.max(0, s[3] - 1)
		local eb
		if e[3] == vim.v.maxcol or e[3] > #line then
			eb = #line + 1 -- include the virtual end-of-line cell
		else
			-- getregionpos end is the start byte of the last character; extend to its end.
			local ch_end = e[3] - 1 + #fn.strcharpart(line:sub(e[3]), 0, 1)
			eb = math.max(ch_end, sb)
		end
		local su = utf16(line, sb)
		local eu = eb > #line and utf16(line, #line) + 1 or utf16(line, eb)
		out[#out + 1] = { lnum - 1, su, eu }
	end
	return out
end

local MAX_MATCHES = 200

local function search_ranges(pattern, lines)
	if pattern == nil or pattern == "" then return {} end
	local ok, re = pcall(vim.regex, (o.ignorecase and "\\c" or "") .. pattern)
	if not ok then return {} end
	local out = {}
	for i, line in ipairs(lines) do
		local start = 0
		while start <= #line and #out < MAX_MATCHES do
			local s, e = re:match_str(line:sub(start + 1))
			if not s then break end
			s, e = s + start, e + start
			if e > s then out[#out + 1] = { i - 1, utf16(line, s), utf16(line, e) } end
			start = e > s and e or e + 1
		end
	end
	return out
end

local last_tick = -1
-- Monotonic counter so pi can discard states that arrive out of order.
local seq = 0

function M.state(force_lines)
	local mode = api.nvim_get_mode()
	local tick = api.nvim_buf_get_changedtick(buf)
	local lines = api.nvim_buf_get_lines(buf, 0, -1, false)
	local cur = api.nvim_win_get_cursor(0)
	local row = cur[1] - 1
	local line = lines[cur[1]] or ""

	seq = seq + 1
	local state = {
		seq = seq,
		mode = mode.mode,
		blocking = mode.blocking,
		row = row,
		col = utf16(line, cur[2]),
		recording = fn.reg_recording(),
		tick = tick,
	}

	if force_lines or tick ~= last_tick then
		state.lines = lines
		last_tick = tick
	end

	local m = mode.mode:sub(1, 1)
	if m == "v" or m == "V" or m == "\22" then
		state.visual = visual_ranges(mode.mode:sub(1, 1), lines)
	end

	local search
	if m == "c" then
		local t = fn.getcmdtype()
		if (t == "/" or t == "?") and o.incsearch then search = fn.getcmdline() end
	elseif vim.v.hlsearch == 1 then
		search = fn.getreg("/")
	end
	state.search = search_ranges(search, lines)

	return state
end

local scheduled = false
local function push()
	-- Coalesce bursts of autocmds into a single notification per event-loop tick.
	if scheduled then return end
	scheduled = true
	vim.schedule(function()
		scheduled = false
		vim.rpcnotify(chan, "pi_state", M.state(false))
	end)
end

-- Modes like operator-pending block the event loop, so vim.schedule would not run until the
-- operator completes. Send those transitions synchronously.
local function push_now()
	vim.rpcnotify(chan, "pi_state", M.state(false))
end

local group = api.nvim_create_augroup("PiNvimMode", { clear = true })
api.nvim_create_autocmd(
	{ "TextChanged", "TextChangedI", "TextChangedP", "CursorMoved", "CursorMovedI", "CmdlineChanged" },
	{ group = group, callback = push }
)
api.nvim_create_autocmd({ "ModeChanged", "RecordingEnter", "RecordingLeave", "CmdlineEnter", "CmdlineLeave" }, {
	group = group,
	callback = push_now,
})

api.nvim_create_autocmd("BufWriteCmd", {
	group = group,
	buffer = buf,
	callback = function()
		vim.bo[buf].modified = false
		vim.rpcnotify(chan, "pi_submit")
	end,
})

-- Replace the buffer contents from pi (history, programmatic setText, completions).
function M.set_text(lines, row, col, reset_undo, insert)
	if reset_undo then
		local ul = vim.bo[buf].undolevels
		vim.bo[buf].undolevels = -1
		api.nvim_buf_set_lines(buf, 0, -1, false, lines)
		vim.bo[buf].undolevels = ul
	else
		api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	end
	vim.bo[buf].modified = false
	local eol = M.set_cursor(row, col)
	if insert then M.start_insert(eol) end
	return M.state(true)
end

-- Enter insert mode from whatever mode nvim is currently in.
-- The keys are queued, so the mode switch happens once the current RPC request returns.
function M.start_insert(eol)
	local mode = api.nvim_get_mode().mode
	if mode:sub(1, 1) == "i" then return end
	if eol == nil then
		eol = api.nvim_win_get_cursor(0)[2] >= #api.nvim_get_current_line()
	end
	local key = eol and "A" or "i"
	api.nvim_feedkeys(api.nvim_replace_termcodes("<C-\\><C-n>" .. key, true, false, true), "n", false)
end

-- Whether `lhs` is mapped in the mode nvim is currently in.
local MAP_MODES = { n = "n", i = "i", R = "i", v = "x", V = "x", ["\22"] = "x", s = "s", S = "s", ["\19"] = "s", c = "c", no = "o" }
function M.has_mapping(lhs)
	local mode = api.nvim_get_mode().mode
	local short = MAP_MODES[mode:sub(1, 2)] or MAP_MODES[mode:sub(1, 1)]
	return short ~= nil and fn.maparg(lhs, short) ~= ""
end

-- Replace a range of lines in place (keeps undo granularity small for completions).
function M.splice(first, last, lines, row, col)
	api.nvim_buf_set_lines(buf, first, last, false, lines)
	M.set_cursor(row, col)
	return M.state(true)
end

function M.set_cursor(row, col)
	local count = api.nvim_buf_line_count(buf)
	row = math.max(0, math.min(row, count - 1))
	local line = api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
	local byte = bytecol(line, col)
	api.nvim_win_set_cursor(0, { row + 1, byte })
	return byte >= #line
end

if user_init and user_init ~= "" then
	local ok, err = pcall(dofile, user_init)
	if not ok then vim.notify("pi-nvim-mode: error in " .. user_init .. ": " .. tostring(err), vim.log.levels.ERROR) end
end

if start_insert then M.start_insert() end

return M.state(true)
