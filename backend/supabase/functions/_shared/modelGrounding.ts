import { ModelError, validateModelResult, type Evidence } from "./model.ts";
import { normalizedEvidence } from "./sourceModel.ts";

/** Inspect generated text, including undeclared assertions, without treating
 * verbatim evidence copies or internal IDs as assertions made in the proposal. */
export function candidateContent(candidate: unknown) {
  const units: { id: string; text: string }[] = [];
  const skip =
    /^(?:source_refs|evidence_refs|notice_evidence|company_evidence|quote|source_id|.*_ids|key|rate_id)$/;
  const visit = (value: unknown) => {
    if (typeof value === "string" && value.trim())
      units.push({ id: `content-${units.length}`, text: value });
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        if (!skip.test(key)) visit(child);
  };
  visit(candidate);
  if (units.length > 2048) throw new ModelError("MODEL_CONTEXT_TOO_LARGE");
  return units;
}
const numericLiterals = (text: string): string[] => {
  const normalized = text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
    .replace(/(?<=\d)[,٬](?=\d{3}(?:\D|$))/g, "")
    .replace(/٫/g, ".");
  return normalized.match(/\d+(?:\.\d+)?/g) ?? [];
};
export function validateGroundingReport(
  report: any,
  candidate: any,
  candidateHash: string,
  evidence: Evidence[],
  requiredIds: string[],
) {
  validateModelResult("verify_grounding", report, evidence, requiredIds);
  const units = candidateContent(candidate),
    ids = units.map((u) => u.id);
  if (
    report.checked_candidate_hash !== candidateHash ||
    new Set(report.processed_content_ids).size !==
      report.processed_content_ids.length ||
    ids.length !== report.processed_content_ids.length ||
    !ids.every((id) => report.processed_content_ids.includes(id))
  ) {
    console.warn(
      "model_coverage_diagnostic",
      JSON.stringify({
        phase: "content",
        expected: ids.length,
        processed: report.processed_content_ids.length,
        matched: ids.filter((id) => report.processed_content_ids.includes(id))
          .length,
        candidate_hash_matches: report.checked_candidate_hash === candidateHash,
      }),
    );
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  }
  const text = normalizedEvidence(units.map((u) => u.text).join("\n"));
  if (units.length && !report.claims.length)
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  for (const claim of report.claims) {
    if (!text.includes(normalizedEvidence(claim.candidate_quote)))
      throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    if (
      claim.status === "supported" &&
      ["company_fact", "tender_fact", "commercial_commitment"].includes(
        claim.kind,
      )
    ) {
      const quotedNumbers = numericLiterals(
        claim.source_refs.map((ref: any) => ref.quote).join("\n"),
      );
      if (
        numericLiterals(claim.candidate_quote).some(
          (n) => !quotedNumbers.includes(n),
        )
      )
        throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    }
  }
  for (const check of report.requirement_checks)
    if (
      check.candidate_quote &&
      !text.includes(normalizedEvidence(check.candidate_quote))
    )
      throw new ModelError("EVIDENCE_REFERENCE_INVALID");
  for (const declared of candidate.company_claims ?? [])
    if (
      !report.claims.some(
        (claim: any) =>
          normalizedEvidence(claim.candidate_quote).includes(
            normalizedEvidence(declared.claim),
          ) ||
          normalizedEvidence(claim.claim) ===
            normalizedEvidence(declared.claim),
      )
    )
      throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
}
export function groundingDefects(report: any) {
  return [
    ...report.claims
      .filter((c: any) => c.status !== "supported")
      .map((c: any) => ({
        kind: c.kind,
        status: c.status,
        detail: c.finding,
        candidate_quote: c.candidate_quote,
        source_refs: c.source_refs,
      })),
    ...report.requirement_checks
      .filter((c: any) => c.status !== "supported")
      .map((c: any) => ({
        requirement_id: c.requirement_id,
        status: c.status,
        detail: c.finding,
        source_refs: c.source_refs,
      })),
    ...report.findings.filter((f: any) => f.severity === "blocking"),
  ];
}
