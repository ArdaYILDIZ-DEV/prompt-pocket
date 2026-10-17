# Prompt Pocket

Save unsent drafts from Pi's editor as titled prompts. Search your library, edit saved prompts, and load them back into the editor without sending a message.

**Ctrl+Alt+P** opens the menu. Prompt Pocket adds no model tools or input hooks. Your draft changes only when you choose to load a saved prompt; replacing different, nonempty text requires confirmation.

## Quick start

Requires **Node.js 22.19+** and **Pi Coding Agent 1.3.0+ within 1.x**. Tested on Linux with Node.js 24.20.0 and Pi 1.3.0. The menu requires Pi's interactive terminal UI; RPC and print modes are not supported.

From a source checkout, try the extension for one session:

```sh
pi -e ./index.ts
```

Use an absolute path if starting Pi elsewhere. Saved prompts belong to your Pi agent directory, not the current project.

To keep the package installed:

```sh
pi install /absolute/path/to/prompt-pocket
```

This changes your personal Pi package settings. Run `/reload` in an existing Pi session afterward. The package has not been published to npm. It uses Pi's host-provided API and TUI packages, with no additional runtime dependencies.

## Save and reuse a prompt

1. Write a prompt in Pi's editor, but **do not send it**.
2. Press **Ctrl+Alt+P**, then **Ctrl+S**. Enter a title and press **Enter**. Your draft stays in the editor.
3. Open the menu again, search by title or body text, and press **Enter** on a saved prompt.
4. Edit the loaded text as needed. Sending it remains a separate, normal Pi action.

With a nonblank draft, the first row is **Save current draft…**; pressing Enter there also opens the title dialog. Once you type a matching search, the matching saved prompt is selected instead. Prompts are sorted by last modification; search supports fuzzy matching and multiple words.

The library is a centered, theme-colored overlay, up to 84 columns wide and 20 rows tall. Its size stays steady while filtering and moving between prompts, independently of the draft behind it. The list scrolls with the selection; previews wrap long lines. On smaller terminals, the panel reduces the list and preview before sacrificing search or keyboard controls. Very short screens omit the preview; all actions remain available from the keyboard.

| In the menu | Action |
|---|---|
| Type | Search titles and prompt bodies |
| ↑ / ↓ | Move the selection |
| Enter | Load the selected prompt, or choose the save row |
| Ctrl+S | Save the current draft as a new record |
| F2 | Edit the selected record's title and body |
| Ctrl+D | Permanently delete the selected record after confirmation |
| Esc | Go back or close the menu |

Navigation, confirmation, and cancellation follow Pi's TUI keybindings; the table shows defaults. Ctrl+S, F2, and Ctrl+D are fixed menu-local bindings.

`/pocket` also opens the library. **Use the shortcut to preserve an existing unsent draft** rather than typing a slash command over it. If your terminal cannot transmit Ctrl+Alt+P, use `/pocket`. Check Pi's warnings if another extension registers the same shortcut.

### Editing and draft protection

- Saving, closing the menu, or cancelling a dialog does not rewrite the main editor. The menu uses an overlay so collapsed large pastes, undo state, and cursor position survive.
- Loading different text over a nonempty draft asks for confirmation. If the draft changes during confirmation, it is not replaced.
- Editing loaded text in the main editor does not update its saved source. Use **F2** for persistent changes.
- F2 opens Pi's multiline editor. Keep the first `# Title` line and the blank line below it. By default, Enter saves, Shift+Enter inserts a newline, and Esc cancels; follow the dialog hints for custom bindings.
- Pi's native multiline dialog trims outer whitespace on submission. Initial saving does not trim the draft; loading uses Pi's normal newline/tab normalization.
- Invalid edits and write failures reopen the edited document instead of discarding it. Copy your work or use Pi's external-editor option before cancelling if you need to recover it. Snapshot conflicts never automatically overwrite newer on-disk content.

## Storage and safety

Default location:

```text
~/.pi/agent/prompt-pocket/
```

