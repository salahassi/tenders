// @vitest-environment node
import { expect, it } from "vitest";
import {
  modelPrompt,
  sha256,
  taskSystemInstructions,
} from "../../supabase/functions/_shared/model";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";
import { primaryModelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import {
  VERIFICATION_INSTRUCTIONS_V4,
  VERIFICATION_INSTRUCTIONS_V5,
} from "../../supabase/functions/_shared/modelVerificationInstructions";
const source = {
  id: "source-1",
  kind: "rfp" as const,
  verified: false,
  text: "The buyer must provide the test accounts.",
};
async function scenario(text = source.text) {
  const candidate = {
    processed_block_ids: [source.id],
    requirements: [
      {
        text,
        category: "deliverables",
        mandatory: true,
        source_refs: [{ id: source.id, quote: source.text }],
        interpretation: "",
        acceptance_evidence: "",
        owner_question: null,
      },
    ],
    questions: [],
    summary: text,
    separate_volumes: false,
  };
  const hash = await sha256(JSON.stringify(candidate)),
    units = candidateContent(candidate);
  const report = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((u) => u.id),
    processed_requirement_ids: [source.id],
    claims: [
      {
        id: "claim1",
        claim: text,
        candidate_quote: text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: source.id, quote: source.text }],
        finding: "The source retains the buyer obligation.",
      },
    ],
    requirement_checks: [
      {
        requirement_id: source.id,
        status: "supported",
        candidate_quote: text,
        source_refs: [{ id: source.id, quote: source.text }],
        finding: "The buyer obligation is retained.",
      },
    ],
    findings: [],
  };
  const ctx = {
    original_task: "analyze_chunk",
    original_context: { draft_input_version: 1, source_contract_version: 1 },
    candidate,
    candidate_hash: hash,
    content_units: units,
    response_style: "compact-verification-v3",
  };
  return { candidate, hash, units, report, ctx };
}
it("describes only the exact category path and keeps every allowed category covered by immutable policy", () => {
  const values =
    primaryModelSchemas.analyze_chunk.shape.requirements.element.shape.category
      .options;
  expect(values).toHaveLength(14);
  for (const value of values)
    expect(VERIFICATION_INSTRUCTIONS_V5).toContain(value);
  expect(
    VERIFICATION_INSTRUCTIONS_V5.startsWith(VERIFICATION_INSTRUCTIONS_V4),
  ).toBe(true);
  expect(VERIFICATION_INSTRUCTIONS_V5).toContain("requirements[*].category");
  expect(VERIFICATION_INSTRUCTIONS_V5).toContain("not a word-based exemption");
  expect(VERIFICATION_INSTRUCTIONS_V5).toContain(
    "Do not exclude source_semantics",
  );
});
it("retains the exact candidate and IDs while a valid verifier avoids manufacturing a category fact", async () => {
  const s = await scenario(),
    prompt = JSON.parse(
      modelPrompt(
        "verify_grounding",
        s.ctx,
        [source],
        [source.id],
        "en",
        false,
        5,
        4,
      ),
    );
  expect(prompt.untrusted_data).toEqual(s.ctx);
  expect(s.units.map((u) => u.text)).toContain("deliverables");
  expect(prompt.verification_policy).toBe(VERIFICATION_INSTRUCTIONS_V5);
  expect(taskSystemInstructions("verify_grounding", 5, 4)).toContain(
    "do not manufacture a claim",
  );
  expect(() =>
    validateGroundingReport(
      s.report,
      s.candidate,
      s.hash,
      [source],
      [source.id],
    ),
  ).not.toThrow();
  expect(groundingDefects(s.report)).toEqual([]);
});
it.each(["tender_fact", "company_fact", "commercial_commitment"])(
  "still rejects unsupported %s narrative using the word deliverables",
  async (kind) => {
    const s = await scenario(
      "Our deliverables include an existing certified platform worth 36 dollars.",
    );
    s.report.claims[0] = { ...s.report.claims[0], kind, source_refs: [] };
    expect(() =>
      validateGroundingReport(
        s.report,
        s.candidate,
        s.hash,
        [source],
        [source.id],
      ),
    ).not.toThrow();
    expect(groundingDefects(s.report)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "missing_supporting_evidence",
          kind,
        }),
      ]),
    );
  },
);
it("does not silently remove the original misclassified category defect", async () => {
  const s = await scenario();
  s.report.claims.push({
    ...s.report.claims[0],
    id: "metadata",
    claim: "The category is deliverables.",
    candidate_quote: "deliverables",
    kind: "tender_fact",
    source_refs: [],
  });
  expect(groundingDefects(s.report)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        candidate_quote: "deliverables",
        reason: "missing_supporting_evidence",
      }),
    ]),
  );
});
it("keeps missing processed IDs and invented finding IDs invalid", async () => {
  const s = await scenario();
  s.report.processed_requirement_ids = [];
  expect(() =>
    validateGroundingReport(
      s.report,
      s.candidate,
      s.hash,
      [source],
      [source.id],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  s.report.processed_requirement_ids = [source.id];
  (s.report.findings as any[]).push({
    severity: "blocking",
    code: "SYNTHETIC",
    detail: "Wrong link",
    claim_ids: ["claim1"],
    requirement_ids: ["requirement-check-0"],
  });
  expect(() =>
    validateGroundingReport(
      s.report,
      s.candidate,
      s.hash,
      [source],
      [source.id],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("keeps a real changed buyer obligation blocking even when its category is valid", async () => {
  const s = await scenario("The supplier must provide the test accounts.");
  s.report.claims[0].status = s.report.requirement_checks[0].status =
    "contradicted";
  expect(groundingDefects(s.report)).toHaveLength(2);
});
