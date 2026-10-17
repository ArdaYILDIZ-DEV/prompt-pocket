import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { temporaryDirectory } from "./temp.ts";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { parseDocument, PromptStore } from "../store.ts";

function fixture() {
  const root = temporaryDirectory("store-");
  const directory = path.join(root, "prompts");
  return { root, directory, store: new PromptStore(directory) };
}
function isolated(name: string, run: (f: ReturnType<typeof fixture>) => void) {
  test(name, () => {
    const f = fixture();
    try { run(f); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

isolated("list is lazy and missing record operations do not create a directory", ({ store, directory }) => {
  assert.deepEqual(store.list(), { prompts: [], warnings: [] });
  const missing = { id: "missing.md", raw: "# Missing\n\nbody", title: "Missing", body: "body", modified: 0 };
  assert.throws(() => store.read(missing));
  assert.throws(() => store.update(missing, "Title", "body"));
  assert.throws(() => store.remove(missing));
  assert.equal(fs.existsSync(directory), false);
});

isolated("exact Unicode and CRLF body roundtrip, duplicate titles never clobber", ({ store, directory }) => {
  const body = "  $& ${literal} $1\r\nsecond  \r\n\n";
  const first = store.create("  Türkçe 日本語 🐍  ", body);
  const second = store.create(first.title, "different");
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, "Türkçe 日本語 🐍");
  assert.equal(first.raw, `# ${first.title}\n\n${body}`);
  assert.equal(fs.readFileSync(path.join(directory, first.id), "utf8"), first.raw);
  assert.deepEqual(store.read(first), first);
  assert.equal(store.list().prompts.length, 2);
  assert.equal(first.body, body);
  assert.equal(typeof first.modified, "number");
});

isolated("validates titles and nonblank bodies before creating anything", ({ store, directory }) => {
  for (const title of ["", "   ", "a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "x".repeat(161)]) {
    assert.throws(() => store.create(title, "body"), /title/i);
  }
  for (const body of ["", " \r\n\t"]) assert.throws(() => store.create("Title", body), /body/i);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(store.create("x".repeat(160), "body").title.length, 160);
});

isolated("update keeps id and old snapshots cannot read, update or delete", ({ store, directory }) => {
  const original = store.create("Original", "old body");
  const updated = store.update(original, "Updated", "new body\r\n");
  assert.equal(updated.id, original.id);
  assert.equal(updated.raw, "# Updated\n\nnew body\r\n");
  assert.throws(() => store.read(original), /changed|conflict/i);
  assert.throws(() => store.update(original, "Stale", "stale"), /changed|conflict/i);
  assert.throws(() => store.remove(original), /changed|conflict/i);
  assert.equal(store.read(updated).raw, updated.raw);
  assert.deepEqual(fs.readdirSync(directory), [updated.id]);
  store.remove(updated);
  assert.throws(() => store.read(updated), /missing|exist|deleted/i);
  assert.throws(() => store.update(updated, "No", "body"), /missing|exist|deleted/i);
  assert.throws(() => store.remove(updated), /missing|exist|deleted/i);
  assert.deepEqual(fs.readdirSync(directory), []);
});

isolated("external changes conflict and malformed or oversized files produce warnings", ({ store, directory }) => {
  const original = store.create("Good", "body");
  fs.writeFileSync(path.join(directory, "malformed.md"), "not a prompt");
  fs.writeFileSync(path.join(directory, "blank.md"), "# Blank\n\n \n");
  fs.writeFileSync(path.join(directory, "invalid-utf8.md"), Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(path.join(directory, "oversized.md"), "x".repeat(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(directory, "ignored.txt"), "ignored");
  fs.mkdirSync(path.join(directory, "folder.md"));
  const result = store.list();
  assert.equal(result.prompts.length, 1);
  assert.equal(result.warnings.length, 4);
  fs.writeFileSync(path.join(directory, original.id), "# Changed\n\nexternal");
  assert.throws(() => store.read(original), /changed|conflict/i);
  assert.throws(() => store.remove(original), /changed|conflict/i);
});

isolated("rejects traversal and symlink mutations; ignores symlink records", ({ store, directory, root }) => {
  const original = store.create("Safe", "body");
  for (const id of ["../escape.md", "/tmp/escape.md", "nested/file.md", "..\\escape.md", ".", "a\u0000.md"]) {
    const bad = { ...original, id };
    assert.throws(() => store.read(bad), /filename|id/i);
    assert.throws(() => store.update(bad, "Title", "body"), /filename|id/i);
    assert.throws(() => store.remove(bad), /filename|id/i);
  }
  const target = path.join(root, "target.md");
  fs.writeFileSync(target, original.raw);
  fs.unlinkSync(path.join(directory, original.id));
  fs.symlinkSync(target, path.join(directory, original.id));
  assert.deepEqual(store.list(), { prompts: [], warnings: [] });
  assert.throws(() => store.read(original), /symlink|symbolic/i);
  assert.throws(() => store.update(original, "Title", "body"), /symlink|symbolic/i);
  assert.throws(() => store.remove(original), /symlink|symbolic/i);
  assert.equal(fs.readFileSync(target, "utf8"), original.raw);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".lock")), false);
});

isolated("rejects a symlink root but permits ordinary symlink ancestors", ({ root }) => {
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link);
  const bad = new PromptStore(link);
  assert.throws(() => bad.list(), /symlink|symbolic/i);
  assert.throws(() => bad.create("Title", "body"), /symlink|symbolic/i);
  const good = new PromptStore(path.join(link, "nested"));
  const prompt = good.create("Title", "body");
  assert.equal(good.read(prompt).body, "body");
});

isolated("private modes on POSIX", ({ store, directory }) => {
  if (process.platform === "win32") return;
  const prompt = store.create("Title", "body");
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, prompt.id)).mode & 0o777, 0o600);
  store.update(prompt, "Updated", "body");
  assert.equal(fs.statSync(path.join(directory, prompt.id)).mode & 0o777, 0o600);
});

