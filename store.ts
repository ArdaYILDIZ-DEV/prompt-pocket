import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  raw: string;
  modified: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function code(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "unknown I/O error";
}
function ioError(action: string, error: unknown): Error {
  return new Error(`${action} (${code(error)}).`, { cause: error });
}
/** Cleanup must not hide a primary failure or misreport a committed write. */
function withCleanup<T>(action: () => T, cleanup: () => void, completed: string): T {
  let failed = false;
  let primary: unknown;
  try { return action(); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { cleanup(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (failed) {
        const reason = primary instanceof Error ? primary.message : String(primary);
        throw new AggregateError([primary, error], `${reason} Cleanup also failed: ${detail}`);
      }
      throw new Error(`${completed} Cleanup failed: ${detail}`, { cause: error });
    }
  }
}

function titleText(title: string): string {
  if (typeof title !== "string" || CONTROLS.test(title)) {
    throw new Error("The title must be a single line without control characters.");
  }
  const trimmed = title.trim();
  if (!trimmed || [...trimmed].length > 160) {
    throw new Error("The title must contain 1–160 characters after trimming.");
  }
  return trimmed;
}
function content(title: string, body: string): { title: string; raw: string } {
  const normalized = titleText(title);
  if (typeof body !== "string" || !body.trim()) throw new Error("The prompt body must not be blank.");
  const raw = `# ${normalized}\n\n${body}`;
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("The complete prompt file exceeds the 2 MiB size limit.");
  // Refuse unpaired surrogates rather than silently changing text during UTF-8 encoding.
  if (Buffer.from(raw, "utf8").toString("utf8") !== raw) throw new Error("The prompt must contain valid Unicode text.");
  return { title: normalized, raw };
}
/** Parse the same complete Markdown document accepted by on-disk records. */
export function parseDocument(raw: string): { title: string; body: string } {
  if (typeof raw !== "string") throw new Error("The prompt document must be text.");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("The complete prompt file exceeds the 2 MiB size limit.");
  const header = /^# ([^\r\n]*)(?:\r\n\r\n|\n\n)/u.exec(raw);
  if (!header) throw new Error("Malformed prompt: expected a Markdown title followed by a blank line.");
  const title = header[1]!;
  const body = raw.slice(header[0].length);
  const checked = content(title, body);
  if (checked.title !== title) throw new Error("Malformed prompt: title must not have surrounding whitespace.");
  return { title, body };
}

function validateId(id: string): void {
  if (typeof id !== "string" || !id.endsWith(".md") || id.length <= 3 ||
      id.includes("/") || id.includes("\\") || CONTROLS.test(id) ||
      path.basename(id) !== id || id === ".md") {
    throw new Error("Invalid prompt filename (id); a safe Markdown basename is required.");
  }
}

/**
 * Small synchronous Markdown store. Cooperating writers use exclusive per-record
 * locks and exact raw snapshots. Locks are never automatically broken: a stale
 * lock requires manual inspection/removal. Atomic publication prevents partial
 * files, but a noncooperating external writer can still race the final snapshot
 * check and rename/unlink. This is not a sandbox against hostile directory swaps.
 * File data is fsynced, but directory entries are not: atomic publication does
 * not constitute an absolute power-loss durability guarantee.
 */
export class PromptStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  private directoryExists(): boolean {
    let stat;
    try { stat = lstatSync(this.directory); }
    catch (error) {
      if (code(error) === "ENOENT") return false;
      throw ioError("Cannot inspect the prompt directory", error);
    }
    if (stat.isSymbolicLink()) throw new Error("The prompt directory must not be a symbolic link.");
    if (!stat.isDirectory()) throw new Error("The prompt location is not a directory.");
    return true;
  }

  private requireDirectory(): void {
    if (!this.directoryExists()) throw new Error("The prompt directory is missing or has been deleted.");
  }

  list(): { prompts: SavedPrompt[]; warnings: string[] } {
    if (!this.directoryExists()) return { prompts: [], warnings: [] };
    let entries;
    try { entries = readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { throw ioError("Cannot list the prompt directory", error); }
    const prompts: SavedPrompt[] = [];
    const warnings: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
      try { prompts.push(this.readDisk(entry.name)); }
      catch (error) {
        // Surface directory failures rather than presenting them as bad records.
        this.requireDirectory();
        const reason = error instanceof Error ? error.message : "Cannot read prompt.";
        // JSON quoting keeps malformed filenames from injecting terminal controls.
        warnings.push(`Skipped ${JSON.stringify(entry.name)}: ${reason}`);
      }
    }
    return { prompts, warnings };
  }

  create(title: string, body: string): SavedPrompt {
    const encoded = content(title, body);
    if (!this.directoryExists()) {
      try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
      catch (error) { throw ioError("Cannot create the prompt directory", error); }
    }
    this.requireDirectory();
    const slug = encoded.title.normalize("NFKD").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "prompt";
    const id = `${slug}-${randomUUID()}.md`;
    return this.publish(id, encoded.title, body, encoded.raw, true);
  }

  read(expected: SavedPrompt): SavedPrompt {
    validateId(expected.id);
    this.requireDirectory();
    const current = this.readDisk(expected.id);
    if (current.raw !== expected.raw) throw new Error("The prompt changed on disk (snapshot conflict); reload before continuing.");
    return current;
  }

  update(expected: SavedPrompt, title: string, body: string): SavedPrompt {
    validateId(expected.id);
    const encoded = content(title, body);
    return this.withLock(expected.id, () => {
      this.read(expected);
      return this.publish(expected.id, encoded.title, body, encoded.raw, false);
    });
  }

  remove(expected: SavedPrompt): void {
    validateId(expected.id);
    this.withLock(expected.id, () => {
      this.read(expected);
      try { unlinkSync(path.join(this.directory, expected.id)); }
      catch (error) { throw ioError("Cannot delete the prompt", error); }
    });
  }

  private readDisk(id: string): SavedPrompt {
    validateId(id);
    const filename = path.join(this.directory, id);
    let stat;
    try { stat = lstatSync(filename); }
    catch (error) { throw ioError("Cannot read the prompt; it may be missing or deleted", error); }
    if (stat.isSymbolicLink()) throw new Error("A prompt record must not be a symbolic link.");
    if (!stat.isFile()) throw new Error("The prompt record is not a regular file.");
    if (stat.size > MAX_BYTES) throw new Error("The prompt file exceeds the 2 MiB size limit.");
    let fd: number;
    try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { throw ioError("Cannot safely open the prompt", error); }
    let raw: string;
    let modified: number;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error("The prompt record is not a regular file.");
      if (opened.size > MAX_BYTES) throw new Error("The prompt file exceeds the 2 MiB size limit.");
      // One extra byte detects growth without allocating 2 MiB per tiny record.
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytes = readSync(fd, buffer, length, buffer.length - length, null);
        if (bytes === 0) break;
        length += bytes;
      }
      if (length > MAX_BYTES) throw new Error("The prompt file exceeds the 2 MiB size limit.");
      const after = fstatSync(fd);
      if (length !== opened.size || after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw new Error("The prompt changed during reading (snapshot conflict); reload before continuing.");
      }
      const bytes = buffer.subarray(0, length);
      raw = bytes.toString("utf8");
      if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("The prompt file is not valid UTF-8.");
      modified = opened.mtimeMs;
    } finally { closeSync(fd); }
    const { title, body } = parseDocument(raw);
    return { id, title, body, raw, modified };
  }

  private withLock<T>(id: string, action: () => T): T {
    this.requireDirectory();
    const lock = path.join(this.directory, `${id}.lock`);
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if (code(error) === "EEXIST") throw new Error("The prompt is locked by another operation; inspect existing locks rather than breaking them automatically.");
      throw ioError("Cannot acquire the prompt lock", error);
    }
    return withCleanup(action, () => {
      const failures: unknown[] = [];
      try { closeSync(fd); } catch (error) { failures.push(error); }
      try { unlinkSync(lock); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `Cannot release the prompt lock (${failures.map(code).join(", ")}).`);
    }, "The operation completed. Do not repeat it; inspect the prompt and its lock.");

  }

  private publish(id: string, title: string, body: string, raw: string, create: boolean): SavedPrompt {
    const temp = path.join(this.directory, `.prompt-${randomUUID()}.tmp`);
    const target = path.join(this.directory, id);
    let fd: number;
    try { fd = openSync(temp, "wx", 0o600); }
    catch (error) { throw ioError("Cannot create the temporary prompt file", error); }
    return withCleanup(() => {
      try {
        const modified = withCleanup(() => {
          writeFileSync(fd, raw, { encoding: "utf8" });
          fsyncSync(fd);
          return fstatSync(fd).mtimeMs;
        }, () => closeSync(fd), "The temporary file was written, but the prompt was not saved.");
        // link is exclusive: even a UUID collision can never replace a record.
        if (create) linkSync(temp, target);
        else renameSync(temp, target);
        return { id, title, body, raw, modified };
      } catch (error) { throw ioError("Cannot publish the saved prompt", error); }
    }, () => {
      try { unlinkSync(temp); }
      catch (error) { if (code(error) !== "ENOENT") throw ioError("Cannot remove the temporary prompt file", error); }
    }, "The prompt was saved. Do not retry the write; inspect the temporary file.");

  }
}
