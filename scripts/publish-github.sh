#!/usr/bin/env bash
# Called only after release:pack; published assets are never overwritten.
set -euo pipefail

tag="${1:?Usage: publish-github.sh vX.Y.Z}"
[[ $# == 1 && "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
directory="releases/$tag"
archive=$(node --input-type=module - "$tag" "$directory" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [tag, directory] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (metadata.version !== pkg.version || tag !== `v${pkg.version}` || metadata.name !== pkg.name ||
    typeof metadata.artifact !== 'string' || path.basename(metadata.artifact) !== metadata.artifact ||
    !metadata.artifact.endsWith('.tgz')) throw new Error('Release metadata mismatch');
const hash = createHash('sha256').update(fs.readFileSync(path.join(directory, metadata.artifact))).digest('hex');
if (hash !== metadata.sha256 || fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== `${hash}  ${metadata.artifact}\n`) {
  throw new Error('Release checksum mismatch');
}
console.log(metadata.artifact);
JS
)

if state=$(gh release view "$tag" --json isDraft --jq '.isDraft' 2>/dev/null); then
  if [[ "$state" != true ]]; then
    echo "Release $tag is already published; refusing to modify it." >&2
    exit 1
  fi
else
  # If view failed for a reason other than absence, create fails safely too.
  gh release create "$tag" --verify-tag --draft --title "$tag" --generate-notes
fi

assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
downloads=$(mktemp -d "$directory/.github-download-XXXXXX")
trap 'rm -rf -- "$downloads"' EXIT
for file in "$archive" SHA256SUMS release.json; do
  if grep -Fxq -- "$file" <<< "$assets"; then
    gh release download "$tag" --pattern "$file" --dir "$downloads"
    if ! cmp -s -- "$directory/$file" "$downloads/$file"; then
      echo "Draft asset $file differs; refusing to overwrite it. Inspect the draft manually." >&2
      exit 1
    fi
  else
    gh release upload "$tag" "$directory/$file"
  fi
done

actual=$(gh release view "$tag" --json assets --jq '.assets[].name' | sort)
expected=$(printf '%s\n' "$archive" SHA256SUMS release.json | sort)
if [[ "$actual" != "$expected" ]]; then
  echo 'Unexpected draft assets; refusing to publish. Inspect the draft manually.' >&2
  exit 1
fi
# No public release exists until every expected asset is present and verified.
gh release edit "$tag" --verify-tag --draft=false
