// Test-only compatibility fixture; never included in the release package.
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
		}
	});
}
