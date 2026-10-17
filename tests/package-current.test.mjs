import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as releases from '../scripts/release.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const manifests = ['package.json', 'package-lock.json'];
function fixture(t, check = 'node check.cjs') {
  const artifacts = path.join(project, '.test-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'package-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: 'current-fixture', version: '1.0.3', files: ['index.ts'], scripts: { check, prepack: 'node -e "process.exit(99)"' } };
  // Deliberately nonstandard formatting: current packaging must never rewrite these bytes.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg) + '  \n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { version: pkg.version } } }) + '\n\n');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const fixture = true;\n');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not in archive');
  fs.writeFileSync(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('checked', 'yes');\n");
  return root;
}
function snapshot(root) {
  return manifests.map(file => fs.readFileSync(path.join(root, file)));
}
function unchanged(root, before) {
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, '.release-lock')), false);
}
function noRelease(root) {
  assert.equal(fs.existsSync(path.join(root, 'releases')), false);
}

test('current mode really packs tagged version with exact files, metadata and hash, without manifest writes', t => {
  const root = fixture(t);
  const before = snapshot(root);
  // Reject even transient writes/renames of either source manifest.
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    assert.ok(!manifests.some(file => target === path.join(root, file)), 'source manifest write');
    return write(target, ...args);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.ok(!manifests.some(file => to === path.join(root, file)), 'source manifest rename');
    return rename(from, to);
  });
  const result = releases.packageCurrent(root, 'v1.0.3');
  assert.equal(result.version, '1.0.3');
  assert.equal(result.directory, path.join(root, 'releases', 'v1.0.3'));
  assert.equal(fs.readFileSync(path.join(root, 'checked'), 'utf8'), 'yes');
  unchanged(root, before);
  const archive = path.join(result.directory, result.artifact);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  assert.equal(result.sha256, sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'release.json'))), {
    name: 'current-fixture', version: '1.0.3', sha256, artifact: 'current-fixture-1.0.3.tgz',
  });
  assert.equal(fs.readFileSync(path.join(result.directory, 'SHA256SUMS'), 'utf8'), `${sha256}  ${result.artifact}\n`);
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n').sort(), ['package/index.ts', 'package/package.json']);
  const packed = spawnSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(JSON.parse(packed.stdout).version, '1.0.3');
});

test('current packs are byte-for-byte reproducible after removing only the disposable release directory', t => {
  const root = fixture(t);
  const before = snapshot(root);
  const first = releases.packageCurrent(root, 'v1.0.3');
  const archive = fs.readFileSync(path.join(first.directory, first.artifact));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  assert.equal(first.sha256, sha256);
  unchanged(root, before);

  fs.rmSync(first.directory, { recursive: true });
  const second = releases.packageCurrent(root, 'v1.0.3');
  const repeated = fs.readFileSync(path.join(second.directory, second.artifact));
  assert.equal(createHash('sha256').update(repeated).digest('hex'), sha256);
  assert.equal(second.sha256, sha256);
  assert.deepEqual(repeated, archive);
  unchanged(root, before);
});

test('invalid or mismatched tags fail before checks or any filesystem writes', t => {
  const root = fixture(t);
  const before = snapshot(root);
  const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('validation wrote a file'));
  const mkdir = t.mock.method(fs, 'mkdirSync', () => assert.fail('validation created a directory'));
  for (const tag of [undefined, '', '1.0.3', 'v1.0.2', 'v01.0.3', 'v1.0.3-beta', 'v1.0.3+build', 'v1.0.3\n', 'v1.0.3 ', 103]) {
    assert.throws(() => releases.packageCurrent(root, tag), /tag/i);
  }
  write.mock.restore();
  mkdir.mock.restore();
  unchanged(root, before);
  noRelease(root);
  assert.equal(fs.existsSync(path.join(root, 'checked')), false);
});

test('both lockfile version fields must match the tag before checks or writes', t => {
  for (const field of ['version', 'root']) {
    const root = fixture(t);
    const target = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(target));
    if (field === 'version') lock.version = '1.0.2';
    else lock.packages[''].version = '1.0.2';
    fs.writeFileSync(target, JSON.stringify(lock));
    const before = snapshot(root);
    const mkdir = t.mock.method(fs, 'mkdirSync', () => assert.fail('validation created a directory'));
    assert.throws(() => releases.packageCurrent(root, 'v1.0.3'), /version|tag/i);
    mkdir.mock.restore();
    unchanged(root, before);
    noRelease(root);
    assert.equal(fs.existsSync(path.join(root, 'checked')), false);
  }
});

test('current check failure and real npm pack failure do not mutate manifests', t => {
  for (const failure of ['check', 'pack']) {
    const root = fixture(t, failure === 'check' ? 'node -e "console.log(\'check marker\');process.exit(7)"' : undefined);
    if (failure === 'pack') {
      const target = path.join(root, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(target));
      delete pkg.name;
      fs.writeFileSync(target, JSON.stringify(pkg));
    }
    const before = snapshot(root);
    assert.throws(() => releases.packageCurrent(root, 'v1.0.3'), failure === 'check' ? /check marker/ : /pack/);
    unchanged(root, before);
    noRelease(root);
  }
});

test('current duplicate directory or symlink is refused before checks', t => {
  for (const symlink of [false, true]) {
    const root = fixture(t);
    const destination = path.join(root, 'releases', 'v1.0.3');
    fs.mkdirSync(path.dirname(destination));
    if (symlink) fs.symlinkSync(path.join(root, 'missing'), destination);
    else fs.mkdirSync(destination);
    const before = snapshot(root);
    assert.throws(() => releases.packageCurrent(root, 'v1.0.3'), /already exists/);
    unchanged(root, before);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), symlink);
    assert.equal(fs.existsSync(path.join(root, 'checked')), false);
  }
});

test('CLI accepts only no arguments or --current with one canonical tag', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(project, 'scripts', 'release.mjs'), path.join(root, 'scripts', 'release.mjs'));
  const run = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'release.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 });
  const before = snapshot(root);
  for (const args of [['--current'], ['--unknown'], ['v1.0.3'], ['--current', 'v1.0.3', 'extra'], ['--current', 'v1.0.2']]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    unchanged(root, before);
    noRelease(root);
  }
  const current = run(['--current', 'v1.0.3']);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /Local release 1\.0\.3/);
  unchanged(root, before);
  const increment = run([]);
  assert.equal(increment.status, 0, increment.stderr);
  assert.match(increment.stdout, /Local release 1\.0\.4/);
  assert.equal(JSON.parse(snapshot(root)[0]).version, '1.0.4');
});
