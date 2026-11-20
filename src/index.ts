import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { NvimEditor } from "./editor.ts";

export default function piNvimMode(pi: ExtensionAPI) {
	let editor: NvimEditor | undefined;
	let enabled = true;
	let failed = false;

	const disposeEditor = () => {
		editor?.dispose();
		editor = undefined;
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const { config, error } = loadConfig();
		if (error) ctx.ui.notify(error, "warning");

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// pi may rebuild the editor (e.g. on reload); only one nvim should be alive at a time.
			disposeEditor();
			const created = new NvimEditor(tui, theme, keybindings, {
				config,
				cwd: ctx.cwd,
				theme: () => ctx.ui.theme,
				onFatal: (reason) => {
					failed = true;
					ctx.ui.notify(`pi-nvim-mode: ${reason}; using the default editor`, "error");
					if (editor === created) {
						const text = created.getText();
						editor = undefined;
						ctx.ui.setEditorComponent(undefined);
						ctx.ui.setEditorText(text);
					}
				},
			});
			editor = created;
			return created;
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled && !failed) install(ctx);
	});

	pi.on("session_shutdown", () => {
		disposeEditor();
	});

	pi.registerCommand("nvim-mode", {
		description: "Toggle the embedded Neovim prompt editor",
		handler: async (_args, ctx) => {
			if (enabled && editor) {
				enabled = false;
				const text = editor.getText();
				disposeEditor();
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.setEditorText(text);
				ctx.ui.notify("nvim mode off", "info");
			} else {
				enabled = true;
				failed = false;
				const text = ctx.ui.getEditorText();
				install(ctx);
				if (text) ctx.ui.setEditorText(text);
				ctx.ui.notify("nvim mode on", "info");
			}
		},
	});
}
