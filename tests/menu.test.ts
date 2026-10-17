import assert from "node:assert/strict";
import { test } from "node:test";
import { getKeybindings, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { PocketMenu, displayText, type MenuAction } from "../menu.ts";
import type { SavedPrompt } from "../store.ts";

const prompt = (id: string, title: string, body: string): SavedPrompt => ({ id, title, body, raw: `# ${title}\n\n${body}`, modified: 1 });
function menu(prompts: SavedPrompt[] = [], draft = false, query = "") {
	const terminal = { rows: 30 };
	const tui = { terminal, requestRender: () => {} } as unknown as TUI;
	const results: (MenuAction | undefined)[] = [];
	const component = new PocketMenu(prompts, draft, { fg: (_color, text) => text }, tui, getKeybindings(), (r) => results.push(r), query);
	return { component, results, terminal };
}

test("draft is the default action and Ctrl+S can save without navigating", () => {
	const f = menu([prompt("one.md", "One", "body")], true);
	f.component.handleInput("\r");
	assert.deepEqual(f.results, [{ kind: "save", query: "" }]);
	const g = menu([], true);
	g.component.handleInput("\x13");
	assert.equal(g.results[0]?.kind, "save");
});

test("empty editor opens a searchable library and cannot save an empty draft", () => {
	const f = menu();
	f.component.handleInput("\x13");
	f.component.handleInput("\r");
	assert.deepEqual(f.results, []);
	assert.match(f.component.render(80).join("\n"), /Write a draft/);
});

test("search matches body text and Enter loads the match instead of the save row", () => {
	const wanted = prompt("two.md", "Second", "unusual regression scenario");
	const f = menu([prompt("one.md", "First", "unrelated"), wanted], true);
	f.component.handleInput("regression");
	f.component.handleInput("\r");
	assert.deepEqual(f.results, [{ kind: "load", prompt: wanted, query: "regression" }]);
});

test("fuzzy search supports nonconsecutive letters and multiple tokens", () => {
	const wanted = prompt("two.md", "Release checklist", "check regression tests");
	const f = menu([prompt("one.md", "Other", "unrelated"), wanted], false, "rls regr");
	f.component.handleInput("\r");
	assert.equal(f.results[0]?.kind, "load");
	assert.ok(f.results[0] && "prompt" in f.results[0]);
	assert.equal(f.results[0].prompt.id, wanted.id);
});

test("keyboard navigation, edit, delete and cancellation are distinct actions", () => {
	const a = prompt("one.md", "First", "a");
	const b = prompt("two.md", "Second", "b");
	const f = menu([a, b]);
	f.component.handleInput("\x1b[B");
	f.component.handleInput("\x1bOQ");
	assert.deepEqual(f.results[0], { kind: "edit", prompt: b, query: "" });
	const g = menu([a]);
	g.component.handleInput("\x04");
	assert.deepEqual(g.results[0], { kind: "delete", prompt: a, query: "" });
	const h = menu([a]);
	h.component.handleInput("\x1b");
	assert.deepEqual(h.results, [undefined]);
});

test("no-match search cannot edit/delete/load an unrelated record", () => {
	const f = menu([prompt("one.md", "First", "abc")], false);
	f.component.handleInput("zzzzz");
	f.component.handleInput("\r");
	f.component.handleInput("\x04");
	f.component.handleInput("\x1bOQ");
	assert.deepEqual(f.results, []);
});

test("narrow terminals, wide characters and resizes never overflow line width", () => {
	const prompts = Array.from({ length: 30 }, (_, i) => prompt(`${i}.md`, `🐍 界 — kayıt ${i}`, "wide 🐍 界 text\nsecond line"));
	const f = menu(prompts, true);
	for (const rows of [30, 12, 5, 45]) {
		f.terminal.rows = rows;
		for (const width of [1, 8, 25, 80]) {
			for (const line of f.component.render(width)) assert.ok(visibleWidth(line) <= width, JSON.stringify({ width, line }));
		}
	}
});

test("resize keeps the selected prompt and focus propagates to native search input", () => {
	const a = prompt("one.md", "First", "a");
	const b = prompt("two.md", "Second", "b");
	const f = menu([a, b]);
	f.component.focused = true;
	assert.equal(f.component.focused, true);
	f.component.handleInput("\x1b[B");
	f.terminal.rows = 12;
	f.component.render(25);
	f.component.handleInput("\r");
	assert.deepEqual(f.results, [{ kind: "load", prompt: b, query: "" }]);
});

test("stored title and body cannot inject ANSI/OSC instructions into the menu", () => {
	const f = menu([prompt("one.md", "name\x1b[31m red", "\x1b]52;c;c2VjcmV0\x07text\x00\x1b[2J")]);
	const output = f.component.render(100).join("\n");
	// The native Input intentionally emits Pi cursor markers; stored text must not emit controls.
	const storedRows = f.component.render(100).filter((_line, index) => index !== 2).join("\n");
	assert.equal(stripTerminalSequences(storedRows), storedRows);
	assert.ok(!output.includes("\x1b[31m"));
	assert.ok(!output.includes("\x1b]52"));
	assert.ok(!output.includes("\x1b[2J"));
	assert.ok(!output.includes("\x00"));
	assert.ok(!output.includes("c2VjcmV0"));
	assert.equal(displayText("a\tb\r\nc"), "a b  c");
});
