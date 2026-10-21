import { candidateContent } from "./modelGrounding.ts";
import { ModelError } from "./model.ts";

export type ContentUnit = { id: string; text: string };
/** Bound output independently of the provider's token limit. IDs always refer
 * to the original candidate; partitioning never edits or drops its text. */
export function verificationBatches(candidate: unknown) {
  const units = candidateContent(candidate);
  if (
    units.length <= 96 &&
    units.reduce((n, u) => n + u.text.length, 0) <= 8000
  )
    return [];
  const batches: ContentUnit[][] = [];
  let current: ContentUnit[] = [],
    size = 0;
  for (const unit of units) {
    if (
      current.length &&
      (current.length >= 80 || size + unit.text.length > 6000)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += unit.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function mergeVerificationReports(
  hash: string,
  reports: any[],
  coverage?: any,
) {
  const claimIds = reports.map((report, batch) => {
    const ids = new Map<string, string>();
    for (const [index, claim] of report.claims.entries()) {
      if (ids.has(claim.id)) throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
      ids.set(claim.id, `b${batch}-c${index}`);
    }
    return ids;
  });
  return {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: reports.flatMap((r) => r.processed_content_ids),
    claims: reports.flatMap((r, i) =>
      r.claims.map((c: any) => ({ ...c, id: claimIds[i].get(c.id) })),
    ),
    processed_requirement_ids: coverage?.processed_requirement_ids ?? [],
    requirement_checks: coverage?.requirement_checks ?? [],
    findings: [
      ...reports.flatMap((r, i) =>
        r.findings.map((f: any) => ({
          ...f,
          claim_ids: f.claim_ids.map((id: string) => {
            const mapped = claimIds[i].get(id);
            if (!mapped) throw new ModelError("EVIDENCE_REFERENCE_INVALID");
            return mapped;
          }),
        })),
      ),
      ...(coverage?.findings ?? []),
    ],
  };
}