When `PI_CODING_AGENT_DIR` is set, its `prompt-pocket/` subdirectory is used instead. Each record is a UTF-8 Markdown file with a readable title-derived prefix and a UUID:

```markdown
# Code review

Review these changes for correctness and maintainability.
```

Titles are single-line Unicode text, 1–160 characters after trimming. Everything after the header's blank line is the body; the header is not loaded into Pi's editor. Duplicate titles create separate files, and renaming a title does not change the record's filename.

- Blank bodies are rejected. The complete file is limited to **2 MiB**. LF and CRLF headers are accepted.
- There is no database, index, watcher, or cloud service. Reopening the menu reads external file changes without `/reload`.
- New directories use POSIX mode `0700`; files use `0600`. Records are **not encrypted**. Back up important prompts and protect sensitive content accordingly.
- Writes use exclusive temporary files, file `fsync`, and atomic publication rather than truncating records in place. Updates and deletion use per-record locks and exact raw snapshots. Cooperating Pi processes cannot silently overwrite the same snapshot.
- Changed or deleted snapshots cannot be loaded, updated, or deleted through a stale selection. Malformed, invalid-UTF-8, and oversized records produce warnings without hiding healthy records. Symlink records are ignored; the storage directory itself cannot be a symlink.
- An external writer that ignores locks can still race the final snapshot check and rename/unlink. This is not a sandbox against hostile filesystem swaps. Directory entries are not separately fsynced, so atomic publication is not an absolute power-loss durability guarantee.
- If cleanup fails after a completed operation, the error explicitly says the prompt was saved or the operation completed. Inspect the record before retrying. When the operation and cleanup both fail, both errors are retained.
- A hard interruption can leave `.md.lock` or hidden `.tmp` files. Locks are never automatically broken. First verify the owning process has stopped, back up the Markdown record, then remove only that record's stale lock. Inspect temporary files before deleting them: they may contain recoverable text.

Only text is saved, not images or attachments. `$1` and `$ARGUMENTS` remain literal during storage and loading; Pi's normal command/template rules still apply when you later send the text. Built-in templates and other extensions' storage are not modified or imported.

## Development

Run from the project root:

```sh
npm ci --ignore-scripts
npm run check
npm run test:tui
npm pack --dry-run --ignore-scripts
```

`npm run check` runs strict TypeScript and unused-code checks, then automated tests. Release tests also require the `tar` command. Fixtures stay under `.test-artifacts/` inside this project and are cleaned up after each test.

Tests cover exact text round-trips, Unicode/CRLF, validation, corrupt files, symlinks and traversal, permissions, I/O and cleanup failures, locks, two independent writers, snapshot conflicts, menu keys, narrow layouts, draft protection, cancellation, and dialog failures. Release tests create real local archives and verify consecutive versions, contents, hashes, rollback, concurrent edits, and hard interruption at two publication boundaries.

`npm run test:tui` requires **Linux and tmux**. It launches actual Pi in regular and fullscreen modes, plus fullscreen with a separate `CustomEditor` fixture. It exercises the shortcut, saving, body search, native editing, replace/delete confirmation and cancellation, and collapsed large-paste preservation. Layout regressions cover an expanded 70-line draft, a populated library, repeated opening/closing, stable placement while filtering and navigating, and resizing an open menu through 110×35, 60×20, and 40×12 terminals. Sessions have their own tmux socket, working directory, and Pi agent directory. Startup networking is disabled; personal settings and records are not loaded, no message is sent, and no provider is called.

macOS, Windows, and other physical terminal/keyboard combinations have not been tested.

The API and package setup were checked against installed **Pi 1.3.0** declarations and the [official package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). Host-provided packages use the recommended `peerDependencies: "*"`; this is not a claim that every Pi version has been tested.

## Local releases

After installing development dependencies, run:

```sh
npm run release
```

Each successful run increments the patch version: `1.0.0 → 1.0.1 → 1.0.2`. `package.json`, `package-lock.json`, and the lockfile's root package version advance together. Inconsistent versions, prereleases, and invalid stable `X.Y.Z` versions are rejected.

