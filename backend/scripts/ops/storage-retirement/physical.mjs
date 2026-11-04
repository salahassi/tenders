/** Linux-only physical census for the pinned StorageAPI file backend.
 * The caller must prove retired-key fencing, stopped writers, PVC identity and
 * absence of another logical owner's path alias. This module grants no authority
 * and never releases quota. It hashes/unlinks exact files under that proof.
 */
import { constants } from 'node:fs';
import { open, lstat, opendir, unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIMITS = Object.freeze({ files: 256, directoryEntries: 16384, fileBytes: 10485760, totalBytes: 262144000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_.-]{1,255}$/;
// Actual pinned file-store uses .json for its TUS configstore. The binary's
// object-admin cleanup also recognizes .info. Both remain exact UUID sidecars.
const SIDECARS = ['.info', '.json'];
function physicalVersion(name) { const suffix = SIDECARS.find(value => name.endsWith(value)); return suffix ? name.slice(0, -suffix.length) : name; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function requireThat(ok, code) { if (!ok) fail(code); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  requireThat(plain(value), 'PHYSICAL_INVALID_JSON');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
export function sha256Json(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function segment(value) { requireThat(typeof value === 'string' && SEGMENT.test(value) && !['.', '..'].includes(value), 'PHYSICAL_INVALID_SCOPE'); return value; }
export function validateScope(scope) {
  requireThat(plain(scope) && Object.keys(scope).sort().join(',') === 'bucketId,globalBucket,operationNonce,storageKey,tenantId,version,versionSeparator', 'PHYSICAL_INVALID_SCOPE');
  requireThat(scope.version === 1 && typeof scope.operationNonce === 'string' && UUID.test(scope.operationNonce), 'PHYSICAL_INVALID_SCOPE');
  requireThat(scope.bucketId === 'tenderdesk-private' && ['/', '-$v-'].includes(scope.versionSeparator), 'PHYSICAL_INVALID_SCOPE');
  segment(scope.globalBucket); segment(scope.tenantId);
  requireThat(typeof scope.storageKey === 'string' && scope.storageKey.length <= 2048, 'PHYSICAL_INVALID_SCOPE');
  const parts = scope.storageKey.split('/');
  requireThat(parts.length >= 1 && parts.length <= 32, 'PHYSICAL_INVALID_SCOPE');
  parts.forEach(segment);
  return [scope.globalBucket, scope.tenantId, scope.bucketId, ...parts];
}
const at = (directory, name = '') => `/proc/self/fd/${directory.fd}${name ? '/' + name : ''}`;
const identity = stat => `${stat.dev}:${stat.ino}`;
const stable = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
async function directoryChild(parent, name) {
  try {
    return await open(at(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('PHYSICAL_UNSAFE_DIRECTORY');
  }
}
async function rootHandle(root) {
  requireThat(process.platform === 'linux' && typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root && root !== '/', 'PHYSICAL_UNSAFE_ROOT');
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of root.slice(1).split('/')) {
      const next = await directoryChild(handle, component);
      requireThat(next, 'PHYSICAL_ROOT_MISSING');
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function parentHandle(root, components) {
  let handle = await rootHandle(root);
  try {
    for (const component of components) {
      const next = await directoryChild(handle, component);
      await handle.close();
      if (!next) return null;
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
async function statAt(parent, name) {
  try { return await lstat(at(parent, name), { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function entries(parent) {
  const result = [], directory = await opendir(at(parent));
  for await (const entry of directory) {
    requireThat(result.length < LIMITS.directoryEntries, 'PHYSICAL_CENSUS_LIMIT');
    result.push(entry.name);
  }
  return result;
}
async function censusNames(root, scope) {
  const components = validateScope(scope), leaf = components.at(-1);
  const parent = await parentHandle(root, components.slice(0, -1));
  if (!parent) return [];
  const result = [];
  try {
    const exact = await statAt(parent, leaf);
    if (exact?.isDirectory()) {
      const versions = await directoryChild(parent, leaf);
      requireThat(versions, 'PHYSICAL_CHANGED');
      try {
        for (const name of await entries(versions)) {
          const version = physicalVersion(name);
          requireThat(UUID.test(version), 'PHYSICAL_UNKNOWN_FAMILY_MEMBER');
          result.push([...components, name].join('/'));
        }
      } finally { await versions.close(); }
    } else if (exact) {
      requireThat(exact.isFile(), 'PHYSICAL_UNSAFE_FILE');
      result.push(components.join('/'));
    }
    // A bare K.info is ambiguous with an unversioned logical object named K.info.
    // Unlike UUID-version .info, the initial proof supports no such assumption.
    for (const suffix of SIDECARS) requireThat(!(await statAt(parent, leaf + suffix)), 'PHYSICAL_UNKNOWN_SIDECAR');
    // Both layouts are supported by the pinned binary; an unknown old write may
    // predate a version-separator setting change. Never restrict by metadata's
    // current version and never include an ordinary sibling-prefix key.
    for (const name of await entries(parent)) {
      if (!name.startsWith(leaf + '-$v-')) continue;
      const suffix = name.slice((leaf + '-$v-').length);
      const version = physicalVersion(suffix);
      requireThat(UUID.test(version), 'PHYSICAL_UNKNOWN_FAMILY_MEMBER');
      result.push([...components.slice(0, -1), name].join('/'));
    }
    requireThat(result.length <= LIMITS.files, 'PHYSICAL_CENSUS_LIMIT');
    return result.sort();
  } finally { await parent.close(); }
}
async function fileReceipt(root, relativePath) {
  const pieces = relativePath.split('/');
  const parent = await parentHandle(root, pieces.slice(0, -1));
  requireThat(parent, 'PHYSICAL_CHANGED');
  let file;
  try {
    const before = await statAt(parent, pieces.at(-1));
    requireThat(before?.isFile() && before.nlink === 1n, 'PHYSICAL_UNSAFE_FILE');
    requireThat(before.size <= BigInt(LIMITS.fileBytes), 'PHYSICAL_BYTE_LIMIT');
    try { file = await open(at(parent, pieces.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { fail('PHYSICAL_CHANGED'); }
    const opened = await file.stat({ bigint: true });
    requireThat(opened.isFile() && stable(before) === stable(opened) && opened.nlink === 1n, 'PHYSICAL_CHANGED');
    const hash = createHash('sha256'), buffer = Buffer.alloc(131072);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      requireThat(total <= LIMITS.fileBytes, 'PHYSICAL_BYTE_LIMIT');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    requireThat(stable(opened) === stable(after) && total === Number(after.size), 'PHYSICAL_CHANGED');
    return { receipt: { relativePath, size: total, sha256: hash.digest('hex') }, identity: stable(after) };
  } finally { await file?.close(); await parent.close(); }
}
function manifest(scope, files) {
  const value = { version: 1, operationNonce: scope.operationNonce, scopeSha256: sha256Json(scope), files, absent: files.length === 0 };
  return { ...value, manifestSha256: sha256Json(value) };
}
async function syncScopeDirectories(root, scope) {
  // Also sync an already-absent family: a previous attempt may have unlinked a
  // file but failed its directory fsync. A fresh absence census is not itself a
  // durability barrier. Stop at the nearest existing directory, syncing it too.
  const components = validateScope(scope);
  let handle = await rootHandle(root);
  try {
    await handle.sync();
    for (const name of components) {
      const stat = await statAt(handle, name);
      if (!stat) break;
      requireThat(stat.isDirectory(), 'PHYSICAL_CHANGED');
      const child = await directoryChild(handle, name);
      requireThat(child, 'PHYSICAL_CHANGED');
      await handle.close(); handle = child;
      await handle.sync();
    }
  } finally { await handle.close(); }
}
export async function inspectScope(root, scope) {
  const names = await censusNames(root, scope), files = [];
  let bytes = 0;
  for (const name of names) {
    const { receipt } = await fileReceipt(root, name);
    bytes += receipt.size;
    requireThat(bytes <= LIMITS.totalBytes, 'PHYSICAL_BYTE_LIMIT');
    files.push(receipt);
  }
  requireThat(canonicalJson(await censusNames(root, scope)) === canonicalJson(names), 'PHYSICAL_CHANGED');
  return manifest(scope, files);
}
export async function reconcileScope(root, scope, expectedManifest) {
  validateScope(scope);
  requireThat(plain(expectedManifest), 'PHYSICAL_MANIFEST_MISMATCH');
  const { manifestSha256, ...unsigned } = expectedManifest;
  requireThat(manifestSha256 === sha256Json(unsigned), 'PHYSICAL_MANIFEST_MISMATCH');
  const before = await inspectScope(root, scope);
  requireThat(canonicalJson(expectedManifest) === canonicalJson(before), 'PHYSICAL_MANIFEST_MISMATCH');
  let removedCount = 0, removedBytes = 0;
  for (const expected of before.files) {
    const observed = await fileReceipt(root, expected.relativePath);
    requireThat(canonicalJson(observed.receipt) === canonicalJson(expected), 'PHYSICAL_CHANGED');
    const pieces = expected.relativePath.split('/'), parent = await parentHandle(root, pieces.slice(0, -1));
    requireThat(parent, 'PHYSICAL_CHANGED');
    try {
      const final = await statAt(parent, pieces.at(-1));
      requireThat(final?.isFile() && final.nlink === 1n && stable(final) === observed.identity, 'PHYSICAL_CHANGED');
      await unlink(at(parent, pieces.at(-1)));
      // The later SQL receipt may durably release the allowance. Do not issue
      // its absence evidence until this directory's unlink is durable too.
      // Errors propagate; partial progress never authorizes quota release.
      await parent.sync();
      removedCount++; removedBytes += expected.size;
    } finally { await parent.close(); }
  }
  await syncScopeDirectories(root, scope);
  const after = await inspectScope(root, scope);
  requireThat(after.absent, 'PHYSICAL_CHANGED');
  return { ...after, beforeManifestSha256: before.manifestSha256, afterManifestSha256: after.manifestSha256, removedCount, removedBytes, remainingCount: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireThat(process.argv.length === 3 && ['inspect', 'remove'].includes(process.argv[2]), 'PHYSICAL_INVALID_COMMAND');
    const scope = JSON.parse(await readFile('/run/storage-retirement/scope.json', 'utf8'));
    const result = process.argv[2] === 'inspect'
      ? await inspectScope('/var/lib/storage', scope)
      : await reconcileScope('/var/lib/storage', scope, JSON.parse(await readFile('/run/storage-retirement/expected-manifest.json', 'utf8')));
    process.stdout.write(canonicalJson(result) + '\n');
  } catch (error) {
    process.stderr.write(canonicalJson({ error: /^PHYSICAL_[A-Z_]+$/.test(error.code || '') ? error.code : 'PHYSICAL_IO_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
