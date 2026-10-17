import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input, SelectList, fuzzyFilter, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth,
	type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import type { SavedPrompt } from "./store.ts";

export type MenuAction =
	| { kind: "save"; query: string }
	| { kind: "load" | "edit" | "delete"; prompt: SavedPrompt; query: string };

/** Display stored text as text, never as terminal instructions. */
export function displayText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export class PocketMenu implements Component, Focusable {
	private readonly input = new Input({ prompt: "Search: ", placeholder: "title or prompt text" });
	private list!: SelectList;
	private listRows = 0;
	private _focused = false;
	private readonly prompts: SavedPrompt[];
	private readonly canSave: boolean;
	private readonly theme: Pick<Theme, "fg">;
	private readonly tui: TUI;
	private readonly keys: Pick<KeybindingsManager, "matches">;
	private readonly done: (action: MenuAction | undefined) => void;

	constructor(
		prompts: SavedPrompt[], canSave: boolean, theme: Pick<Theme, "fg">, tui: TUI,
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

	private rebuild(selected?: string): void {
		const query = this.input.getValue();
		const items = fuzzyFilter(this.prompts, query, (p) => `${p.title}\n${p.body}`).map((p) => ({
			value: p.id, label: displayText(p.title),
		}));
		if (this.canSave) items.unshift({ value: "", label: "+ Save current draft…" });
		this.listRows = Math.max(1, Math.min(8, this.tui.terminal.rows - 12));
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
		if (this.listRows !== Math.max(1, Math.min(8, this.tui.terminal.rows - 12))) {
			this.rebuild(this.list.getSelectedItem()?.value);
		}
		const prompt = this.prompts.find((p) => p.id === this.list.getSelectedItem()?.value);
		const preview = prompt
			? prompt.body.split(/\r?\n/).filter((line) => line.trim()).slice(0, 2).map(displayText)
			: [this.canSave ? "Save the editor text without sending or clearing it." : "Write a draft to save it here."];
		const hints = `${this.canSave ? "Ctrl+S save · " : ""}↑↓ choose · Enter load · F2 edit · Ctrl+D delete · Esc back`;
		return [
			this.theme.fg("accent", "─".repeat(Math.max(0, width))),
			this.theme.fg("accent", `Prompt Pocket · ${this.prompts.length} saved`),
			...this.input.render(Math.max(1, width)),
			...this.list.render(Math.max(1, width)),
			"",
			...preview.map((s) => this.theme.fg("muted", s)),
			this.theme.fg("dim", hints),
			this.theme.fg("accent", "─".repeat(Math.max(0, width))),
		].map((line) => {
			const clipped = truncateToWidth(line, Math.max(1, width));
			return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		});
	}

	invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
