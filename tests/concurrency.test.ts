import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { temporaryDirectory } from "./temp.ts";
import { test } from "node:test";
import { PromptStore } from "../store.ts";

test("two independent Pi-like processes cannot silently overwrite the same snapshot", { timeout: 15_000 }, async (t) => {
	const root = temporaryDirectory("concurrency-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new PromptStore(root);
	const original = store.create("Shared", "original body");
	const source = `
		import { PromptStore } from ${JSON.stringify(new URL("../store.ts", import.meta.url).href)};
		const store = new PromptStore(process.argv[1]);
		const expected = JSON.parse(process.argv[2]);
		store.read(expected);
		process.stdout.write("ready\\n");
		await new Promise(resolve => process.stdin.once("data", resolve));
		try {
			store.update(expected, "Shared", process.argv[3]);
			process.stdout.write("updated\\n");
		} catch (error) {
			if (!/conflict|locked/.test(error.message)) throw error;
			process.stdout.write("protected\\n");
		}
		process.stdin.destroy();
	`;
	function writer(body: string) {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source, root, JSON.stringify(original), body], { stdio: "pipe" });
		t.after(() => { if (child.exitCode === null) child.kill(); });
		let output = "";
		let stderr = "";
		let readyResolve!: () => void;
		const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
		child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.includes("ready\n")) readyResolve(); });
		child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
		const done = new Promise<string>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Writer exit ${code}: ${stderr}`)));
		});
		return { child, ready, done };
	}
	const first = writer("first writer");
	const second = writer("second writer");
	await Promise.race([Promise.all([first.ready, second.ready]), Promise.all([first.done, second.done])]);
	first.child.stdin.end("go\n");
	second.child.stdin.end("go\n");
	const output = await Promise.all([first.done, second.done]);
	assert.equal(output.filter((text) => text.includes("updated\n")).length, 1);
	assert.equal(output.filter((text) => text.includes("protected\n")).length, 1);
	assert.ok(["first writer", "second writer"].includes(store.list().prompts[0].body));
	assert.deepEqual(readdirSync(root), [original.id]);
});
