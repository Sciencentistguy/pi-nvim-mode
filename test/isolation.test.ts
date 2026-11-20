import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { NvimSession } from "../src/session.ts";

const HOSTILE = `
vim.g.pi_nvim_mode_pwned = (vim.g.pi_nvim_mode_pwned or "") .. "${"${SOURCE}"} "
vim.keymap.set("i", "jk", "<Esc>")
vim.o.expandtab = false
`;

let root: string;
const saved: Record<string, string | undefined> = {};

function plant(dir: string, file: string, label: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), HOSTILE.replace("${SOURCE}", label));
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "pi-nvim-mode-test-"));
	const config = join(root, "config");
	const data = join(root, "data");
	for (const app of ["nvim", "pi-nvim-mode"]) {
		plant(join(config, app), "init.lua", `${app}/init.lua`);
		plant(join(config, app, "plugin"), "evil.lua", `${app}/plugin`);
		plant(join(config, app, "after", "plugin"), "evil.lua", `${app}/after`);
		plant(join(data, app, "site", "plugin"), "evil.lua", `${app}/site`);
		plant(join(data, app, "site", "pack", "x", "start", "evil", "plugin"), "evil.lua", `${app}/pack`);
	}
	plant(join(root, "sysconfig", "pi-nvim-mode", "plugin"), "evil.lua", "xdg-config-dirs");
	plant(root, "exrc.lua", "exrc");
	writeFileSync(join(root, ".nvim.lua"), HOSTILE.replace("${SOURCE}", ".nvim.lua"));

	const env = {
		HOME: root,
		XDG_CONFIG_HOME: config,
		XDG_DATA_HOME: data,
		XDG_CONFIG_DIRS: join(root, "sysconfig"),
		VIMINIT: `lua vim.g.pi_nvim_mode_pwned = "VIMINIT"`,
		NVIM_APPNAME: "nvim",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
});

after(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

function startSession(init?: string): Promise<NvimSession> {
	return new Promise((resolve, reject) => {
		const session: NvimSession = new NvimSession({
			command: process.env.PI_NVIM_BIN ?? "nvim",
			cwd: root,
			init,
			startInInsert: false,
			width: 80,
			height: 10,
			onUpdate: () => {},
			onSubmit: () => {},
			onFatal: reject,
		});
		session.getMode().then(() => resolve(session), reject);
	});
}

test("user configuration, plugins, VIMINIT and exrc are never loaded", async () => {
	const session = await startSession();
	try {
		const result = await session.exec<{ pwned: unknown; jk: string; expandtab: boolean; scripts: string[]; rtp: string }>(
			`return {
				pwned = vim.g.pi_nvim_mode_pwned or vim.NIL,
				jk = vim.fn.maparg("jk", "i"),
				expandtab = vim.o.expandtab,
				scripts = vim.tbl_map(function(s) return s.name end, vim.fn.getscriptinfo()),
				rtp = vim.o.runtimepath,
			}`,
		);
		assert.ok(result);
		assert.equal(result.pwned, null);
		assert.equal(result.jk, "");
		assert.equal(result.expandtab, true);
		for (const script of result.scripts) assert.ok(!script.startsWith(root), `loaded ${script}`);
		for (const path of result.rtp.split(",")) assert.ok(!path.startsWith(root), `runtimepath has ${path}`);
	} finally {
		session.dispose();
	}
});

test("the opt-in init file is the only user config that runs", async () => {
	const init = join(root, "opt-in.lua");
	writeFileSync(init, `vim.g.pi_nvim_mode_opt_in = true`);
	const session = await startSession(init);
	try {
		const result = await session.exec<[boolean, unknown]>(
			"return { vim.g.pi_nvim_mode_opt_in == true, vim.g.pi_nvim_mode_pwned or vim.NIL }",
		);
		assert.deepEqual(result, [true, null]);
	} finally {
		session.dispose();
	}
});

test("editing round-trips through nvim", async () => {
	const session = await startSession();
	try {
		session.input("ihello wörld<Esc>0dw");
		await session.refresh();
		assert.deepEqual(session.state.lines, ["wörld"]);
		assert.equal(session.state.mode, "n");
		session.setText("one\ntwo", { cursor: { row: 1, col: 1 } });
		session.input("yyP");
		await session.refresh();
		assert.equal(session.text, "one\ntwo\ntwo");
	} finally {
		session.dispose();
	}
});
