import assert from "node:assert/strict";
import { test } from "node:test";
import { encode, ExtType, StreamDecoder } from "../src/msgpack.ts";

const roundTrip = (value: unknown) => new StreamDecoder().push(encode(value))[0];

test("round-trips scalars", () => {
	for (const v of [null, true, false, 0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32, -1, -32, -33, -128, -129, -40000, -(2 ** 31) - 1, 1.5]) {
		assert.deepEqual(roundTrip(v), v);
	}
});

test("round-trips strings of every length class", () => {
	for (const n of [0, 31, 32, 255, 256, 70000]) {
		const s = "é".repeat(n);
		assert.equal(roundTrip(s), s);
	}
});

test("round-trips nested arrays and maps", () => {
	const value = { a: [1, "two", { three: [null, false] }], b: Array.from({ length: 20 }, (_, i) => i) };
	assert.deepEqual(roundTrip(value), value);
});

test("decodes ext types (nvim Buffer/Window handles)", () => {
	const ext = new ExtType(0, new Uint8Array([1]));
	assert.deepEqual(roundTrip(ext), ext);
});

test("stream decoder handles values split across chunks", () => {
	const bytes = new Uint8Array([...encode([2, "redraw", [["flush"]]]), ...encode({ x: "y".repeat(300) })]);
	const decoder = new StreamDecoder();
	const out: unknown[] = [];
	for (let i = 0; i < bytes.length; i += 7) out.push(...decoder.push(bytes.slice(i, i + 7)));
	assert.deepEqual(out, [[2, "redraw", [["flush"]]], { x: "y".repeat(300) }]);
});
