/** Offline qualification manifest/scoring only. No fetch, provider adapter,
 * credentials, model call or production mutation exists in this module. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export const CORPUS_SHA256 = "9a1fd88f07fc9fc9d9b06ae3b67699976dacf221e0af7ee03fafdd59bfe25d7c";
export const RETRIEVAL_SHA256 = "cc8f3d70d4847bc1652e3560ff83ad209da5b64e1330d2b8abbf815981046c41";
export const TASKS = ["analyze_chunk", "classify_opportunity", "summarize_review", "plan_structure", "plan_blueprint", "plan_proposal", "draft_section", "plan_commercial", "review_proposal", "inspect_source_page", "verify_grounding", "repair_result", "connection_probe"];
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const check = (condition, code) => { if (!condition) throw new Error(code); };
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identifier = (value) => typeof value === "string" && value.trim().length > 0;
const iso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export async function loadReserve() {
  const directory = new URL("../../tests/backend/fixtures/qualification-reserve/", import.meta.url);
  const [corpusBytes, retrievalBytes] = await Promise.all([readFile(new URL("corpus-v4.json", directory)), readFile(new URL("retrieval-v3.json", directory))]);
  check(sha256(corpusBytes) === CORPUS_SHA256 && sha256(retrievalBytes) === RETRIEVAL_SHA256, "RESERVE_HASH_CHANGED");
  const corpus = JSON.parse(corpusBytes), retrieval = JSON.parse(retrievalBytes);
  validateReserve(corpus, retrieval);
  return { corpus, retrieval };
}
export function validateReserve(corpus, retrieval) {
  check(sha256(JSON.stringify(corpus, null, 2) + "\n") === CORPUS_SHA256 && sha256(JSON.stringify(retrieval, null, 2) + "\n") === RETRIEVAL_SHA256, "RESERVE_OBJECT_CHANGED");
  check(corpus.version === 4 && corpus.cases.length === 50 && corpus.repetitions === 2 && corpus.scheduled_per_model === 100, "RESERVE_CENSUS_INVALID");
  check(corpus.private_holdout === false && corpus.blindness === "not_independently_blinded", "RESERVE_SCOPE_INVALID");
  const cases = new Set(), groups = new Map();
  for (const row of corpus.cases) {
    check(!cases.has(row.id) && TASKS.includes(row.task) && ["en", "ar"].includes(row.language), "RESERVE_CASE_INVALID"); cases.add(row.id);
    groups.set(row.split_group, [...(groups.get(row.split_group) || []), row]);
    const spans = new Set();
    for (const doc of row.documents) {
      check(sha256(doc.text) === doc.sha256, "RESERVE_SOURCE_HASH_INVALID");
      const points = Array.from(doc.text);
      for (const span of doc.spans) {
        check(span.coordinate === "unicode_code_point" && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= points.length && points.slice(span.start, span.end).join("") === span.quote && !spans.has(span.id), "RESERVE_SPAN_INVALID"); spans.add(span.id);
      }
    }
    const invariants = new Set();
    for (const inv of row.oracle.invariants) {
      check(!invariants.has(inv.id) && identifier(inv.required_meaning) && inv.target_paths.length > 0 && (row.task === "connection_probe" || inv.source_span_ids.length > 0), "RESERVE_ORACLE_INVALID");
      check(inv.source_span_ids.every((id) => spans.has(id)), "RESERVE_ORACLE_SOURCE_INVALID"); invariants.add(inv.id);
    }
    check(invariants.size > 0 && row.oracle.noncritical_acceptance_threshold === null, "RESERVE_THRESHOLD_INVALID");
    const projection = publicCase(row);
    const forbidden = new Set(["oracle", "required_meaning", "candidate_variant", "expected_behavior", "critical_gate", "split_group", "candidate_status"]);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) { check(!forbidden.has(key), "RESERVE_GOLD_LEAK"); visit(item); }
    };
    visit(projection);
  }
  for (const task of TASKS) for (const language of ["en", "ar"])
    check(corpus.cases.filter((row) => row.task === task && row.language === language).length === (task === "connection_probe" ? 1 : 2), "RESERVE_TASK_LANGUAGE_GAP");
  for (const rows of groups.values()) check(rows.length === 2 && new Set(rows.map((r) => r.language)).size === 2, "RESERVE_SPLIT_LEAK");
  check(retrieval.cases.length === 16 && retrieval.business_recall_threshold === null, "RESERVE_RETRIEVAL_CENSUS_INVALID");
  for (const row of retrieval.cases) {
    check(sha256(row.source_text) === row.source_sha256 && row.gold_spans.length === 2, "RESERVE_RETRIEVAL_SOURCE_INVALID");
    for (const span of row.gold_spans) check(Array.from(row.source_text).slice(span.start, span.end).join("") === span.quote, "RESERVE_RETRIEVAL_SPAN_INVALID");
    const bounded = retrievalSource(row, retrieval, "bounded_context");
    check(sha256(bounded) === row.bounded_source_sha256, "RESERVE_RETRIEVAL_ASSEMBLY_INVALID");
    for (const span of row.bounded_gold_spans) check(Array.from(bounded).slice(span.start, span.end).join("") === span.quote, "RESERVE_RETRIEVAL_SPAN_INVALID");
  }
}
/** Assemble source bytes only. This never executes the production selector or
 * establishes database authorization. Gold fields are not part of its result. */
