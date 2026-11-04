import type { ModelTask, Evidence } from "./model.ts";
import { serviceScopeSchema, type ServiceScope } from "./discovery.ts";
import { collectSourcePageErrors } from "./sourceModel.ts";
import { blockedContent } from "./contentPolicy.ts";
import {
  validationDiagnostic,
  type ModelValidationDiagnostic,
  mergeModelValidationDiagnostics,
} from "./modelValidationDiagnostics.ts";

/** Independent domain checks run only after the complete task schema parsed.
 * Source/candidate text stays private: diagnostics contain field paths and IDs.
 */
export function collectDomainDiagnostics(
  task: ModelTask,
  result: any,
  evidence: Evidence[],
  requiredIds: string[],
  options?: { scopePolicy?: ServiceScope; independentGrounding?: boolean },
) {
  let collected = {
    diagnostics: [] as ModelValidationDiagnostic[],
    omittedCount: 0,
  };
  const retain = (diagnostic: ModelValidationDiagnostic) => {
    collected = mergeModelValidationDiagnostics(collected, {
      diagnostics: [diagnostic],
    });
  };
  let terminalCode: string | undefined;
  const add = (
    reason: Parameters<typeof validationDiagnostic>[1],
    paths: string[],
    code: Parameters<
      typeof validationDiagnostic
    >[0] = "EVIDENCE_REFERENCE_INVALID",
  ) => retain(validationDiagnostic(code, reason, { paths }));
  const coverage = (paths: string[]) =>
    retain(
      validationDiagnostic(
        "MODEL_COVERAGE_INCOMPLETE",
        "required_content_missing",
        { paths, requirement_ids: requiredIds },
      ),
    );
  if (blockedContent(JSON.stringify(result))) {
    terminalCode = "MODEL_OUTPUT_POLICY_BLOCKED";
    add("invalid_scope", ["$"]);
  }
  if (task === "inspect_source_page")
    for (const error of collectSourcePageErrors(result, evidence))
      add(error.reason, [error.path]);
  if (task === "verify_grounding")
    result.findings.forEach((finding: any, index: number) => {
      finding.claim_ids.forEach((id: string, i: number) => {
        if (!result.claims.some((c: any) => c.id === id))
          add("invalid_finding_reference", [
            `$.findings[${index}].claim_ids[${i}]`,
          ]);
      });
      finding.requirement_ids.forEach((id: string, i: number) => {
        if (!requiredIds.includes(id))
          add("invalid_finding_reference", [
            `$.findings[${index}].requirement_ids[${i}]`,
          ]);
      });
    });
  if (task === "summarize_review") {
    result.questions.forEach((q: any, i: number) => {
      if (q.requirement_ids.length)
        add("invalid_finding_reference", [`$.questions[${i}].requirement_ids`]);
    });
    if (!result.directives.length && !result.questions.length)
      coverage(["$.directives", "$.questions"]);
  }
  if (task === "classify_opportunity") {
    const parsedPolicy = serviceScopeSchema.safeParse(options?.scopePolicy);
    const policy = parsedPolicy.success ? parsedPolicy.data : undefined,
      decision = result.scope_decision;
    const invalidScope = Boolean(
      policy &&
      decision &&
      ((policy.scope === "company_knowledge" &&
        (decision.keyword_evidence ?? []).length) ||
        (policy.scope === "keywords" &&
          (decision.company_evidence ?? []).length) ||
        (decision.keyword_evidence ?? []).some(
          (ref: any) =>
            !policy[
              ref.kind === "include" ? "include_keywords" : "exclude_keywords"
            ].includes(ref.keyword),
        )),
    );
    if (invalidScope)
      add("invalid_scope", [
        "$.scope_decision.company_evidence",
        "$.scope_decision.keyword_evidence",
      ]);
    if (
      policy &&
      decision &&
      decision.status !== "uncertain" &&
      !(decision.company_evidence ?? []).length &&
      !(decision.keyword_evidence ?? []).length
    )
      add("source_missing", [
        "$.scope_decision.company_evidence",
        "$.scope_decision.keyword_evidence",
      ]);
    for (const [key, factor] of Object.entries(result.factors) as [
      string,
      any,
    ][]) {
      const keywordScope =
        key === "scope" &&
        policy &&
        policy.scope !== "company_knowledge" &&
        !invalidScope &&
        decision?.status !== "uncertain" &&
        decision?.keyword_evidence?.length &&
        factor.notice_evidence.length;
      if (
        factor.rating !== null &&
        (!factor.notice_evidence.length ||
          (!factor.company_evidence.length && !keywordScope))
      )
        add("source_missing", [
          `$.factors.${key}.notice_evidence`,
          `$.factors.${key}.company_evidence`,
        ]);
    }
  }
  if (task === "plan_proposal") {
    result.sections.forEach((s: any, i: number) => {
      if (s.key.startsWith("fixed-")) {
        terminalCode ??= "TEMPLATE_BLOCK_OVERRIDE";
        add("invalid_scope", [`$.sections[${i}].key`]);
      }
    });
    const addressed = [
      ...result.sections.flatMap((s: any) => s.requirement_ids),
      ...result.questions.flatMap((q: any) => q.requirement_ids),
    ];
    if (
      requiredIds.some((id) => !addressed.includes(id)) ||
      addressed.some((id) => !requiredIds.includes(id))
    )
      coverage(["$.sections", "$.questions"]);
  }
  if (task === "draft_section") {
    if (
      result.requirement_ids.some((id: string) => !requiredIds.includes(id)) ||
      requiredIds.some(
        (id) =>
          !result.requirement_ids.includes(id) &&
          !result.questions.some((q: any) => q.requirement_ids.includes(id)),
      )
    )
      coverage(["$.requirement_ids", "$.questions"]);
    if (!options?.independentGrounding)
      result.content_blocks.forEach((block: any, index: number) => {
        const cells =
          block.type === "table"
            ? [...block.headers, ...block.rows.flat()]
            : [block.text];
        if (
          cells.some((cell: string) =>
            cell
              .split(/[.!?\n]/)
              .some(
                (sentence) =>
                  /we (?:hold|are certified|have delivered|are licensed)|our (?:certifications|customers)|لدينا شهاد|نمتلك شهاد|نحن معتمد|عملاؤنا/i.test(
                    sentence,
                  ) &&
                  !sentence.includes("[INPUT REQUIRED") &&
                  !result.company_claims.some((c: any) =>
                    c.quote.includes(sentence.trim()),
                  ),
              ),
          )
        )
          add(
            "unsupported_company_claim",
            [`$.content_blocks[${index}]`],
            "UNSUPPORTED_COMPANY_CLAIM",
          );
      });
  }
  if (task === "review_proposal")
    result.responses.forEach((response: any, index: number) => {
      if (response.status === "not_applicable_approved") {
        terminalCode ??= "MODEL_CANNOT_APPROVE";
        add("invalid_scope", [`$.responses[${index}].status`]);
      }
    });
  return { ...collected, terminalCode };
}
