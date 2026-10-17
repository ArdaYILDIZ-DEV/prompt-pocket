import { type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box, Input, SelectList, Text, fuzzyFilter, matchesKey, stripTerminalSequences, truncateToWidth,
	type Component, type Focusable, type OverlayOptions, type TUI,
} from "@earendil-works/pi-tui";
import type { SavedPrompt } from "./store.ts";

export type MenuAction =
	| { kind: "save"; query: string }
	| { kind: "load" | "edit" | "delete"; prompt: SavedPrompt; query: string };

/** Display stored text as text, never as terminal instructions. */
export function displayText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Pi owns screen-relative placement and clamps this reading width on small terminals. */
export const MENU_OVERLAY_OPTIONS = {
	anchor: "center", width: 84, maxHeight: "100%",
} satisfies OverlayOptions;

export class PocketMenu implements Component, Focusable {
	private readonly input = new Input({ prompt: "Search: ", placeholder: "title or prompt text" });
	private list!: SelectList;
	private listRows = 0;
	private _focused = false;
	private readonly prompts: SavedPrompt[];
	private readonly canSave: boolean;
	private readonly theme: Pick<Theme, "fg" | "bg">;
	private readonly tui: TUI;
	private readonly keys: Pick<KeybindingsManager, "matches">;
	private readonly done: (action: MenuAction | undefined) => void;

	constructor(
		prompts: SavedPrompt[], canSave: boolean, theme: Pick<Theme, "fg" | "bg">, tui: TUI,
		keys: Pick<KeybindingsManager, "matches">, done: (action: MenuAction | undefined) => void, query = "",
	) {
		this.prompts = prompts;
		this.canSave = canSave;
		this.theme = theme;
		this.tui = tui;
		this.keys = keys;
		this.done = done;
		this.input.setValue(query);
		this.rebuild();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }

	private rebuild(selected?: string, rows = this.listRows || 8): void {
		const query = this.input.getValue();
		const items = fuzzyFilter(this.prompts, query, (p) => `${p.title}\n${p.body}`).map((p) => ({
			value: p.id, label: displayText(p.title),
		}));
		if (this.canSave) items.unshift({ value: "", label: "+ Save current draft…" });
		this.listRows = rows;
		this.list = new SelectList(items, this.listRows, {
			selectedPrefix: (s) => this.theme.fg("accent", s),
			selectedText: (s) => this.theme.fg("accent", s),
			description: (s) => this.theme.fg("muted", s),
			scrollInfo: (s) => this.theme.fg("dim", s),
			noMatch: (s) => this.theme.fg("dim", s),
		});
		const index = selected === undefined ? -1 : items.findIndex((i) => i.value === selected);
		this.list.setSelectedIndex(index >= 0 ? index : this.canSave && query && items.length > 1 ? 1 : 0);
		this.list.onSelect = () => this.choose("load");
		this.list.onCancel = () => this.done(undefined);
	}

	private choose(kind: "load" | "edit" | "delete"): void {
		const id = this.list.getSelectedItem()?.value;
		if (id === undefined) return;
		const query = this.input.getValue();
		if (id === "") {
			if (kind === "load") this.done({ kind: "save", query });
			return;
		}
		const prompt = this.prompts.find((p) => p.id === id);
		if (prompt) this.done({ kind, prompt, query });
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) this.done(undefined);
		else if (matchesKey(data, "ctrl+s")) {
			if (this.canSave) this.done({ kind: "save", query: this.input.getValue() });
		} else if (matchesKey(data, "f2")) this.choose("edit");
		else if (matchesKey(data, "ctrl+d")) this.choose("delete");
		else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down") ||
			this.keys.matches(data, "tui.select.confirm")) this.list.handleInput(data);
		else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (before !== this.input.getValue()) this.rebuild();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		// Budget the WHOLE panel, not just the list: maxHeight clips, it does not reflow.
		// Reserved list/preview space keeps the native centered anchor still while searching.
		const height = Math.max(1, Math.min(20, this.tui.terminal.rows));
		const padding = width >= 16 ? 1 : 0;
		const bordered = height >= 7 && width >= 4;
		const innerWidth = Math.max(1, width - padding * 2 - (bordered ? 2 : 0));
		const heading = height >= 4;
		const selected = this.list.getSelectedItem()?.value;
		const enter = selected === "" ? "save" : "load";
		const hints = innerWidth >= 38
			? `↑↓ choose · Enter ${enter} · Esc back\n${this.canSave ? "Ctrl+S save · " : ""}F2 edit · Ctrl+D delete`
			: `↑↓ Enter · Esc back\n${this.canSave ? "Ctrl+S · " : ""}F2 · Ctrl+D`;
		// Leave at least two rows for results before wrapping shortcut help.
		const help = height >= 7
			? new Text(this.theme.fg("dim", hints), 0, 0).render(innerWidth)
				.slice(0, Math.max(1, height - 6))
			: height >= 5 ? [this.theme.fg("dim", "Esc back")] : [];
		const available = height - (bordered ? 2 : 0) - (heading ? 1 : 0) - 1 - help.length;
		const previewRows = available >= 9 ? 4 : available >= 6 ? 2 : 0;
		const listSpace = Math.max(0, available - previewRows);
		// SelectList adds its own scroll-status row when necessary.
		const rows = Math.max(1, Math.min(8, listSpace - 1));
		if (rows !== this.listRows) this.rebuild(selected, rows);
		const prompt = this.prompts.find((p) => p.id === this.list.getSelectedItem()?.value);
		const listLines = this.list.getSelectedItem()
			? this.list.render(innerWidth).slice(0, listSpace)
			: [this.theme.fg("muted", this.prompts.length ? "No prompts match." : "No saved prompts yet.")].slice(0, listSpace);
		while (listLines.length < listSpace) listLines.push("");
		const preview: string[] = [];
		if (previewRows) {
			preview.push(this.theme.fg("dim", prompt ? "Preview" : selected === "" ? "Current draft" : "Library"));
			// Bound display work even for a multi-megabyte saved prompt. Never change stored text.
			const body = prompt
				? prompt.body.slice(0, 2000).split(/\r?\n/).map(displayText).join("\n").trim()
				: selected === "" ? "Save the editor text without sending or clearing it."
				: this.prompts.length ? "Try another title or phrase from the prompt." : "Write a draft to save it here.";
			const wrapped = new Text(this.theme.fg("muted", body), 0, 0).render(innerWidth);
			preview.push(...wrapped.slice(0, previewRows - 1));
			if (wrapped.length > previewRows - 1) {
				preview[preview.length - 1] = truncateToWidth(`${preview.at(-1)} …`, innerWidth);
			}
			while (preview.length < previewRows) preview.push("");
		}
		const lines = [
			...(heading ? [this.theme.fg("accent", `Prompt Pocket · ${this.prompts.length} saved`)] : []),
			...this.input.render(innerWidth),
			...listLines,
			...preview,
			...help,
		];
		const pad = " ".repeat(padding);
		const content = lines.map((line) => `${pad}${truncateToWidth(line, innerWidth, "…", true)}${pad}`);
		const border = (text: string) => this.theme.fg("accent", text);
		const framed = bordered ? [
			border(`╭${"─".repeat(width - 2)}╮`),
			...content.map((line) => `${border("│")}${line}${border("│")}`),
			border(`╰${"─".repeat(width - 2)}╯`),
		] : content;
		// Box paints the entire surface, including the frame; no draft can bleed through it.
		const panel = new Box(0, 0, (text) => this.theme.bg("customMessageBg", text));
		panel.addChild({ render: () => framed, invalidate: () => {} });
		return panel.render(width);
	}

	invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
