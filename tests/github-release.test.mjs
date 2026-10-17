import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { temporaryDirectory } from "./temp.ts";

const script = resolve(import.meta.dirname, "../scripts/publish-github.sh");
function fixture(t) {
	const root = temporaryDirectory("github-release-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "releases/v1.0.2");
	const bin = join(root, "bin");
	mkdirSync(dir, { recursive: true });
	mkdirSync(bin);
	const archive = "fixture-1.0.2.tgz";
	const bytes = Buffer.from("verified archive fixture");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.2" }));
	writeFileSync(join(dir, archive), bytes);
	writeFileSync(join(dir, "SHA256SUMS"), `${sha256}  ${archive}\n`);
	writeFileSync(join(dir, "release.json"), JSON.stringify({ name: "fixture", version: "1.0.2", artifact: archive, sha256 }));
	const statePath = join(root, "remote.json");
	writeFileSync(statePath, JSON.stringify({ exists: false, draft: true, assets: {} }));
	// All gh calls stay in this disposable fake; it has no networking code.
	writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const [, command, tag, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE));
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
const fail = () => process.exit(1);
if (tag !== 'v1.0.2') fail();
if (command === 'view') {
  if (!state.exists || process.env.FAKE_GH_FAIL === 'view') fail();
  console.log(args.includes('isDraft') ? String(state.draft) : Object.keys(state.assets).join('\\n'));
} else if (command === 'create') {
  if (state.exists || process.env.FAKE_GH_FAIL === 'create') fail();
  if (!args.includes('--verify-tag') || !args.includes('--draft')) fail();
  state.exists = true; save();
} else if (command === 'upload') {
  const file = args[0];
  const name = path.basename(file);
  if (process.env.FAKE_GH_FAIL === 'upload:' + name || name in state.assets) fail();
  state.assets[name] = fs.readFileSync(file).toString('base64'); save();
} else if (command === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  const dir = args[args.indexOf('--dir') + 1];
  if (!(name in state.assets)) fail();
  fs.writeFileSync(path.join(dir, name), Buffer.from(state.assets[name], 'base64'));
} else if (command === 'edit') {
  if (process.env.FAKE_GH_FAIL === 'edit') fail();
  if (!args.includes('--draft=false') || !args.includes('--verify-tag')) fail();
  state.draft = false; save();
} else fail();
`, { mode: 0o755 });
	const state = () => JSON.parse(readFileSync(statePath, "utf8"));
	const run = (failure = "", tag = "v1.0.2") => spawnSync("bash", [script, tag], {
		cwd: root, timeout: 10_000, encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "test-only", GH_REPO: "fixture/repo", FAKE_GH_STATE: statePath, FAKE_GH_FAIL: failure },
	});
	return { root, dir, archive, state, statePath, run };
}

test("publishes only after all three verified assets exist; published releases cannot be changed", (t) => {
	const f = fixture(t);
	const first = f.run();
	assert.equal(first.status, 0, first.stderr);
	assert.equal(f.state().draft, false);
	assert.equal(Object.keys(f.state().assets).length, 3);
	const before = readFileSync(f.statePath, "utf8");
	const duplicate = f.run();
	assert.notEqual(duplicate.status, 0);
	assert.match(duplicate.stderr, /already published/);
	assert.equal(readFileSync(f.statePath, "utf8"), before);
});

test("an upload failure leaves a draft; retry verifies existing bytes and uploads only missing assets", (t) => {
	const f = fixture(t);
	assert.notEqual(f.run("upload:release.json").status, 0);
	assert.equal(f.state().draft, true);
	assert.equal(Object.keys(f.state().assets).length, 2);
	const retry = f.run();
	assert.equal(retry.status, 0, retry.stderr);
	assert.equal(f.state().draft, false);
});

test("a failed final publish stays a draft and can be retried without overwriting assets", (t) => {
	const f = fixture(t);
	assert.notEqual(f.run("edit").status, 0);
	assert.equal(f.state().draft, true);
	assert.equal(Object.keys(f.state().assets).length, 3);
	const retry = f.run();
	assert.equal(retry.status, 0, retry.stderr);
	assert.equal(f.state().draft, false);
});

test("conflicting or unexpected draft assets are preserved and never published", (t) => {
	for (const name of ["SHA256SUMS", "unexpected.txt"]) {
		const f = fixture(t);
		writeFileSync(f.statePath, JSON.stringify({ exists: true, draft: true, assets: { [name]: Buffer.from("someone else's work").toString("base64") } }));
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /refusing to (overwrite|publish)/);
		assert.equal(f.state().draft, true);
		assert.equal(f.state().assets[name], Buffer.from("someone else's work").toString("base64"));
	}
});

test("bad local checksums, tag mismatches and API failures cannot create a public release", (t) => {
	for (const failure of ["checksum", "tag", "create", "view"]) {
		const f = fixture(t);
		if (failure === "checksum") writeFileSync(join(f.dir, f.archive), "damaged");
		const result = f.run(["create", "view"].includes(failure) ? failure : "", failure === "tag" ? "v1.0.9" : "v1.0.2");
		assert.notEqual(result.status, 0);
		assert.equal(f.state().draft, true);
		if (["checksum", "tag", "create"].includes(failure)) assert.equal(f.state().exists, false);
	}
});
