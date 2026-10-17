// Real Pi TUI smoke test. No provider calls, personal settings or personal prompts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { temporaryDirectory } from "./temp.ts";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const project = resolve(import.meta.dirname, "..");
const cli = join(project, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const root = temporaryDirectory("tui-");
const socket = join(root, "tmux.sock");
const mode = process.argv[2] ?? "regular";
assert.ok(["regular", "fullscreen"].includes(mode));
const customEditor = process.argv.includes("--custom-editor");
const keepCaptures = process.argv.includes("--keep-captures");
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 10_000 });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const command = ["env", `PI_CODING_AGENT_DIR=${agentDir}`, "PI_OFFLINE=1", "timeout", "90s", process.execPath, cli,
	"--offline", "--no-extensions", "-e", join(project, "index.ts"), "-e", join(project, "tests/layout-fixture.ts"), "--no-skills", "--no-prompt-templates",
	"--no-context-files", "--no-themes", "--no-tools", "--no-session", "--tui-mode", mode,
	...(customEditor ? ["-e", join(project, "tests/custom-editor-fixture.ts")] : [])];
let pane;
let lastScreen = "";
const capture = () => tmux("capture-pane", "-p", "-J", "-t", pane);
const keys = (...values) => tmux("send-keys", "-t", pane, ...values);
const text = (value) => tmux("send-keys", "-t", pane, "-l", "--", value);
async function waitFor(pattern) {
	for (let i = 0; i < 120; i++) {
		lastScreen = capture();
		if (pattern.test(lastScreen)) return lastScreen;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${pattern}\n${lastScreen}`);
}
async function waitForFiles(check) {
	for (let i = 0; i < 120; i++) {
		if (check()) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for file change\n${capture()}`);
}
async function openMenu() {
	// ESC + Ctrl+P is the legacy terminal encoding for Ctrl+Alt+P.
	keys("Escape", "C-p");
	await waitFor(/Prompt Pocket/);
	await delay(100);
}
const directory = join(agentDir, "prompt-pocket");
const saved = () => readdirSync(directory).filter((name) => name.endsWith(".md"));
try {
	pane = tmux("-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "pocket-test", "-x", "110", "-y", "35", "-c", root, ...command).trim();
	console.log(`Isolated ${mode} Pi${customEditor ? " with CustomEditor" : ""}: socket=${socket}, session=pocket-test, cwd=${root}`);
	console.log(`Monitor: tmux -S ${quote(socket)} attach -t pocket-test`);
	await waitFor(/v1\.3\.0|coding agent|No models|tokens|claude|No API/i);
	await delay(500);
	text("Unique unsent pocket draft");
	await openMenu();
	keys("C-s");
	await waitFor(/Save prompt.*title/);
	text("Terminal smoke title");
	keys("Enter");
	await waitFor(/Prompt saved/);
	assert.equal(saved().length, 1);
	let file = join(directory, saved()[0]);
	assert.equal(readFileSync(file, "utf8"), "# Terminal smoke title\n\nUnique unsent pocket draft");
	assert.match(capture(), /Unique unsent pocket draft/);

	await openMenu();
	text("Unique");
	keys("F2");
	await waitFor(/Edit saved prompt/);
	text(" edited");
	keys("Enter");
	await waitFor(/Unique unsent pocket draft edited/);
	assert.equal(readFileSync(file, "utf8"), "# Terminal smoke title\n\nUnique unsent pocket draft edited");
	keys("Escape");
	await delay(150);

	await openMenu();
	text("edited");
	keys("Enter");
	await waitFor(/Replace current draft/);
	keys("Escape");
	await waitFor(/Prompt Pocket/);
	keys("Escape");
	await delay(150);
	assert.match(capture(), /Unique unsent pocket draft/);

	await openMenu();
	text("edited");
	keys("Enter");
	await waitFor(/Replace current draft/);
	keys("Enter");
	await waitFor(/Unique unsent pocket draft edited/);
	await delay(150);
	// A new menu shows the loaded body, but its save row must not be deleted.
	await openMenu();
	text("edited");
	keys("C-d");
	await waitFor(/Delete saved prompt/);
	keys("Escape");
	await waitFor(/Prompt Pocket/);
	assert.equal(saved().length, 1);
	keys("C-d");
	await waitFor(/Delete saved prompt/);
	keys("Enter");
	await waitForFiles(() => saved().length === 0);
	await waitFor(/Prompt Pocket/);
	assert.equal(saved().length, 0);
	keys("Escape");
	await delay(100);
	assert.match(capture(), /Unique unsent pocket draft edited/);
	assert.ok(!/Error loading extension|TypeError|Unhandled|API key required/i.test(capture()));

	keys("C-c");
	await delay(150);
	const large = Array.from({ length: 25 }, (_, i) => `Line ${i}: ${"large paste content ".repeat(12)}`).join("\n");
	tmux("set-buffer", "-b", "pocket", large);
	tmux("paste-buffer", "-b", "pocket", "-p", "-t", pane);
	await waitFor(/paste #/i);
	await openMenu();
	keys("Escape");
	await delay(150);
	await openMenu();
	keys("C-s");
	await waitFor(/Save prompt.*title/);
	text("Large paste preservation");
	keys("Enter");
	await waitForFiles(() => saved().length === 1);
	file = join(directory, saved()[0]);
	assert.equal(readFileSync(file, "utf8"), `# Large paste preservation\n\n${large}`);
	assert.ok(readdirSync(directory).every((name) => name.endsWith(".md")));
	// Real expanded editor text exercises overlay composition independently of collapsed pastes.
	keys("C-c");
	await delay(150);
	const draft = Array.from({ length: 70 }, (_, i) => `Expanded line ${i}: ${"wide unsent editor draft 界 ".repeat(7)}`).join("\n");
	writeFileSync(join(root, "draft-input.txt"), draft);
	text("/pocket-test-draft");
	keys("Enter");
	await waitFor(/Fixture draft ready/);
	for (let i = 0; i < 24; i++) {
		const title = i === 0 ? "Layout short" : i === 1 ? "Layout multiline 界 😀 " + "wide title 界 ".repeat(8).trimEnd() : `Layout record ${String(i).padStart(2, "0")}`;
		const body = i === 0 ? "Short preview" : `Long preview 界 😀 ${"wide body 界 ".repeat(30)}\nSecond preview ${"more text ".repeat(20)}\nThird preview`;
		writeFileSync(join(directory, `layout-${String(i).padStart(2, "0")}.md`), `# ${title}\n\n${body}`);
	}
	const captureDirectory = keepCaptures ? temporaryDirectory(`tui-layout-${mode}${customEditor ? "-custom" : ""}-`) : undefined;
	if (captureDirectory) console.log(`Layout captures retained: ${captureDirectory}`);
	const expectedFiles = saved().sort().map((name) => [name, readFileSync(join(directory, name), "utf8")]);
	const snapshotDraft = async () => {
		rmSync(join(root, "draft-output.txt"), { force: true });
		keys("Escape", "C-y");
		await waitForFiles(() => { try { return readFileSync(join(root, "draft-output.txt"), "utf8") === draft; } catch { return false; } });
		assert.equal(readFileSync(join(root, "draft-output.txt"), "utf8"), draft);
		assert.deepEqual(saved().sort().map((name) => [name, readFileSync(join(directory, name), "utf8")]), expectedFiles,
			"Layout interactions unexpectedly saved, edited or deleted a record");
	};
	const assertMenu = (screen, saveVisible = false) => {
		for (const label of ["Prompt Pocket", "Search:", ...(saveVisible ? ["Save current draft"] : []), "Ctrl+S", "Esc", "F2", "Ctrl+D"]) {
			assert.ok(screen.includes(label), `Missing ${label} at ${tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}").trim()}\n${screen}`);
		}
		assert.match(screen, /[→›❯>]\s*(?:\+ Save current draft|Layout)/u, `Selected item not visible\n${screen}`);
		return screen.split("\n").findIndex((line) => line.includes("Prompt Pocket"));
	};
	for (const [width, height] of [[110, 35], [60, 20], [40, 12], [110, 35]]) {
		await openMenu();
		tmux("resize-window", "-t", "pocket-test", "-x", String(width), "-y", String(height));
		await delay(250);
		assertMenu(capture(), true);
		assert.match(capture(), /Prompt Pocket · 25 saved/, "All fixture records must load");
		if (captureDirectory && (width === 110 || width === 40)) {
			writeFileSync(join(captureDirectory, `${width}x${height}.txt`), capture());
			writeFileSync(join(captureDirectory, `${width}x${height}.ansi`), tmux("capture-pane", "-p", "-e", "-t", pane));
		}
		keys("Escape");
		await delay(150);
		for (let repeat = 0; repeat < 2; repeat++) {
			await openMenu();
			const top = assertMenu(capture(), true);
			text("Layout short");
			await delay(200);
			assert.equal(assertMenu(capture()), top, "Filtering moved menu header");
			assert.match(capture(), /→\s*Layout short/, "Search must select the matching record");
			keys("C-u");
			text("Layout multiline");
			await delay(200);
			assert.equal(assertMenu(capture()), top, "Long wide title/preview moved menu header");
			assert.match(capture(), /→\s*Layout multiline/, "Wide title search must select its matching record");
			keys("C-u");
			text("Layout");
			await delay(200);
			const filteredTop = assertMenu(capture());
			assert.equal(filteredTop, top, "Restoring search moved menu header");
			for (const key of ["Down", "Down", "Up", "Up"]) {
				keys(key);
				await delay(120);
				assert.equal(assertMenu(capture()), filteredTop, "Preview length moved menu header");
			}
			keys("Escape");
			await delay(150);
		}
		// A shortcut reads without submitting or modifying the nonempty draft.
		await snapshotDraft();
	}
	console.log(`PASS (${mode}${customEditor ? ", CustomEditor" : ""}): existing save/edit/load/delete and collapsed paste workflows; expanded long draft preserved through repeated menu/search/navigation/resizes at 110x35, 60x20, 40x12; full menu and stable header; no message sent.`);
} catch (error) {
	if (pane) console.error(tmux("display-message", "-p", "-t", pane, "command=#{pane_current_command} dead=#{pane_dead} pid=#{pane_pid}"));
	console.error(lastScreen || (pane ? capture() : "No pane created"));
	throw error;
} finally {
	if (pane) { try { tmux("kill-server"); } catch {} }
	rmSync(root, { recursive: true, force: true });
}
