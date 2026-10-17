import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { temporaryDirectory } from "./temp.ts";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import promptPocket, { openPocket, SHORTCUT } from "../index.ts";
import type { MenuAction } from "../menu.ts";
import { PromptStore } from "../store.ts";

type Choice = MenuAction | undefined | (() => MenuAction | undefined);
function fixture(t: { after: (fn: () => void) => void }, draft = "") {
	const root = temporaryDirectory("workflow-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new PromptStore(join(root, "prompts"));
	const actions: Choice[] = [];
	const titles: (string | undefined)[] = [];
	const edits: (string | undefined)[] = [];
	const confirmations: (() => boolean)[] = [];
	const notices: string[] = [];
	const prefills: string[] = [];
	const writes: string[] = [];
	const menuOptions: unknown[] = [];
	let menuCount = 0;
	const state = { draft };
	const ctx = {
		hasUI: true, mode: "tui",
		ui: {
			getEditorText: () => state.draft,
			setEditorText: (text: string) => { writes.push(text); state.draft = text; },
			notify: (message: string) => { notices.push(message); },
			custom: async (_factory: unknown, options: unknown) => {
				menuOptions.push(options);
				assert.ok(++menuCount < 20, "workflow must not spin");
				const next = actions.shift();
				return typeof next === "function" ? next() : next;
			},
			input: async () => titles.shift(),
			editor: async (_title: string, prefill: string) => { prefills.push(prefill); return edits.shift(); },
			confirm: async () => confirmations.shift()?.() ?? false,
		},
	} as unknown as ExtensionContext;
	return { root, store, ctx, state, actions, titles, edits, confirmations, notices, prefills, writes, menuOptions };
}

test("saving captures the unsent draft verbatim with its chosen title and never writes the editor", async (t) => {
	const f = fixture(t, "  first line\r\n$1 and $ARGUMENTS\n\nlast  \n");
	f.actions.push({ kind: "save", query: "" });
	f.titles.push("  Araştırma 🐍  ");
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts[0].body, f.state.draft);
	assert.equal(f.store.list().prompts[0].title, "Araştırma 🐍");
	assert.deepEqual(f.writes, []);
	assert.match(f.notices.join(), /saved/);
	assert.deepEqual(f.menuOptions[0], { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
});

test("menu and title cancellation preserve draft and do not create a directory", async (t) => {
	const f = fixture(t, "unsent");
	f.actions.push({ kind: "save", query: "" }, undefined);
	f.titles.push(undefined);
	await openPocket(f.ctx, f.store);
	assert.equal(f.state.draft, "unsent");
	assert.deepEqual(readdirSync(f.root), []);
	assert.deepEqual(f.writes, []);
});

test("invalid title is reported, leaves draft unchanged, and does not create a record", async (t) => {
	const f = fixture(t, "valuable draft");
	f.actions.push({ kind: "save", query: "" }, undefined);
	f.titles.push(" \n ");
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts.length, 0);
	assert.match(f.notices.join(), /title/);
	assert.equal(f.state.draft, "valuable draft");
});

test("loading into an empty editor inserts literal content without sending it", async (t) => {
	const f = fixture(t);
	const prompt = f.store.create("Literal", "/review $1\n$ARGUMENTS\n");
	f.actions.push({ kind: "load", prompt, query: "literal" });
	await openPocket(f.ctx, f.store);
	assert.deepEqual(f.writes, [prompt.body]);
	assert.match(f.notices.join(), /Prompt loaded/); // Also schedules Pi's render after setEditorText().
});

test("loading over a nonempty draft requires approval and cancel is non-destructive", async (t) => {
	const f = fixture(t, "do not lose me");
	const prompt = f.store.create("Saved", "replacement");
	f.actions.push({ kind: "load", prompt, query: "" }, undefined);
	f.confirmations.push(() => false);
	await openPocket(f.ctx, f.store);
	assert.equal(f.state.draft, "do not lose me");
	assert.deepEqual(f.writes, []);
	f.actions.push({ kind: "load", prompt, query: "" });
	f.confirmations.push(() => true);
	await openPocket(f.ctx, f.store);
	assert.equal(f.state.draft, "replacement");
});

test("a draft changed during replacement confirmation is never overwritten", async (t) => {
	const f = fixture(t, "old draft");
	const prompt = f.store.create("Saved", "replacement");
	f.actions.push({ kind: "load", prompt, query: "" }, undefined);
	f.confirmations.push(() => { f.state.draft = "newer draft"; return true; });
	await openPocket(f.ctx, f.store);
	assert.equal(f.state.draft, "newer draft");
	assert.deepEqual(f.writes, []);
	assert.match(f.notices.join(), /editor changed/);
});

test("a saved prompt changed during confirmation is not loaded from stale data", async (t) => {
	const f = fixture(t, "draft");
	const prompt = f.store.create("Saved", "original");
	f.actions.push({ kind: "load", prompt, query: "" }, undefined);
	f.confirmations.push(() => { f.store.update(prompt, "Saved", "external change"); return true; });
	await openPocket(f.ctx, f.store);
	assert.equal(f.state.draft, "draft");
	assert.deepEqual(f.writes, []);
	assert.match(f.notices.join(), /conflict/);
});

test("editing changes title and text without touching the main draft", async (t) => {
	const f = fixture(t, "draft");
	const prompt = f.store.create("Before", "old body");
	f.actions.push({ kind: "edit", prompt, query: "before" }, undefined);
	f.edits.push("# After\n\nnew body\n");
	await openPocket(f.ctx, f.store);
	const saved = f.store.list().prompts[0];
	assert.equal(saved.id, prompt.id);
	assert.equal(saved.title, "After");
	assert.equal(saved.body, "new body\n");
	assert.equal(f.state.draft, "draft");
	assert.deepEqual(f.writes, []);
});

test("invalid edit is kept for correction rather than discarded", async (t) => {
	const f = fixture(t);
	const prompt = f.store.create("Before", "old body");
	f.actions.push({ kind: "edit", prompt, query: "" }, undefined);
	f.edits.push("broken document", "# Fixed\n\nrecovered");
	await openPocket(f.ctx, f.store);
	assert.deepEqual(f.prefills, [prompt.raw, "broken document"]);
	assert.equal(f.store.list().prompts[0].body, "recovered");
});

test("an edit conflict keeps the edited document available and protects external changes", async (t) => {
	const f = fixture(t);
	const prompt = f.store.create("Before", "old body");
	f.actions.push({ kind: "edit", prompt, query: "" }, undefined);
	f.edits.push("# Mine\n\nmy edits", undefined);
	const originalEditor = f.ctx.ui.editor;
	let first = true;
	f.ctx.ui.editor = async (title, prefill) => {
		if (first) { first = false; f.store.update(prompt, "External", "other work"); }
		return originalEditor(title, prefill);
	};
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts[0].title, "External");
	assert.deepEqual(f.prefills, [prompt.raw, "# Mine\n\nmy edits"]);
	assert.match(f.notices.join(), /conflict/);
});

