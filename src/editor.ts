import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CURSOR_MARKER,
	type EditorTheme,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	renderFakeCursor,
	SelectList,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { NvimModeConfig } from "./config.ts";
import { toNvimInput } from "./keys.ts";
import { log, NvimSession, type Range } from "./session.ts";

export interface NvimEditorDeps {
	config: NvimModeConfig;
	cwd: string;
	theme: () => Theme;
	/** nvim is unusable; the extension should fall back to pi's default editor. */
	onFatal: (reason: string) => void;
}

type ModeGroup = "normal" | "insert" | "visual" | "cmdline" | "pending" | "other";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const HISTORY_LIMIT = 100;
const SLASH_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };
const ATTACHMENT_DEBOUNCE_MS = 20;
const MAX_MESSAGE_LINES = 6;
const MAX_POPUP_ITEMS = 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Cell {
	text: string;
	/** UTF-16 index of the grapheme in its logical line. */
	index: number;
	width: number;
	space: boolean;
}

interface VisualLine {
	row: number;
	cells: Cell[];
	/** UTF-16 start/end of this wrapped segment. */
	start: number;
	end: number;
	last: boolean;
}

interface Completion {
	list: SelectList;
	prefix: string;
	force: boolean;
}

function toCells(line: string): Cell[] {
	const cells: Cell[] = [];
	for (const { segment, index } of segmenter.segment(line)) {
		let text = segment;
		const code = segment.codePointAt(0)!;
		if (segment === "\t") text = "    ";
		else if (code < 0x20 || code === 0x7f) text = `^${String.fromCharCode(code === 0x7f ? 63 : code + 64)}`;
		cells.push({ text, index, width: Math.max(visibleWidth(text), text === "" ? 0 : 1), space: /^\s$/u.test(segment) });
	}
	return cells;
}

/** Word-wrap a line into visual segments no wider than `width` cells. */
function wrapCells(row: number, line: string, width: number): VisualLine[] {
	const cells = toCells(line);
	const out: VisualLine[] = [];
	let start = 0;
	let used = 0;
	let lastBreak = -1;
	for (let k = 0; k < cells.length; k++) {
		const cell = cells[k]!;
		if (used + cell.width > width && k > start) {
			const cut = lastBreak > start ? lastBreak : k;
			out.push(segmentOf(row, line, cells, start, cut, false));
			used = 0;
			for (let j = cut; j < k; j++) used += cells[j]!.width;
			start = cut;
			lastBreak = -1;
		}
		used += cell.width;
		if (cell.space) lastBreak = k + 1;
	}
	out.push(segmentOf(row, line, cells, start, cells.length, true));
	return out;
}

function segmentOf(row: number, line: string, cells: Cell[], from: number, to: number, last: boolean): VisualLine {
	const slice = cells.slice(from, to);
	return {
		row,
		cells: slice,
		start: slice[0]?.index ?? (from < cells.length ? cells[from]!.index : line.length),
		end: to < cells.length ? cells[to]!.index : line.length,
		last,
	};
}

const INVERSE = "\x1b[7m";
const NO_INVERSE = "\x1b[27m";
const UNDERLINE = "\x1b[4m";
const NO_UNDERLINE = "\x1b[24m";

