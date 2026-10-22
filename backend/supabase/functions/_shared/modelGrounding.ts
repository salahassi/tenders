import { ModelError, validateModelResult, type Evidence } from "./model.ts";
import { normalizedEvidence } from "./sourceModel.ts";
import { validationDiagnostic } from "./modelValidationDiagnostics.ts";

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
function withoutReferenceIdentifiers(text: string, referenceIds: Set<string>) {
  // Internal source and requirement UUIDs identify records, not quantities.
  // Only exact supplied UUIDs at identifier boundaries are exempt. Keep
  // unknown IDs, embedded substrings and all surrounding factual numbers.
  return text.replace(
    /(?<![\p{L}\p{N}_-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\p{L}\p{N}_-])/gu,
    (id) => (referenceIds.has(id) ? "" : id),
  );
}
/** Only keys from the frozen, server-built proposal context may be treated as
 * cross-references. Never derive this allowlist from a candidate or its report. */
export function groundingOptions(context: any, aggregateVerification = false) {
  const keys =
    context?.workflow_version >= 2
      ? [
          ...(Array.isArray(context.response_locations)
            ? context.response_locations.map((r: any) => r?.section_key)
            : []),
          ...(Array.isArray(context.shared_decisions)
            ? context.shared_decisions.map((r: any) => r?.key)
            : []),
        ].filter(
          (key): key is string =>
            typeof key === "string" && /^[a-z][a-z0-9_-]{1,99}$/.test(key),
        )
      : [];
  return {
    aggregateVerification,
    proposalReferenceKeys: [...new Set<string>(keys)],
  };
}
function withoutProposalReferences(text: string, keys: Set<string>) {
  return text.replace(
    /(?<![\p{L}\p{N}_-])[a-z][a-z0-9_-]{1,99}(?![\p{L}\p{N}_-])/gu,
    (key) => (keys.has(key) ? "" : key),
  );
}
function adjacentItemNumbers(
  ref: { id: string; quote: string },
  evidence: Evidence[],
) {
  const source = evidence.find((e) => e.id === ref.id)?.text;
  if (!source || !ref.quote) return [];
  const start = source.indexOf(ref.quote);
  // Require one exact occurrence and a directly adjacent row/list label. Never
  // search unrelated parts of a source merely to find a convenient number.
  if (start < 0 || start !== source.lastIndexOf(ref.quote)) return [];
  const prefix = source
    .slice(0, start)
    .match(/(?:^|\n)[ \t]*([0-9٠-٩۰-۹]{1,4})[.)]?[ \t]*(?:\r?\n[ \t]*)?$/u);
  const table = tableItemNumbers(source, start, ref.quote.length);
  return table ?? (prefix ? numericLiterals(prefix[1]) : []);
}
/** PDF table extraction can put a title and quantity between its row number
 * and the quoted description. Recognize only an explicit BOQ-style header and
 * consecutive row boundaries; never treat an arbitrary nearby number as proof.
 * An unbounded final row is excluded; an explicit page break can bound only its
 * first contiguous paragraph, never arbitrary trailing text or the next page. */
