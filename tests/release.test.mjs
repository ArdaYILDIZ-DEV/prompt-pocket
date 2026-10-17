import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { release } from '../scripts/release.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(project, '.test-artifacts');
const files = ['index.ts', 'menu.ts', 'store.ts', 'README.md', 'LICENSE'];
function fixture(t, check = 'node -e "process.exit(0)"') {
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: 'release-fixture', version: '1.0.0', files, scripts: { check, prepack: 'node -e "process.exit(99)"' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2) + '\n');
  for (const file of files) fs.writeFileSync(path.join(root, file), `fixture ${file}\n`);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'must not be packed');
  return root;
}
function originals(root) {
  return ['package.json', 'package-lock.json'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
}
function unchanged(root, before) {
  assert.deepEqual(originals(root), before);
  assert.equal(fs.existsSync(path.join(root, '.release-lock')), false);
}

test('consecutive real offline packs agree with manifests, exact content and hash', t => {
  const root = fixture(t);
  for (const version of ['1.0.1', '1.0.2']) {
    const result = release(root);
    assert.equal(result.version, version);
    const dir = path.join(root, 'releases', `v${version}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'release.json')));
    const archive = path.join(dir, metadata.artifact);
    const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    assert.deepEqual(metadata, { name: 'release-fixture', version, sha256: hash, artifact: `release-fixture-${version}.tgz` });
    assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), `${hash}  ${metadata.artifact}\n`);
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), [...files, 'package.json'].map(file => `package/${file}`).sort());
    const manifest = spawnSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(manifest.status, 0, manifest.stderr);
    assert.equal(JSON.parse(manifest.stdout).version, version);
    for (const file of files) {
      const content = spawnSync('tar', ['-xOzf', archive, `package/${file}`], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(content.status, 0, content.stderr);
      assert.equal(content.stdout, fs.readFileSync(path.join(root, file), 'utf8'));
    }
    const [pkg, lock] = originals(root).map(JSON.parse);
    assert.equal(pkg.version, version);
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    assert.equal(fs.existsSync(path.join(root, '.release-lock')), false);
  }
});

test('check failure leaves exact originals and no release', t => {
  const root = fixture(t, 'node -e "console.log(\'check assertion marker\');process.exit(7)"');
  const before = originals(root);
  assert.throws(() => release(root), /check assertion marker/);
  unchanged(root, before);
  assert.equal(fs.existsSync(path.join(root, 'releases', 'v1.0.1')), false);
});

test('real pack failure leaves originals unchanged', t => {
  const root = fixture(t);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath));
  delete pkg.name;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const before = originals(root);
  assert.throws(() => release(root), /pack/);
  unchanged(root, before);
});

test('rejects inconsistent, unstable and unsafe versions', t => {
  for (const version of ['1.0.1', '01.0.0', '1.0.0-beta', '1.0.9007199254740991']) {
    const root = fixture(t);
    const pkg = JSON.parse(originals(root)[0]);
    pkg.version = version;
    if (version !== '1.0.1') {
      const lock = JSON.parse(originals(root)[1]);
      lock.version = lock.packages[''].version = version;
      fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    const before = originals(root);
    assert.throws(() => release(root), /version/i);
    unchanged(root, before);
  }
});

test('existing lock is never removed', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.release-lock'));
  fs.writeFileSync(path.join(root, '.release-lock', 'owner'), 'other');
  assert.throws(() => release(root), /lock/i);
  assert.equal(fs.readFileSync(path.join(root, '.release-lock', 'owner'), 'utf8'), 'other');
});

test('duplicate directory or dangling symlink is never replaced', t => {
  for (const symlink of [false, true]) {
    const root = fixture(t);
    const target = path.join(root, 'releases', 'v1.0.1');
    fs.mkdirSync(path.dirname(target));
    if (symlink) fs.symlinkSync(path.join(root, 'missing'), target);
    else fs.mkdirSync(target);
    const before = originals(root);
    assert.throws(() => release(root), /already exists/);
    unchanged(root, before);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), symlink);
  }
});

test('publication failure restores both manifests byte-for-byte', t => {
  const root = fixture(t);
  const before = originals(root);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, 'releases', 'v1.0.1')) throw new Error('publication failure');
    return rename(from, to);
  });
  assert.throws(() => release(root), /publication failure/);
  unchanged(root, before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases')), []);
});

test('partial manifest update failure rolls back the first update', t => {
  const root = fixture(t);
  const before = originals(root);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('package-lock.json.next')) throw new Error('manifest failure');
    return rename(from, to);
  });
  assert.throws(() => release(root), /manifest failure/);
  unchanged(root, before);
});

test('edits made during check are preserved and release is aborted', t => {
  const root = fixture(t);
  // Use a separate script to keep shell quoting unambiguous.
  const pkg = JSON.parse(originals(root)[0]);
  pkg.scripts.check = 'node change.cjs';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'change.cjs'), "require('node:fs').appendFileSync('package.json', ' ');\n");
  const before = originals(root);
  assert.throws(() => release(root), /changed/);
  assert.equal(originals(root)[0], before[0] + ' ');
  assert.equal(originals(root)[1], before[1]);
});

test('postcommit cleanup failure is a warning, not a rollback', t => {
  const root = fixture(t);
  const remove = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === path.join(root, '.release-lock')) throw new Error('cleanup failure');
    return remove(target, options);
  });
  const result = release(root);
  mocked.mock.restore();
  assert.match(result.warning, /cleanup failure/);
  assert.equal(JSON.parse(originals(root)[0]).version, '1.0.1');
  assert.equal(fs.existsSync(path.join(root, 'releases', 'v1.0.1', 'release.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.release-lock', 'package.json.original')), true);
  assert.throws(() => release(root), /lock/i);
});
