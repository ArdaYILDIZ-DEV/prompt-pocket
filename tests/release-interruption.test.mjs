import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { release } from "../scripts/release.mjs";
import { temporaryDirectory } from "./temp.ts";

// Kill only our disposable child, after a real rename; no production fault hooks.
for (const boundary of ["manifest", "publication"]) {
	test(`hard interruption after ${boundary} retains recovery evidence and blocks retries`, (t) => {
		const root = temporaryDirectory("interruption-");
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const pkg = { name: "interrupted-fixture", version: "1.0.0", files: ["index.ts"], scripts: { check: 'node -e "process.exit(0)"' } };
		const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version } } };
		const originals = [JSON.stringify(pkg), JSON.stringify(lock)];
		writeFileSync(join(root, "package.json"), originals[0]);
		writeFileSync(join(root, "package-lock.json"), originals[1]);
		writeFileSync(join(root, "index.ts"), "export default function () {}\n");
		mkdirSync(join(root, ".test-artifacts"));
		const target = boundary === "manifest" ? join(root, "package.json") : join(root, "releases", "v1.0.1");
		const source = `
			import fs from 'node:fs';
			import { release } from ${JSON.stringify(new URL("../scripts/release.mjs", import.meta.url).href)};
			const rename = fs.renameSync;
			fs.renameSync = (from, to) => {
				const result = rename(from, to);
				if (to === ${JSON.stringify(target)}) process.kill(process.pid, 'SIGKILL');
				return result;
			};
			release(${JSON.stringify(root)});
		`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
		assert.equal(child.error, undefined);
		assert.equal(child.signal, "SIGKILL", child.stderr);
		assert.equal(child.stdout, "", "interrupted release must not claim success");
		for (const [index, file] of ["package.json", "package-lock.json"].entries()) {
			assert.equal(readFileSync(join(root, ".release-lock", `${file}.original`), "utf8"), originals[index]);
		}
		const current = ["package.json", "package-lock.json"].map((file) => readFileSync(join(root, file), "utf8"));
		assert.equal(JSON.parse(current[0]).version, "1.0.1");
		assert.equal(JSON.parse(current[1]).version, boundary === "manifest" ? "1.0.0" : "1.0.1");
		assert.throws(() => release(root), /lock/i);
		assert.deepEqual(["package.json", "package-lock.json"].map((file) => readFileSync(join(root, file), "utf8")), current);
		if (boundary === "manifest") {
			assert.ok(readdirSync(join(root, "releases")).every((name) => name.startsWith(".v1.0.1-")));
		} else {
			const dir = join(root, "releases", "v1.0.1");
			const metadata = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
			assert.equal(metadata.version, "1.0.1");
			assert.equal(createHash("sha256").update(readFileSync(join(dir, metadata.artifact))).digest("hex"), metadata.sha256);
		}
	});
}