isolated("existing record locks are never broken and failures clean owned locks", ({ store, directory }) => {
  const prompt = store.create("Title", "body");
  const lock = path.join(directory, `${prompt.id}.lock`);
  fs.writeFileSync(lock, "another process");
  assert.throws(() => store.update(prompt, "Updated", "body"), /lock|busy/i);
  assert.throws(() => store.remove(prompt), /lock|busy/i);
  assert.equal(fs.readFileSync(lock, "utf8"), "another process");
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(directory, prompt.id), "# External\n\nbody");
  assert.throws(() => store.update(prompt, "Updated", "body"), /changed|conflict/i);
  assert.deepEqual(fs.readdirSync(directory), [prompt.id]);
});

isolated("failed atomic publication preserves originals and cleans temps and locks", ({ store, directory }) => {
  const prompt = store.create("Title", "body");
  const rename = fs.renameSync;
  const link = fs.linkSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error("injected failure"), { code: "EIO" }); };
    fs.linkSync = () => { throw Object.assign(new Error("injected failure"), { code: "EIO" }); };
    syncBuiltinESMExports();
    assert.throws(() => store.update(prompt, "Updated", "new body"), /EIO|publish|save|update/i);
    assert.throws(() => store.create("Other", "body"), /EIO|publish|save|create/i);
  } finally {
    fs.renameSync = rename;
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(path.join(directory, prompt.id), "utf8"), prompt.raw);
  assert.deepEqual(fs.readdirSync(directory), [prompt.id]);
});

isolated("failed fsync preserves originals and cleans temporary files and owned locks", ({ store, directory }) => {
  const prompt = store.create("Title", "body");
  const fsync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Object.assign(new Error("injected failure"), { code: "EIO" }); };
    syncBuiltinESMExports();
    assert.throws(() => store.update(prompt, "Updated", "new body"), /EIO/i);
    assert.throws(() => store.create("Other", "body"), /EIO/i);
  } finally {
    fs.fsyncSync = fsync;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(path.join(directory, prompt.id), "utf8"), prompt.raw);
  assert.deepEqual(fs.readdirSync(directory), [prompt.id]);
});

isolated("cleanup failures retain the primary error and identify committed writes", ({ store, directory }) => {
  const prompt = store.create("Title", "body");
  const unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = (filename) => {
      if (String(filename).endsWith(".lock")) throw Object.assign(new Error("lock cleanup"), { code: "EACCES" });
      return unlink(filename);
    };
    syncBuiltinESMExports();
    // This write succeeds even though removing its lock fails.
    assert.throws(() => store.update(prompt, "Updated", "new body"), /completed.*cleanup/i);
    assert.equal(fs.readFileSync(path.join(directory, prompt.id), "utf8"), "# Updated\n\nnew body");
    unlink(path.join(directory, `${prompt.id}.lock`));
    assert.throws(() => store.update(prompt, "Stale", "body"), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /conflict/);
      assert.match(error.message, /cleanup/i);
      return true;
    });
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  }
});