function tableItemNumbers(
  source: string,
  quoteStart: number,
  quoteLength: number,
): string[] | null {
  const text = source
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
  const headers = [...text.slice(0, quoteStart).matchAll(/^[ \t]*#[^\n]*$/gm)];
  const anchor = headers.at(-1)?.index;
  if (anchor === undefined) return null;
  const body = text.slice(anchor);
  const rowPattern = /^[ \t]*([0-9]{1,4})(?=[ \t\r\n]|$)/gm;
  const matches = [...body.matchAll(rowPattern)];
  const first = matches[0];
  if (!first || first[1] !== "1" || first.index > 1200) return null;
  const header = body.slice(0, first.index);
  if (
    !/(?:\bdescription\b|الوصف)/iu.test(header) ||
    !/(?:\bqty\b|\bquantity\b|الكمية)/iu.test(header) ||
    !/(?:\bprice\b|\btotal\b|السعر|الإجمالي)/iu.test(header)
  )
    return null;
  const rows: { number: number; start: number }[] = [];
  let unrecognizedBoundary = Infinity;
  for (const match of matches) {
    const start = anchor + match.index;
    const previousLine = text.slice(0, start).trimEnd().split("\n").at(-1);
    const page = previousLine?.match(/^\[(?:Page|صفحة)\s+([0-9]+)\]$/iu);
    if (page && page[1] === match[1]) continue;
    const number = Number(match[1]);
    if (number !== rows.length + 1) {
      unrecognizedBoundary = start;
      break;
    }
    rows.push({ number, start });
  }
  for (let i = 0; i + 1 < rows.length; i++)
    if (
      quoteStart > rows[i].start &&
      quoteStart + quoteLength <= rows[i + 1].start
    )
      return [String(rows[i].number)];
  const last = rows.at(-1);
  if (last && quoteStart > last.start) {
    const tail = text.slice(last.start);
    const boundary = tail.match(
      /\r?\n[ \t]*\r?\n[ \t]*\[(?:Page|صفحة)\s+[0-9]+\]/iu,
    );
    if (boundary?.index !== undefined) {
      const paragraph = tail.slice(0, boundary.index);
      if (
        !/\r?\n[ \t]*\r?\n/u.test(paragraph) &&
        last.start + boundary.index <= unrecognizedBoundary &&
        quoteStart + quoteLength <= last.start + boundary.index
      )
        return [String(last.number)];
    }
  }
  return [];
}
const itemLabel =
  /(?:\b(?:BOQ\s+)?(?:item|line|row|section|clause)|(?:البند|بند|الصف|صف|الفقرة|فقرة))\s*(?:رقم\s+)?([0-9٠-٩۰-۹]{1,4})(?![0-9٠-٩۰-۹]|[.,٫٬][0-9٠-٩۰-۹])/giu;
function declaredClaimCovered(declared: string, claims: any[]) {
  const text = normalizedEvidence(declared);
  if (
    claims.some(
      (claim) =>
        normalizedEvidence(claim.candidate_quote).includes(text) ||
        normalizedEvidence(claim.claim) === text,
    )
  )
    return true;
  // A compound declaration may be reviewed as several atomic assertions.
  // Count exact quoted spans, never their summed lengths: overlaps/duplicates
  // cannot fill a missing clause, number, negation or punctuation. Only
  // whitespace between covered spans is immaterial after normalization.
  const spans: [number, number][] = [];
  for (const claim of claims) {
    const quote = normalizedEvidence(claim.candidate_quote);
    if (!quote) continue;
    for (
      let start = text.indexOf(quote);
      start >= 0;
      start = text.indexOf(quote, start + 1)
    )
      spans.push([start, start + quote.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let coveredUntil = 0;
  for (const [start, end] of spans) {
    if (text.slice(coveredUntil, start).trim()) return false;
    coveredUntil = Math.max(coveredUntil, end);
  }
  return spans.length > 0 && !text.slice(coveredUntil).trim();
}
export function validateGroundingReport(
  report: any,
  candidate: any,
  candidateHash: string,
  evidence: Evidence[],
  requiredIds: string[],
  scope?: { units: { id: string; text: string }[]; requirementsOnly?: boolean },
  options?: {
    aggregateVerification?: boolean;
    proposalReferenceKeys?: string[];
  },
) {
  validateModelResult(
    "verify_grounding",
    report,
    evidence,
    requiredIds,
    options,
  );
  const units = scope?.units ?? candidateContent(candidate),
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
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
      validationDiagnostic(
        "MODEL_COVERAGE_INCOMPLETE",
        report.checked_candidate_hash !== candidateHash
          ? "candidate_hash_mismatch"
          : "content_ids_mismatch",
        {
          paths: ["$.checked_candidate_hash", "$.processed_content_ids"],
          content_ids: ids,
        },
      ),
    ]);
  }
  const text = normalizedEvidence(units.map((u) => u.text).join("\n"));
  if (units.length && !report.claims.length && !scope?.requirementsOnly)
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
      validationDiagnostic(
        "MODEL_COVERAGE_INCOMPLETE",
        "missing_content_claims",
        { paths: ["$.claims"], content_ids: ids },
      ),
    ]);
  if (scope?.requirementsOnly && report.claims.length)
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
      validationDiagnostic(
        "MODEL_COVERAGE_INCOMPLETE",
        "unexpected_content_claims",
        { paths: ["$.claims"] },
      ),
    ]);
  const referenceIds = new Set([
    ...evidence.map((source) => source.id),
    ...requiredIds,
  ]);
  const proposalReferences = new Set(options?.proposalReferenceKeys ?? []);
  for (const [index, claim] of report.claims.entries()) {
    if (!text.includes(normalizedEvidence(claim.candidate_quote))) {
      console.warn(
        "model_evidence_diagnostic",
        JSON.stringify({ reason: "candidate_quote_mismatch" }),
      );
      throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
        validationDiagnostic(
          "EVIDENCE_REFERENCE_INVALID",
          "candidate_quote_mismatch",
          { paths: [`$.claims[${index}].candidate_quote`] },
        ),
      ]);
    }
    if (
      claim.status === "supported" &&
      claim.source_refs.length > 0 &&
      ["company_fact", "tender_fact", "commercial_commitment"].includes(
        claim.kind,
      )
    ) {
      const quotedNumbers = numericLiterals(
        withoutReferenceIdentifiers(
          claim.source_refs.map((ref: any) => ref.quote).join("\n"),
          referenceIds,
        ),
      );
      const adjacentLabels = claim.source_refs.flatMap((ref: any) =>
        adjacentItemNumbers(ref, evidence),
      );
      let unsupportedLabel = false;
      const unsupportedNumbers: string[] = [];
      const factualText = withoutProposalReferences(
        withoutReferenceIdentifiers(claim.candidate_quote, referenceIds),
        proposalReferences,
      ).replace(itemLabel, (_match: string, label: string) => {
        const number = numericLiterals(label)[0];
        if (
          !quotedNumbers.includes(number) &&
          !adjacentLabels.includes(number)
        ) {
          unsupportedLabel = true;
          unsupportedNumbers.push(number);
        }
        return "";
      });
      unsupportedNumbers.push(
        ...numericLiterals(factualText).filter(
          (n) => !quotedNumbers.includes(n),
        ),
      );
      if (unsupportedLabel || unsupportedNumbers.length) {
        console.warn(
          "model_evidence_diagnostic",
          JSON.stringify({ reason: "numeric_evidence_mismatch" }),
        );
        throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
          validationDiagnostic(
            "EVIDENCE_REFERENCE_INVALID",
            "numeric_evidence_mismatch",
            {
              paths: [
                `$.claims[${index}].candidate_quote`,
                `$.claims[${index}].source_refs`,
              ],
              evidence_ids: claim.source_refs.map((ref: any) => ref.id),
              numeric_literals: [...new Set(unsupportedNumbers)],
            },
          ),
        ]);
      }
    }
  }
  for (const [index, check] of report.requirement_checks.entries())
    if (
      check.candidate_quote &&
      !text.includes(normalizedEvidence(check.candidate_quote))
    ) {
      console.warn(
        "model_evidence_diagnostic",
        JSON.stringify({ reason: "requirement_quote_mismatch" }),
      );
      throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
        validationDiagnostic(
          "EVIDENCE_REFERENCE_INVALID",
          "requirement_quote_mismatch",
          {
            paths: [`$.requirement_checks[${index}].candidate_quote`],
            requirement_ids: [check.requirement_id],
          },
        ),
      ]);
    }
  for (const [index, declared] of (scope
    ? []
    : (candidate.company_claims ?? [])
  ).entries())
    if (!declaredClaimCovered(declared.claim, report.claims))
      throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
        validationDiagnostic(
          "MODEL_COVERAGE_INCOMPLETE",
          "declared_claim_uncovered",
          { paths: [`$.company_claims[${index}].claim`, "$.claims"] },
        ),
      ]);
}
export function groundingDefects(report: any) {
  const missingSupport = (claim: any) =>
    claim.status === "supported" &&
    ["company_fact", "tender_fact", "commercial_commitment"].includes(
      claim.kind,
    ) &&
    !claim.source_refs.length;
  return [
    ...report.claims
      .filter(
        (c: any) =>
          // An explicitly unresolved assumption records missing input in the
          // draft; insufficient evidence alone does not require rewriting it.
          // Contradictions, factual claims and explicit blocking findings still
          // need correction. Do not promote the assumption to a supported fact.
          (c.status !== "supported" &&
            !(c.kind === "assumption" && c.status === "insufficient")) ||
          missingSupport(c),
      )
      .map((c: any) => ({
        kind: c.kind,
        status: missingSupport(c) ? "insufficient" : c.status,
        detail: missingSupport(c)
          ? "This factual assertion has no supporting source reference."
          : c.finding,
        candidate_quote: c.candidate_quote,
        source_refs: c.source_refs,
        ...(missingSupport(c)
          ? {
              claim_id: c.id,
              reason: "missing_supporting_evidence",
              instruction:
                "Support the assertion with supplied evidence, or revise it to an explicit uncertainty, question or conditional proposal. Distinguish missing evidence from lack of real company capability. Never invent a source or a company fact.",
            }
          : {}),
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
