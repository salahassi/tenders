// @vitest-environment node
// Synthetic receipts/judgments below test bookkeeping only, never model quality.
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { taskRegistry } from "../../supabase/functions/_shared/modelContract";
import { CORPUS_SHA256, RETRIEVAL_SHA256, TASKS, loadReserve, publicCase, retrievalSource, schedule, scoreReserve, sha256, validateActivation, validateReserve, type ReserveCorpus, type RetrievalReserve } from "../../scripts/qualification/reserve.mjs";
let corpus: ReserveCorpus, retrieval: RetrievalReserve;
beforeAll(async () => { ({ corpus, retrieval } = await loadReserve()); });
const hash = (value: string) => sha256(`synthetic mechanical test only: ${value}`);
function lockFor(targetCount = 1): any {
  return {
    version: 1, state: "frozen", frozen_at: "2026-11-04T00:00:00Z", corpus_sha256: CORPUS_SHA256, retrieval_sha256: RETRIEVAL_SHA256,
    source_revision: "a".repeat(40), adapter_sha256: hash("adapter"), validator_sha256: hash("validator"),
    execution_authorization_reference: "synthetic test; no live execution authorized", oracle_review_reference: "synthetic mechanical receipt; no actual output reviewed",
    repetitions: 2, automatic_retries: 0, planned_invocations: 100 * targetCount,
    targets: Array.from({ length: targetCount }, (_, index) => ({
      key: `synthetic-${index}`, provider_id: `synthetic-provider-${index}`, connection_id: `synthetic-connection-${index}`, model_id: `synthetic-model-${index}`, configured_model_name: `synthetic-configured-${index}`,
      configuration_sha256: hash(`config-${index}`), capabilities_sha256: hash(`capabilities-${index}`), provider_reported_model_names: [`synthetic-reported-${index}`],
      request_pins: Object.fromEntries(corpus.cases.map((row) => [row.id, { input_sha256: hash(`input-${index}-${row.id}`), prompt_sha256: hash(`prompt-${index}-${row.task}`), output_schema_sha256: hash(`schema-${row.task}`), contract_version: "synthetic-current-contract" }])),
    })),
  };
}
function mechanical(targetCount = 1) {
  const lock = lockFor(targetCount), slots = schedule(corpus, lock);
  const observations = slots.map((slot) => {
    const target = lock.targets.find((item: any) => item.key === slot.target_key);
    return {
      slot_id: slot.slot_id, corpus_sha256: CORPUS_SHA256, input_sha256: slot.input_sha256, source_revision: lock.source_revision, adapter_sha256: lock.adapter_sha256,
      request_pin: structuredClone(target.request_pins[slot.case_id]), resolved_target: Object.fromEntries(["provider_id", "connection_id", "model_id", "configured_model_name", "configuration_sha256", "capabilities_sha256"].map((field) => [field, target[field]])),
      provider_reported_identity: { status: "reported", model_name: target.provider_reported_model_names[0], evidence_reference: "synthetic provider response only" },
      status: "completed", provider_generation_posts: 1, observed_at: "2026-11-04T01:00:00Z", usage: { input_tokens: null, output_tokens: null }, output_sha256: hash(`output-${slot.target_key}-${slot.case_id}`), domain_validation: "passed", validator_sha256: lock.validator_sha256,
    } as any;
  });
  const adjudications = slots.map((slot, index) => ({
    slot_id: slot.slot_id, output_sha256: observations[index].output_sha256, oracle_sha256: CORPUS_SHA256, reviewer_id: "synthetic-reviewer", method: "mechanical fixture only, not semantic judgment", review_evidence_reference: "synthetic unit test",
    invariants: corpus.cases.find((row) => row.id === slot.case_id)!.oracle.invariants.map((inv) => ({ id: inv.id, verdict: "pass", source_span_ids: [...inv.source_span_ids], examined_output_paths: [`$.${inv.target_paths[0].replaceAll("[*]", "[0]")}`] })),
  } as any));
  return { lock, observations, adjudications };
}
function score(fixture: ReturnType<typeof mechanical>) { return scoreReserve(corpus, fixture.lock, fixture.observations, fixture.adjudications); }
describe("frozen source reserve integrity, not production task qualification", () => {
  it("covers the actual 13-task registry in both languages with fixed repeats and grouped twins", () => {
    expect([...TASKS].sort()).toEqual(Object.keys(taskRegistry).sort()); expect(corpus.cases).toHaveLength(50);
    const slots = schedule(corpus, lockFor(2)); expect(slots).toHaveLength(200); expect(new Set(slots.map((row) => row.slot_id)).size).toBe(200);
    expect(slots.filter((row) => row.task === "connection_probe")).toHaveLength(8);
    expect(corpus).toMatchObject({ private_holdout: false, blindness: "not_independently_blinded", prior_provider_outputs_for_this_bundle: 0, noncritical_business_thresholds: null });
  });
  it("binds source hashes/code-point spans, including Arabic, without gold in public adapter material", () => {
    validateReserve(corpus, retrieval);
    for (const row of corpus.cases) {
      const material = publicCase(row);
      expect(Object.keys(material)).toEqual(["task", "language", "instruction", "documents", "workflow_facts"]);
      expect(material).not.toHaveProperty("oracle"); expect(material).not.toHaveProperty("family");
      expect(material.documents.every((doc) => /^reserve-[0-9a-f-]+$/.test(doc.id))).toBe(true);
      for (const doc of material.documents) { expect(sha256(doc.text)).toBe(doc.sha256); for (const span of doc.spans) expect(Array.from(doc.text).slice(span.start, span.end).join("")).toBe(span.quote); }
      material.workflow_facts.synthetic_mutation = true; expect(row.workflow_facts).not.toHaveProperty("synthetic_mutation");
    }
  });
  it("preserves v1/v2 immutable pre-output review history", async () => {
    for (const [file, expected] of Object.entries({
      "corpus-v1.json": "71284f11f26a77224293bb9603145de1c4f9ddfe1a6d4cea642bb3c756a75225", "retrieval-v1.json": "171d5e5a975cd2fd942e76e2c9834d4c2459c9a7f1dd2b7765892726b14d6678",
      "corpus-v2.json": "e0e670aa9251b1ae6f6f788e80cea43455c248e505ac5b20fef7e4dc9641e023", "retrieval-v2.json": "f7ba64b966a7f2883c22c6854c4c02c5143768e4c8deb3c392d05416f782e53e",
    })) expect(sha256(await readFile(new URL(`./fixtures/qualification-reserve/${file}`, import.meta.url)))).toBe(expected);
  });
  it("assembles 48 prospective retrieval cells with separate compact and bounded hashes", () => {
    expect(retrieval.cases).toHaveLength(16);
    for (const row of retrieval.cases) {
      expect(row.modes).toEqual(["whole_source", "bounded_context", "preflight_excluded"]);
      const compact = retrievalSource(row, retrieval, "whole_source"), bounded = retrievalSource(row, retrieval, "bounded_context");
      expect(compact).toBe(row.source_text); expect(sha256(compact)).toBe(row.source_sha256); expect(sha256(bounded)).toBe(row.bounded_source_sha256);
      const distractors = Array.from({ length: 6 }, (_, i) => retrieval.source_assembly.distractor_text_template.replace("{index}", String(i + 1)));
      expect(Buffer.byteLength([compact, ...distractors].join("\n\n"))).toBeLessThan(24_000); expect(Buffer.byteLength(bounded)).toBeGreaterThan(24_000);
      for (const span of row.bounded_gold_spans) expect(Array.from(bounded).slice(span.start, span.end).join("")).toBe(span.quote);
      expect(retrievalSource(row, retrieval, "preflight_excluded")).toBe(compact); expect(row.recall_threshold).toBeNull();
    }
    expect(() => retrievalSource(retrieval.cases[0], retrieval, "invented")).toThrow("RETRIEVAL_MODE_INVALID");
  });
  it.each(["source", "critical", "retrieval"])("rejects mutable %s gold before retaining any frozen hash claim", (change) => {
    const c = structuredClone(corpus), r = structuredClone(retrieval);
    if (change === "source") c.cases[0].documents[0].text += " changed"; if (change === "critical") c.cases[0].oracle.invariants[0].critical = false; if (change === "retrieval") r.cases[0].gold_qualifier = "changed";
    expect(() => validateReserve(c, r)).toThrow("RESERVE_OBJECT_CHANGED"); if (change !== "retrieval") expect(() => schedule(c, lockFor())).toThrow("RESERVE_OBJECT_CHANGED");
  });
});
describe("activation and request identity", () => {
  it("leaves the committed example unexecutable without a target or authorization", async () => {
    const lock = JSON.parse(await readFile(new URL("./fixtures/qualification-reserve/activation-lock.example.json", import.meta.url), "utf8"));
    expect(lock.targets).toEqual([]); expect(lock.planned_invocations).toBe(0); expect(() => validateActivation(corpus, lock)).toThrow("ACTIVATION_NOT_FROZEN");
  });
  it.each(["input_sha256", "prompt_sha256", "output_schema_sha256", "contract_version"])("rejects absent activation %s", (field) => {
    const lock = lockFor(); delete lock.targets[0].request_pins[corpus.cases[0].id][field]; expect(() => schedule(corpus, lock)).toThrow("ACTIVATION_REQUEST_UNPINNED");
  });
  it.each(["source_revision", "adapter_sha256", "validator_sha256", "execution_authorization_reference", "oracle_review_reference"])("rejects absent activation %s", (field) => {
    const lock = lockFor(); delete lock[field]; expect(() => schedule(corpus, lock)).toThrow();
  });
  it("rejects duplicate identities, changed denominator, retries, configuration gaps and absent response identities", () => {
    const a = lockFor(2); Object.assign(a.targets[1], { provider_id: a.targets[0].provider_id, connection_id: a.targets[0].connection_id, model_id: a.targets[0].model_id }); expect(() => schedule(corpus, a)).toThrow("ACTIVATION_IDENTITY_DUPLICATE");
    const b = lockFor(); b.planned_invocations--; expect(() => schedule(corpus, b)).toThrow("ACTIVATION_DENOMINATOR_MISMATCH");
    const c = lockFor(); c.automatic_retries = 1; expect(() => schedule(corpus, c)).toThrow("ACTIVATION_MATRIX_EMPTY");
    const d = lockFor(); delete d.targets[0].configuration_sha256; expect(() => schedule(corpus, d)).toThrow("ACTIVATION_CONFIGURATION_UNPINNED");
    const e = lockFor(); e.targets[0].provider_reported_model_names = []; expect(() => schedule(corpus, e)).toThrow("ACTIVATION_REPORTED_IDENTITY_UNPINNED");
  });
  it.each(["input_sha256", "prompt_sha256", "output_schema_sha256", "contract_version"])("cannot count old or missing observed %s against the locked request", (field) => {
    const a = mechanical(); a.observations[0].request_pin[field] = "old-or-wrong"; expect(() => score(a)).toThrow("RECEIPT_REQUEST_PIN_MISMATCH");
    delete a.observations[0].request_pin[field]; expect(() => score(a)).toThrow("RECEIPT_REQUEST_PIN_MISMATCH");
  });
  it.each(["adapter_sha256", "request_pin"])("requires actual observed %s", (field) => { const a = mechanical(); delete a.observations[0][field]; expect(() => score(a)).toThrow("RECEIPT_REQUEST_PIN_MISMATCH"); });
  it.each(["provider_id", "connection_id", "model_id", "configured_model_name", "configuration_sha256", "capabilities_sha256"])("rejects changed resolved %s", (field) => {
    const a = mechanical(); a.observations[0].resolved_target[field] = "wrong"; expect(() => score(a)).toThrow("RECEIPT_TARGET_MISMATCH");
  });
  it("leaves unknown actual identity unknown and unable to pass qualification", () => {
    const a = mechanical(); a.observations[0].provider_reported_identity = { status: "not_reported", model_name: null, evidence_reference: null };
    const report = score(a); expect(report.provider_reported_identity).toEqual({ matched: 99, not_reported: 1, unexpected: 0 });
    expect(report.critical_gate).toBe("passed_for_exact_reserve"); expect(report.qualification_gate).toBe("not_qualified");
    a.observations[0].provider_reported_identity.model_name = a.lock.targets[0].configured_model_name; expect(() => score(a)).toThrow("RECEIPT_REPORTED_IDENTITY_INVALID");
  });
  it("retains unexpected response identity as an explicit qualification failure", () => { const a = mechanical(); a.observations[0].provider_reported_identity.model_name = "unexpected-alias"; expect(score(a)).toMatchObject({ qualification_gate: "failed", provider_reported_identity: { unexpected: 1 } }); });
});
describe("mechanical denominators and source-bound judgments", () => {
  it("reports synthetic arithmetic separately from business, private holdout and population accuracy", () => {
    const a = mechanical(), report = score(a);
    expect(report.totals).toMatchObject({ scheduled: 100, observed: 100, attempted: 100, completed: 100, domain_valid: 100, scored: 100, missing: 0 });
    expect(report.by_evaluation_kind.semantic.scheduled).toBe(96); expect(report.by_evaluation_kind.connectivity_probe.scheduled).toBe(4); expect(Object.keys(report.by_target_task_language)).toHaveLength(26);
    expect(report).toMatchObject({ qualification_gate: "passed_for_exact_reserve", business_acceptance: "unapproved_noncritical_thresholds", private_holdout_status: "not_supplied_or_blinded", universal_accuracy_claim: false, population_confidence_interval: null });
    expect(report.unknown_usage).toEqual({ input: 100, output: 100 }); expect(a.observations[0].usage).toEqual({ input_tokens: null, output_tokens: null });
    for (const field of ["scheduled_invariants", "attempted_invariants", "completed_invariants", "domain_valid_invariants", "scored_invariants"]) expect(Object.values(report.by_target_language_semantic_class).reduce((sum: number, row: any) => sum + row[field], 0)).toBe(216);
    expect(report.activation_sha256).toBe(sha256(JSON.stringify(a.lock, null, 2) + "\n"));
  });
  it.each([0, 1])("keeps unavailable observations unscored with %i attempted POSTs per slot", (posts) => {
    const a = mechanical(); a.adjudications = [];
    for (const row of a.observations) { row.status = "unavailable"; row.provider_generation_posts = posts; delete row.output_sha256; row.domain_validation = "not_run"; }
    expect(score(a)).toMatchObject({ totals: { scheduled: 100, observed: 100, attempted: posts * 100, completed: 0, scored: 0, unavailable: 100 }, qualification_gate: "not_qualified" });
  });
  it.each(["transport_error", "refused", "invalid_output", "not_attempted"])("retains %s as an explicit unscored denominator", (status) => {
    const a = mechanical(); a.adjudications = [];
    for (const row of a.observations) { row.status = status; if (status === "not_attempted") row.provider_generation_posts = 0; if (status === "invalid_output") { row.domain_validation = "failed"; row.validation_error_codes = ["synthetic-schema-error"]; } }
    const report = score(a); expect(report.totals[status]).toBe(100); expect(report.totals.scored).toBe(0); expect(report.qualification_gate).toBe("not_qualified");
  });
  it("does not shrink the denominator for a missing slot or judgment", () => {
    const a = mechanical(); a.observations.pop(); a.adjudications.pop(); a.adjudications.pop();
    expect(score(a)).toMatchObject({ totals: { scheduled: 100, observed: 99, missing: 1, unadjudicated: 1, scored: 98 }, qualification_gate: "not_qualified" });
  });
  it.each(["false_acceptance", "omission", "false_rejection"])("one critical %s fails despite all other passes", (verdict) => {
    const a = mechanical(); a.adjudications[0].invariants[0].verdict = verdict; expect(score(a).totals[`critical_${verdict}`]).toBe(1); expect(score(a).qualification_gate).toBe("failed");
  });
  it("cannot hide a critical defect behind incomplete or undetermined judgments", () => {
    const a = mechanical(); a.adjudications[0].invariants = [a.adjudications[0].invariants[0]]; a.adjudications[0].invariants[0].verdict = "omission";
    expect(score(a)).toMatchObject({ totals: { critical_omission: 1, unadjudicated: 1 }, critical_gate: "failed", repeat_stability: { comparable_pairs: 49 } });
    a.adjudications[0].invariants[0].verdict = "undetermined"; expect(score(a)).toMatchObject({ totals: { critical_omission: 0, unadjudicated: 1 }, critical_gate: "not_qualified", repeat_stability: { comparable_pairs: 49 } });
  });
  it("does not inflate semantic failures with a connectivity probe failure", () => {
    const a = mechanical(), index = a.observations.findIndex((r) => r.slot_id.includes("connection_probe")); a.adjudications[index].invariants[0].verdict = "false_acceptance";
    const report = score(a); expect(report.totals).toMatchObject({ critical_false_acceptance: 0, protocol_failure: 1 }); expect(report.by_evaluation_kind.semantic.protocol_failure).toBe(0); expect(report.qualification_gate).toBe("failed");
  });
  it.each(["duplicate", "foreign", "old_source", "old_input", "before_freeze", "extra_post", "missing_output", "invalid_usage", "domain_bypass"])("rejects corrupt receipt %s", (fault) => {
    const a = mechanical(), row = a.observations[0];
    if (fault === "duplicate") a.observations.push(structuredClone(row)); if (fault === "foreign") row.slot_id = "foreign"; if (fault === "old_source") row.source_revision = "b".repeat(40); if (fault === "old_input") row.input_sha256 = hash("changed");
    if (fault === "before_freeze") row.observed_at = "2026-11-03T23:59:59Z"; if (fault === "extra_post") row.provider_generation_posts = 2; if (fault === "missing_output") delete row.output_sha256; if (fault === "invalid_usage") row.usage.input_tokens = -1; if (fault === "domain_bypass") row.domain_validation = "skipped";
    expect(() => score(a)).toThrow();
  });
  it.each(["duplicate", "foreign", "output", "oracle", "source", "self_grading", "provenance", "invariant"])("rejects corrupt judgment %s", (fault) => {
    const a = mechanical(), judgment = a.adjudications[0];
    if (fault === "duplicate") a.adjudications.push(structuredClone(judgment)); if (fault === "foreign") judgment.slot_id = "foreign"; if (fault === "output") judgment.output_sha256 = hash("other-output"); if (fault === "oracle") judgment.oracle_sha256 = hash("other-oracle");
    if (fault === "source") judgment.invariants[0].source_span_ids = ["wrong-source"]; if (fault === "self_grading") judgment.reviewer_id = a.lock.targets[0].model_id; if (fault === "provenance") judgment.review_evidence_reference = " "; if (fault === "invariant") judgment.invariants.push(structuredClone(judgment.invariants[0]));
    expect(() => score(a)).toThrow();
  });
  it.each(["$.unrelated", "$.requirements[*].text", "$.requirements[-1].text", "$.requirements[0].text..x", "$.requirements[0].text;approve", 12, null])("requires actual related concrete output paths: %s", (path) => {
    const a = mechanical(); a.adjudications[0].invariants[0].examined_output_paths = [path]; expect(() => score(a)).toThrow("JUDGMENT_TRACE_MISSING");
  });
  it("accepts a concrete leaf, and an omitted parent's inspected path only for an omission finding", () => {
    const a = mechanical(); a.adjudications[0].invariants[0].examined_output_paths = ["$.requirements[3].source_semantics.actor"]; expect(() => score(a)).not.toThrow();
    a.adjudications[0].invariants[0].examined_output_paths = ["$.requirements"]; expect(() => score(a)).toThrow("JUDGMENT_TRACE_MISSING");
    a.adjudications[0].invariants[0].verdict = "omission"; expect(score(a).totals.critical_omission).toBe(1);
  });
  it("separates changed output hashes from semantic repeat disagreement", () => {
    const a = mechanical(); a.observations[1].output_sha256 = a.adjudications[1].output_sha256 = hash("different equivalent prose");
    expect(score(a).repeat_stability).toEqual({ comparable_pairs: 50, differing_output_hashes: 1, differing_invariant_verdicts: 0 });
    a.adjudications[1].invariants[0].verdict = "omission"; expect(score(a).repeat_stability.differing_invariant_verdicts).toBe(1);
  });
});
