// Offline TUI test commands; never included in the release package.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("pocket-test-draft", {
		description: "Set the isolated test draft without bracketed paste collapsing",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText(readFileSync(join(process.cwd(), "draft-input.txt"), "utf8"));
			ctx.ui.notify("Fixture draft ready", "info");
		},
	});
	pi.registerShortcut("ctrl+alt+y", {
		description: "Snapshot the isolated editor for preservation assertions",
		handler: async (ctx) => {
			writeFileSync(join(process.cwd(), "draft-output.txt"), ctx.ui.getEditorText());
		},
	});
}
