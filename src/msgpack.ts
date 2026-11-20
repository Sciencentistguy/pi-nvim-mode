/**
 * Minimal MessagePack codec covering what Neovim's RPC protocol uses.
 * Kept dependency-free so the extension installs without npm.
 */

export class ExtType {
	readonly type: number;
	readonly data: Uint8Array;

	constructor(type: number, data: Uint8Array) {
		this.type = type;
		this.data = data;
	}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class Writer {
	private buf = new Uint8Array(256);
	private view = new DataView(this.buf.buffer);
	private pos = 0;

	private ensure(n: number): void {
		if (this.pos + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.pos + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.pos));
		this.buf = next;
		this.view = new DataView(next.buffer);
	}

	u8(v: number): void {
		this.ensure(1);
		this.view.setUint8(this.pos, v);
		this.pos += 1;
	}

	u16(v: number): void {
		this.ensure(2);
		this.view.setUint16(this.pos, v);
		this.pos += 2;
	}

	u32(v: number): void {
		this.ensure(4);
		this.view.setUint32(this.pos, v);
		this.pos += 4;
	}

	i8(v: number): void {
		this.ensure(1);
		this.view.setInt8(this.pos, v);
		this.pos += 1;
	}

	i16(v: number): void {
		this.ensure(2);
		this.view.setInt16(this.pos, v);
		this.pos += 2;
	}

	i32(v: number): void {
		this.ensure(4);
		this.view.setInt32(this.pos, v);
		this.pos += 4;
	}

	i64(v: bigint): void {
		this.ensure(8);
		this.view.setBigInt64(this.pos, v);
		this.pos += 8;
	}

	u64(v: bigint): void {
		this.ensure(8);
		this.view.setBigUint64(this.pos, v);
		this.pos += 8;
	}

	f64(v: number): void {
		this.ensure(8);
		this.view.setFloat64(this.pos, v);
		this.pos += 8;
	}

	bytes(b: Uint8Array): void {
		this.ensure(b.length);
		this.buf.set(b, this.pos);
		this.pos += b.length;
	}

	result(): Uint8Array {
		return this.buf.slice(0, this.pos);
	}
}

function encodeInto(w: Writer, value: unknown): void {
	if (value === null || value === undefined) {
		w.u8(0xc0);
	} else if (value === false) {
		w.u8(0xc2);
	} else if (value === true) {
		w.u8(0xc3);
	} else if (typeof value === "number") {
		encodeNumber(w, value);
	} else if (typeof value === "bigint") {
		if (value >= 0n) {
			w.u8(0xcf);
			w.u64(value);
		} else {
			w.u8(0xd3);
			w.i64(value);
		}
	} else if (typeof value === "string") {
		const bytes = textEncoder.encode(value);
		const n = bytes.length;
		if (n < 32) w.u8(0xa0 | n);
		else if (n < 0x100) {
			w.u8(0xd9);
			w.u8(n);
		} else if (n < 0x10000) {
			w.u8(0xda);
			w.u16(n);
		} else {
			w.u8(0xdb);
			w.u32(n);
		}
		w.bytes(bytes);
	} else if (value instanceof Uint8Array) {
		const n = value.length;
		if (n < 0x100) {
			w.u8(0xc4);
			w.u8(n);
		} else if (n < 0x10000) {
			w.u8(0xc5);
			w.u16(n);
		} else {
			w.u8(0xc6);
			w.u32(n);
		}
		w.bytes(value);
	} else if (value instanceof ExtType) {
		const n = value.data.length;
		if (n === 1) w.u8(0xd4);
		else if (n === 2) w.u8(0xd5);
		else if (n === 4) w.u8(0xd6);
		else if (n === 8) w.u8(0xd7);
		else if (n === 16) w.u8(0xd8);
		else if (n < 0x100) {
			w.u8(0xc7);
			w.u8(n);
		} else if (n < 0x10000) {
			w.u8(0xc8);
			w.u16(n);
		} else {
			w.u8(0xc9);
			w.u32(n);
		}
		w.i8(value.type);
		w.bytes(value.data);
	} else if (Array.isArray(value)) {
		const n = value.length;
		if (n < 16) w.u8(0x90 | n);
		else if (n < 0x10000) {
			w.u8(0xdc);
			w.u16(n);
		} else {
			w.u8(0xdd);
			w.u32(n);
		}
		for (const item of value) encodeInto(w, item);
	} else if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		const n = entries.length;
		if (n < 16) w.u8(0x80 | n);
		else if (n < 0x10000) {
			w.u8(0xde);
			w.u16(n);
		} else {
			w.u8(0xdf);
			w.u32(n);
		}
		for (const [k, v] of entries) {
			encodeInto(w, k);
			encodeInto(w, v);
		}
	} else {
		throw new TypeError(`msgpack: cannot encode ${typeof value}`);
	}
}

function encodeNumber(w: Writer, v: number): void {
	if (!Number.isInteger(v)) {
		w.u8(0xcb);
		w.f64(v);
	} else if (v >= 0) {
		if (v < 0x80) w.u8(v);
		else if (v < 0x100) {
			w.u8(0xcc);
			w.u8(v);
		} else if (v < 0x10000) {
			w.u8(0xcd);
			w.u16(v);
		} else if (v < 0x100000000) {
			w.u8(0xce);
			w.u32(v);
		} else {
			w.u8(0xcf);
			w.u64(BigInt(v));
		}
	} else if (v >= -32) {
		w.i8(v);
	} else if (v >= -0x80) {
		w.u8(0xd0);
		w.i8(v);
	} else if (v >= -0x8000) {
		w.u8(0xd1);
		w.i16(v);
	} else if (v >= -0x80000000) {
		w.u8(0xd2);
		w.i32(v);
	} else {
		w.u8(0xd3);
		w.i64(BigInt(v));
	}
}