The command runs `npm run check`, packs the next version using the explicit `package.json` file allowlist, verifies its contents, and atomically exposes a local release directory. For example:

```text
releases/v1.0.1/
  pi-prompt-pocket-1.0.1.tgz
  SHA256SUMS
  release.json
```

- npm subprocesses are offline, with packaging lifecycle scripts disabled, temporary empty user/global npm configs, and a project-local cache. The command does not install dependencies.
- Check/pack failures leave versions unchanged. Handled pre-publication write failures restore modified manifests byte-for-byte. Concurrent manifest edits are not overwritten; unsafe recovery stops with backups retained.
- `.release-lock/` excludes concurrent releases. Existing version directories or symlinks are never replaced. Keep and back up `releases/`: it is Git-ignored and forms part of local duplicate detection.
- The final version-directory rename is the commit point. Cleanup failures afterward produce a warning, not a rollback. There is no absolute power-loss durability guarantee.
- **The local command does not commit, tag, push, or publish.** A clean Git tree is not required; manifests are changed but not staged. Do not edit sources while a release runs. GitHub publication is handled separately below; npm publication is not configured.

### Recover an interrupted release

Never blindly delete `.release-lock/`. Verify the process has stopped and back up the recovery directory. Compare current manifests with `.release-lock/package.json.original` and `.release-lock/package-lock.json.original`; inspect hidden staging directories under `releases/` and any final release's `release.json` and archive checksum.

If the final version directory is absent, publication did not complete: restore a consistent previous version while preserving concurrent user edits. If the final directory exists and its archive version/hash are correct, the release committed: do not restore old manifests. Bring manifests into agreement with the committed local version, then remove only this operation's lock/staging leftovers after recovering any needed data. The next normal release advances to the following patch.

## Publish to GitHub Releases

The [GitHub release workflow](.github/workflows/release.yml) runs when a stable `vX.Y.Z` tag is pushed. It checks out that tag, installs locked development dependencies, runs the isolated terminal tests, and calls `npm run release:pack -- "$GITHUB_REF_NAME"`. This reuses the local release checks and packer **without bumping or modifying the tagged manifests**. The tag must exactly match their version.

After reviewing and testing your changes, publish a new patch from your clean, up-to-date `main` checkout:

```sh
npm run release
version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
git add package.json package-lock.json
git commit -m "chore(release): prepare v$version"
git tag "v$version"
git push --atomic origin main "v$version"
```

Commit feature/docs changes before this sequence. Unlike the local release command, the final push **starts a real GitHub release**. The workflow uses the repository's `GITHUB_TOKEN` with `contents: write`; no personal token or npm credential is needed. Repository policies must allow Actions and release creation. Local output directories are ignored and are rebuilt from the committed tag, not uploaded from your machine.

The [Releases page](https://github.com/ArdaYILDIZ-DEV/prompt-pocket/releases) receives the `.tgz` package, `SHA256SUMS`, and `release.json`. A draft is created first and becomes public only after all three assets are present. Existing draft assets are downloaded and compared before reuse; conflicting or unexpected assets stop publication and are never overwritten. Published releases cannot be modified by this script. The workflow is serialized per tag and never force-pushes or moves tags.

If upload or final publication fails, inspect the draft and rerun the failed workflow for the **same tag**; matching assets are reused and missing assets are uploaded. Do not increment the version just to retry a draft. After publication, a rerun refuses to change the public release. You can also choose **Actions → GitHub release → Run workflow** and select the existing version tag, not a branch. Do not delete/recreate a published tag to retry. There is no atomic transaction across Git and GitHub APIs: a failed run can leave a pushed tag and an unpublished draft, but does not report successful publication.

The publication helper is tested with an isolated local fake `gh` executable for upload failures, retries, checksum mismatch, conflicting assets and duplicate publication. Its draft workflow follows the official [GitHub CLI create](https://cli.github.com/manual/gh_release_create), [upload](https://cli.github.com/manual/gh_release_upload), and [edit](https://cli.github.com/manual/gh_release_edit) contracts.

## License

[MIT](LICENSE).
