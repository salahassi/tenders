// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { fixtures, evaluate, limitsForSuite, validateTargets } from "../../scripts/ops/live-model-evaluation.mjs";
import { semanticCorpus } from "../../scripts/ops/live-model-evaluation-semantics.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";

const findings: Record<string, string> = {
  modality: "The optional workshop was incorrectly strengthened to mandatory.",
  prohibition: "Subcontracting is prohibited, but the candidate permits it.",
  actor: "The source assigns the test accounts to the buyer, not the supplier.",
  trigger: "The phase two approval condition was removed, making delivery unconditional.",
  exception: "The legal retention exception was removed from the deletion obligation.",
  unit_translation: "The source requires 30 days, not 30 months.",
  number_association: "12 reports are required; 36 refers to test accounts, not reports.",
  consequence: "The buyer may choose a deduction; it is not mandatory or automatic.",
};
function reportFor(fixture: any) {
  const quote = fixture.context.candidate.requirements[0].text;
  const bad = fixture.qualification.variant === "mutated";
  const finding = bad ? findings[fixture.qualification.family] : "The candidate preserves the source meaning.";
  return { checked_candidate_hash: fixture.context.candidate_hash, reviewed_all_content: true,
    processed_content_ids: fixture.context.content_units.map((c: any) => c.id),
    processed_requirement_ids: fixture.required,
    claims: [{ id: "claim-1", claim: quote, candidate_quote: quote, kind: "tender_fact",
      status: bad ? "contradicted" : "supported", source_refs: [{ id: fixture.required[0], quote: fixture.evidence[0].text }], finding }],
    requirement_checks: [{ requirement_id: fixture.required[0], status: bad ? "contradicted" : "supported", candidate_quote: quote,
      source_refs: [{ id: fixture.required[0], quote: fixture.evidence[0].text }], finding }], findings: [] };
}
afterEach(() => vi.restoreAllMocks());

it("freezes 32 paired cases and keeps gold, variant, split and finding patterns outside every provider prompt", async () => {
  const { corpus, sha256: corpusHash } = await semanticCorpus();
  expect(corpus.policy).toMatchObject({ critical_false_acceptances: 0, faithful_false_rejections: 0, repetitions: 1, automatic_retries: 0 });
  expect(corpus.split).toBe("development");
  for (const language of ["en", "ar"] as const) {
    const cases = await fixtures(`semantic_${language}`);
    expect(cases).toHaveLength(16);
    expect(new Set(cases.map((f: any) => f.qualification.family)).size).toBe(8);
    for (const f of cases) {
      const prompt = JSON.parse(modelPrompt(f.task, f.context, f.evidence, f.required, f.language, false, f.verificationRevision, f.semanticRevision));
      expect(prompt.untrusted_data.candidate_hash).toBe(await sha256(JSON.stringify(f.context.candidate)));
      expect(prompt.untrusted_data.response_style).toBe("compact-verification-v3");
      expect(JSON.stringify(prompt.untrusted_data)).not.toMatch(/defect_term_groups|qualification|expected_field_paths|faithful|mutated|EVAL_SEMANTIC/);
      expect(f.qualification.corpus_sha256).toBe(corpusHash);
      const report = reportFor(f);
      expect(() => f.domainValidate(report), f.id).not.toThrow();
      expect(() => f.assert(report), f.id).not.toThrow();
    }
  }
});

it("never counts a blanket supported verdict, generic rejection, wrong-source finding or wrong-hash report as detection", async () => {
  for (const f of [...await fixtures("semantic_en"), ...await fixtures("semantic_ar")]) {
    const r = reportFor(f);
    r.checked_candidate_hash = "0".repeat(64);
    expect(() => f.domainValidate(r)).toThrow();
    if (f.qualification.variant !== "mutated") continue;
    for (const mode of ["supported", "generic", "wrong_source"]) {
      const report = reportFor(f);
      if (mode === "supported") {
        report.claims[0].status = report.requirement_checks[0].status = "supported";
      } else if (mode === "generic") {
        report.claims[0].finding = report.requirement_checks[0].finding = "Some unspecified issue.";
      } else {
        report.requirement_checks[0].requirement_id = "unrelated-source";
        report.claims[0].source_refs[0].id = "unrelated-source";
      }
      expect(() => f.assert(report), `${f.id}:${mode}`).toThrow("EVAL_SEMANTIC_FALSE_ACCEPTANCE");
    }
  }
});

it("counts false rejection of each faithful bilingual control independently", async () => {
  for (const f of [...await fixtures("semantic_en"), ...await fixtures("semantic_ar")].filter((f: any) => f.qualification.variant === "faithful")) {
    const report = reportFor(f);
    report.requirement_checks[0].status = "insufficient";
    expect(() => f.assert(report)).toThrow("EVAL_SEMANTIC_FALSE_REJECTION");
  }
});

it("accepts a canonical short quotation of the changed field without requiring the full sentence", async () => {
  const { corpus } = await semanticCorpus();
  for (const f of [...await fixtures("semantic_en"), ...await fixtures("semantic_ar")].filter((f: any) => f.qualification.variant === "mutated")) {
    const row = corpus.cases.find((r: any) => r.family === f.qualification.family && r.language === f.language)!;
    const report = reportFor(f);
    report.claims[0].candidate_quote = report.requirement_checks[0].candidate_quote = row.oracle.offending_candidate_spans[0];
    expect(() => f.domainValidate(report), f.id).not.toThrow();
    expect(() => f.assert(report), f.id).not.toThrow();
    report.claims[0].candidate_quote = report.requirement_checks[0].candidate_quote = "";
    expect(() => f.assert(report)).toThrow("EVAL_SEMANTIC_FALSE_ACCEPTANCE");
  }
});

const targets = ["openai", "qwencloud"].map((provider) => ({ provider, model: "synthetic-model", project_ref: "fixture",
  key: "synthetic-private-key", capabilities: defaultCapabilities(provider as "openai" | "qwencloud") }));
it("bounds actual adapter attempts and records every unavailable target/case without exposing credentials or silently passing", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(limitsForSuite("semantic_ar")).toMatchObject({ models: 4, generations: 64 });
  const transport = vi.fn(async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }));
  const report = await evaluate(targets, transport as typeof fetch, async () => {}, undefined, "semantic_ar");
  expect(report.complete).toBe(true);
  expect(report.passed).toBe(false);
  expect(report.results).toHaveLength(32);
  expect(report.generations).toBe(32);
  expect(transport).toHaveBeenCalledTimes(32);
  expect(report.results.every((r: any) => !r.passed && r.qualification.split === "development")).toBe(true);
  expect(report.production_records_created).toBe(0);
  expect(report.results.every((r: any) => r.semantic_outcome === "not_scored")).toBe(true);
  expect(JSON.stringify(report)).not.toContain(targets[0].key);
  expect(() => validateTargets([...targets, ...targets], "semantic_ar")).toThrow("EVAL_DUPLICATE_TARGET");
  expect(() => validateTargets([targets[1]], "semantic_ar")).toThrow("EVAL_BOTH_PROVIDERS_REQUIRED");
});
