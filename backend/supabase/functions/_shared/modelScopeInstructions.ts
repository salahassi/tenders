// Immutable, phase-pinned interpretation policy. Business specializations,
// interests and exclusions come only from the supplied database snapshot.
export const SCOPE_COMPARISON_PROMPT_V1 = "scope-v1";
export const SCOPE_COMPARISON_INSTRUCTIONS_V1 =
  "For opportunity classification and its verification or correction, apply this contextual service-scope policy. " +
  "Scope means the relevance of the purchased work to the selected business specialization and interests, not proof of delivery capacity or legal eligibility. " +
  "Derive that specialization only from the supplied current verified Company Knowledge and the database scope_policy selected for this assessment. Never substitute a preset business domain, fixed list of sectors, or your assumptions about this company. " +
  "For company_knowledge, use the verified company services and expertise; for keywords, use the configured interests; for combined, use either the verified company specialization or configured interests. Honor any applicable configured exclusions in keywords or combined mode. Exclusions are optional; the user need not enumerate every unrelated field. " +
  "Compare the meaning, intended outcomes, deliverables and expertise required by the notice with that specialization. Exact terms, literal keyword matches and identical language are not required. A relevant service may be described through its purpose or workflow. Buyer sector alone neither establishes nor rules out relevance. " +
  "When the requested work is clearly understood and substantively unrelated to the evidenced specialization or selected interests, return out_of_scope with citations to both sides of the comparison. This does not require an explicit exclusion keyword, a statement that the company works ONLY in its described fields, or evidence that it is incapable of the work. " +
  "The legacy warning about a service being absent from company files prevents rejection based on missing wording alone; it does not prohibit a supported semantic comparison of different kinds of work. A company profile need not be an exhaustive catalog of every service it can or cannot perform. " +
  "Return in_scope when the purchased work has a supported contextual relationship to the selected specialization or interests. Do not invent an unmentioned component, proposed extra service, subcontractor or hypothetical company capability to manufacture relevance. " +
  "Use uncertain when the notice does not establish the nature of the work, the selected specialization is not sufficiently evidenced, or a material conflict or inseparable mixed scope prevents a justified decision. Describe the actual unresolved scope question. Missing staff availability, certifications, project history or tender-specific qualification evidence alone does not make an otherwise clear scope decision uncertain. " +
  "Keep capability, sector experience and prerequisite factors independently evidence-based. An out_of_scope decision does not prove incapability or ineligibility; an in_scope decision does not prove capacity, experience or compliance. Missing proof for those factors remains unknown. A scope-factor rating may reflect a cited contextual match or mismatch. " +
  "Cite exact supplied notice and selected company quotations or configured terms. Explain the relationship as a comparative assessment; the sources need not state the comparison's conclusion verbatim. Never invent quotations or use interests as company credentials. " +
  "During verification and correction, evaluate this same contextual relationship against the original scope_policy and evidence. Do not reject a grounded scope mismatch merely because no explicit negative company statement or exclusion exists, and do not turn it into uncertain while correcting a separate unsupported capability or eligibility claim. Still reject unsupported scope conclusions, invented relevance and real evidence conflicts. Verification findings are judgments to check, not new company facts or new business criteria.";

/** The task/context discriminator is application-owned; evidence text never
 * selects a trusted instruction policy. */
export function scopeComparisonApplies(
  task: string,
  context: unknown,
): boolean {
  if (task === "classify_opportunity") return true;
  if (!context || typeof context !== "object") return false;
  const value = context as Record<string, unknown>;
  return (
    (task === "verify_grounding" &&
      value.original_task === "classify_opportunity") ||
    (task === "repair_result" && value.target_task === "classify_opportunity")
  );
}
