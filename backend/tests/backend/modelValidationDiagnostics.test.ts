// @vitest-environment node
import { expect, it, vi } from "vitest";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import {
  modelValidationCodes,
  modelValidationReasons,
  repairOnlyValidationArtifact,
  validationDiagnostic,
  type ModelValidationCode,
  type ModelValidationReason,
} from "../../supabase/functions/_shared/modelValidationDiagnostics";

const hash = "a".repeat(64);
const diagnostic = () =>
  validationDiagnostic("EVIDENCE_REFERENCE_INVALID", "source_quote_mismatch", {
    paths: ["$.claims[10].source_refs[0].quote"],
    evidence_ids: ["rfp-block-1"],
  });
const report = () => ({
  checked_candidate_hash: hash,
  reviewed_all_content: true,
  processed_content_ids: ["content-0"],
  claims: [
    {
      id: "claim-1",
      claim: "Synthetic delivery is mandatory.",
      candidate_quote: "Synthetic delivery is mandatory.",
      kind: "tender_fact",
      status: "contradicted",
      source_refs: [
        { id: "rfp-block-1", quote: "Synthetic source quotation." },
      ],
      finding: "Synthetic verifier claim remains untrusted.",
    },
  ],
  processed_requirement_ids: ["requirement-1"],
  requirement_checks: [
    {
      requirement_id: "requirement-1",
      status: "insufficient",
      candidate_quote: "Synthetic delivery is mandatory.",
      source_refs: [],
      finding: "Synthetic unresolved requirement.",
    },
  ],
  findings: [
    {
      severity: "blocking",
      code: "SYNTHETIC_LATEST_FINDING",
      detail: "Keep the latest finding even though the report is untrusted.",
      claim_ids: ["claim-1"],
      requirement_ids: ["requirement-1"],
    },
    {
      severity: "advisory",
      code: "SYNTHETIC_ADVISORY",
      detail: "Keep advisory findings too.",
      claim_ids: [],
      requirement_ids: [],
    },
  ],
});