export function retrievalSource(row, retrieval, mode) {
  check(row.modes.includes(mode), "RETRIEVAL_MODE_INVALID");
  if (mode !== "bounded_context") return row.source_text;
  const recipe = retrieval.source_assembly;
  return recipe.bounded_filler.repeat(recipe.filler_repetitions_before_fact) + "\n\n" + row.gold_fact + "\n\n" + recipe.bounded_filler.repeat(recipe.filler_repetitions_before_qualifier) + "\n\n" + row.gold_qualifier;
}
/** This is source material for a future canonical adapter, NOT a taskInput or
 * alternate prompt. The adapter must preserve production task contracts. */
export function publicCase(row) {
  return structuredClone({ task: row.task, language: row.language, instruction: row.instruction, documents: row.documents, workflow_facts: row.workflow_facts });
}
export function validateActivation(corpus, lock) {
  // Validate the supplied object itself, not just a remembered file hash.
  // Otherwise callers could mutate gold/critical flags after loading it.
  check(sha256(JSON.stringify(corpus, null, 2) + "\n") === CORPUS_SHA256, "RESERVE_OBJECT_CHANGED");
  check(lock.version === 1 && lock.state === "frozen" && iso(lock.frozen_at), "ACTIVATION_NOT_FROZEN");
  check(lock.corpus_sha256 === CORPUS_SHA256 && lock.retrieval_sha256 === RETRIEVAL_SHA256, "ACTIVATION_CORPUS_MISMATCH");
  check(/^[0-9a-f]{40}$/.test(lock.source_revision || "") && digest(lock.adapter_sha256) && digest(lock.validator_sha256), "ACTIVATION_SOURCE_UNPINNED");
  check(identifier(lock.execution_authorization_reference) && identifier(lock.oracle_review_reference), "ACTIVATION_REVIEW_MISSING");
  check(Array.isArray(lock.targets) && lock.targets.length > 0 && lock.repetitions === 2 && lock.automatic_retries === 0, "ACTIVATION_MATRIX_EMPTY");
  const targets = new Set(), identities = new Set();
  for (const target of lock.targets) {
    check(/^[a-z0-9_-]{1,100}$/.test(target.key) && !targets.has(target.key), "ACTIVATION_TARGET_DUPLICATE"); targets.add(target.key);
    for (const field of ["provider_id", "connection_id", "model_id", "configured_model_name"]) check(identifier(target[field]), "ACTIVATION_TARGET_UNBOUND");
    const identity = JSON.stringify([target.provider_id, target.connection_id, target.model_id]);
    check(!identities.has(identity), "ACTIVATION_IDENTITY_DUPLICATE"); identities.add(identity);
    check(digest(target.configuration_sha256) && digest(target.capabilities_sha256), "ACTIVATION_CONFIGURATION_UNPINNED");
    check(Array.isArray(target.provider_reported_model_names) && target.provider_reported_model_names.length > 0 && target.provider_reported_model_names.every(identifier) && new Set(target.provider_reported_model_names).size === target.provider_reported_model_names.length, "ACTIVATION_REPORTED_IDENTITY_UNPINNED");
    check(Object.keys(target.request_pins || {}).length === corpus.cases.length, "ACTIVATION_TASK_PIN_GAP");
    for (const row of corpus.cases) {
      const pin = target.request_pins[row.id];
      check(pin && digest(pin.input_sha256) && digest(pin.prompt_sha256) && digest(pin.output_schema_sha256) && identifier(pin.contract_version), "ACTIVATION_REQUEST_UNPINNED");
    }
  }
  check(lock.planned_invocations === corpus.cases.length * lock.repetitions * lock.targets.length, "ACTIVATION_DENOMINATOR_MISMATCH");
  // This validates a receipt, never user authorization. Existing runner policy
  // must independently authorize every actual provider call and source.
  return lock;
}
export function schedule(corpus, lock) {
  validateActivation(corpus, lock);
  return lock.targets.flatMap((target) => corpus.cases.flatMap((row) => [1, 2].map((repetition) => ({ slot_id: `${target.key}|${row.id}|${repetition}`, target_key: target.key, case_id: row.id, task: row.task, language: row.language, repetition, input_sha256: target.request_pins[row.id].input_sha256 }))));
}
const statusSet = new Set(["not_attempted", "unavailable", "transport_error", "refused", "invalid_output", "completed"]);
function pathTokens(value, wildcard = false) {
  if (typeof value !== "string" || value.length > 500) return null;
  const path = value.startsWith("$.") ? value.slice(2) : value;
  const index = wildcard ? "(?:0|[1-9][0-9]*|\\*)" : "(?:0|[1-9][0-9]*)";
  if (!new RegExp(`^[a-zA-Z_][a-zA-Z_0-9]*(?:\\[${index}\\])*(?:\\.[a-zA-Z_][a-zA-Z_0-9]*(?:\\[${index}\\])*)*$`).test(path)) return null;
  return path.replace(/\[([^\]]+)\]/g, ".$1").split(".");
}
function relevantPath(path, targets, omission) {
  const actual = pathTokens(path);
  if (!actual) return false;
  return targets.some((target) => {
    const expected = pathTokens(target, true);
    if (!expected) return false;
    const count = Math.min(actual.length, expected.length);
    const matches = expected.slice(0, count).every((token, i) => token === actual[i] || (token === "*" && /^(0|[1-9][0-9]*)$/.test(actual[i])));
    return matches && (actual.length >= expected.length || omission);
  });
}
const verdictSet = new Set(["pass", "false_acceptance", "omission", "false_rejection", "undetermined"]);
function freshCounts() { return { scheduled: 0, observed: 0, attempted: 0, completed: 0, domain_valid: 0, scored: 0, missing: 0, unadjudicated: 0, unavailable: 0, transport_error: 0, refused: 0, invalid_output: 0, not_attempted: 0, critical_false_acceptance: 0, critical_omission: 0, critical_false_rejection: 0, protocol_failure: 0 }; }
/** Mechanical denominator/integrity scorer. It does not infer semantic truth
 * from text or ask a model to grade itself. Separate judgments must be tied to
 * the exact private output and frozen oracle with declared reviewer provenance. */
