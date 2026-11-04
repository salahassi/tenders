import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, truncate, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspectScope, reconcileScope, canonicalJson, sha256Json, LIMITS } from './physical.mjs';

const scope = { version: 1, operationNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', globalBucket: 'retirement', tenantId: 'retirement', bucketId: 'tenderdesk-private', storageKey: 'workspace/artifacts/key.docx', versionSeparator: '/' };
const version = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'physical-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, scope.globalBucket, scope.tenantId, scope.bucketId, scope.storageKey);
  async function put(relative = '/' + version, text = 'synthetic bytes') { const file = base + relative; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; }
  return { root, base, put };
}

test('exact dual-layout census and compare-and-remove preserve sibling-prefix objects', async t => {
  const { root, base, put } = await fixture(t);
  await put(); await put('/' + version + '.info', '{}'); await put('/' + version + '.json', '{}'); await put('-$v-' + version, 'legacy');
  const sibling = await put('-other', 'must remain');
  const before = await inspectScope(root, scope);
  assert.equal(before.files.length, 4); assert.equal(before.absent, false);
  assert.deepEqual((await inspectScope(root, { ...scope, versionSeparator: '-$v-' })).files, before.files);
  const removed = await reconcileScope(root, scope, before);
  assert.equal(removed.removedCount, 4); assert.equal(removed.removedBytes, 25);
  assert.equal(removed.remainingCount, 0); assert.equal(removed.beforeManifestSha256, before.manifestSha256);
  assert.equal(await readFile(sibling, 'utf8'), 'must remain');
  const after = await inspectScope(root, scope);
  assert.equal(after.absent, true);
  assert.equal((await reconcileScope(root, scope, after)).removedCount, 0);
  assert.ok(base.startsWith(root));
});
test('unversioned exact base and absent descendant are supported', async t => {
  const { root, put } = await fixture(t);
  assert.equal((await inspectScope(root, scope)).absent, true);
  await put('', 'base');
  const saved = await inspectScope(root, scope);
  assert.equal(saved.files[0].size, 4);
  assert.equal((await reconcileScope(root, scope, saved)).removedBytes, 4);
});
test('canonical JSON uses recursively sorted keys and UTF8, including numeric keys', () => {
  assert.equal(canonicalJson({ z: 'ب', a: { 2: 'b', 10: 'a' } }), '{"a":{"10":"a","2":"b"},"z":"ب"}');
  assert.equal(sha256Json({ z: 'ب', a: { 2: 'b', 10: 'a' } }), '17d794cd0f02019da5ce9d174903ebb292a8c58771985b021a232e87cca60708');
});
test('unsafe selectors fail without reading/deleting', async t => {
  const { root, put } = await fixture(t); await put();
  for (const storageKey of ['/absolute', '../key', 'key/../other', 'key\\other', 'a/%2e%2e', 'a//b']) {
    await assert.rejects(inspectScope(root, { ...scope, storageKey }), { code: 'PHYSICAL_INVALID_SCOPE' });
  }
  for (const patch of [{ bucketId: 'other' }, { operationNonce: null }, { root: '/' }, { version: 2 }]) {
    await assert.rejects(inspectScope(root, { ...scope, ...patch }), { code: 'PHYSICAL_INVALID_SCOPE' });
  }
  assert.equal((await inspectScope(root, scope)).files.length, 1);
});
test('ancestor and final symlinks never follow outside the selected root', async t => {
  const { root, base } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'physical-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const victim = path.join(outside, 'victim'); await writeFile(victim, 'unchanged');
  await mkdir(path.dirname(base), { recursive: true }); await symlink(victim, base);
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_UNSAFE_FILE' });
  await rm(base); await rm(path.dirname(base), { recursive: true }); await symlink(outside, path.dirname(base));
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_UNSAFE_DIRECTORY' });
  assert.equal(await readFile(victim, 'utf8'), 'unchanged');
});
test('hard links and unknown family member types are rejected', async t => {
  const { root, base, put } = await fixture(t);
  const file = await put(); await link(file, path.join(root, 'alias'));
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_UNSAFE_FILE' });
  await rm(path.join(root, 'alias')); await mkdir(base + '/' + randomUUID());
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_UNSAFE_FILE' });
});
test('unknown names, malformed versions and ambiguous bare sidecars fail closed', async t => {
  const { root, base, put } = await fixture(t); await put();
  for (const suffix of ['/not-a-version', '-$v-invalid', '.info', '.json']) {
    const file = await put(suffix, 'unknown');
    await assert.rejects(inspectScope(root, scope), error => ['PHYSICAL_UNKNOWN_FAMILY_MEMBER', 'PHYSICAL_UNKNOWN_SIDECAR'].includes(error.code));
    await rm(file);
  }
  assert.equal((await inspectScope(root, scope)).files.length, 1);
  assert.ok(base);
});
test('same-sized changed bytes fail the prior manifest before deleting any file', async t => {
  const { root, put } = await fixture(t);
  const first = await put('/' + version, 'first'); await put('/' + randomUUID(), 'other');
  const saved = await inspectScope(root, scope); await writeFile(first, 'after');
  await assert.rejects(reconcileScope(root, scope, saved), { code: 'PHYSICAL_MANIFEST_MISMATCH' });
  assert.equal((await inspectScope(root, scope)).files.length, 2);
});
test('new family member, forged manifest or other operation nonce cannot reuse approval', async t => {
  const { root, put } = await fixture(t); await put();
  const saved = await inspectScope(root, scope);
  await assert.rejects(reconcileScope(root, { ...scope, operationNonce: randomUUID() }, saved), { code: 'PHYSICAL_MANIFEST_MISMATCH' });
  await assert.rejects(reconcileScope(root, scope, { ...saved, files: [] }), { code: 'PHYSICAL_MANIFEST_MISMATCH' });
  await put('/' + randomUUID());
  await assert.rejects(reconcileScope(root, scope, saved), { code: 'PHYSICAL_MANIFEST_MISMATCH' });
  assert.equal((await inspectScope(root, scope)).files.length, 2);
});
test('file-size and count ceilings fail explicitly and leave physical files intact', async t => {
  const { root, put } = await fixture(t); const large = await put(); await truncate(large, LIMITS.fileBytes + 1);
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_BYTE_LIMIT' }); await truncate(large, 0);
  for (let n = 0; n < LIMITS.files; n++) await put('/' + randomUUID(), '');
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_CENSUS_LIMIT' });
  assert.equal((await readFile(large)).length, 0);
});
test('aggregate byte ceiling does not truncate the manifest or remove admitted members', async t => {
  const { root, put } = await fixture(t);
  const count = Math.floor(LIMITS.totalBytes / LIMITS.fileBytes) + 1;
  const files = [];
  for (let n = 0; n < count; n++) { const file = await put('/' + randomUUID(), ''); await truncate(file, LIMITS.fileBytes); files.push(file); }
  await assert.rejects(inspectScope(root, scope), { code: 'PHYSICAL_BYTE_LIMIT' });
  // Sparse fixture files limit actual disk allocation; hashes still cover every
  // logical byte before the explicit aggregate ceiling is reported.
  assert.equal((await readFile(files[0])).length, LIMITS.fileBytes);
});
test('directory fsync failure issues no success receipt, and an absent retry still syncs', async t => {
  const { root, put } = await fixture(t); await put();
  const saved = await inspectScope(root, scope);
  const handle = await open(root); const prototype = Object.getPrototypeOf(handle); await handle.close();
  const original = prototype.sync; let calls = 0;
  prototype.sync = async function () { calls++; throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }); };
  try {
    await assert.rejects(reconcileScope(root, scope, saved), { code: 'EIO' });
    assert.equal(calls, 1);
    const absent = await inspectScope(root, scope); assert.equal(absent.absent, true);
    await assert.rejects(reconcileScope(root, scope, absent), { code: 'EIO' });
    assert.equal(calls, 2, 'absence alone cannot bypass the durability barrier');
  } finally { prototype.sync = original; }
  const after = await inspectScope(root, scope);
  assert.equal((await reconcileScope(root, scope, after)).remainingCount, 0);
});
