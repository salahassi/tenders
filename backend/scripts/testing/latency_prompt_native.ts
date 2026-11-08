/** Native image probe. Product imports resolve only inside the immutable image.
 * Backend/store doubles exercise phase identity, not SQL/provider behavior. */
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const product = "/app/backend/supabase/functions/_shared/";
const { modelPrompt, sha256 } = await import(product + "model.ts");
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

const legacyHashes: Record<string, string> = {};
for (const language of ["en", "ar"] as const) for (const semantic of [0, 1, 2, 3, 4, 5] as const) {
  for (const task of ["analyze_chunk", "repair_result"] as const) {
    const context = task === "analyze_chunk" ? x.original : { target_task: "analyze_chunk", original_context: x.original };
    const wire = modelPrompt(task, context, x.evidence, x.requiredIds, language, false, 1, semantic);
    legacyHashes[`${task}:${language}:s${semantic}:v1`] = await sha256(wire);
    equal(JSON.parse(wire).evidence, x.evidence, "LEGACY_EVIDENCE_CHANGED");
  }
  for (const verification of [1, 2, 3, 4, 5] as const) {
    legacyHashes[`verify_grounding:${language}:s${semantic}:v${verification}`] = await sha256(
      modelPrompt("verify_grounding", x.context, x.evidence, x.requiredIds, language, false, verification, semantic));
  }
}
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
const legacyPins: Record<string, unknown> = {};
for (const version of [0, 1, 2, 3, 4, 5] as const) {
  const m = memory(false), prefix = `synthetic:accepted:semantic:${version}`;
  const key = `semantic-instructions-${await sha256(prefix)}`;
  const value = { version, legacy_input_hash: await sha256(modelPrompt("analyze_chunk", x.original, x.evidence, x.requiredIds, "ar")),
    ...(version ? { instructions: semanticPolicyText(version) } : {}) };
  m.records.set(key, { value: structuredClone(value) });
  check(await pinSemanticPrompt(semanticOptions(m, prefix)) === version, "LEGACY_SEMANTIC_PIN_CHANGED");
  check(await readSemanticPromptRevision(m.store, prefix) === version, "LEGACY_SEMANTIC_READ_CHANGED");
  equal(m.records.get(key).value, value, "LEGACY_PIN_MUTATED");
  check(m.writes() === 0 && m.calls.length === 0, "LEGACY_PIN_REAUTHORIZED");
  legacyPins[`semantic:${version}`] = value;
}
for (const version of [1, 2, 3, 4, 5] as const) {
  const m = memory(false), prefix = `synthetic:accepted:verification:${version}`;
  const key = `verification-instructions-${await sha256(prefix)}`;
  const value = { version, legacy_input_hash: await sha256(modelPrompt("verify_grounding", x.context, x.evidence, x.requiredIds, "ar")),
    ...(version >= 2 ? { instructions: verificationPolicyText(version) } : {}) };
  m.records.set(key, { value: structuredClone(value) });
  check(await pinVerificationPrompt(verificationOptions(m, prefix)) === version, "LEGACY_VERIFICATION_PIN_CHANGED");
  equal(m.records.get(key).value, value, "LEGACY_PIN_MUTATED");
  check(m.writes() === 0 && m.calls.length === 0, "LEGACY_PIN_REAUTHORIZED");
  legacyPins[`verification:${version}`] = value;
}
check(await pinSemanticPrompt(semanticOptions(memory(true), "synthetic:already-started:semantic")) === 0, "STARTED_SEMANTIC_UPGRADED");
check(await pinVerificationPrompt(verificationOptions(memory(true), "synthetic:already-started:verification")) === 1, "STARTED_VERIFICATION_UPGRADED");
const checks: Record<string, boolean> = { legacy_phase_pins_retained: true, started_phase_uses_legacy: true };
let reduction = 0;
if (!baseline) {
  const { analysisLiteralCoverage } = await import(product + "modelAnalysisLiteralCoverage.ts");
  // SQL records every prepared request under the existing 100-character label
  // contract. Include old verifier pins paired with the newly selected wire.
  for (const verification of [1, 2, 3, 4, 5, 6])
    metadataLabel(JSON.parse(modelPrompt("verify_grounding", x.context, x.evidence,
      x.requiredIds, "ar", false, verification, 6)).prompt_version);
  for (const task of ["analyze_chunk", "verify_grounding", "repair_result"] as const) {
    const context = task === "analyze_chunk" ? x.original : task === "verify_grounding" ? x.context : { target_task: "analyze_chunk", original_context: x.original };
    const legacy = JSON.parse(modelPrompt(task, context, x.evidence, x.requiredIds, "ar", false, 5, 4));
    const compact = JSON.parse(modelPrompt(task, context, x.evidence, x.requiredIds, "ar", false, 5, 6));
    equal(compact.untrusted_data, legacy.untrusted_data, "CONTEXT_CHANGED");
    equal(compact.analysis_evidence_contract, legacy.analysis_evidence_contract, "AUTHORITY_CHANGED");
    equal(compact.evidence, x.evidence.map(({ id, text, kind, verified }) => ({ id, text, kind, verified })), "COMPACT_EVIDENCE_LOST");
    check(compact.prompt_version.includes(".ew1."), "WIRE_POLICY_UNVERSIONED");
    metadataLabel(compact.prompt_version);
    const saved = JSON.stringify(legacy).length - JSON.stringify(compact).length;
    check(saved > 0, "WIRE_NOT_SMALLER"); reduction += saved;
    const m = memory(false), options = semanticOptions(m, `synthetic:new:${task}`, task, context);
    check(await pinSemanticPrompt(options) === 6 && await pinSemanticPrompt(options) === 6, "NEW_SEMANTIC_PIN");
    check(await readSemanticPromptRevision(m.store, options.requestPrefix) === 6, "NEW_SEMANTIC_READ");
    check(m.calls.length === 1 && m.writes() === 1, "NEW_PIN_REAUTHORIZED");
    await rejected(() => pinSemanticPrompt({ ...options, evidence: [{ ...x.evidence[0], text: "Changed" }, ...x.evidence.slice(1)] }));
  }
  const coverage = analysisLiteralCoverage(x.context, x.evidence, x.requiredIds);
  equal(coverage, { version: 1, kind: "source_literal_fidelity", candidate_hash: x.context.candidate_hash,
    units: [{ content_id: "content-0", path: "$.requirements[0].text", source_span_ids: x.spans.map(s => s.id) }] }, "LITERAL_SCOPE_CHANGED");
  const prompt = JSON.parse(modelPrompt("verify_grounding", x.context, x.evidence, x.requiredIds, "ar", false, 6, 6));
  metadataLabel(prompt.prompt_version);
  equal(prompt.analysis_literal_coverage, coverage, "LITERAL_MANIFEST_MISSING");
  equal(prompt.required_ids, x.requiredIds, "REQUIRED_IDS_CHANGED");
  equal(prompt.untrusted_data.content_units, candidateContent(x.candidate), "CONTENT_IDS_CHANGED");
  const m = memory(false), options = verificationOptions(m, "synthetic:new:verification");
  check(await pinVerificationPrompt(options) === 6 && await pinVerificationPrompt(options) === 6, "NEW_VERIFICATION_PIN");
  check(m.calls.length === 1 && m.writes() === 1, "NEW_VERIFICATION_REAUTHORIZED");
  const bad = structuredClone(x.context); bad.candidate.requirements[0].text += " Invented obligation.";
  bad.content_units = candidateContent(bad.candidate);
  check(analysisLiteralCoverage(bad, x.evidence, x.requiredIds) === null, "FORGED_LITERAL_ACCEPTED");
  await rejected(() => modelPrompt("verify_grounding", bad, x.evidence, x.requiredIds, "ar", false, 6, 6));
  await rejected(() => pinVerificationPrompt({ ...options, context: bad }));
  const changed = structuredClone(x.candidate); changed.requirements[0].source_refs[0].quote += " forged";
  await rejected(() => validateSourceCandidate("analyze_chunk", changed, x.original, x.evidence), "SOURCE_SPAN_TEXT_INVALID");
  for (const name of ["zero_requirements", "non_rfp_reference", "notice_reference"]) {
    const flexible = fixture(name === "notice_reference" ? "notice" : "document", name === "non_rfp_reference");
    const original: any = { ...flexible.original, draft_input_version: 1 };
    flexible.context.original_context = original;
    if (name !== "notice_reference") {
      flexible.candidate.requirements = [];
      flexible.candidate.summary = "Reference-only input; no formal requirement inventory is asserted.";
    }
    flexible.context.content_units = candidateContent(flexible.candidate);
    flexible.context.candidate_hash = await sha256(JSON.stringify(flexible.candidate));
    validateSourceCandidate("analyze_chunk", flexible.candidate, original, flexible.evidence);
    const sem = memory(false), ver = memory(false);
    const writer = { ...semanticOptions(sem, `synthetic:flexible:${name}`, "analyze_chunk", original),
      evidence: flexible.evidence, requiredIds: flexible.requiredIds };
    check(await pinSemanticPrompt(writer) === 6, "FLEXIBLE_WRITER_POLICY");
    const projected = JSON.parse(modelPrompt("analyze_chunk", original, flexible.evidence, flexible.requiredIds, "ar", false, 1, 6));
    metadataLabel(projected.prompt_version);
    equal(projected.untrusted_data, original, "FLEXIBLE_INPUT_CHANGED");
    equal(projected.evidence, flexible.evidence.map(({ id, text, kind, verified }) => ({ id, text, kind, verified })), "FLEXIBLE_EVIDENCE_CHANGED");
    check(projected.analysis_evidence_contract.requirement_source_kinds.includes("notice"), "NOTICE_SCOPE_LOST");
    const verify = { ...verificationOptions(ver, `synthetic:flexible:verify:${name}`), context: flexible.context,
      evidence: flexible.evidence, requiredIds: flexible.requiredIds };
    const expected = name === "notice_reference" ? 6 : 5;
    check(await pinVerificationPrompt(verify) === expected && await pinVerificationPrompt(verify) === expected, "FLEXIBLE_VERIFIER_POLICY");
    const verifiedWire = JSON.parse(modelPrompt("verify_grounding", flexible.context, flexible.evidence,
      flexible.requiredIds, "ar", false, expected, 6));
    metadataLabel(verifiedWire.prompt_version);
    equal(verifiedWire.untrusted_data.candidate, flexible.candidate, "FLEXIBLE_CANDIDATE_CHANGED");
    if (name !== "notice_reference") {
      check(verifiedWire.untrusted_data.candidate.requirements.length === 0 && !verifiedWire.analysis_literal_coverage, "ZERO_INVENTORY_CHANGED");
    } else check(verifiedWire.analysis_literal_coverage.units.length === 1, "NOTICE_LITERAL_NOT_PROVED");
  }
  Object.assign(checks, { new_phase_revision6_pinned: true, compact_evidence_lossless: true, literal_coverage_exact: true,
    forged_literal_rejected: true, changed_pin_rejected: true, new_pins_replay_exact: true, flexible_input_contract_preserved: true });
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
console.log(JSON.stringify({ version: 1, baseline, passed: true, checks, source_sha256, legacy_prompt_sha256: legacyHashes,
  legacy_pins_sha256: await sha256(JSON.stringify(legacyPins)), legacy_prompt_count: Object.keys(legacyHashes).length,
  legacy_pin_count: Object.keys(legacyPins).length, compact_saved_characters: reduction, provider_calls: 0,
  scope: "Actual immutable-image prompt and phase-pin functions with synthetic in-memory store/backend; no SQL or provider execution." }));
