import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NvimRpc } from "./rpc.ts";

const BOOTSTRAP = readFileSync(fileURLToPath(new URL("./bootstrap.lua", import.meta.url)), "utf8");

/** [line, startUtf16, endUtf16) */
export type Range = [number, number, number];

export interface BufferState {
	lines: string[];
	row: number;
	/** UTF-16 offset into lines[row]. */
	col: number;
	/** Raw nvim_get_mode() mode string ("n", "i", "no", "v", "V", "\x16", "c", ...). */
	mode: string;
	recording: string;
	tick: number;
	visual: Range[];
	search: Range[];
}

interface RawState {
	seq: number;
	lines?: string[];
	row: number;
	col: number;
	mode: string;
	recording: string;
	tick: number;
	visual?: Range[];
	search?: Range[];
}

export interface Cmdline {
	text: string;
	/** UTF-16 cursor offset into text. */
	pos: number;
	firstc: string;
	prompt: string;
	indent: number;
}

export interface Message {
	text: string;
	error: boolean;
}

export interface PopupMenu {
	items: { word: string; kind: string; menu: string }[];
	selected: number;
}

export interface SessionOptions {
	command: string;
	cwd: string;
	init?: string;
	startInInsert: boolean;
	width: number;
	height: number;
	onUpdate: () => void;
	onSubmit: () => void;
	/** nvim failed in a way that restarting will not fix. */
	onFatal: (reason: string) => void;
}

/** Message kinds that only duplicate what the editor already shows. */
const QUIET_MESSAGE_KINDS = new Set(["search_cmd", "search_count", "undo", "completion", "bufwrite", "wildlist"]);
const ERROR_MESSAGE_KINDS = new Set(["emsg", "echoerr", "lua_error", "rpc_error"]);

type Chunks = [number, string, ...unknown[]][];

function chunksText(chunks: unknown): string {
	if (!Array.isArray(chunks)) return "";
	return (chunks as Chunks).map((c) => c[1]).join("");
}

function byteToUtf16(text: string, byte: number): number {
	const bytes = Buffer.from(text, "utf8");
	return bytes.subarray(0, Math.max(0, byte)).toString("utf8").length;
}

const LOG_FILE = process.env.PI_NVIM_MODE_LOG;