/** Some themes leave background tokens unset, in which case theme.bg only emits a reset. */
function hasBackground(theme: Theme, token: "selectedBg" | "searchMatchBg"): boolean {
	return /\x1b\[48[;:]/.test(theme.bg(token, ""));
}

function inRanges(ranges: Range[], row: number, index: number): boolean {
	for (const [r, s, e] of ranges) if (r === row && index >= s && index < e) return true;
	return false;
}

export function modeGroup(mode: string, blocking: boolean): ModeGroup {
	if (blocking || mode.startsWith("no")) return "pending";
	const c = mode[0];
	if (c === "i" || c === "R") return "insert";
	if (c === "v" || c === "V" || c === "\x16" || c === "s" || c === "S" || c === "\x13") return "visual";
	if (c === "c") return "cmdline";
	if (c === "n") return "normal";
	return "other";
}

function modeLabel(mode: string): string {
	if (mode.startsWith("no")) return "O-PENDING";
	if (mode.startsWith("ni")) return "(INSERT)";
	switch (mode[0]) {
		case "n":
			return "NORMAL";
		case "i":
			return "INSERT";
		case "R":
			return mode.startsWith("Rv") ? "V-REPLACE" : "REPLACE";
		case "v":
			return "VISUAL";
		case "V":
			return "V-LINE";
		case "\x16":
			return "V-BLOCK";
		case "s":
			return "SELECT";
		case "S":
			return "S-LINE";
		case "\x13":
			return "S-BLOCK";
		case "c":
			return "COMMAND";
		case "r":
			return "PROMPT";
		default:
			return mode.toUpperCase();
	}
}

export class NvimEditor extends CustomEditor {
	private readonly session: NvimSession;
	private readonly deps: NvimEditorDeps;
	private readonly appKeys: KeybindingsManager;
	private provider?: AutocompleteProvider;
	private completion?: Completion;
	private completionAbort?: AbortController;
	private completionTimer?: ReturnType<typeof setTimeout>;
	private completionKey = "";
	private queue: Promise<void> = Promise.resolve();
	private pendingPaste: string | undefined;
	private promptHistory: string[] = [];
	private promptHistoryIndex = -1;
	private promptHistoryDraft = "";
	private scroll = 0;
	private lastLayout: { lines: VisualLine[]; top: number; paddingX: number } = { lines: [], top: 0, paddingX: 0 };
	private lastText = "";
	private fallback = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: NvimEditorDeps) {
		super(tui, theme, keybindings);
		this.deps = deps;
		this.appKeys = keybindings;
		this.session = new NvimSession({
			command: deps.config.nvim,
			cwd: deps.cwd,
			init: deps.config.init,
			startInInsert: deps.config.startInInsert,
			width: Math.max(1, tui.terminal.columns - 2),
			height: this.maxVisibleLines(),
			onUpdate: () => this.onSessionUpdate(),
			onSubmit: () => this.enqueue(() => this.submitPrompt()),
			onFatal: (reason) => this.enterFallback(reason),
		});
	}

	dispose(): void {
		this.session.dispose();
		this.cancelCompletion();
	}

	// ── pi editor API ──────────────────────────────────────────────────

	override getText(): string {
		return this.fallback ? super.getText() : this.session.text;
	}

	override getExpandedText(): string {
		return this.fallback ? super.getExpandedText() : this.session.text;
	}

	override getLines(): string[] {
		return this.fallback ? super.getLines() : [...this.session.state.lines];
	}

	override getCursor(): { line: number; col: number } {
		if (this.fallback) return super.getCursor();
		return { line: this.session.state.row, col: this.session.state.col };
	}

	override setText(text: string): void {
		if (this.fallback) return super.setText(text);
		this.promptHistoryIndex = -1;
		this.cancelCompletion();
		const normalized = text.replace(/\r\n?/g, "\n");
		this.session.setText(normalized, {
			resetUndo: normalized === "",
			insert: normalized === "" ? this.deps.config.startInInsert : undefined,
		});
		this.emitChange();
		this.tui.requestRender();
	}

	override insertTextAtCursor(text: string): void {
		if (this.fallback) return super.insertTextAtCursor(text);
		if (!text) return;
		this.enqueue(() => this.session.paste(text));
	}

	override addToHistory(text: string): void {
		super.addToHistory(text);
		const trimmed = text.trim();
		if (!trimmed || this.promptHistory[0] === trimmed) return;
		this.promptHistory.unshift(trimmed);
		if (this.promptHistory.length > HISTORY_LIMIT) this.promptHistory.pop();
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(provider);
		this.provider = provider;
	}

	override isShowingAutocomplete(): boolean {
		return this.fallback ? super.isShowingAutocomplete() : this.completion !== undefined;
	}

	private enterFallback(reason: string): void {
		if (this.fallback) return;
		this.fallback = true;
		this.cancelCompletion();
		super.setText(this.session.text);
		this.deps.onFatal(reason);
		this.tui.requestRender();
	}

	private emitChange(): void {
		const text = this.getText();
		if (text === this.lastText) return;
		this.lastText = text;
		this.onChange?.(text);
	}

	private onSessionUpdate(): void {
		this.emitChange();
		this.updateCompletion();
		this.tui.requestRender();
	}

	// ── input ──────────────────────────────────────────────────────────

	private enqueue(task: () => void | Promise<void>): void {
		this.queue = this.queue.then(task).catch(() => {});
	}

	override handleInput(data: string): void {
		if (this.fallback) return super.handleInput(data);

		// Bracketed paste may arrive split across several chunks.
		if (this.pendingPaste !== undefined || data.includes(PASTE_START)) {
			this.pendingPaste = (this.pendingPaste ?? "") + data.replace(PASTE_START, "");
			const end = this.pendingPaste.indexOf(PASTE_END);
			if (end === -1) return;
			const text = this.pendingPaste.slice(0, end);
			const rest = this.pendingPaste.slice(end + PASTE_END.length);
			this.pendingPaste = undefined;
			this.enqueue(() => this.session.paste(text.replace(/\r\n?/g, "\n")));
			if (rest) this.handleInput(rest);
			return;
		}

		if (isKeyRelease(data)) return;
		this.enqueue(() => this.dispatch(data));
	}

	/** Keys whose meaning depends on nvim's current mode, so nvim must catch up first. */
	private needsSync(data: string): boolean {
		const tui = getKeybindings();
		if (matchesKey(data, "escape") || matchesKey(data, "up") || matchesKey(data, "down")) return true;
		if (tui.matches(data, "tui.input.submit") || tui.matches(data, "tui.input.newLine")) return true;
		if (tui.matches(data, "tui.input.tab")) return true;
		if (this.completion) return true;
		for (const action of ["app.interrupt", "app.clipboard.pasteImage", "app.exit"] as const) {
			if (this.appKeys.matches(data, action)) return true;
		}
		for (const action of this.actionHandlers.keys()) if (this.appKeys.matches(data, action)) return true;
		return false;
	}

	private async dispatch(data: string): Promise<void> {
		this.session.clearMessage();

		if (!this.needsSync(data)) {
			if (this.onExtensionShortcut?.(data)) return;
			this.sendKey(data);
			return;
		}

		const { mode, blocking } = await this.session.getMode();
		const group = modeGroup(mode, blocking);
		log("dispatch", data, mode, blocking, group);

		// A pending command (operator, count, register, `f`…) owns every key until it completes.
		if (group === "pending") {
			this.sendKey(data);
			return;
		}

		if (this.completion && group === "insert" && (await this.handleCompletionKey(data))) return;
		if (this.onExtensionShortcut?.(data)) return;

		const tui = getKeybindings();
		const keys = this.appKeys;

		if (tui.matches(data, "tui.input.submit")) {
			if (group === "insert" || (group === "normal" && this.deps.config.submitInNormal)) {
				await this.submitPrompt();
			} else {
				this.sendKey(data);
			}
			return;
		}

		if (tui.matches(data, "tui.input.newLine") && group === "insert") {
			this.session.input("<CR>");
			return;
		}

		// Escape is essential to vim, so it only interrupts pi from idle normal mode. Any other
		// interrupt key (e.g. ctrl+c) works everywhere except while typing an ex command.
		if (keys.matches(data, "app.interrupt") && (group === "normal" || (!matchesKey(data, "escape") && group !== "cmdline"))) {
			const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
			handler?.();
			return;
		}

		if ((matchesKey(data, "up") || matchesKey(data, "down")) && (group === "normal" || group === "insert")) {
			if (this.navigatePromptHistory(matchesKey(data, "up") ? -1 : 1)) return;
			this.sendKey(data);
			return;
		}

		if (tui.matches(data, "tui.input.tab") && group === "insert" && this.provider) {
			if (await this.forceCompletion()) return;
			this.sendKey(data);
			return;
		}

		if (this.ownedByNvim(data, group)) {
			this.sendKey(data);
			return;
		}

		if (keys.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		if (keys.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				handler?.();
			} else {
				this.sendKey(data);
			}
			return;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && keys.matches(data, action)) {
				handler();
				return;
			}
		}

		this.sendKey(data);
	}

	private ownedByNvim(data: string, group: ModeGroup): boolean {
		const { normal, insert } = this.deps.config.nvimKeys;
		const list = group === "insert" ? insert : group === "normal" || group === "visual" ? normal : undefined;
		// Command-line mode (and prompts) are pure nvim: no app actions fire while typing an ex command.
		if (group === "cmdline" || group === "other") return true;
		return list?.some((key) => matchesKey(data, key as Parameters<typeof matchesKey>[1])) ?? false;
	}

	private sendKey(data: string): void {
		const keys = toNvimInput(data);
		if (keys) this.session.input(keys);
	}

	private async submitPrompt(): Promise<void> {
		if (this.disableSubmit) return;
		this.cancelCompletion();
		await this.session.refresh();
		const text = this.session.text.trim();
		this.promptHistoryIndex = -1;
		this.session.setText("", { resetUndo: true, insert: this.deps.config.startInInsert });
		this.scroll = 0;
		this.emitChange();
		this.onSubmit?.(text);
		this.tui.requestRender();
	}

	/** Returns false when the cursor is not on the edge line, so the key should move the cursor instead. */
	private navigatePromptHistory(direction: -1 | 1): boolean {
		const { row, lines } = this.session.state;
		if (direction === -1 && row !== 0) return false;
		if (direction === 1 && row !== lines.length - 1) return false;
		if (this.promptHistory.length === 0) return direction === -1 ? false : this.promptHistoryIndex !== -1;

		const next = this.promptHistoryIndex - direction;
		if (next < -1 || next >= this.promptHistory.length) return true;
		if (this.promptHistoryIndex === -1) this.promptHistoryDraft = this.session.text;
		this.promptHistoryIndex = next;
		const text = next === -1 ? this.promptHistoryDraft : this.promptHistory[next]!;
		const textLines = text.split("\n");
		// Going back lands on the first line (so Up keeps walking); forward lands on the last.
		const cursor = direction === -1 ? { row: 0, col: 0 } : { row: textLines.length - 1, col: textLines.at(-1)!.length };
		this.session.setText(text, { cursor });
		this.emitChange();
		return true;
	}

	// ── autocomplete (pi's provider, rendered by us) ──────────────────

	private async handleCompletionKey(data: string): Promise<boolean> {
		const completion = this.completion!;
		const tui = getKeybindings();
		if (tui.matches(data, "tui.select.cancel")) {
			this.cancelCompletion();
			// Escape also leaves insert mode, like closing a completion menu in vim.
			if (matchesKey(data, "escape")) this.session.input("<Esc>");
			return true;
		}
		if (matchesKey(data, "ctrl+n")) {
			completion.list.handleInput("\x1b[B");
			return true;
		}
		if (matchesKey(data, "ctrl+p")) {
			completion.list.handleInput("\x1b[A");
			return true;
		}
		if (
			tui.matches(data, "tui.select.up") ||
			tui.matches(data, "tui.select.down") ||
			tui.matches(data, "tui.select.pageUp") ||
			tui.matches(data, "tui.select.pageDown")
		) {
			completion.list.handleInput(data);
			return true;
		}
		const isTab = tui.matches(data, "tui.input.tab");
		const isConfirm = tui.matches(data, "tui.select.confirm");
		if (isTab || isConfirm) {
			const item = completion.list.getSelectedItem();
			if (!item) {
				this.cancelCompletion();
				return isTab;
			}
			await this.applyCompletion(item, completion.prefix);
			// Choosing a slash command with Enter runs it, matching pi's own editor.
			if (isConfirm && completion.prefix.startsWith("/")) await this.submitPrompt();
			return true;
		}
		return false;
	}

	private async applyCompletion(item: { value: string; label: string }, prefix: string): Promise<void> {
		if (!this.provider) return;
		this.cancelCompletion();
		await this.session.refresh();
		const { lines, row, col } = this.session.state;
		const result = this.provider.applyCompletion(lines, row, col, item, prefix);
		let first = 0;
		while (first < lines.length && first < result.lines.length && lines[first] === result.lines[first]) first++;
		let tailOld = lines.length;
		let tailNew = result.lines.length;
		while (tailOld > first && tailNew > first && lines[tailOld - 1] === result.lines[tailNew - 1]) {
			tailOld--;
			tailNew--;
		}
		this.session.splice(first, tailOld, result.lines.slice(first, tailNew), result.cursorLine, result.cursorCol);
		// Completions change text without nvim seeing the keystrokes; don't immediately re-open the menu.
		this.completionKey = this.snapshotKey();
		this.emitChange();
	}

	private snapshotKey(): string {
		const { tick, row, col } = this.session.state;
		return `${tick}:${row}:${col}`;
	}

	private cancelCompletion(): void {
		this.completion = undefined;
		this.completionAbort?.abort();
		this.completionAbort = undefined;
		if (this.completionTimer) clearTimeout(this.completionTimer);
		this.completionTimer = undefined;
	}

	private shouldAutoTrigger(): { debounce: number } | undefined {
		const { lines, row, col } = this.session.state;
		const before = (lines[row] ?? "").slice(0, col);
		if (row === 0 && before.trimStart().startsWith("/")) return { debounce: 0 };
		const triggers = ["@", "#", ...(this.provider?.triggerCharacters ?? [])]
			.filter((c) => c.length === 1 && c !== "/" && !/\s/.test(c))
			.map((c) => c.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&"))
			.join("");
		const pattern = new RegExp(`(?:^|[\\s])[([{<\`]*(?:@"[^"]*|[${triggers}][^\\s]*)$`, "u");
		if (pattern.test(before)) return { debounce: before.includes("@") ? ATTACHMENT_DEBOUNCE_MS : 0 };
		return undefined;
	}

	/** Called after every nvim state update. Opens, refreshes, or closes the menu as the user types. */
	private updateCompletion(): void {
		if (!this.provider) return;
		const group = modeGroup(this.session.state.mode, false);
		if (group !== "insert") {
			if (this.completion || this.completionAbort) this.cancelCompletion();
			return;
		}
		const key = this.snapshotKey();
		if (key === this.completionKey) return;
		this.completionKey = key;

		const trigger = this.completion ? { debounce: 0 } : this.shouldAutoTrigger();
		if (!trigger) return;
		this.requestCompletion(this.completion?.force ?? false, trigger.debounce);
	}

	private requestCompletion(force: boolean, debounce: number): void {
		this.completionAbort?.abort();
		if (this.completionTimer) clearTimeout(this.completionTimer);
		const run = () => {
			this.completionTimer = undefined;
			void this.fetchSuggestions(force).then((suggestions) => {
				if (suggestions === undefined) return;
				this.showSuggestions(suggestions, force);
			});
		};
		if (debounce > 0) this.completionTimer = setTimeout(run, debounce);
		else run();
	}

	/** Resolves undefined when the request was superseded. */
	private async fetchSuggestions(force: boolean): Promise<AutocompleteSuggestions | null | undefined> {
		if (!this.provider) return null;
		const controller = new AbortController();
		this.completionAbort = controller;
		const snapshot = this.snapshotKey();
		const { lines, row, col } = this.session.state;
		let suggestions: AutocompleteSuggestions | null;
		try {
			suggestions = await this.provider.getSuggestions(lines, row, col, { signal: controller.signal, force });
		} catch {
			suggestions = null;
		}
		if (controller.signal.aborted || snapshot !== this.snapshotKey()) return undefined;
		this.completionAbort = undefined;
		return suggestions;
	}

	private showSuggestions(suggestions: AutocompleteSuggestions | null, force: boolean): void {
		if (!suggestions || suggestions.items.length === 0) {
			this.completion = undefined;
			this.tui.requestRender();
			return;
		}
		const layout = suggestions.prefix.startsWith("/") ? SLASH_LAYOUT : undefined;
		const list = new SelectList(suggestions.items, this.getAutocompleteMaxVisible(), this.selectTheme(), layout);
		const exact = suggestions.items.findIndex((i) => i.value === suggestions.prefix);
		const partial = suggestions.items.findIndex((i) => suggestions.prefix && i.value.startsWith(suggestions.prefix));
		const best = exact >= 0 ? exact : partial;
		if (best >= 0) list.setSelectedIndex(best);
		this.completion = { list, prefix: suggestions.prefix, force };
		this.tui.requestRender();
	}

	/** Tab in insert mode. Returns false when there is nothing to complete. */
	private async forceCompletion(): Promise<boolean> {
		if (!this.provider) return false;
		await this.session.refresh();
		const { lines, row, col } = this.session.state;
		const before = (lines[row] ?? "").slice(0, col);
		const slash = row === 0 && before.trimStart().startsWith("/") && !before.trimStart().includes(" ");
		const force = !slash;
		if (force && this.provider.shouldTriggerFileCompletion && !this.provider.shouldTriggerFileCompletion(lines, row, col)) {
			return false;
		}
		const suggestions = await this.fetchSuggestions(force);
		if (!suggestions || suggestions.items.length === 0) return false;
		if (force && suggestions.items.length === 1) {
			await this.applyCompletion(suggestions.items[0]!, suggestions.prefix);
			return true;
		}
		this.showSuggestions(suggestions, force);
		return true;
	}

	private selectTheme() {
		return (this as unknown as { theme: EditorTheme }).theme.selectList;
	}

	// ── rendering ──────────────────────────────────────────────────────

	private maxVisibleLines(): number {
		return Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
	}

	override render(width: number): string[] {
		if (this.fallback) return super.render(width);

		const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const maxVisible = this.maxVisibleLines();
		this.session.resize(layoutWidth, maxVisible);

		const theme = this.deps.theme();
		const { state } = this.session;
		const group = modeGroup(state.mode, false);
		const showCursor = group !== "cmdline";

		const visual: VisualLine[] = [];
		state.lines.forEach((line, row) => visual.push(...wrapCells(row, line, layoutWidth)));

		let cursorLine = visual.findIndex(
			(v) => v.row === state.row && state.col >= v.start && (state.col < v.end || v.last),
		);
		if (cursorLine === -1) cursorLine = 0;
		if (cursorLine < this.scroll) this.scroll = cursorLine;
		else if (cursorLine >= this.scroll + maxVisible) this.scroll = cursorLine - maxVisible + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, visual.length - maxVisible)));

		const shown = visual.slice(this.scroll, this.scroll + maxVisible);
		this.lastLayout = { lines: shown, top: 1, paddingX };
		const pad = " ".repeat(paddingX);
		const out: string[] = [this.renderTopBorder(width, this.scroll)];

		for (const vl of shown) {
			const cursorCol = showCursor && vl.row === state.row && state.col >= vl.start && (state.col < vl.end || vl.last)
				? state.col
				: undefined;
			let text = "";
			let used = 0;
			for (const cell of vl.cells) {
				text += this.styleCell(cell.text, vl.row, cell.index, cursorCol === cell.index, theme);
				used += cell.width;
			}
			// End-of-line cell: cursor after the last character, or a selected newline.
			const eolIndex = vl.end;
			const eolCursor = cursorCol !== undefined && cursorCol >= vl.end && vl.last;
			const eolSelected = vl.last && inRanges(state.visual, vl.row, eolIndex);
			if (eolCursor || eolSelected) {
				text += this.styleCell(" ", vl.row, eolIndex, eolCursor, theme);
				used += 1;
			}
			out.push(`${pad}${text}${" ".repeat(Math.max(0, contentWidth - used))}${used > contentWidth ? "" : pad}`);
		}

		const hiddenBelow = visual.length - (this.scroll + shown.length);
		out.push(this.renderStatusBorder(width, hiddenBelow, theme));

		for (const line of this.renderBelow(contentWidth, theme)) {
			out.push(`${pad}${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))}${pad}`);
		}
		return out;
	}

	private styleCell(text: string, row: number, index: number, cursor: boolean, theme: Theme): string {
		const { visual, search } = this.session.state;
		const marker = cursor && this.focused ? CURSOR_MARKER : "";
		if (inRanges(visual, row, index)) {
			if (hasBackground(theme, "selectedBg")) {
				const styled = theme.bg("selectedBg", text);
				return cursor ? marker + renderFakeCursor(styled) : styled;
			}
			// Themes without a selection colour: selection is inverse, so show the cursor underlined.
			return cursor ? `${marker}${UNDERLINE}${text}${NO_UNDERLINE}` : `${INVERSE}${text}${NO_INVERSE}`;
		}
		let styled = text;
		if (inRanges(search, row, index)) {
			styled = hasBackground(theme, "searchMatchBg")
				? theme.bg("searchMatchBg", text)
				: `${UNDERLINE}${theme.fg("warning", text)}${NO_UNDERLINE}`;
		}
		return cursor ? marker + renderFakeCursor(styled) : styled;
	}

	private renderStatusBorder(width: number, hiddenBelow: number, theme: Theme): string {
		const { state, showcmd } = this.session;
		const group = modeGroup(state.mode, false);
		const color = group === "insert" ? "success" : group === "visual" ? "warning" : group === "cmdline" ? "accent" : "muted";
		const left = theme.fg(color, theme.bold(` ${modeLabel(state.mode)} `));
		const parts: string[] = [];
		if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} more`);
		if (showcmd && group !== "cmdline") parts.push(showcmd);
		if (state.recording) parts.push(`recording @${state.recording}`);
		const right = parts.length ? theme.fg("muted", ` ${parts.join("  ")} `) : "";
		const fill = width - 1 - visibleWidth(left) - visibleWidth(right) - 1;
		if (fill < 1) return truncateToWidth(this.borderColor("─") + left, width, "");
		return this.borderColor("─") + left + this.borderColor("─".repeat(fill)) + right + this.borderColor("─");
	}

	private renderBelow(width: number, theme: Theme): string[] {
		const { cmdline, message, popupmenu } = this.session;
		const lines: string[] = [];

		if (cmdline) {
			const prefix = cmdline.firstc + cmdline.prompt + " ".repeat(cmdline.indent);
			const before = cmdline.text.slice(0, cmdline.pos);
			const at = [...segmenter.segment(cmdline.text.slice(cmdline.pos))][0]?.segment ?? " ";
			const after = cmdline.text.slice(cmdline.pos + (at === " " && cmdline.pos >= cmdline.text.length ? 0 : at.length));
			let head = prefix + before;
			// Keep the cursor visible on long command lines by dropping text from the left.
			while (visibleWidth(head) + 1 > width && head.length > 0) head = head.slice(1);
			const cursor = (this.focused ? CURSOR_MARKER : "") + renderFakeCursor(at);
			lines.push(truncateToWidth(head + cursor + after, width, ""));
		} else if (message) {
			const msgLines = message.text.split("\n").slice(-MAX_MESSAGE_LINES);
			for (const l of msgLines) lines.push(theme.fg(message.error ? "error" : "muted", truncateToWidth(l, width)));
		}

		if (popupmenu && popupmenu.items.length > 0) {
			const total = popupmenu.items.length;
			const sel = popupmenu.selected;
			const start = Math.max(0, Math.min(sel - Math.floor(MAX_POPUP_ITEMS / 2), total - MAX_POPUP_ITEMS));
			const selectTheme = this.selectTheme();
			for (let i = start; i < Math.min(total, start + MAX_POPUP_ITEMS); i++) {
				const item = popupmenu.items[i]!;
				const label = [item.word, item.kind, item.menu].filter(Boolean).join("  ");
				const text = truncateToWidth(`  ${label}`, width);
				lines.push(i === sel ? selectTheme.selectedText(text) : text);
			}
			if (total > MAX_POPUP_ITEMS) lines.push(selectTheme.scrollInfo(`  (${sel + 1}/${total})`));
		}

		if (this.completion) lines.push(...this.completion.list.render(width));
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.fallback) return super.handleMouse(event);
		if (event.type !== "click" || event.button !== "left") return undefined;
		const { lines, top, paddingX } = this.lastLayout;
		const vl = lines[event.y - top];
		if (!vl) return { handled: true, focus: true };
		const target = Math.max(0, event.x - paddingX);
		let used = 0;
		let col = vl.last ? vl.end : (vl.cells.at(-1)?.index ?? vl.start);
		for (const cell of vl.cells) {
			if (target < used + cell.width) {
				col = cell.index;
				break;
			}
			used += cell.width;
		}
		this.enqueue(() => this.session.setCursor(vl.row, col));
		return { handled: true, focus: true };
	}
}
