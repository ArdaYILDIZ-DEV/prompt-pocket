# Working on Prompt Pocket

## Architecture

This is a source-distributed TypeScript extension for Pi's interactive terminal UI, not a model tool. Node.js 22.19+ is required; development dependencies pin Pi 1.3.0. Check that version's public declarations/docs before changing host integrations.

- `index.ts`: `/pocket`, Ctrl+Alt+P, dialog workflow, confirmation and draft protection. The default factory registers capabilities; it does not access storage until invoked.
- `menu.ts`: searchable overlay built from Pi's native Input and SelectList. Keep filesystem logic out of rendering and sanitize stored text before terminal display.
- `store.ts`: synchronous UTF-8 Markdown records beneath `getAgentDir()/prompt-pocket`, validation, raw snapshots, exclusive record locks and atomic writes. No database or background watcher.
- `scripts/release.mjs`: dependency-free, offline packaging transaction shared by patch releases and current-tag packaging. Tests use disposable fixture projects rather than releasing this repository.
- `.github/workflows/release.yml` and `scripts/publish-github.sh`: tag-triggered GitHub draft publication after checks; `GH_TOKEN` is exposed only to the publishing step.

## Important boundaries

- Opening, saving, editing or cancelling must not rewrite the main draft. Keep the menu an **overlay**: non-overlay custom dialogs can lose Pi's collapsed-paste map when restoring editor text.
- Only an explicit load calls `setEditorText`; replacing different nonempty text requires confirmation and a fresh draft/saved-record check. Never automatically send loaded text.
- Preserve body text exactly when saving. Pi's native edit dialog trims outer whitespace; do not promise lossless native editing. Record IDs stay stable when titles change.
- Updates/deletes require the exact raw snapshot and a per-record lock. Do not break stale locks automatically. External writers ignoring locks and sudden power loss remain documented limitations.
- Cleanup can fail **after** an operation commits. Preserve the primary error and clearly distinguish a completed write from a failed write; do not blindly retry it.
- Runtime modules are shipped as TypeScript, without a build step. Adding one requires updating `package.json`'s explicit `files` allowlist. The release script intentionally accepts only flat filenames. Host packages remain peers, not bundled dependencies.

## Verification

Run commands from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run test:tui
```

`check` runs strict/unused-code TypeScript checks and Node tests. Storage, menu and workflow regressions live in `tests/*.test.ts`; release and hard-interruption tests are `tests/*.test.mjs`. Release tests require `tar`. All disposable fixture data stays in `.test-artifacts/`.

`test:tui` requires Linux and tmux. It runs isolated, offline Pi sessions in regular/fullscreen modes, including a CustomEditor fixture, without personal settings or provider calls. Keep that isolation when extending tests. Other operating systems and physical terminal combinations have not been verified.

## Release changes

`npm run release` is a **real local release**, not a dry run: it checks the project, increments the patch version in both manifests and the lockfile root package, and creates `releases/vVERSION/` with a tarball, SHA256SUMS and metadata. It does not commit, tag, push or publish remotely. Test release-code changes against fixture projects first.

The final directory rename is the commit point. Before it, handled failures roll back owned manifest changes; after it, cleanup failure is only a warning. `.release-lock/` retains recovery backups on interruption and blocks retries. Never remove it without inspecting the final artifact and current/original manifests; follow README's recovery section. Preserve prior release directories for duplicate detection.

`npm run release:pack -- vX.Y.Z` checks and packages the already-versioned source without changing either manifest. It requires an exact tag/version match and uses the same checks, lock, allowlist and checksum path as local releases. Do not bump again inside CI.

Pushing a matching version tag starts the GitHub workflow: locked install, three actual TUI scenarios, current-tag packaging, then draft publication with all three assets. The publisher never overwrites conflicting assets or modifies a published release. Failed drafts can be retried for the same tag; existing assets must match byte-for-byte. Keep tag pushes separate from ordinary source pushes, and never force-move a published tag.

`tests/package-current.test.mjs` covers no-mutation tagged packaging and reproducibility; `tests/github-release.test.mjs` tests publishing with a local fake `gh`, never the real API. Validate workflow changes with actionlint and publisher changes with `bash -n` plus these tests before exercising the real workflow.

Keep user-facing setup, compatibility and recovery details in `README.md`; avoid duplicating them here.
