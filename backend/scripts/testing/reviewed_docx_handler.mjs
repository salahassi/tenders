#!/usr/bin/env node
// Synthetic Auth/Storage/authority fixture, actual API and canonical verifier.
// This qualifies no hosted authorization and never calls a network dependency.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, documentPath, requestPath, outputPath, expectedError] = process.argv.slice(2);
if (!repository || !documentPath || !requestPath || !outputPath) throw new Error('repository DOCX request.json output.json [expected-error] required');
const load = (path) => import(pathToFileURL(resolve(repository, path)).href);
const { createApiHandler } = await load('backend/supabase/functions/api/handler.ts');
const { modelEnvironments } = await load('backend/supabase/functions/_shared/backend.ts');
const { buildExportModel } = await load('backend/supabase/functions/_shared/export.ts');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(documentPath), requestBytes = await readFile(requestPath);
const request = JSON.parse(requestBytes.toString('utf8'));
// Explicit synthetic server-owned context pin, not a claim of DB admission.
request.snapshot.export_renderer_version = 'ordinary-2';
const model = buildExportModel(request);
const actor = '00000000-0000-4000-8000-000000000001', artifactId = '00000000-0000-4000-8000-000000000002';
const artifact = { id: artifactId, original_name: 'synthetic-reviewed.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expected_size: bytes.length, content_hash: hash(bytes), storage_key: 'synthetic/reviewed', kind: 'reviewed', status: 'pending' };
const calls = [];
const backend = {
  authenticate: async () => ({ id: actor }), membership: async () => ({ workspace_id: actor, role: 'Owner' }),
  userRpc: async (_token, name, args) => { calls.push({ name, args }); if (name !== 'artifact_context') throw new Error('unexpected context'); return { artifact, request }; },
  object: async () => new Blob([bytes]),
  internal: async (name, args) => { calls.push({ name, args }); if (name !== 'complete_export_artifact') throw new Error('unexpected mutation'); return { id: artifactId, status: 'ready' }; },
};
const env = { url: 'https://synthetic.invalid', publishableKey: 'synthetic-key', serviceKey: 'synthetic-service', workerSecret: 'synthetic-worker', allowedOrigins: ['https://synthetic-client.invalid'], models: modelEnvironments(() => undefined) };
const handler = createApiHandler(env, () => backend);
const started = performance.now();
const response = await handler(new Request(`https://synthetic.invalid/functions/v1/api/v1/export-artifacts/${artifactId}/complete`, { method: 'POST', headers: { origin: env.allowedOrigins[0], authorization: 'Bearer synthetic-caller' } }));
const result = await response.json();
const source = {};
for (const path of ['backend/supabase/functions/api/handler.ts', 'backend/supabase/functions/_shared/originals.ts', 'backend/supabase/functions/_shared/exportUpload.ts', 'backend/supabase/functions/_shared/export.ts', 'backend/supabase/functions/_shared/boundedDocx.ts', 'backend/supabase/functions/_shared/boundedDocxArchive.ts']) {
  try { source[path] = hash(await readFile(resolve(repository, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; source[path] = null; }
}
const passed = expectedError ? response.status === 422 && result.error?.code === expectedError && !calls.some((call) => call.name === 'complete_export_artifact') : response.status === 200 && result.data?.status === 'ready' && calls.filter((call) => call.name === 'complete_export_artifact').length === 1;
const receipt = { version: 1, scope: expectedError ? 'Actual handler expected rejection; synthetic Auth/Storage/server-owned ordinary-2 pin; no SQL admission/hosted/native-memory claim' : 'Actual handler and canonical verifier; synthetic Auth/Storage/server-owned ordinary-2 pin; no SQL admission/hosted/native-memory claim', node: process.version, artifact_sha256: hash(bytes), artifact_bytes: bytes.length, request_sha256: hash(requestBytes), model_sha256: hash(JSON.stringify(model)), source_sha256: source, status: response.status, error_code: result.error?.code ?? null, completion_calls: calls.filter((call) => call.name === 'complete_export_artifact').length, duration_ms: performance.now() - started, expected_error: expectedError ?? null, passed };
await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
if (!passed) process.exitCode = 1;