test("delete cancellation preserves the file; approved delete leaves draft alone", async (t) => {
	const f = fixture(t, "draft");
	const prompt = f.store.create("Saved", "body");
	f.actions.push({ kind: "delete", prompt, query: "" }, undefined);
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts.length, 1);
	f.actions.push({ kind: "delete", prompt, query: "" }, undefined);
	f.confirmations.push(() => true);
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts.length, 0);
	assert.equal(f.state.draft, "draft");
});

test("delete confirmation cannot delete a concurrently edited file", async (t) => {
	const f = fixture(t);
	const prompt = f.store.create("Saved", "body");
	f.actions.push({ kind: "delete", prompt, query: "" }, undefined);
	f.confirmations.push(() => { f.store.update(prompt, "Changed", "new body"); return true; });
	await openPocket(f.ctx, f.store);
	assert.equal(f.store.list().prompts[0].body, "new body");
	assert.match(f.notices.join(), /conflict/);
});

test("filesystem failure is reported once, without a menu spin or editor write", async (t) => {
	const f = fixture(t, "draft");
	writeFileSync(join(f.root, "prompts"), "not a directory");
	await openPocket(f.ctx, f.store);
	assert.equal(f.notices.length, 1);
	assert.deepEqual(f.writes, []);
});

test("a failed menu dialog is reported once instead of reopening forever", async (t) => {
	const f = fixture(t, "valuable draft");
	let calls = 0;
	f.ctx.ui.custom = (async () => {
		if (++calls === 1) throw new Error("dialog unavailable");
		return undefined;
	}) as ExtensionUIContext["custom"];
	await openPocket(f.ctx, f.store);
	assert.equal(calls, 1);
	assert.deepEqual(f.notices, ["dialog unavailable"]);
	assert.equal(f.state.draft, "valuable draft");
	assert.deepEqual(f.writes, []);
});

test("non-TUI modes do not open UI or access storage", async (t) => {
	const f = fixture(t);
	const ctx = { ...f.ctx, hasUI: true, mode: "rpc" } as ExtensionContext;
	await openPocket(ctx, f.store);
	assert.match(f.notices.join(), /interactive/);
	assert.deepEqual(readdirSync(f.root), []);
});

test("headless calls do not require a UI object", async () => {
	await openPocket({ hasUI: false } as ExtensionContext, new PromptStore("/not-used"));
});

test("repeated shortcut presses cannot stack menus, and closing releases the guard", async (t) => {
	const f = fixture(t);
	const pending: ((result: undefined) => void)[] = [];
	f.ctx.ui.custom = (() => new Promise<undefined>((resolve) => pending.push(resolve))) as ExtensionUIContext["custom"];
	let handler: ((ctx: ExtensionContext) => void | Promise<void>) | undefined;
	const api: Partial<ExtensionAPI> = {
		registerShortcut: (_key, options) => { handler = options.handler; },
		registerCommand: () => {},
	};
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.root;
	try { promptPocket(api as ExtensionAPI); }
	finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	assert.ok(handler);
	const first = handler(f.ctx);
	await handler(f.ctx);
	assert.equal(pending.length, 1);
	pending.shift()!(undefined);
	await first;
	const second = handler(f.ctx);
	assert.equal(pending.length, 1);
	pending.shift()!(undefined);
	await second;
	assert.deepEqual(f.writes, []);
});

test("extension registers only its shortcut and one command, no tools or input hooks", () => {
	const shortcuts: string[] = [];
	const commands: string[] = [];
	const api = {
		registerShortcut: (key: string) => { shortcuts.push(key); },
		registerCommand: (name: string) => { commands.push(name); },
	} as unknown as ExtensionAPI;
	promptPocket(api);
	assert.deepEqual(shortcuts, [SHORTCUT]);
	assert.equal(SHORTCUT, "ctrl+alt+p");
	assert.deepEqual(commands, ["pocket"]);
});