isolated("temporary cleanup failure explicitly reports a saved record, not a failed write", ({ store, directory }) => {
  const prompt = store.create("Title", "body");
  const unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = (filename) => {
      if (String(filename).endsWith(".tmp")) throw Object.assign(new Error("temp cleanup"), { code: "EACCES" });
      return unlink(filename);
    };
    syncBuiltinESMExports();
    assert.throws(() => store.update(prompt, "Saved", "persisted"), /saved.*cleanup/i);
    assert.equal(fs.readFileSync(path.join(directory, prompt.id), "utf8"), "# Saved\n\npersisted");
    assert.ok(!fs.readdirSync(directory).some((name) => name.endsWith(".lock")));
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  }
});

test("parseDocument shares store validation and preserves the exact body", () => {
  const body = "  $& ${literal}\r\nbody  \n\n";
  assert.deepEqual(parseDocument(`# 日本語 🐍\n\n${body}`), { title: "日本語 🐍", body });
  assert.deepEqual(parseDocument(`# 日本語 🐍\r\n\r\n${body}`), { title: "日本語 🐍", body });
  for (const raw of ["No header", "# Title\nbody", "# Title\n\n ", "# Title \n\nbody", "# Title \r\n\r\nbody", "# Title\r\n\nbody", "# Title\n\r\nbody", "# a\nb\n\nbody", `# ${"x".repeat(161)}\n\nbody`, "# Title\n\n\ud800"]) {
    assert.throws(() => parseDocument(raw));
  }
  assert.throws(() => parseDocument(`# T\n\n${"x".repeat(2 * 1024 * 1024)}`), /size|MiB/i);
});

isolated("external CRLF documents retain raw snapshots and exact bodies", ({ store, directory }) => {
  const original = store.create("Title", "old body");
  const body = " $& ${literal}  \r\nlast  \n\n";
  const raw = `# 日本語 🐍\r\n\r\n${body}`;
  fs.writeFileSync(path.join(directory, original.id), raw);
  const result = store.list();
  assert.deepEqual(result.warnings, []);
  assert.equal(result.prompts.length, 1);
  const external = result.prompts[0]!;
  assert.equal(external.raw, raw);
  assert.equal(external.body, body);
  assert.deepEqual(store.read(external), external);
  assert.throws(() => store.read(original), /changed|conflict/i);
  const updated = store.update(external, external.title, external.body);
  assert.equal(updated.id, original.id);
  assert.equal(updated.body, body);
  assert.equal(updated.raw, `# 日本語 🐍\n\n${body}`);
});

isolated("small reads use size-bounded buffers and reject growth during read", ({ store, directory }) => {
  const prompt = store.create("Title", "small body");
  const filename = path.join(directory, prompt.id);
  const read = fs.readSync;
  let allocated = 0;
  try {
    fs.readSync = (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offsetOrOptions?: number | fs.ReadOptions,
      length?: number,
      position?: fs.ReadPosition | null,
    ): number => {
      allocated = buffer.byteLength;
      fs.appendFileSync(filename, "external growth");
      if (typeof offsetOrOptions === "number") {
        assert.notEqual(length, undefined);
        return read(fd, buffer, offsetOrOptions, length!, position ?? null);
      }
      return read(fd, buffer, offsetOrOptions);
    };
    syncBuiltinESMExports();
    assert.throws(() => store.read(prompt), /changed|conflict/i);
    assert.equal(allocated, Buffer.byteLength(prompt.raw) + 1);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
});

isolated("size bound includes UTF-8 header and rejects oversized writes without changing old file", ({ store, directory }) => {
  const limit = 2 * 1024 * 1024;
  const prompt = store.create("T", "x".repeat(limit - Buffer.byteLength("# T\n\n")));
  assert.equal(Buffer.byteLength(prompt.raw), limit);
  assert.equal(store.read(prompt).raw, prompt.raw);
  assert.throws(() => store.update(prompt, "T", `${prompt.body}é`), /size|large|MiB/i);
  assert.throws(() => store.create("T", "é".repeat(limit)), /size|large|MiB/i);
  assert.equal(fs.readFileSync(path.join(directory, prompt.id), "utf8"), prompt.raw);
  assert.deepEqual(fs.readdirSync(directory), [prompt.id]);
});

isolated("directory I/O failures are not disguised as an empty list", ({ directory, store }) => {
  fs.writeFileSync(directory, "not a directory");
  assert.throws(() => store.list(), /directory/i);
  assert.throws(() => store.create("Title", "body"), /directory/i);
});