export function scoreReserve(corpus, lock, observations, adjudications) {
  const slots = schedule(corpus, lock), expected = new Map(slots.map((s) => [s.slot_id, s]));
  const seen = new Map(), judgments = new Map();
  for (const row of observations) {
    check(expected.has(row.slot_id) && !seen.has(row.slot_id), "RECEIPT_UNKNOWN_OR_DUPLICATE");
    const slot = expected.get(row.slot_id);
    check(row.corpus_sha256 === CORPUS_SHA256 && row.input_sha256 === slot.input_sha256 && row.source_revision === lock.source_revision, "RECEIPT_PIN_MISMATCH");
    const target = lock.targets.find((item) => item.key === slot.target_key);
    const pin = target.request_pins[slot.case_id];
    check(row.adapter_sha256 === lock.adapter_sha256 && row.request_pin && ["input_sha256", "prompt_sha256", "output_schema_sha256", "contract_version"].every((field) => row.request_pin[field] === pin[field]), "RECEIPT_REQUEST_PIN_MISMATCH");
    check(row.resolved_target && ["provider_id", "connection_id", "model_id", "configured_model_name", "configuration_sha256", "capabilities_sha256"].every((field) => row.resolved_target[field] === target[field]), "RECEIPT_TARGET_MISMATCH");
    check(statusSet.has(row.status) && [0, 1].includes(row.provider_generation_posts), "RECEIPT_STATUS_INVALID");
    check(iso(row.observed_at) && Date.parse(row.observed_at) >= Date.parse(lock.frozen_at), "RECEIPT_PRECEDES_FREEZE");
    check(row.usage && [row.usage.input_tokens, row.usage.output_tokens].every((x) => x === null || (Number.isSafeInteger(x) && x >= 0)), "RECEIPT_USAGE_INVALID");
    if (["completed", "invalid_output", "refused"].includes(row.status)) check(row.provider_generation_posts === 1 && digest(row.output_sha256), "RECEIPT_OUTPUT_MISSING");
    if (row.status === "not_attempted") check(row.provider_generation_posts === 0, "RECEIPT_POST_COUNT_INVALID");
    if (row.status === "invalid_output") check(row.domain_validation === "failed" && Array.isArray(row.validation_error_codes) && row.validation_error_codes.length > 0, "RECEIPT_REJECTION_UNPROVEN");
    if (row.status === "completed") {
      check(row.domain_validation === "passed" && row.validator_sha256 === lock.validator_sha256, "RECEIPT_DOMAIN_UNPROVEN");
      const identity = row.provider_reported_identity;
      check(identity && ((identity.status === "reported" && identifier(identity.model_name) && identifier(identity.evidence_reference)) || (identity.status === "not_reported" && identity.model_name === null && identity.evidence_reference === null)), "RECEIPT_REPORTED_IDENTITY_INVALID");
    }
    seen.set(row.slot_id, row);
  }
  for (const judgment of adjudications) {
    check(expected.has(judgment.slot_id) && !judgments.has(judgment.slot_id), "JUDGMENT_UNKNOWN_OR_DUPLICATE");
    const observation = seen.get(judgment.slot_id), slot = expected.get(judgment.slot_id);
    check(observation?.status === "completed" && judgment.output_sha256 === observation.output_sha256 && judgment.oracle_sha256 === CORPUS_SHA256, "JUDGMENT_OUTPUT_MISMATCH");
    const target = lock.targets.find((t) => t.key === slot.target_key);
    check(identifier(judgment.reviewer_id) && judgment.reviewer_id !== target.model_id && identifier(judgment.method) && identifier(judgment.review_evidence_reference), "JUDGMENT_PROVENANCE_MISSING");
    const row = corpus.cases.find((c) => c.id === slot.case_id), allowed = new Map(row.oracle.invariants.map((i) => [i.id, i])), matched = new Set();
    for (const finding of judgment.invariants) {
      check(allowed.has(finding.id) && !matched.has(finding.id) && verdictSet.has(finding.verdict), "JUDGMENT_INVARIANT_INVALID"); matched.add(finding.id);
      const inv = allowed.get(finding.id);
      check(Array.isArray(finding.source_span_ids) && inv.source_span_ids.every((id) => finding.source_span_ids.includes(id)) && finding.source_span_ids.every((id) => inv.source_span_ids.includes(id)), "JUDGMENT_SOURCE_MISMATCH");
      check(Array.isArray(finding.examined_output_paths) && finding.examined_output_paths.length > 0 && finding.examined_output_paths.every((path) => relevantPath(path, inv.target_paths, finding.verdict === "omission")), "JUDGMENT_TRACE_MISSING");
    }
    judgments.set(judgment.slot_id, judgment);
  }
  const totals = freshCounts(), byCell = {}, byKind = { semantic: freshCounts(), connectivity_probe: freshCounts() }, byClass = {}, unknownUsage = { input: 0, output: 0 }, reportedIdentity = { matched: 0, not_reported: 0, unexpected: 0 };
  for (const slot of slots) {
    const key = `${slot.target_key}|${slot.task}|${slot.language}`, counts = byCell[key] ??= freshCounts();
    const kindCounts = byKind[slot.task === "connection_probe" ? "connectivity_probe" : "semantic"];
    const increment = (field, amount = 1) => { totals[field] += amount; counts[field] += amount; kindCounts[field] += amount; };
    increment("scheduled"); const row = seen.get(slot.slot_id);
    if (!row) { increment("missing"); continue; }
    increment("observed"); increment("attempted", row.provider_generation_posts);
    if (row.usage.input_tokens === null) unknownUsage.input++; if (row.usage.output_tokens === null) unknownUsage.output++;
    if (["completed", "invalid_output", "refused"].includes(row.status)) increment("completed");
    if (row.status !== "completed") { increment(row.status); continue; }
    increment("domain_valid");
    const target = lock.targets.find((item) => item.key === slot.target_key);
    const identity = row.provider_reported_identity;
    reportedIdentity[identity.status === "not_reported" ? "not_reported" : target.provider_reported_model_names.includes(identity.model_name) ? "matched" : "unexpected"]++;
    const judgment = judgments.get(slot.slot_id);
    const testCase = corpus.cases.find((c) => c.id === slot.case_id);
    if (!judgment || judgment.invariants.length !== testCase.oracle.invariants.length || judgment.invariants.some((f) => f.verdict === "undetermined")) increment("unadjudicated");
    else increment("scored");
    for (const finding of judgment?.invariants || []) {
      const inv = testCase.oracle.invariants.find((i) => i.id === finding.id);
      if (["pass", "undetermined"].includes(finding.verdict)) continue;
      if (inv.critical) increment(`critical_${finding.verdict}`);
      else if (inv.protocol_required) increment("protocol_failure");
    }
  }
  // Per-class units are invariant assessments, not additional provider calls.
  // Translation twins and repeated observations are kept in the same family.
  for (const slot of slots) {
    const testCase = corpus.cases.find((row) => row.id === slot.case_id);
    const observation = seen.get(slot.slot_id), judgment = judgments.get(slot.slot_id);
    for (const invariant of testCase.oracle.invariants) {
      const key = `${slot.target_key}|${slot.language}|${invariant.class}`;
      const counts = byClass[key] ??= { scheduled_invariants: 0, observed_invariants: 0, attempted_invariants: 0, completed_invariants: 0, domain_valid_invariants: 0, scored_invariants: 0, pass: 0, false_acceptance: 0, omission: 0, false_rejection: 0, undetermined_or_missing: 0 };
      counts.scheduled_invariants++;
      if (observation) {
        counts.observed_invariants++;
        counts.attempted_invariants += observation.provider_generation_posts;
        if (["completed", "invalid_output", "refused"].includes(observation.status)) counts.completed_invariants++;
        if (observation.status === "completed") counts.domain_valid_invariants++;
      }
      const finding = judgment?.invariants.find((item) => item.id === invariant.id);
      if (!finding || finding.verdict === "undetermined") counts.undetermined_or_missing++;
      else { counts.scored_invariants++; counts[finding.verdict]++; }
    }
  }
  let comparableRepeats = 0, outputVariations = 0, verdictVariations = 0;
  for (const target of lock.targets) for (const testCase of corpus.cases) {
    const ids = [1, 2].map((repeat) => `${target.key}|${testCase.id}|${repeat}`);
    if (!ids.every((id) => {
      const judgment = judgments.get(id);
      return seen.get(id)?.status === "completed" && judgment && judgment.invariants.length === testCase.oracle.invariants.length && judgment.invariants.every((item) => item.verdict !== "undetermined");
    })) continue;
    comparableRepeats++;
    if (seen.get(ids[0]).output_sha256 !== seen.get(ids[1]).output_sha256) outputVariations++;
    const values = ids.map((id) => JSON.stringify(testCase.oracle.invariants.map((invariant) => judgments.get(id).invariants.find((item) => item.id === invariant.id)?.verdict ?? "missing")));
    if (values[0] !== values[1]) verdictVariations++;
  }
  const defects = totals.critical_false_acceptance + totals.critical_omission + totals.critical_false_rejection + totals.protocol_failure;
  return { version: 1, corpus_sha256: CORPUS_SHA256, activation_sha256: sha256(JSON.stringify(lock, null, 2) + "\n"), source_revision: lock.source_revision, adapter_sha256: lock.adapter_sha256, validator_sha256: lock.validator_sha256, totals, by_evaluation_kind: byKind, by_target_task_language: byCell, by_target_language_semantic_class: byClass, repeat_stability: { comparable_pairs: comparableRepeats, differing_output_hashes: outputVariations, differing_invariant_verdicts: verdictVariations }, unknown_usage: unknownUsage,
    critical_gate: defects ? "failed" : totals.scored === totals.scheduled ? "passed_for_exact_reserve" : "not_qualified",
    provider_reported_identity: reportedIdentity,
    qualification_gate: defects || reportedIdentity.unexpected ? "failed" : totals.scored === totals.scheduled && reportedIdentity.matched === totals.scheduled ? "passed_for_exact_reserve" : "not_qualified",
    business_acceptance: "unapproved_noncritical_thresholds", private_holdout_status: "not_supplied_or_blinded", universal_accuracy_claim: false,
    population_confidence_interval: null, interval_reason: "Nonrandom designed cases; translations and repetitions are clustered, not independent population samples.",
    limitations: "Judgment provenance and actual output/source review are externally supplied evidence; this mechanical scorer cannot establish reviewer independence or authenticate an authorization reference." };
}