export function encode(value: unknown): Uint8Array {
	const w = new Writer();
	encodeInto(w, value);
	return w.result();
}

/** Thrown internally when the buffer ends mid-value; the stream decoder waits for more data. */
class Incomplete extends Error {}

class Reader {
	pos = 0;
	private readonly view: DataView;
	private readonly buf: Uint8Array;

	constructor(buf: Uint8Array) {
		this.buf = buf;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	private need(n: number): void {
		if (this.pos + n > this.buf.length) throw new Incomplete();
	}

	u8(): number {
		this.need(1);
		return this.view.getUint8(this.pos++);
	}

	u16(): number {
		this.need(2);
		const v = this.view.getUint16(this.pos);
		this.pos += 2;
		return v;
	}

	u32(): number {
		this.need(4);
		const v = this.view.getUint32(this.pos);
		this.pos += 4;
		return v;
	}

	i8(): number {
		this.need(1);
		return this.view.getInt8(this.pos++);
	}

	i16(): number {
		this.need(2);
		const v = this.view.getInt16(this.pos);
		this.pos += 2;
		return v;
	}

	i32(): number {
		this.need(4);
		const v = this.view.getInt32(this.pos);
		this.pos += 4;
		return v;
	}

	u64(): number {
		this.need(8);
		const v = this.view.getBigUint64(this.pos);
		this.pos += 8;
		return Number(v);
	}

	i64(): number {
		this.need(8);
		const v = this.view.getBigInt64(this.pos);
		this.pos += 8;
		return Number(v);
	}

	f32(): number {
		this.need(4);
		const v = this.view.getFloat32(this.pos);
		this.pos += 4;
		return v;
	}

	f64(): number {
		this.need(8);
		const v = this.view.getFloat64(this.pos);
		this.pos += 8;
		return v;
	}

	bytes(n: number): Uint8Array {
		this.need(n);
		const b = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return b;
	}

	str(n: number): string {
		return textDecoder.decode(this.bytes(n));
	}

	value(): unknown {
		const t = this.u8();
		if (t < 0x80) return t;
		if (t < 0x90) return this.map(t & 0x0f);
		if (t < 0xa0) return this.array(t & 0x0f);
		if (t < 0xc0) return this.str(t & 0x1f);
		if (t >= 0xe0) return t - 0x100;
		switch (t) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return this.bytes(this.u8()).slice();
			case 0xc5:
				return this.bytes(this.u16()).slice();
			case 0xc6:
				return this.bytes(this.u32()).slice();
			case 0xc7:
				return this.ext(this.u8());
			case 0xc8:
				return this.ext(this.u16());
			case 0xc9:
				return this.ext(this.u32());
			case 0xca:
				return this.f32();
			case 0xcb:
				return this.f64();
			case 0xcc:
				return this.u8();
			case 0xcd:
				return this.u16();
			case 0xce:
				return this.u32();
			case 0xcf:
				return this.u64();
			case 0xd0:
				return this.i8();
			case 0xd1:
				return this.i16();
			case 0xd2:
				return this.i32();
			case 0xd3:
				return this.i64();
			case 0xd4:
				return this.ext(1);
			case 0xd5:
				return this.ext(2);
			case 0xd6:
				return this.ext(4);
			case 0xd7:
				return this.ext(8);
			case 0xd8:
				return this.ext(16);
			case 0xd9:
				return this.str(this.u8());
			case 0xda:
				return this.str(this.u16());
			case 0xdb:
				return this.str(this.u32());
			case 0xdc:
				return this.array(this.u16());
			case 0xdd:
				return this.array(this.u32());
			case 0xde:
				return this.map(this.u16());
			case 0xdf:
				return this.map(this.u32());
			default:
				throw new Error(`msgpack: invalid type byte 0x${t.toString(16)}`);
		}
	}

	private array(n: number): unknown[] {
		const out = new Array<unknown>(n);
		for (let i = 0; i < n; i++) out[i] = this.value();
		return out;
	}

	private map(n: number): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (let i = 0; i < n; i++) {
			const k = this.value();
			out[String(k)] = this.value();
		}
		return out;
	}

	private ext(n: number): ExtType {
		const type = this.i8();
		return new ExtType(type, this.bytes(n).slice());
	}
}

/** Incrementally decodes a stream of concatenated msgpack values. */
export class StreamDecoder {
	private pending: Uint8Array = new Uint8Array(0);

	push(chunk: Uint8Array): unknown[] {
		if (this.pending.length === 0) {
			this.pending = chunk;
		} else {
			const merged = new Uint8Array(this.pending.length + chunk.length);
			merged.set(this.pending);
			merged.set(chunk, this.pending.length);
			this.pending = merged;
		}

		const values: unknown[] = [];
		const reader = new Reader(this.pending);
		while (reader.pos < this.pending.length) {
			const start = reader.pos;
			try {
				values.push(reader.value());
			} catch (err) {
				if (err instanceof Incomplete) {
					reader.pos = start;
					break;
				}
				throw err;
			}
		}
		this.pending = this.pending.slice(reader.pos);
		return values;
	}
}
