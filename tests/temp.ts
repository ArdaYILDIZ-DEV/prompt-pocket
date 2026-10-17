import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

/** Keep disposable test data inside the project, never in the user's Pi directory. */
export function temporaryDirectory(prefix: string): string {
	const parent = resolve(import.meta.dirname, "../.test-artifacts");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	return mkdtempSync(join(parent, prefix));
}
