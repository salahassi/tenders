import type { Evidence, ModelTask } from "./model.ts";
import { normalizedEvidence } from "./sourceModel.ts";
import {
  MAX_MODEL_VALIDATION_DIAGNOSTICS,
  validationDiagnostic,
  type ModelValidationDiagnostic,
} from "./modelValidationDiagnostics.ts";

/** Match the existing normalized containment/source-role rule exactly. */
export function quoteReferenceDiagnostic(
  ref: { id: string; quote: string },
  source: Evidence | undefined,
  kind: Evidence["kind"] | undefined,
  path: string,
): ModelValidationDiagnostic | undefined {
  const quote = normalizedEvidence(ref.quote);
  const reason = !source
    ? "source_missing"
    : !quote
      ? "quote_empty"
      : !normalizedEvidence(source.text).includes(quote)
        ? "source_quote_mismatch"
        : kind && source.kind !== kind
          ? "source_kind_mismatch"
          : source.kind === "company" && !source.verified
            ? "company_not_verified"
            : undefined;
  return reason
    ? validationDiagnostic("EVIDENCE_REFERENCE_INVALID", reason, {
        paths: [path],
        evidence_ids: [ref.id],
      })
    : undefined;
}

/** A bounded traversal of a schema-valid task, not a replacement for semantic
 * validation. Keep all independent reference failures visible before repair. */
export function collectReferenceDiagnostics(
  task: ModelTask,
  result: any,
  evidence: Evidence[],
  requiredIds: string[],
  options?: { draftInputVersion?: 1; independentGrounding?: boolean },
) {
  const diagnostics: ModelValidationDiagnostic[] = [];
  let count = 0;
  let code: ModelValidationDiagnostic["code"] | undefined;
  const add = (item: ModelValidationDiagnostic) => {
    code ??= item.code;
    count++;
    // Schema bounds cap traversal; retained diagnostics remain bounded even
    // for a large aggregate verifier report. Paths identify unique checks.
    diagnostics.push(item);
    diagnostics.sort((a, b) => {
      const x = a.paths[0] ?? "",
        y = b.paths[0] ?? "";
      return x < y ? -1 : x > y ? 1 : 0;
    });
    if (diagnostics.length > MAX_MODEL_VALIDATION_DIAGNOSTICS)
      diagnostics.pop();
  };
  const sameIds = (actual: string[], expected: string[]) =>
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    expected.every((id) => actual.includes(id));
  const coverage = (actual: string[], path: string) => {
    if (!sameIds(actual, requiredIds))
      add(
        validationDiagnostic(
          "MODEL_COVERAGE_INCOMPLETE",
          "required_ids_mismatch",
          {
            paths: [path],
            requirement_ids: requiredIds,
          },
        ),
      );
  };
  const sources = new Map<string, Evidence>();
  for (const source of evidence)
    if (!sources.has(source.id)) sources.set(source.id, source);
  const quotes = (
    refs: { id: string; quote: string }[],
    path: string,
    kind?: Evidence["kind"],
    allowedKinds?: Evidence["kind"][],
  ) => {
    for (const [index, ref] of refs.entries()) {
      const found = sources.get(ref.id);
      const source =
        found && (!allowedKinds || allowedKinds.includes(found.kind))
          ? found
          : undefined;
      const diagnostic = quoteReferenceDiagnostic(
        ref,
        source,
        kind,
        `${path}[${index}].quote`,
      );
      if (diagnostic) add(diagnostic);
    }
  };
  if (task === "analyze_chunk") {
    coverage(result.processed_block_ids, "$.processed_block_ids");
    result.requirements.forEach((req: any, index: number) =>
      quotes(
        req.source_refs,
        `$.requirements[${index}].source_refs`,
        options?.draftInputVersion === 1 ? undefined : "rfp",
        options?.draftInputVersion === 1 ? ["rfp", "notice"] : undefined,
      ),
    );
  } else if (task === "verify_grounding") {
    coverage(result.processed_requirement_ids, "$.processed_requirement_ids");
    coverage(
      result.requirement_checks.map((r: any) => r.requirement_id),
      "$.requirement_checks",
    );
    if (
      new Set(result.claims.map((r: any) => r.id)).size !== result.claims.length
    )
      add(
        validationDiagnostic(
          "MODEL_COVERAGE_INCOMPLETE",
          "duplicate_claim_ids",
          { paths: ["$.claims"] },
        ),
      );
    result.claims.forEach((claim: any, index: number) =>
      quotes(
        claim.source_refs,
        `$.claims[${index}].source_refs`,
        claim.kind === "company_fact" && claim.status === "supported"
          ? "company"
          : undefined,
      ),
    );
    result.requirement_checks.forEach((req: any, index: number) =>
      quotes(req.source_refs, `$.requirement_checks[${index}].source_refs`),
    );
  } else if (task === "summarize_review") {
    coverage(result.processed_review_ids, "$.processed_review_ids");
    result.directives.forEach((r: any, i: number) =>
      quotes(r.source_refs, `$.directives[${i}].source_refs`, "review"),
    );
  } else if (task === "classify_opportunity") {
    if (result.scope_decision) {
      quotes(
        result.scope_decision.notice_evidence,
        "$.scope_decision.notice_evidence",
        "notice",
      );
      quotes(
        result.scope_decision.company_evidence ?? [],
        "$.scope_decision.company_evidence",
        "company",
      );
    }
    for (const [key, factor] of Object.entries(result.factors) as [
      string,
      any,
    ][]) {
      quotes(
        factor.notice_evidence,
        `$.factors.${key}.notice_evidence`,
        "notice",
      );
      quotes(
        factor.company_evidence,
        `$.factors.${key}.company_evidence`,
        "company",
      );
    }
  } else if (task === "plan_blueprint" || task === "plan_structure") {
    result.decisions.forEach((r: any, i: number) =>
      quotes(
        r.evidence_refs,
        `$.decisions[${i}].evidence_refs`,
        r.kind === "company_fact" ? "company" : undefined,
      ),
    );
  } else if (task === "draft_section") {
    quotes(result.evidence_refs, "$.evidence_refs");
    for (const [index, claim] of result.company_claims.entries()) {
      const fact = sources.get(claim.source_id);
      if (
        !fact ||
        fact.kind !== "company" ||
        !fact.verified ||
        (options?.independentGrounding
          ? !normalizedEvidence(claim.quote) ||
            !normalizedEvidence(fact.text).includes(
              normalizedEvidence(claim.quote),
            )
          : !fact.text.includes(claim.quote) ||
            !claim.quote.includes(claim.claim))
      )
        add(
          validationDiagnostic(
            "UNSUPPORTED_COMPANY_CLAIM",
            "unsupported_company_claim",
            {
              paths: [
                `$.company_claims[${index}].source_id`,
                `$.company_claims[${index}].quote`,
              ],
              evidence_ids: [claim.source_id],
            },
          ),
        );
    }
  } else if (task === "plan_proposal") {
    coverage(result.processed_requirement_ids, "$.processed_requirement_ids");
  } else if (task === "review_proposal") {
    coverage(result.processed_requirement_ids, "$.processed_requirement_ids");
    coverage(
      result.responses.map((r: any) => r.requirement_id),
      "$.responses",
    );
    result.responses.forEach((r: any, i: number) =>
      quotes(r.evidence_refs, `$.responses[${i}].evidence_refs`),
    );
  }
  return { code, diagnostics, omittedCount: count - diagnostics.length };
}
