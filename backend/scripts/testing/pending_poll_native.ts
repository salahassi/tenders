/** Native image probe. Product imports resolve only inside the immutable image.
 * Backend/store doubles exercise phase identity, not SQL/provider behavior. */
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const product = "/app/backend/supabase/functions/_shared/";
const { modelPrompt, sha256, executeModel, ModelDeferred } = await import(product + "model.ts");
const { canonicalSourceSpanId, validateSourceCandidate } = await import(product + "sourceEvidence.ts");
const { candidateContent } = await import(product + "modelGrounding.ts");
const { pinSemanticPrompt, readSemanticPromptRevision } = await import(product + "modelSemanticPrompt.ts");
const { semanticPolicyText } = await import(product + "modelSemanticInstructions.ts");
const { pinVerificationPrompt } = await import(product + "modelVerificationPrompt.ts");
const { verificationPolicyText } = await import(product + "modelVerificationInstructions.ts");

const baseline = runtime.env.get("NATIVE_BASELINE_MODE") === "true";
const check = (condition: unknown, code: string) => { if (!condition) throw new Error(code); };
const equal = (a: unknown, b: unknown, code: string) => check(JSON.stringify(a) === JSON.stringify(b), code);
const metadataLabel = (value: unknown) => check(typeof value === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(value), "PROMPT_METADATA_CONTRACT");
const rejected = async (run: () => unknown | Promise<unknown>, code = "MODEL_IDENTITY_CHANGED") => {
  try { await run(); } catch (error) { check(String(error).includes(code), "WRONG_REJECTION"); return; }
  throw new Error("EXPECTED_REJECTION");
};
const block = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
function fixture(sourceKind: "document" | "notice" = "document", referenceOnly = false) {
  const quotes = referenceOnly ? ["Historical example for a different buyer. ".repeat(16), "Reference material, not this buyer's request for proposal. ".repeat(16)] :
    ["Do not pay before acceptance of ٣ units. 😀\r\n".repeat(16), "Retain the buyer's explicit exception and original conditions.\r\n".repeat(16)];
  const spans = quotes.map((quote, index) => {
    const value = { version: 1, entity_kind: sourceKind, entity_id: block, content_hash: hash,
      extraction_version: "native-v1", block_id: block, block_hash: "b".repeat(64),
      coordinate: "unicode_code_point", start: index * 2000, end: index * 2000 + Array.from(quote).length,
      quote, locator: { kind: "synthetic", paragraph: index + 1 }, authority: {
        version: 1, decision_id: referenceOnly ? null : block, revision: referenceOnly ? 0 : 1,
        role: referenceOnly ? "unknown" : "buyer_rfp", status: referenceOnly ? "unconfirmed" : "confirmed",
        supersedes: null, precedence: 0,
      } };
    return { ...value, id: canonicalSourceSpanId(value as any) };
  });
  const reference = { entity_kind: sourceKind, entity_id: block, content_hash: hash };
  const kind = sourceKind === "notice" ? "notice" : "rfp";
  const evidence: any[] = [{ id: block, text: quotes.join("\n"), kind, verified: false, reference,
    locator: { kind: "synthetic" } }, ...spans.map((span) => ({
      id: span.id, text: span.quote, kind, verified: false, reference, source_span: span,
    }))];
  const candidate: any = { processed_block_ids: [block], requirements: [{
    text: quotes.join("\n[Separate source passage]\n"), category: "contractual", mandatory: true,
    source_refs: spans.map((span) => ({ id: span.id, quote: span.quote })),
    interpretation: "Payment is conditional on acceptance.", acceptance_evidence: "Acceptance record", owner_question: null,
    source_semantics: { version: 1, modality: "prohibited", actor: "supplier", negated: true,
      conditions: ["acceptance"], exceptions: ["explicit exception"], consequences: [],
      quantities: [{ value: "3", unit: "units", currency: null }], dates: [],
      source_span_ids: spans.map((span) => span.id), authority_role: "buyer_rfp", authority_status: "confirmed",
      review_status: "pending", review_id: null } }], questions: [], separate_volumes: false,
    summary: "Preserve the buyer's payment condition." };
  const original = { source_contract_version: 1, repair_contract_version: 1,
    source_evidence: { version: 1, spans, reviews: [] } };
  const context: any = { original_task: "analyze_chunk", original_context: original, candidate,
    candidate_hash: "c".repeat(64), content_units: candidateContent(candidate) };
  return { block, spans, evidence, candidate, original, context, requiredIds: [block] };
}
const x = fixture();
x.context.candidate_hash = await sha256(JSON.stringify(x.candidate));
const before = JSON.stringify(x);
validateSourceCandidate("analyze_chunk", x.candidate, x.original, x.evidence);

