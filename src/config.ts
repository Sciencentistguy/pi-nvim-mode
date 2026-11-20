import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NvimModeConfig {
	/** Neovim executable. */
	nvim: string;
	/**
	 * Optional Lua file sourced after the built-in setup. This is the only way user
	 * configuration reaches the embedded nvim; the regular init.lua is never read.
	 */
	init?: string;
	/**
	 * Keys (pi key ids such as "ctrl+x") that go to nvim instead of pi's app actions,
	 * per mode group. Keys not listed keep their pi behaviour when bound to an app action.
	 */
	nvimKeys: {
		normal: string[];
		insert: string[];
	};
	/** Whether Enter in normal mode submits the prompt (otherwise it goes to nvim). */
	submitInNormal: boolean;
	/** Start each prompt in insert mode. */
	startInInsert: boolean;
}

export const CONFIG_DIR = join(homedir(), ".pi", "agent", "nvim-mode");

const DEFAULTS: NvimModeConfig = {
	nvim: "nvim",
	nvimKeys: {
		// Visual block, decrement, increment, redo.
		normal: ["ctrl+v", "ctrl+x", "ctrl+a", "ctrl+r"],
		insert: ["ctrl+r"],
	},
	submitInNormal: true,
	startInInsert: true,
};

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function loadConfig(): { config: NvimModeConfig; error?: string } {
	const config: NvimModeConfig = structuredClone(DEFAULTS);
	const defaultInit = join(CONFIG_DIR, "init.lua");
	if (existsSync(defaultInit)) config.init = defaultInit;

	const file = join(CONFIG_DIR, "config.json");
	let error: string | undefined;
	if (existsSync(file)) {
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<NvimModeConfig>;
			if (typeof raw.nvim === "string") config.nvim = expandHome(raw.nvim);
			if (typeof raw.init === "string") config.init = expandHome(raw.init);
			if (typeof raw.submitInNormal === "boolean") config.submitInNormal = raw.submitInNormal;
			if (typeof raw.startInInsert === "boolean") config.startInInsert = raw.startInInsert;
			if (raw.nvimKeys && typeof raw.nvimKeys === "object") {
				if (Array.isArray(raw.nvimKeys.normal)) config.nvimKeys.normal = raw.nvimKeys.normal.map(String);
				if (Array.isArray(raw.nvimKeys.insert)) config.nvimKeys.insert = raw.nvimKeys.insert.map(String);
			}
		} catch (err) {
			error = `pi-nvim-mode: invalid ${file}: ${(err as Error).message}`;
		}
	}

	if (process.env.PI_NVIM_BIN) config.nvim = expandHome(process.env.PI_NVIM_BIN);
	return { config, error };
}