it("retains bounded typed paths, identifiers and numeric literals without copying body or messages", () => {
  const input = {
    paths: [
      "$.claims[10].source_refs[0].quote",
      "$.claims[10].source_refs[0].quote",
    ],
    evidence_ids: ["6bf0ef4d-cd27-47d0-a6c1-9f29217a8dca", "rfp:block-1"],
    requirement_ids: ["req-1"],
    content_ids: ["content-0"],
    numeric_literals: ["120", "-0.5", "120"],
    body: "Synthetic private company body.",
    message: "Synthetic private error message.",
  };
  const result = validationDiagnostic(
    "EVIDENCE_REFERENCE_INVALID",
    "numeric_evidence_mismatch",
    input,
  );
  expect(result).toEqual({
    code: "EVIDENCE_REFERENCE_INVALID",
    reason: "numeric_evidence_mismatch",
    paths: ["$.claims[10].source_refs[0].quote"],
    evidence_ids: input.evidence_ids,
    requirement_ids: ["req-1"],
    content_ids: ["content-0"],
    numeric_literals: ["120", "-0.5"],
  });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("rejects free text and oversized metadata rather than truncating it into a different identifier", () => {
  const result = validationDiagnostic(
    "MODEL_COVERAGE_INCOMPLETE",
    "required_ids_mismatch",
    {
      paths: [
        "$.claims[0].candidate_quote",
        "customer body",
        "$.claims[0]['private text']",
        "$." + "a".repeat(240),
      ],
      evidence_ids: ["safe-id", "customer body", "x".repeat(121)],
      numeric_literals: ["42", "amount 42", "NaN", "Infinity", "1".repeat(81)],
    },
  );
  expect(result.paths).toEqual(["$.claims[0].candidate_quote"]);
  expect(result.evidence_ids).toEqual(["safe-id"]);
  expect(result.numeric_literals).toEqual(["42"]);
});

it("bounds each diagnostic collection and exposes omitted diagnostic count", () => {
  const item = validationDiagnostic(
    "MODEL_COVERAGE_INCOMPLETE",
    "content_ids_mismatch",
    {
      paths: Array.from(
        { length: 40 },
        (_, i) => `$.claims[${i}].candidate_quote`,
      ),
      content_ids: Array.from({ length: 40 }, (_, i) => `content-${i}`),
      numeric_literals: Array.from({ length: 40 }, (_, i) => String(i)),
    },
  );
  expect(item.paths).toHaveLength(16);
  expect(item.content_ids).toHaveLength(16);
  expect(item.numeric_literals).toHaveLength(16);
  const artifact = repairOnlyValidationArtifact({
    candidateHash: hash,
    diagnostics: Array.from({ length: 40 }, () => item),
  });
  expect(artifact.validation_diagnostics).toHaveLength(32);
  expect(artifact.omitted_diagnostic_count).toBe(8);
});

it.each(modelValidationReasons)(
  "supports fixed diagnostic reason %s",
  (reason) => {
    expect(
      validationDiagnostic("EVIDENCE_REFERENCE_INVALID", reason).reason,
    ).toBe(reason);
  },
);

it.each(modelValidationCodes)(
  "supports repairable validation code %s",
  (code) => {
    expect(validationDiagnostic(code, "source_missing").code).toBe(code);
  },
);

it("rejects unknown codes and reasons instead of admitting arbitrary error text", () => {
  expect(() =>
    validationDiagnostic(
      "PRIVATE_TEXT" as ModelValidationCode,
      "source_missing",
    ),
  ).toThrow("INVALID_MODEL_VALIDATION_DIAGNOSTIC");
  expect(() =>
    validationDiagnostic(
      "EVIDENCE_REFERENCE_INVALID",
      "private body" as ModelValidationReason,
    ),
  ).toThrow("INVALID_MODEL_VALIDATION_DIAGNOSTIC");
});

it("creates an explicit unresolved repair instruction that cannot be parsed as a valid verification report", () => {
  const artifact = repairOnlyValidationArtifact({
    candidateHash: hash,
    diagnostics: [diagnostic()],
  });
  expect(artifact.coverage).toBe("repair_only");
  expect(artifact.result.reviewed_all_content).toBe(false);
  expect(artifact.result.claims).toEqual([]);
  expect(artifact.result.requirement_checks).toEqual([]);
  expect(artifact.result.processed_content_ids).toEqual([]);
  expect(artifact.result.processed_requirement_ids).toEqual([]);
  expect(artifact.result.findings).toMatchObject([
    {
      severity: "blocking",
      code: "UNRESOLVED_VALIDATION",
      claim_ids: [],
      requirement_ids: [],
    },
  ]);
  expect(modelSchemas.verify_grounding.safeParse(artifact.result).success).toBe(
    false,
  );
  expect(artifact.result.findings[0].detail).toContain("does not establish");
});

it("requires a specific candidate hash and at least one diagnostic", () => {
  expect(() =>
    repairOnlyValidationArtifact({
      candidateHash: "wrong",
      diagnostics: [diagnostic()],
    }),
  ).toThrow("INVALID_REPAIR_ONLY_CANDIDATE_HASH");
  expect(() =>
    repairOnlyValidationArtifact({ candidateHash: hash, diagnostics: [] }),
  ).toThrow("REPAIR_ONLY_DIAGNOSTIC_REQUIRED");
});

it("preserves every finding from the exact safe schema-valid matching report only as untrusted data", () => {
  const original = report();
  const before = JSON.stringify(original);
  const isReportPolicySafe = vi.fn(() => true);
  const artifact = repairOnlyValidationArtifact({
    candidateHash: hash,
    diagnostics: [diagnostic()],
    untrustedReport: original,
    isReportPolicySafe,
  });
  expect(isReportPolicySafe).toHaveBeenCalledOnce();
  expect(isReportPolicySafe).toHaveBeenCalledWith(before);
  expect(artifact.untrusted_report).toEqual(original);
  expect(artifact.untrusted_report).not.toBe(original);
  expect(artifact.untrusted_report?.findings).toEqual(original.findings);
  expect(artifact.result.findings).toHaveLength(1);
  expect(artifact.result.findings[0].code).toBe("UNRESOLVED_VALIDATION");
  original.findings[0].detail = "Changed after construction";
  expect(JSON.stringify(artifact.untrusted_report)).toBe(before);
});

it.each([
  "missing policy check",
  "policy rejected",
  "schema invalid",
  "different candidate",
])("does not retain report for %s", (condition) => {
  const value = report();
  if (condition === "schema invalid") value.reviewed_all_content = false;
  if (condition === "different candidate")
    value.checked_candidate_hash = "b".repeat(64);
  const isReportPolicySafe =
    condition === "missing policy check"
      ? undefined
      : vi.fn(() => condition !== "policy rejected");
  const artifact = repairOnlyValidationArtifact({
    candidateHash: hash,
    diagnostics: [diagnostic()],
    untrustedReport: value,
    isReportPolicySafe,
  });
  expect(artifact.untrusted_report).toBeUndefined();
  expect(artifact.result.findings[0].severity).toBe("blocking");
  if (condition === "schema invalid" || condition === "different candidate")
    expect(isReportPolicySafe).not.toHaveBeenCalled();
});

it("rebuilds diagnostics to exclude widened runtime fields and returns deterministic artifacts", () => {
  const widened = { ...diagnostic(), body: "Synthetic private body." };
  const input = { candidateHash: hash, diagnostics: [widened] };
  const first = repairOnlyValidationArtifact(input);
  const second = repairOnlyValidationArtifact(input);
  expect(first).toEqual(second);
  expect(JSON.stringify(first)).not.toContain("private body");
  expect(first.validation_diagnostics[0]).not.toBe(widened);
});
