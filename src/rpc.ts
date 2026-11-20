import { type ChildProcess, spawn } from "node:child_process";
import { encode, StreamDecoder } from "./msgpack.ts";

const REQUEST = 0;
const RESPONSE = 1;
const NOTIFICATION = 2;

/** Called synchronously, in wire order relative to notifications. */
export type ResponseCallback = (error: Error | undefined, result: unknown) => void;

export type NotificationHandler = (method: string, params: unknown[]) => void;

export interface SpawnOptions {
	/** Neovim executable. */
	command: string;
	cwd?: string;
	onNotification: NotificationHandler;
	onExit: (reason: string) => void;
}

/**
 * Environment variables that could make nvim load configuration or talk to
 * another nvim instance. They are stripped before spawning.
 */
const UNSAFE_ENV = ["VIMINIT", "EXINIT", "MYVIMRC", "NVIM", "NVIM_LISTEN_ADDRESS", "NVIM_LOG_FILE"];

/** Name used for NVIM_APPNAME so stdpath() never resolves to the user's directories. */
export const APP_NAME = "pi-nvim-mode";

/**
 * Arguments that start a pristine Neovim regardless of the user's setup:
 * - `--clean` skips init.lua/init.vim, user runtime dirs, plugins under stdpath(), and env-based init.
 * - `--clean` re-enables bundled plugins even with `--noplugin`, so `noloadplugins` is set via `--cmd`
 *   (which runs before plugin loading) to skip netrw, matchparen, editorconfig, etc.
 * - `-n` disables swap files, `-i NONE` disables shada.
 * - `--embed` speaks msgpack-rpc on stdio and waits for a UI to attach before starting.
 */
export const NVIM_ARGS = ["--embed", "--clean", "--cmd", "set noloadplugins", "-n", "-i", "NONE"];

export class NvimRpc {
	private readonly proc: ChildProcess;
	private readonly decoder = new StreamDecoder();
	private readonly pending = new Map<number, ResponseCallback>();
	private nextId = 1;
	private closed = false;
	private readonly onNotification: NotificationHandler;

	constructor(opts: SpawnOptions) {
		this.onNotification = opts.onNotification;

		const env: NodeJS.ProcessEnv = { ...process.env, NVIM_APPNAME: APP_NAME };
		for (const key of UNSAFE_ENV) delete env[key];

		this.proc = spawn(opts.command, NVIM_ARGS, {
			cwd: opts.cwd,
			env,
			stdio: ["pipe", "pipe", "ignore"],
		});

		this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
		this.proc.on("error", (err) => this.close(`failed to start ${opts.command}: ${err.message}`, opts.onExit));
		this.proc.on("exit", (code, signal) =>
			this.close(`nvim exited (${signal ?? `code ${code}`})`, opts.onExit),
		);
		this.proc.stdin!.on("error", () => {});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private close(reason: string, onExit: (reason: string) => void): void {
		if (this.closed) return;
		this.closed = true;
		for (const cb of this.pending.values()) cb(new Error(reason), undefined);
		this.pending.clear();
		onExit(reason);
	}

	private onData(chunk: Buffer): void {
		let messages: unknown[];
		try {
			messages = this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		} catch (err) {
			this.proc.kill();
			return;
		}
		for (const msg of messages) {
			if (!Array.isArray(msg)) continue;
			const kind = msg[0];
			if (kind === RESPONSE) {
				const [, id, error, result] = msg as [number, number, unknown, unknown];
				const cb = this.pending.get(id);
				if (!cb) continue;
				this.pending.delete(id);
				cb(error ? new Error(formatError(error)) : undefined, result);
			} else if (kind === NOTIFICATION) {
				const [, method, params] = msg as [number, string, unknown[]];
				this.onNotification(method, params);
			} else if (kind === REQUEST) {
				// We expose no methods; reply with an error so nvim never blocks on us.
				const [, id, method] = msg as [number, number, string];
				this.write([RESPONSE, id, `pi-nvim-mode: unknown method ${method}`, null]);
			}
		}
	}

	private write(message: unknown[]): void {
		if (this.closed) return;
		this.proc.stdin!.write(encode(message));
	}

	/** Send a request whose reply is delivered synchronously, before any later message. */
	send(method: string, params: unknown[], cb: ResponseCallback): void {
		if (this.closed) {
			cb(new Error("nvim is not running"), undefined);
			return;
		}
		const id = this.nextId++;
		this.pending.set(id, cb);
		this.write([REQUEST, id, method, params]);
	}

	request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.send(method, params, (err, result) => (err ? reject(err) : resolve(result as T)));
		});
	}

	notify(method: string, params: unknown[] = []): void {
		this.write([NOTIFICATION, method, params]);
	}

	kill(): void {
		if (this.closed) return;
		this.proc.stdin!.end();
		this.proc.kill();
	}
}

function formatError(error: unknown): string {
	if (Array.isArray(error) && typeof error[1] === "string") return error[1];
	return String(error);
}