export function log(...parts: unknown[]): void {
	if (!LOG_FILE) return;
	appendFileSync(LOG_FILE, `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
}

const MAX_QUICK_RESTARTS = 3;
const QUICK_RESTART_MS = 2000;

export class NvimSession {
	state: BufferState = {
		lines: [""],
		row: 0,
		col: 0,
		mode: "n",
		recording: "",
		tick: 0,
		visual: [],
		search: [],
	};
	cmdline: Cmdline | undefined;
	message: Message | undefined;
	showcmd = "";
	popupmenu: PopupMenu | undefined;

	private rpc!: NvimRpc;
	private readonly opts: SessionOptions;
	private width: number;
	private height: number;
	private disposed = false;
	private seq = 0;
	/** Local edits awaiting nvim's acknowledgement; pushes in the meantime are stale. */
	private pendingEdits = 0;
	private quickRestarts = 0;
	private startedAt = 0;

	constructor(opts: SessionOptions) {
		this.opts = opts;
		this.width = opts.width;
		this.height = opts.height;
		this.start(this.state.lines, opts.startInInsert);
	}

	get alive(): boolean {
		return !this.disposed && !this.rpc.isClosed;
	}

	get text(): string {
		return this.state.lines.join("\n");
	}

	private start(lines: string[], insert: boolean): void {
		this.startedAt = Date.now();
		// Until nvim answers (slow on some machines) show the mode it is about to enter.
		this.state = { ...this.state, mode: insert ? "i" : "n" };
		this.seq = 0;
		this.pendingEdits = 0;
		const rpc = new NvimRpc({
			command: this.opts.command,
			cwd: this.opts.cwd,
			onNotification: (method, params) => {
				if (rpc === this.rpc) this.onNotification(method, params);
			},
			onExit: (reason) => {
				if (rpc === this.rpc) this.onExit(reason);
			},
		});
		this.rpc = rpc;

		// Requests are processed in order, so input sent before these resolve is still handled
		// after the bootstrap has run.
		this.call("nvim_ui_attach", [
			Math.max(1, this.width),
			Math.max(1, this.height),
			{ ext_linegrid: true, ext_cmdline: true, ext_messages: true, ext_popupmenu: true, rgb: true },
		]);
		this.callSync<RawState>("nvim_exec_lua", [BOOTSTRAP, [this.opts.init ?? "", insert]], (st) => this.applyState(st));
		const isEmpty = lines.length === 1 && lines[0] === "";
		if (!isEmpty) this.setText(lines.join("\n"), { insert });
	}

	private onExit(reason: string): void {
		if (this.disposed) return;
		const quick = Date.now() - this.startedAt < QUICK_RESTART_MS;
		this.quickRestarts = quick ? this.quickRestarts + 1 : 0;
		if (this.quickRestarts >= MAX_QUICK_RESTARTS || reason.startsWith("failed to start")) {
			this.disposed = true;
			this.opts.onFatal(reason);
			return;
		}
		// Most likely `:q`. Bring nvim back with the same text.
		this.cmdline = undefined;
		this.popupmenu = undefined;
		this.showcmd = "";
		this.start(this.state.lines, this.opts.startInInsert);
		this.opts.onUpdate();
	}

	private call<T = unknown>(method: string, params: unknown[]): Promise<T | undefined> {
		log("request", method, method === "nvim_exec_lua" ? [String(params[0]).slice(0, 60), params[1]] : params);
		return this.rpc.request<T>(method, params).catch((err: Error) => {
			log("error", method, err.message);
			if (!this.rpc.isClosed) this.showMessage(err.message, true);
			return undefined;
		});
	}

	/** Like call(), but `onResult` runs synchronously in wire order with notifications. */
	private callSync<T>(method: string, params: unknown[], onResult: (result: T) => void, onDone?: () => void): void {
		log("request", method, method === "nvim_exec_lua" ? [String(params[0]).slice(0, 60), params[1]] : params);
		this.rpc.send(method, params, (err, result) => {
			onDone?.();
			if (err) {
				log("error", method, err.message);
				if (!this.rpc.isClosed) this.showMessage(err.message, true);
			} else if (result) {
				onResult(result as T);
			}
		});
	}

	private lua<T = unknown>(code: string, args: unknown[]): Promise<T | undefined> {
		return this.call<T>("nvim_exec_lua", [code, args]);
	}

	private showMessage(text: string, error: boolean): void {
		this.message = { text, error };
		this.opts.onUpdate();
	}

	clearMessage(): void {
		this.message = undefined;
	}

	private applyState(s: RawState): void {
		log("state", s.seq, this.seq, s.mode);
		if (s.seq <= this.seq) return;
		this.seq = s.seq;
		const prev = this.state;
		this.state = {
			lines: s.lines ?? prev.lines,
			row: s.row,
			col: s.col,
			mode: s.mode,
			recording: s.recording,
			tick: s.tick,
			visual: s.visual ?? [],
			search: s.search ?? [],
		};
		this.opts.onUpdate();
	}

	private onNotification(method: string, params: unknown[]): void {
		if (method !== "redraw") log("notify", method, params);
		if (method === "pi_state") {
			if (this.pendingEdits === 0) this.applyState(params[0] as RawState);
		} else if (method === "pi_submit") {
			this.opts.onSubmit();
		} else if (method === "redraw") {
			let changed = false;
			for (const batch of params as unknown[][]) {
				const name = batch[0] as string;
				for (const args of batch.slice(1) as unknown[][]) {
					changed = this.onRedraw(name, args) || changed;
				}
			}
			if (changed) this.opts.onUpdate();
		}
	}

	private onRedraw(name: string, args: unknown[]): boolean {
		switch (name) {
			case "cmdline_show": {
				const [content, pos, firstc, prompt, indent] = args as [Chunks, number, string, string, number];
				const text = chunksText(content);
				this.cmdline = { text, pos: byteToUtf16(text, pos), firstc, prompt, indent };
				return true;
			}
			case "cmdline_pos": {
				const [pos] = args as [number];
				if (this.cmdline) this.cmdline.pos = byteToUtf16(this.cmdline.text, pos);
				return true;
			}
			case "cmdline_hide":
				this.cmdline = undefined;
				return true;
			case "msg_show": {
				const [kind, content, replaceLast] = args as [string, Chunks, boolean];
				if (QUIET_MESSAGE_KINDS.has(kind)) return false;
				const text = chunksText(content).replace(/\n+$/, "");
				if (!text) return false;
				const error = ERROR_MESSAGE_KINDS.has(kind);
				if (this.message && !replaceLast && !error && !this.message.error) {
					this.message = { text: `${this.message.text}\n${text}`, error };
				} else {
					this.message = { text, error };
				}
				return true;
			}
			case "msg_clear":
				this.message = undefined;
				return true;
			case "msg_showcmd": {
				this.showcmd = chunksText(args[0]);
				return true;
			}
			case "popupmenu_show": {
				const [items, selected] = args as [[string, string, string, string][], number];
				this.popupmenu = { items: items.map(([word, kind, menu]) => ({ word, kind, menu })), selected };
				return true;
			}
			case "popupmenu_select": {
				if (this.popupmenu) this.popupmenu.selected = args[0] as number;
				return true;
			}
			case "popupmenu_hide":
				this.popupmenu = undefined;
				return true;
			default:
				return false;
		}
	}

	/**
	 * Mode after every previously sent key has been processed. nvim_get_mode is answered even
	 * while nvim waits for the rest of a command, so this never stalls.
	 */
	async getMode(): Promise<{ mode: string; blocking: boolean }> {
		const res = await this.call<{ mode: string; blocking: boolean }>("nvim_get_mode", []);
		return res ?? { mode: this.state.mode, blocking: false };
	}

	/** Fetch the full state. Only call when nvim is not blocking (see getMode). */
	async refresh(): Promise<void> {
		const { blocking } = await this.getMode();
		if (blocking) return;
		await new Promise<void>((resolve) =>
			this.callSync<RawState>("nvim_exec_lua", ["return PiNvimMode.state(true)", []], (st) => this.applyState(st), resolve),
		);
	}

	setCursor(row: number, col: number): void {
		this.state = { ...this.state, row, col };
		this.edit("PiNvimMode.set_cursor(...) return PiNvimMode.state(true)", [row, col]);
		this.opts.onUpdate();
	}

	/** Run Lua in the embedded nvim and return its result. */
	exec<T = unknown>(code: string, args: unknown[] = []): Promise<T | undefined> {
		return this.lua<T>(code, args);
	}

	/** Whether `<M-key>` has a mapping in nvim's current mode. */
	async hasAltMapping(key: string): Promise<boolean> {
		const lhs = key === "<" ? "<M-lt>" : `<M-${key}>`;
		const mapped = await this.lua<boolean>("return PiNvimMode.has_mapping(...)", [lhs]);
		return mapped ?? false;
	}

	input(keys: string): void {
		this.call("nvim_input", [keys]);
	}

	paste(text: string): void {
		this.call("nvim_paste", [text, true, -1]);
	}

	/** Replace the whole buffer. Resets undo history when `resetUndo` is set. */
	setText(text: string, opts: { resetUndo?: boolean; insert?: boolean; cursor?: { row: number; col: number } } = {}): void {
		const lines = text.replace(/\r\n?/g, "\n").split("\n");
		const row = opts.cursor?.row ?? lines.length - 1;
		const col = opts.cursor?.col ?? lines[row]!.length;
		// Update locally first so getText() is correct immediately.
		this.state = { ...this.state, lines, row, col, visual: [], search: [] };
		this.edit("return PiNvimMode.set_text(...)", [lines, row, col, !!opts.resetUndo, !!opts.insert]);
	}

	/** Replace lines [first, last) keeping the rest of the buffer and its undo history. */
	splice(first: number, last: number, lines: string[], row: number, col: number): void {
		const next = [...this.state.lines];
		next.splice(first, last - first, ...lines);
		this.state = { ...this.state, lines: next, row, col };
		this.edit("return PiNvimMode.splice(...)", [first, last, lines, row, col]);
	}

	private edit(code: string, args: unknown[]): void {
		const rpc = this.rpc;
		this.pendingEdits++;
		this.callSync<RawState>(
			"nvim_exec_lua",
			[code, args],
			(st) => {
				if (rpc === this.rpc) this.applyState(st);
			},
			() => {
				// A restart resets the counter; replies from the old process no longer count.
				if (rpc === this.rpc) this.pendingEdits--;
			},
		);
	}

	resize(width: number, height: number): void {
		width = Math.max(1, width);
		height = Math.max(1, height);
		if (width === this.width && height === this.height) return;
		this.width = width;
		this.height = height;
		this.call("nvim_ui_try_resize", [width, height]);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rpc.kill();
	}
}
