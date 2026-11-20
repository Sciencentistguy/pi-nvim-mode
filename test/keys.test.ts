import assert from "node:assert/strict";
import { test } from "node:test";
import { keyIdToNvim, toNvimInput } from "../src/keys.ts";

test("printable text is passed through with < escaped", () => {
	assert.equal(toNvimInput("a"), "a");
	assert.equal(toNvimInput("A"), "A");
	assert.equal(toNvimInput("<"), "<lt>");
	assert.equal(toNvimInput("ünï"), "ünï");
	assert.equal(toNvimInput(" "), " ");
});

test("terminal sequences map to nvim key notation", () => {
	const cases: [string, string][] = [
		["\x1b", "<Esc>"],
		["\r", "<CR>"],
		["\x7f", "<BS>"],
		["\t", "<Tab>"],
		["\x1b[Z", "<S-Tab>"],
		["\x1b[A", "<Up>"],
		["\x1b[3~", "<Del>"],
		["\x1b[5~", "<PageUp>"],
		["\x01", "<C-a>"],
		["\x16", "<C-v>"],
		["\x12", "<C-r>"],
		["\x1bx", "<M-x>"],
		["\x1b[1;5C", "<C-Right>"],
		["\x1bOP", "<F1>"],
	];
	for (const [data, expected] of cases) assert.equal(toNvimInput(data), expected, JSON.stringify(data));
});

test("kitty CSI-u sequences", () => {
	assert.equal(toNvimInput("\x1b[97u"), "a");
	assert.equal(toNvimInput("\x1b[97;5u"), "<C-a>");
	assert.equal(toNvimInput("\x1b[13;2u"), "<S-CR>");
});

test("key ids with modifiers", () => {
	assert.equal(keyIdToNvim("ctrl+shift+p"), "<C-S-p>");
	assert.equal(keyIdToNvim("shift+a"), "A");
	assert.equal(keyIdToNvim("alt+enter"), "<M-CR>");
	assert.equal(keyIdToNvim("ctrl+\\"), "<C-Bslash>");
	assert.equal(keyIdToNvim("f12"), "<F12>");
});
