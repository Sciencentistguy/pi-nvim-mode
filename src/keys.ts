import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";

const SPECIAL: Record<string, string> = {
	escape: "Esc",
	esc: "Esc",
	enter: "CR",
	return: "CR",
	tab: "Tab",
	space: "Space",
	backspace: "BS",
	delete: "Del",
	insert: "Insert",
	clear: "Del",
	home: "Home",
	end: "End",
	pageUp: "PageUp",
	pageDown: "PageDown",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	"<": "lt",
	"\\": "Bslash",
	"|": "Bar",
};

const MODIFIERS: Record<string, string> = { ctrl: "C", alt: "M", shift: "S", super: "D" };

/** Notation for Alt+<char> (a single printable character), e.g. `<M-a>`, `<M-Space>`. */
export function altLhs(ch: string): string {
	return `<M-${ch === " " ? "Space" : (SPECIAL[ch] ?? ch)}>`;
}

/** Escape literal text for nvim_input, where `<` starts a key code. */
export function escapeLiteral(text: string): string {
	return text.replaceAll("<", "<lt>");
}

function isPrintableText(data: string): boolean {
	if (data.length === 0 || data.startsWith("\x1b")) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false;
	}
	return true;
}

/** Convert a pi-tui key id such as `ctrl+shift+a` to nvim notation such as `<C-S-a>`. */
export function keyIdToNvim(id: string): string | undefined {
	let base: string;
	let modPart: string;
	if (id === "+" || id.endsWith("++")) {
		base = "+";
		modPart = id.slice(0, -1);
	} else {
		const idx = id.lastIndexOf("+");
		base = idx === -1 ? id : id.slice(idx + 1);
		modPart = idx === -1 ? "" : id.slice(0, idx + 1);
	}
	const mods = modPart
		.split("+")
		.filter(Boolean)
		.map((m) => MODIFIERS[m]);
	if (mods.some((m) => m === undefined)) return undefined;

	const fkey = /^f(\d{1,2})$/.exec(base);
	let name: string;
	if (fkey) name = `F${fkey[1]}`;
	else if (base in SPECIAL) name = SPECIAL[base]!;
	else if ([...base].length === 1) {
		// Shift+letter is just the uppercase letter.
		if (mods.length === 1 && mods[0] === "S" && /^[a-z]$/.test(base)) return base.toUpperCase();
		if (mods.length === 0) return base;
		name = base;
	} else return undefined;

	if (mods.length === 0) return `<${name}>`;
	return `<${mods.join("-")}-${name}>`;
}

/**
 * The character of a legacy Alt+<char> encoding (ESC followed by one printable character).
 * Terminals send the same bytes when Esc and a key arrive in one read, which happens whenever
 * the machine is slow enough to batch them, so the two cannot be told apart.
 */
export function legacyAltChar(data: string): string | undefined {
	if (data.length < 2 || !data.startsWith("\x1b")) return undefined;
	const ch = data.slice(1);
	return isPrintableText(ch) && [...ch].length === 1 ? ch : undefined;
}

/**
 * Translate raw terminal input into nvim_input key notation.
 * Returns undefined for input that has no sensible nvim equivalent.
 */
export function toNvimInput(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return escapeLiteral(kitty);
	if (isPrintableText(data)) return escapeLiteral(data);

	const id = parseKey(data);
	if (id) return keyIdToNvim(id);

	// Legacy Alt+<char> encoding: ESC followed by a printable character.
	const ch = legacyAltChar(data);
	if (ch !== undefined) {
		return altLhs(ch);
	}
	return undefined;
}
