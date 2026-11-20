# pi-nvim-mode

Vim mode for [pi](https://pi.dev)'s prompt editor, backed by a real Neovim running in
`--embed` mode. Every edit goes through Neovim, so motions, text objects, counts, registers,
macros, `.` repeat, undo trees, `:s`, and `/` search all behave exactly like they do in Neovim.

Your own Neovim configuration is **never** loaded (see [Isolation](#isolation)).

## Install

Requires Neovim 0.11 or newer on `PATH`.

```sh
pi install /path/to/pi-nvim-mode
# or try it for one session:
pi -e /path/to/pi-nvim-mode/src/index.ts
```

Toggle it at runtime with `/nvim-mode`.

## Usage

The prompt starts in insert mode. The mode is shown in the editor's bottom border,
along with pending keys (`2d`, `"a`) and macro recording (`recording @q`).

| Key | Behaviour |
| --- | --- |
| `Enter` (insert / normal) | Submit the prompt |
| `Shift+Enter`, `Ctrl+J` (insert) | Newline |
| `:w` | Submit the prompt |
| `Esc` (insert, visual, …) | Back to normal mode |
| `Esc` (normal) | pi's interrupt: abort the agent, double-Esc for `/tree`, etc. |
| `Up` / `Down` on the first / last line | Prompt history |
| `Tab` (insert) | pi's file/command completion (falls back to a literal Tab) |
| `/`, `@`, `#` (insert) | pi's slash-command and file autocomplete menu |
| `Ctrl+N` / `Ctrl+P` | Move through pi's menu while it is open |

All other keys go to Neovim, except keys bound to pi app actions (`Ctrl+C`, `Ctrl+L`, `Ctrl+O`,
`Shift+Tab`, …), which keep their pi behaviour. Some keys are too important to vim to give up;
by default these go to Neovim even though pi binds them:

- normal and visual: `Ctrl+V` (visual block), `Ctrl+X`/`Ctrl+A` (decrement/increment), `Ctrl+R` (redo)
- insert: `Ctrl+R` (insert register)

`Ctrl+D` exits pi only when the prompt is empty, as in the default editor. In command-line mode
(`:`, `/`, `?`) every key goes to Neovim.

If the app interrupt is bound to something other than `Esc` (for example `Ctrl+C` in
`keybindings.json`), that key interrupts from any mode except command-line mode.

`:q` restarts Neovim with the same text, so it cannot leave you without an editor. If Neovim cannot
start at all, the extension shows an error and switches back to pi's default editor.

## Configuration

Everything is optional and lives in `~/.pi/agent/nvim-mode/`:

- `init.lua` is sourced after the built-in setup. This is the **only** user Lua that reaches the
  embedded Neovim, so put mappings and options for the prompt here, e.g.
  `vim.keymap.set("i", "jk", "<Esc>")`.
- `config.json`:

  ```json
  {
    "nvim": "/path/to/nvim",
    "init": "~/somewhere/else.lua",
    "startInInsert": true,
    "submitInNormal": true,
    "nvimKeys": {
      "normal": ["ctrl+v", "ctrl+x", "ctrl+a", "ctrl+r"],
      "insert": ["ctrl+r", "ctrl+n"]
    }
  }
  ```

  `nvimKeys` lists pi key ids that go to Neovim instead of pi's app actions. Setting
  `submitInNormal` to `false` sends `Enter` to Neovim in normal mode, so you submit with `:w` or from
  insert mode.

The `PI_NVIM_BIN` environment variable overrides `nvim`. Set `PI_NVIM_MODE_LOG=/path/to/file` to log
the RPC traffic for debugging.

## Isolation

The embedded Neovim must behave the same on every machine, whatever is in `~/.config/nvim`:

- It starts with `--clean`, which skips `init.lua`/`init.vim`, `VIMINIT`/`EXINIT`, and the user
  config and data directories on `runtimepath`.
- `--cmd "set noloadplugins"` stops the bundled runtime plugins (netrw, matchparen, editorconfig,
  …). `--noplugin` alone does not work here, because `--clean` turns plugin loading back on.
- `-n -i NONE` disables swap files and shada, so nothing is read from or written to your
  history, marks, or registers.
- `NVIM_APPNAME=pi-nvim-mode` points `stdpath()` away from your `nvim` directories, and the
  bootstrap trims `runtimepath`/`packpath` to Neovim's own runtime, which also drops system-wide
  XDG directories.
- `VIMINIT`, `EXINIT`, `MYVIMRC`, `NVIM`, `NVIM_LISTEN_ADDRESS` and `NVIM_LOG_FILE` are removed from
  the child environment, so it cannot attach to or be confused with a parent Neovim (e.g. when pi
  runs inside a `:terminal`).
- `exrc`, `modeline` and swap/backup/undo files are off, and the buffer is `buftype=acwrite`, so
  `:w` never touches the filesystem.

`test/isolation.test.ts` plants a hostile `init.lua`, plugins, a `pack/` directory, a project `.nvim.lua`,
and `VIMINIT`, then asserts none of them ran.

## How it works

```
terminal ─▶ pi TUI ─▶ NvimEditor.handleInput ─▶ nvim_input ─▶ nvim --embed
                         ▲                                     │
                         └──── pi_state / redraw notifications ◀┘
```

- `src/rpc.ts`, `src/msgpack.ts`: a dependency-free msgpack-RPC client. Replies are delivered
  synchronously in wire order with notifications, so state updates can never be applied out of order.
- `src/bootstrap.lua`: runs inside Neovim. It configures the prompt buffer and pushes a compact
  state snapshot (lines, cursor in UTF-16 units, mode, visual and search ranges, recording register)
  on every relevant autocmd, tagged with a monotonic sequence number.
- `src/session.ts`: owns the Neovim process. It attaches a UI with `ext_cmdline`, `ext_messages`,
  and `ext_popupmenu`, so it gets the command line, messages, `showcmd`, and completion menus as
  structured events. It also restarts Neovim after `:q`.
- `src/editor.ts`: a `CustomEditor` subclass. It renders the buffer itself (word wrap, cursor,
  visual and search highlighting, mode line, command line, messages), routes keys, and runs pi's
  autocomplete provider against the Neovim buffer.

Keys are handled one at a time, in order. Most are sent straight to Neovim. For keys whose meaning
depends on the mode (`Enter`, `Esc`, arrows, `Tab`, app shortcuts), the editor first asks
`nvim_get_mode`. Neovim answers that request immediately, even in the middle of a pending command,
and only after it has processed all earlier input, so the decision always reflects the real mode.
While a command is pending (`d`, `f`, `"`, a count, …) every key goes to Neovim.

## Development

```sh
npm test          # node --test, needs nvim on PATH
npx tsc --noEmit  # type-check against pi's typings (node_modules/@earendil-works/*)
```