function memory(started: boolean) {
  const records = new Map<string, any>();
  const calls: any[] = [];
  let writes = 0;
  const backend = { internal: async (name: string, args: any) => {
    check(name === "model_phase_started", "UNEXPECTED_BACKEND_CALL"); calls.push({ name, args }); return started;
  } };
  const store = { action: async (operation: string, args: any) => {
    if (operation === "result_get") return records.get(args.key) ?? null;
    check(operation === "result_put", "UNEXPECTED_STORE_CALL"); writes++;
    const result = { value: structuredClone(args.value) }; records.set(args.key, result); return result;
  } };
  return { backend, store, records, calls, writes: () => writes };
}
const semanticOptions = (m: ReturnType<typeof memory>, prefix: string, task: any = "analyze_chunk", context: any = x.original) => ({
  backend: m.backend, store: m.store, job: { id: block, lease_token: block }, requestPrefix: prefix,
  task, context, evidence: x.evidence, requiredIds: x.requiredIds, language: "ar" as const,
  repair: false, verificationRevision: task === "verify_grounding" ? 6 : 1,
});
const verificationOptions = (m: ReturnType<typeof memory>, prefix: string) => ({
  backend: m.backend, store: m.store, job: { id: block, lease_token: block, checkpoint: {} }, requestPrefix: prefix,
  context: x.context, evidence: x.evidence, requiredIds: x.requiredIds, language: "ar" as const, repair: false,
});
const revision6PromptHashes: Record<string, string> = {};
for (const language of ["en", "ar"] as const) {
  for (const task of ["analyze_chunk", "repair_result"] as const) {
    const context = task === "analyze_chunk" ? x.original : { target_task: "analyze_chunk", original_context: x.original };
    const wire = modelPrompt(task, context, x.evidence, x.requiredIds, language, false, 1, 6);
    metadataLabel(JSON.parse(wire).prompt_version);
    revision6PromptHashes[`${task}:${language}:s6:v1`] = await sha256(wire);
  }
  for (const semantic of [0, 1, 2, 3, 4, 5, 6] as const) for (const verification of [1, 2, 3, 4, 5, 6] as const) {
    if (semantic !== 6 && verification !== 6) continue;
    const wire = modelPrompt("verify_grounding", x.context, x.evidence, x.requiredIds, language, false, verification, semantic);
    metadataLabel(JSON.parse(wire).prompt_version);
    revision6PromptHashes[`verify_grounding:${language}:s${semantic}:v${verification}`] = await sha256(wire);
  }
}
const revision6PinHashes: Record<string, string> = {};
for (const phase of ["semantic", "verification"] as const) {
  const created = memory(false), prefix = `synthetic:accepted-poll:phase:${phase}:6`;
  const select = phase === "semantic" ? pinSemanticPrompt : pinVerificationPrompt;
  const options = phase === "semantic" ? semanticOptions(created, prefix) : verificationOptions(created, prefix);
  check(await select(options) === 6, "REVISION6_PIN_NOT_SELECTED");
  check(created.writes() === 1 && created.calls.length === 1, "REVISION6_PIN_CREATE_COUNT");
  const key = `${phase === "semantic" ? "semantic" : "verification"}-instructions-${await sha256(prefix)}`;
  const record = created.records.get(key);
  check(record?.value?.version === 6, "REVISION6_PIN_MISSING");
  revision6PinHashes[`${phase}:6`] = await sha256(JSON.stringify(record.value));
  const accepted = memory(false); accepted.records.set(key, structuredClone(record));
  const replay = phase === "semantic" ? semanticOptions(accepted, prefix) : verificationOptions(accepted, prefix);
  check(await select(replay) === 6 && accepted.writes() === 0 && accepted.calls.length === 0, "REVISION6_PIN_REPLAY_CHANGED");
  equal(accepted.records.get(key), record, "REVISION6_ACCEPTED_RECORD_CHANGED");
}
const checks: Record<string, boolean> = {};
let generationPosts = 0, newReservations = 0;
if (!baseline) {
  const { prepareAcceptedModelPoll } = await import(product + "modelAcceptedPoll.ts");
  const { defaultCapabilities, taskRegistry } = await import(product + "modelContract.ts");
  // Every transport is an in-process response double. An unexpected transport,
  // reservation, checkpoint or generation fails before it can have any effect.
  const fixturePoll = async (status = "completed", invalid: "schema" | "coverage" | "quote" | null = null) => {
    const events: string[] = [], backendCalls: any[] = [], ledgerCalls: any[] = [], methods: string[] = [];
    const capabilities = defaultCapabilities("openai");
    const profile = { ...taskRegistry.draft_section.profile, reasoning: "none" };
    const configuration: any = { provider: "openai", model: "synthetic-model", project_ref: "synthetic-project",
      connection_id: block, model_config_id: block, enabled: true, free_only: false, billing_verified: true,
      free_quota_only: false, verified_at: new Date().toISOString(), quota_mode: "provider_managed",
      quota_ends_at: null, route_revision: 3, profile, capabilities };
    const environment = { provider: "openai", model: configuration.model, projectRef: configuration.project_ref,
      key: "synthetic-offline-key" };
    const context = { key: "approach" };
    const evidence = [{ id: "synthetic-evidence", kind: "rfp", verified: false,
      text: "Proposed workflow requires buyer approval." }];
    const requiredIds = ["synthetic-requirement"];
    const prompt = modelPrompt("draft_section", context, evidence, requiredIds, "en", false, 1, 5);
    const inputHash = await sha256(prompt), prefix = "synthetic:pending-poll:candidate-0", thread = "d".repeat(64);
    const candidate: any = { key: "approach", title: "Approach",
      content_blocks: [{ type: "paragraph", text: evidence[0].text }], requirement_ids: requiredIds,
      evidence_refs: [{ id: evidence[0].id, quote: evidence[0].text }], company_claims: [], assumptions: [], questions: [] };
    if (invalid === "schema") delete candidate.content_blocks;
    if (invalid === "coverage") candidate.requirement_ids = [];
    if (invalid === "quote") candidate.evidence_refs[0].quote = "A different unsupported quotation.";
    const pending: any = { id: "synthetic-usage", remote_request_id: "resp_native_poll", state: "reserved",
      remote_deadline: new Date(Date.now() + 600000).toISOString(), execution_metadata: {
        input_hash: inputHash, prompt_version: JSON.parse(prompt).prompt_version, schema_version: "1",
        contract_version: "1", profile, capabilities, route_revision: 3, reasoning_control: null,
      } };
    const issuance = { id: block, deadline_at: new Date(Date.now() + 120000).toISOString(), outcome: "active", error_code: null };
    const prepared: any = { version: 1, operation: "draft_section", request_prefix: prefix, attempt_id: "41",
      pending, configuration, issuance_request: issuance };
    const job: any = { id: block, lease_token: block, checkpoint: { model_executor: 2, graph_thread: thread,
      model_round: { input_hash: inputHash, remaining: [configuration], output_error: null, retry_windows: [] },
      model_routing: { providers: [configuration] } } };
    const manifest: any[] = [{ entity_kind: "document", entity_id: block, content_hash: hash }];
    let rpcValue: any = prepared;
    const backend: any = { internal: async (name: string, args: any) => {
      events.push(name); backendCalls.push({ name, args });
      if (name === "prepare_accepted_model_poll") {
        equal(args, { job_id: job.id, lease: job.lease_token, thread_id: thread,
          graph_input_hash: hash, manifest }, "FUSED_RPC_IDENTITY_CHANGED");
        return structuredClone(rpcValue);
      }
      if (name === "finish_model_attempt") {
        check(args.attempt_id === "41" && args.lease === job.lease_token && args.result_code === "MODEL_IN_PROGRESS"
          && args.sent === false && args.usage_id === pending.id, "PENDING_ATTEMPT_CHANGED");
        return true;
      }
      if (name === "defer_pending_model_request") {
        equal(args, { job_id: job.id, lease: job.lease_token, reservation: pending.id }, "PENDING_RESERVATION_CHANGED");
        return true;
      }
      throw new Error("UNEXPECTED_POLL_BACKEND_CALL");
    } };
    const fetcher: typeof fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") generationPosts++;
      check(method === "GET" || method === "DELETE", "GENERATION_OR_EXTRA_TRANSPORT");
      check(String(url) === "https://api.openai.com/v1/responses/" + pending.remote_request_id, "REMOTE_ID_CHANGED");
      methods.push(method); events.push("HTTP:" + method);
      if (method === "DELETE") return Response.json({ id: pending.remote_request_id, deleted: true });
      return Response.json({ id: pending.remote_request_id, status,
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(candidate) }] }],
        usage: { input_tokens: 10, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 } } });
    };
    const record = (name: string, args: any[]) => { events.push(name); ledgerCalls.push({ name, args }); };
    const ledger: any = {
      jobIdentity: { id: job.id, lease_token: job.lease_token }, requestPrefix: prefix,
      preflight: async (actual: any, task: string) => {
        equal(actual, manifest, "MANIFEST_CHANGED"); check(task === "draft_section", "TASK_CHANGED");
        record("preflight", [actual, task]);
        return { routing_mode: "round_robin", executor_version: 2, providers: [configuration],
          pending_model_config_id: configuration.model_config_id, issuance_request: issuance };
      },
      beginAttempt: async (...args: any[]) => {
        record("beginAttempt", args); check(args[5] === "41", "ACCEPTED_ATTEMPT_NOT_REUSED"); return "41";
      },
      endAttempt: async (...args: any[]) => { record("endAttempt", args); },
      resume: async (...args: any[]) => { record("resume", args); return structuredClone(pending); },
      requestPrepared: async (...args: any[]) => { record("requestPrepared", args); },
      reserve: async () => { newReservations++; throw new Error("NEW_RESERVATION_FOR_ACCEPTED_REQUEST"); },
      checkpoint: async () => { throw new Error("NEW_BACKGROUND_REQUEST"); },
      defer: async () => { throw new Error("READY_RESPONSE_DEFERRED"); },
      settle: async (...args: any[]) => { record("settle", args); },
      candidateReceived: async (...args: any[]) => { record("candidateReceived", args); },
      validateCandidateScope: async (...args: any[]) => { record("validateCandidateScope", args); },
      validateCandidate: (...args: any[]) => { record("validateCandidate", args); },
    };
    const options = { backend, job, threadId: thread, graphInputHash: hash, manifest,
      environments: { openai: environment }, fetcher };
    const execute = (receipt: any) => executeModel("draft_section", context, evidence, requiredIds, manifest,
      options.environments, ledger, "en", false, fetcher, 1, { semanticRevision: 5, acceptedPoll: receipt });
    return { options, prepared, pending, configuration, issuance, job, inputHash, prefix,
      candidate, methods, events, backendCalls, ledgerCalls, ledger, execute,
      setRpc: (value: any) => { rpcValue = value; } };
  };
  for (const status of ["in_progress", "queued"]) {
    const f = await fixturePoll(status), original = JSON.stringify({ job: f.job, pending: f.pending });
    let deferred = false;
    try { await prepareAcceptedModelPoll(f.options); } catch (error) { check(error instanceof ModelDeferred, "PENDING_NOT_DEFERRED"); deferred = true; }
    check(deferred, "PENDING_NOT_DEFERRED");
    equal(f.events, ["prepare_accepted_model_poll", "HTTP:GET", "finish_model_attempt", "defer_pending_model_request"], "PENDING_REPLAYED_GRAPH");
    equal(JSON.stringify({ job: f.job, pending: f.pending }), original, "PENDING_IDENTITY_MUTATED");
    check(f.ledgerCalls.length === 0, "PENDING_ENTERED_GENERATION");
  }
  checks.pending_poll_without_generation = true;
  const ready = await fixturePoll(), receipt = await prepareAcceptedModelPoll(ready.options);
  check(receipt?.available === true, "READY_RECEIPT_MISSING");
  equal(ready.events, ["prepare_accepted_model_poll", "HTTP:GET"], "READY_ACCEPTED_BEFORE_VALIDATION");
  equal(await ready.execute(receipt), ready.candidate, "READY_CANDIDATE_CHANGED");
  equal(ready.methods, ["GET"], "READY_REPOLLED");
  check(typeof ready.ledger.cleanup === "function", "READY_CLEANUP_MISSING");
  await ready.ledger.cleanup();
  equal(ready.methods, ["GET", "DELETE"], "READY_CLEANUP_CHANGED");
  const calls = (f: typeof ready, name: string) => f.ledgerCalls.filter(call => call.name === name);
  equal(calls(ready, "settle").map(call => call.args), [[ready.pending.id, { input: 10, output: 8, thinking: 0 }]], "READY_USAGE_CHANGED");
  for (const name of ["preflight", "requestPrepared", "resume", "candidateReceived", "validateCandidateScope", "validateCandidate", "endAttempt"])
    check(calls(ready, name).length === 1, "READY_VALIDATION_BYPASSED");
  check(calls(ready, "endAttempt")[0].args[1] === "SUCCEEDED", "READY_NOT_SUCCEEDED");
  check(receipt.available === false, "READY_RECEIPT_NOT_CONSUMED");
  await rejected(() => receipt.consume(calls(ready, "requestPrepared")[0].args[0], ready.pending));
  checks.ready_response_rejoins_validation = true;
  for (const [invalid, code] of [["schema", "MODEL_OUTPUT_INVALID"], ["coverage", "MODEL_COVERAGE_INCOMPLETE"], ["quote", "EVIDENCE_REFERENCE_INVALID"]] as const) {
    const f = await fixturePoll("completed", invalid), received = await prepareAcceptedModelPoll(f.options);
    await rejected(() => f.execute(received), code);
    equal(f.methods, ["GET"], "INVALID_READY_REPOLLED");
    check(calls(f, "validateCandidate").length === 0 && calls(f, "settle").length === 1, "INVALID_CANDIDATE_ACCEPTED");
    check(!calls(f, "endAttempt").some(call => call.args[1] === "SUCCEEDED"), "INVALID_RECORDED_SUCCESS");
  }
  checks.invalid_ready_response_rejected = true;
  for (const field of ["job", "requestPrefix", "task", "inputHash", "configuration"]) {
    const f = await fixturePoll(), received = await prepareAcceptedModelPoll(f.options);
    const binding: any = { job: f.ledger.jobIdentity, requestPrefix: f.prefix, task: "draft_section",
      inputHash: f.inputHash, configuration: f.configuration };
    binding[field] = field === "job" ? { ...binding.job, lease_token: "changed-lease" }
      : field === "configuration" ? { ...f.configuration, model: "different-model" } : "changed";
    await rejected(() => received.attempt(binding));
    check(f.ledgerCalls.length === 0, "CHANGED_IDENTITY_ACCEPTED");
  }
  for (const field of ["id", "remote_request_id", "remote_deadline", "execution_metadata"]) {
    const f = await fixturePoll(), received = await prepareAcceptedModelPoll(f.options);
    received.attempt({ job: f.ledger.jobIdentity, requestPrefix: f.prefix, task: "draft_section",
      inputHash: f.inputHash, configuration: f.configuration });
    // Keep the exact source metadata; change only one durable accepted identity.
    const changed = structuredClone(f.pending);
    changed[field] = field === "execution_metadata" ? { ...changed.execution_metadata, route_revision: 4 } : "changed";
    await rejected(() => received.consume(calls(ready, "requestPrepared")[0].args[0], changed));
  }
  checks.pending_identity_retained = true;
  for (const reason of ["expired", "closed"]) {
    const f = await fixturePoll();
    if (reason === "expired") f.issuance.deadline_at = new Date(Date.now() - 1000).toISOString();
    else f.issuance.outcome = "canceled";
    await rejected(() => prepareAcceptedModelPoll(f.options), "PROPOSAL_ISSUANCE_TIMEOUT");
    check(f.methods.length === 0 && f.ledgerCalls.length === 0, "CLOSED_ISSUANCE_POLLED");
  }
  const expired = await fixturePoll();
  expired.pending.remote_deadline = new Date(Date.now() - 1000).toISOString();
  const expiredReceipt = await prepareAcceptedModelPoll(expired.options);
  check(expiredReceipt?.available === true && expired.methods.length === 0, "EXPIRED_REMOTE_POLLED");
  await rejected(() => expired.execute(expiredReceipt), "AI_AGENTS_UNAVAILABLE");
  check(calls(expired, "settle").some(call => call.args[0] === expired.pending.id && call.args[2] === "MODEL_RESULT_EXPIRED")
    && calls(expired, "endAttempt").some(call => call.args[1] === "MODEL_RESULT_EXPIRED"), "EXPIRED_ACCOUNTING_BYPASSED");
  check(expired.methods.length === 0 && calls(expired, "validateCandidate").length === 0, "EXPIRED_RESULT_ACCEPTED");
  checks.expired_or_closed_request_rejected = true;
  for (const reason of ["legacy_executor", "missing_thread", "missing_round", "verifier_recheck", "sql_null"]) {
    const f = await fixturePoll();
    if (reason === "legacy_executor") f.job.checkpoint.model_executor = 1;
    if (reason === "missing_thread") delete f.job.checkpoint.graph_thread;
    if (reason === "missing_round") delete f.job.checkpoint.model_round;
    if (reason === "verifier_recheck") f.job.checkpoint.verifier_recheck = false;
    if (reason === "sql_null") f.setRpc(null);
    check(await prepareAcceptedModelPoll(f.options) === null, "LEGACY_DID_NOT_FALL_BACK");
    equal(f.events, reason === "sql_null" ? ["prepare_accepted_model_poll"] : [], "LEGACY_POLL_SIDE_EFFECT");
  }
  checks.legacy_pending_falls_back = true;
}
equal(JSON.stringify(x), before, "INPUTS_MUTATED");
const source_sha256: Record<string, string> = {};
// Fonts are binary. Hash raw bytes for every copied file, matching the builder.
async function bytesHash(path: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await runtime.readFile(path)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function collectBytes(relative: string) {
  for await (const entry of runtime.readDir("/app/" + relative)) {
    const path = relative + "/" + entry.name;
    if (entry.isDirectory) await collectBytes(path);
    else if (entry.isFile) source_sha256[path] = await bytesHash("/app/" + path);
    else throw new Error("UNSUPPORTED_IMAGE_SOURCE_TYPE");
  }
}
for (const root of ["backend/supabase/functions", "backend/scripts/runtime", "frontend/public/fonts"]) await collectBytes(root);
for (const file of ["frontend/src/lib/renderDocx.ts", "frontend/src/lib/docxTableStream.ts"]) source_sha256[file] = await bytesHash("/app/" + file);
console.log(JSON.stringify({ version: 1, baseline, passed: true, checks, source_sha256,
  revision6_prompt_sha256: revision6PromptHashes, revision6_pins_sha256: revision6PinHashes,
  provider_calls: 0, generation_posts: generationPosts, new_reservations: newReservations,
  scope: "Actual immutable-image poll/model validation and accepted phase pins; synthetic backend/ledger/fetch only." }));
