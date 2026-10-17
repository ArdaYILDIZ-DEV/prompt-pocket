import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MENU_OVERLAY_OPTIONS, PocketMenu, displayText, type MenuAction } from "./menu.ts";
import { PromptStore, parseDocument, type SavedPrompt } from "./store.ts";

export const SHORTCUT = "ctrl+alt+p";

function report(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(displayText(error instanceof Error ? error.message : "Prompt Pocket operation failed."), "error");
}

async function editPrompt(ctx: ExtensionContext, store: PromptStore, prompt: SavedPrompt): Promise<void> {
	let document = store.read(prompt).raw;
	for (;;) {
		const edited = await ctx.ui.editor("Edit saved prompt — # Title, blank line, prompt text", document);
		if (edited === undefined) return;
		document = edited;
		try {
			const { title, body } = parseDocument(document);
			store.update(prompt, title, body);
			ctx.ui.notify("Prompt updated.", "info");
			return;
		} catch (error) {
			report(ctx, error);
			ctx.ui.notify("Edits are kept in the next dialog. Fix the document, or copy your edits before cancelling.", "warning");
		}
	}
}

/** No editor writes except an explicitly confirmed load; dialogs preserve the draft. */
export async function openPocket(ctx: ExtensionContext, store: PromptStore): Promise<void> {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Prompt Pocket requires Pi's interactive terminal UI.", "warning");
		return;
	}
	let query = "";
	for (;;) {
		let action: MenuAction | undefined;
		try {
			const { prompts, warnings } = store.list();
			if (warnings.length) ctx.ui.notify(displayText(warnings.join("\n")), "warning");
			prompts.sort((a, b) => b.modified - a.modified || a.title.localeCompare(b.title));
			const draft = ctx.ui.getEditorText();
			// Non-overlay custom dialogs restore collapsed text with setText(), losing Pi's paste map.
			// An overlay leaves the underlying editor, cursor, undo and large pastes untouched.
			action = await ctx.ui.custom<MenuAction | undefined>((tui, theme, keys, done) =>
				new PocketMenu(prompts, !!draft.trim(), theme, tui, keys, done, query),
				{ overlay: true, overlayOptions: MENU_OVERLAY_OPTIONS });
			if (!action) return;
			query = action.query;
			if (action.kind === "save") {
				const title = await ctx.ui.input("Save prompt — title (1–160 characters)");
				if (title === undefined) continue;
				store.create(title, draft);
				ctx.ui.notify("Prompt saved. Your draft is unchanged.", "info");
				return;
			}
			if (action.kind === "edit") {
				await editPrompt(ctx, store, action.prompt);
				continue;
			}
			if (action.kind === "delete") {
				if (await ctx.ui.confirm("Delete saved prompt?", `Permanently delete “${displayText(action.prompt.title)}”?`)) {
					store.remove(action.prompt);
					ctx.ui.notify("Prompt deleted.", "info");
				}
				continue;
			}
			const prompt = store.read(action.prompt);
			const current = ctx.ui.getEditorText();
			if (current && current !== prompt.body &&
				!await ctx.ui.confirm("Replace current draft?", "The editor already contains text. Replace it with the saved prompt?")) continue;
			if (ctx.ui.getEditorText() !== current) throw new Error("The editor changed while the dialog was open. Nothing was replaced.");
			store.read(prompt);
			ctx.ui.setEditorText(prompt.body);
			ctx.ui.notify("Prompt loaded. Edit it before sending.", "info");
			return;
		} catch (error) {
			report(ctx, error);
			// Retry action errors, not a failed menu/list operation (which could spin forever).
			if (!action) return;
			try { store.list(); } catch { return; }
		}
	}
}

export default function promptPocket(pi: ExtensionAPI): void {
	const store = new PromptStore(join(getAgentDir(), "prompt-pocket"));
	let open = false;
	const show = async (ctx: ExtensionContext) => {
		if (open) return;
		open = true;
		try { await openPocket(ctx, store); }
		finally { open = false; }
	};
	pi.registerShortcut(SHORTCUT, { description: "Open Prompt Pocket", handler: show });
	pi.registerCommand("pocket", { description: "Save, find, edit or load a prompt", handler: (_args, ctx) => show(ctx) });
}
