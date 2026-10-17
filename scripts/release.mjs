import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function exists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function directory(target) {
  fs.mkdirSync(target, { recursive: true });
  if (!fs.lstatSync(target).isDirectory()) throw new Error(`Not a real directory: ${target}`);
}

/** Local-only release. A surviving lock requires manual inspection, never auto-recovery. */
export function release(root) {
  return prepare(root, true);
}

/** Package an already-bumped, exactly tagged stable version without rewriting manifests. */
export function packageCurrent(root, tag) {
  return prepare(root, false, tag);
}

function prepare(root, increment, tag) {
  root = path.resolve(root);
  // Validate current tags and all manifest versions before acquiring a lock or writing anything.
  if (!increment && (typeof tag !== 'string' ||
      /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(tag)?.[0] !== tag)) {
    throw new Error('Tag must be an exact canonical vX.Y.Z');
  }
  let manifests = [];
  let pkg, lock, version;
  const inspectManifests = () => {
    manifests = ['package.json', 'package-lock.json'].map(file => {
      const target = path.join(root, file);
      if (!fs.lstatSync(target).isFile()) throw new Error(`Manifest must be a regular file: ${file}`);
      const original = fs.readFileSync(target, 'utf8');
      return { file, target, original, value: JSON.parse(original), updated: false };
    });
    [pkg, lock] = manifests.map(item => item.value);
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pkg.version);
    if (!match || match[0] !== pkg.version || !match.slice(1).every(part => Number.isSafeInteger(Number(part))) ||
        (increment && !Number.isSafeInteger(Number(match?.[3]) + 1))) {
      throw new Error('Version must be stable X.Y.Z with safe components and, when incrementing, a safe next patch');
    }
    if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) throw new Error('Manifest versions are inconsistent');
    if (!increment && tag !== `v${pkg.version}`) throw new Error('Tag does not match manifest versions');
    version = increment ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : pkg.version;
  };
  if (!increment) inspectManifests();
  const lockDir = path.join(root, '.release-lock');
  try { fs.mkdirSync(lockDir); }
  catch (error) { throw new Error(`Cannot acquire release lock: ${lockDir}`, { cause: error }); }
  const owner = fs.lstatSync(lockDir);
  let staging;
  let committed = false;
  const cleanup = () => {
    const current = fs.lstatSync(lockDir);
    if (current.ino !== owner.ino || current.dev !== owner.dev) throw new Error('Release lock ownership changed; inspect manually');
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true });
  };
  try {
    // Normal releases retain lock-first recovery semantics, even after a partial manifest update.
    if (increment) inspectManifests();
    const unchanged = item => {
      if (!fs.lstatSync(item.target).isFile() || fs.readFileSync(item.target, 'utf8') !== (item.updated ? item.next : item.original)) {
        throw new Error(`${item.file} changed during release; refusing to overwrite it`);
      }
    };
    manifests.forEach(unchanged);
    for (const { file, original } of manifests) {
      fs.writeFileSync(path.join(lockDir, `${file}.original`), original, { flag: 'wx' });
    }
    if (!Array.isArray(pkg.files) || pkg.files.length === 0 || new Set(pkg.files).size !== pkg.files.length ||
        !pkg.files.every(file => typeof file === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file) && file !== 'package.json')) {
      throw new Error('package.files must be an explicit allowlist of unique, flat filenames');
    }
    const releases = path.join(root, 'releases');
    if (exists(releases) && !fs.lstatSync(releases).isDirectory()) throw new Error('releases must be a real directory');
    const destination = path.join(releases, `v${version}`);
    const refuseDuplicate = () => { if (exists(destination)) throw new Error(`Release already exists: v${version}`); };
    refuseDuplicate();

    const cache = path.join(root, '.test-artifacts', 'npm-cache');
    directory(path.dirname(cache));
    directory(cache);
    const userConfig = path.join(lockDir, 'user.npmrc');
    const globalConfig = path.join(lockDir, 'global.npmrc');
    fs.writeFileSync(userConfig, '');
    fs.writeFileSync(globalConfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && !/^(NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key)));
    Object.assign(env, {
      npm_config_cache: cache, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
      npm_config_fund: 'false', npm_config_update_notifier: 'false',
    });
    const npm = (args, cwd) => {
      const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.error || result.status !== 0) {
        const diagnostics = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
        throw new Error(`npm ${args.join(' ')} failed: ${diagnostics}`);
      }
      return result.stdout;
    };
    // The check sees the original version; no project manifest is written before it passes.
    npm(['run', 'check'], root);
    manifests.forEach(unchanged);
    pkg.version = lock.version = lock.packages[''].version = version;
    for (const item of manifests) item.next = increment ? JSON.stringify(item.value, null, 2) + '\n' : item.original;
    const packRoot = path.join(lockDir, 'package');
    fs.mkdirSync(packRoot);
    fs.writeFileSync(path.join(packRoot, 'package.json'), manifests[0].next);
    for (const file of pkg.files) {
      const source = path.join(root, file);
      if (!fs.lstatSync(source).isFile()) throw new Error(`Allowlisted file must be a regular file: ${file}`);
      fs.copyFileSync(source, path.join(packRoot, file), fs.constants.COPYFILE_EXCL);
    }
    const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], packRoot));
    const info = packed[0];
    const expected = [...pkg.files, 'package.json'].sort();
    if (packed.length !== 1 || info.name !== pkg.name || info.version !== version ||
        JSON.stringify(info.files.map(file => file.path).sort()) !== JSON.stringify(expected) ||
        typeof info.filename !== 'string' || path.basename(info.filename) !== info.filename || !info.filename.endsWith('.tgz')) {
      throw new Error('npm pack output does not match the exact allowlist and version');
    }
    const archive = path.join(packRoot, info.filename);
    const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    directory(releases);
    staging = fs.mkdtempSync(path.join(releases, `.v${version}-`));
    fs.copyFileSync(archive, path.join(staging, info.filename), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${sha256}  ${info.filename}\n`);
    fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ name: pkg.name, version, sha256, artifact: info.filename }, null, 2) + '\n');
    refuseDuplicate();
    manifests.forEach(unchanged);
    // Backups remain inside the lock until publication. On interruption, stop and inspect them.
    for (const item of increment ? manifests : []) {
      unchanged(item);
      const nextPath = path.join(lockDir, `${item.file}.next`);
      fs.writeFileSync(nextPath, item.next, { flag: 'wx' });
      fs.renameSync(nextPath, item.target);
      item.updated = true;
    }
    manifests.forEach(unchanged);
    refuseDuplicate();
    fs.renameSync(staging, destination); // Commit point: never roll back after this succeeds.
    committed = true;
    staging = undefined;
    const result = { name: pkg.name, version, directory: destination, artifact: info.filename, sha256 };
    try { cleanup(); }
    catch (error) { result.warning = `Release committed, but cleanup failed: ${error.message}. Inspect ${lockDir} manually.`; }
    return result;
  } catch (error) {
    if (committed) throw error;
    try {
      for (const item of manifests.filter(item => item.updated)) {
        // Preserve concurrent edits, retaining recovery backups instead of overwriting them.
        if (!fs.lstatSync(item.target).isFile() || fs.readFileSync(item.target, 'utf8') !== item.next) {
          throw new Error(`${item.file} changed after update; manual recovery required`);
        }
        fs.renameSync(path.join(lockDir, `${item.file}.original`), item.target);
      }
      cleanup();
    } catch (recoveryError) {
      throw new Error(`${error.message}; recovery incomplete: ${recoveryError.message}. Inspect ${lockDir} manually.`, { cause: error });
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--current')) {
      throw new Error('Usage: node scripts/release.mjs [--current vX.Y.Z]');
    }
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = args.length === 0 ? release(root) : packageCurrent(root, args[1]);
    console.log(`Local release ${result.version}: ${result.directory}`);
    if (result.warning) console.warn(result.warning);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
