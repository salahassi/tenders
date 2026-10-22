// @vitest-environment node
import { expect, it } from "vitest";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";
import {
  mergeVerificationReports,
  sameVerificationPartition,
} from "../../supabase/functions/_shared/modelVerification";

it("preserves partition identity across JSONB key ordering while rejecting real policy changes", () => {
  const policy = { version: 2 as const, outputTokens: 40000 };
  expect(
    sameVerificationPartition(
      { policy: { outputTokens: 40000, version: 2 }, version: 4 },
      policy,
    ),
  ).toBe(true);
  for (const pin of [
    null,
    {},
    [],
    { version: 4, policy: { version: 2, outputTokens: 16384 } },
    { version: 3, policy },
    { version: 4, policy, extra: true },
    { version: 4, policy: { ...policy, extra: true } },
    { version: 4, policy: { version: 2, outputTokens: "40000" } },
  ])
    expect(sameVerificationPartition(pin, policy)).toBe(false);
});

const hash = "a".repeat(64);
function fixture() {
  const candidate = Array.from(
    { length: 160 },
    (_, i) => `Proposed work ${i} requires buyer confirmation.`,
  );
  const units = candidateContent(candidate);
  const reports = [units.slice(0, 80), units.slice(80)].map((scope) => ({
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: scope.map((u) => u.id),
    claims: scope.map((u, i) => ({
      // Provider-local identifiers may already occupy all 200 allowed chars.
      id: "x".repeat(197) + String(i).padStart(3, "0"),
      claim: u.text,
      candidate_quote: u.text,
      kind: "assumption",
      status: "supported",
      source_refs: [],
      finding: "Conditional proposed work.",
    })),
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: Array.from({ length: 30 }, (_, i) => ({
      severity: "advisory",
      code: "CONFIRM_SCOPE",
      detail: "Confirm proposed scope.",
      claim_ids: ["x".repeat(197) + String(i).padStart(3, "0")],
      requirement_ids: [],
    })),
  }));
  const coverage = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((u) => u.id),
    claims: [],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [
      {
        severity: "blocking",
        code: "INCONSISTENT_DELIVERY",
        detail: "The delivery approaches conflict across content batches.",
        claim_ids: [],
        requirement_ids: [],
      },
    ],
  };
  return { candidate, units, reports, coverage };
}
const validateAggregate = (report: unknown, candidate: unknown) =>
  validateGroundingReport(report, candidate, hash, [], [], undefined, {
    aggregateVerification: true,
  });

it("merges document-sized reports without widening provider bounds or losing finding references", () => {
  const { candidate, units, reports, coverage } = fixture();
  for (const [i, report] of reports.entries())
    expect(() =>
      validateGroundingReport(report, candidate, hash, [], [], {
        units: units.slice(i * 80, (i + 1) * 80),
      }),
    ).not.toThrow();
  expect(() =>
    validateGroundingReport(coverage, candidate, hash, [], [], {
      units,
      requirementsOnly: true,
    }),
  ).not.toThrow();
  const merged = mergeVerificationReports(hash, reports, coverage);
  expect(merged.claims).toHaveLength(160);
  expect(merged.findings).toHaveLength(61);
  expect(modelSchemas.verify_grounding.safeParse(merged).success).toBe(false);
  expect(() => validateAggregate(merged, candidate)).not.toThrow();
  expect(new Set(merged.claims.map((c) => c.id)).size).toBe(160);
  expect(merged.claims.every((c) => c.id.length <= 200)).toBe(true);
  for (const [batch, report] of reports.entries())
    for (const [index, finding] of report.findings.entries()) {
      const mapped = merged.findings[batch * 30 + index].claim_ids[0];
      const original = report.claims.find((c) => c.id === finding.claim_ids[0]);
      expect(merged.claims.find((c) => c.id === mapped)?.candidate_quote).toBe(
        original?.candidate_quote,
      );
    }
  // Whole-candidate contradictions remain actionable with no requirement IDs.
  expect(groundingDefects(merged)).toEqual(coverage.findings);
});

it.each(["duplicate_claim", "unknown_finding_claim"])(
  "rejects invalid report ID mappings: %s",
  (defect) => {
    const { reports, coverage } = fixture();
    if (defect === "duplicate_claim")
      reports[0].claims[1].id = reports[0].claims[0].id;
    else reports[0].findings[0].claim_ids = ["missing-claim"];
    expect(() => mergeVerificationReports(hash, reports, coverage)).toThrow();
  },
);

it.each(["source", "candidate_quote", "coverage", "finding"])(
  "keeps deterministic aggregate checks for %s",
  (defect) => {
    const { candidate, reports, coverage } = fixture();
    const merged = mergeVerificationReports(hash, reports, coverage);
    if (defect === "source")
      merged.claims[0].source_refs = [{ id: "fabricated", quote: "invented" }];
    if (defect === "candidate_quote")
      merged.claims[0].candidate_quote = "Unrelated candidate text.";
    if (defect === "coverage") merged.processed_content_ids.pop();
    if (defect === "finding") merged.findings[0].claim_ids = ["missing-claim"];
    expect(() => validateAggregate(merged, candidate)).toThrow();
  },
);

it("keeps missing factual evidence blocking after aggregate schema validation", () => {
  const { candidate, reports, coverage } = fixture();
  const merged = mergeVerificationReports(hash, reports, coverage);
  merged.claims[0].kind = "company_fact";
  const before = JSON.stringify(merged);
  expect(() => validateAggregate(merged, candidate)).not.toThrow();
  expect(groundingDefects(merged)).toEqual([
    expect.objectContaining({
      claim_id: merged.claims[0].id,
      reason: "missing_supporting_evidence",
      status: "insufficient",
      candidate_quote: merged.claims[0].candidate_quote,
    }),
    ...coverage.findings,
  ]);
  expect(JSON.stringify(merged)).toBe(before);
});

it.each(["claims", "findings"])("bounds aggregate %s at 2048", (field) => {
  const { candidate, reports, coverage } = fixture();
  const merged = mergeVerificationReports(hash, reports, coverage);
  if (field === "claims")
    merged.claims = Array.from({ length: 2048 }, (_, i) => ({
      ...merged.claims[0],
      id: `claim-${i}`,
    }));
  else
    merged.findings = Array.from({ length: 2048 }, () => ({
      ...merged.findings[0],
    }));
  // Existing findings must refer to the current bounded claim collection.
  if (field === "claims")
    for (const finding of merged.findings)
      finding.claim_ids = finding.claim_ids.length ? ["claim-0"] : [];
  expect(() => validateAggregate(merged, candidate)).not.toThrow();
  if (field === "claims")
    merged.claims.push({ ...merged.claims[0], id: "claim-2048" });
  else merged.findings.push({ ...merged.findings[0] });
  expect(() => validateAggregate(merged, candidate)).toThrow();
});
