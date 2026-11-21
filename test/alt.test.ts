import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyAltChar } from "../src/keys.ts";
import { NvimSession } from "../src/session.ts";

test("legacyAltChar recognises ESC plus one printable character only", () => {
	assert.equal(legacyAltChar("\x1ba"), "a");
	assert.equal(legacyAltChar("\x1b<"), "<");
	assert.equal(legacyAltChar("a"), undefined);
	assert.equal(legacyAltChar("\x1b"), undefined);
	assert.equal(legacyAltChar("\x1b[A"), undefined);
	assert.equal(legacyAltChar("\x1b\x1b"), undefined);
});

test("hasAltMapping reflects user mappings in the current mode", async () => {
	const session = new NvimSession({
		command: process.env.PI_NVIM_BIN ?? "nvim",
		cwd: process.cwd(),
		startInInsert: true,
		width: 80,
		height: 10,
		onUpdate: () => {},
		onSubmit: () => {},
		onFatal: () => {},
	});
	try {
		assert.equal(await session.hasAltMapping("a"), false);
		await session.exec('vim.keymap.set("i", "<M-a>", "x")');
		assert.equal(await session.hasAltMapping("a"), true);
		assert.equal(await session.hasAltMapping("b"), false);
		session.input("<Esc>");
		assert.equal(await session.hasAltMapping("a"), false, "insert-mode mapping must not apply in normal mode");
	} finally {
		session.dispose();
	}
});
