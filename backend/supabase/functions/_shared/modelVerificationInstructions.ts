// Immutable application policy. Never interpolate provider, user or document
// instructions here. New wording requires a new phase-pinned policy version.
export type VerificationRevision = 1 | 2 | 3 | 4 | 5;
export const VERIFICATION_PROMPT_V2 =
  "tenderdesk-grounding-v2-contiguous-quotes";
export const VERIFICATION_INSTRUCTIONS_V2 =
  "Review only the supplied content_units against the supplied evidence. " +
  "Every candidate_quote must be one exact contiguous substring of ONE content_unit.text. " +
  "Every source_refs entry must use an existing evidence.id and its quote must be one exact contiguous substring of THAT evidence.text. " +
  "Copy all words, punctuation and numbers within each selected span, in their original order. " +
  "Do not paraphrase, translate, insert ellipses, skip words, or splice separated passages into a quote. " +
  "Choose a short complete span, not an abbreviated span with words omitted. " +
  "If support comes from two separated spans, return two source_refs entries, even when both use the same evidence.id. " +
  "Split a claim spanning different content units into separate claims with their own exact candidate_quote. " +
  "For supported factual claims, include source quotations that prove the claim, including every stated number; an unrelated occurrence of the same number is not proof. " +
  "Do not label a company_fact, tender_fact or commercial_commitment supported without supporting source_refs. " +
  "Missing supplied company evidence is an uncertainty, not proof that the company lacks the capability; distinguish assumptions and proposed solutions from verified facts. " +
  "Keep justified contradicted or insufficient verdicts and blocking findings; never change a verdict merely to pass validation. " +
  "Copy checked_candidate_hash and return every scoped content ID and required ID exactly. " +
  "For requirements_only, return claims=[] and check the required IDs against content_units; otherwise report the factual claims in the content batch. " +
  "Before returning, check each quotation against its single original text and split any joined spans into separate entries.";

export const VERIFICATION_PROMPT_V3 = "tenderdesk-grounding-v3-review-boundary";
export const VERIFICATION_INSTRUCTIONS_V3 =
  VERIFICATION_INSTRUCTIONS_V2 +
  " " +
  "When original_task is review_proposal, the candidate is an AUDIT REPORT, not the proposal being audited. " +
  "Verify whether its judgments accurately describe original_context.sections, original_context.commercial_draft and the RFP evidence. " +
  "Those supplied sections and commercial fields are proposed content: they establish what the draft says, not independently verified company capabilities. " +
  "A correct negative judgment, partial coverage, missing price, unresolved input or blocking business finding in an audit report is a valid review outcome. " +
  "Do not copy such business risks into this verification report's blocking findings. Verification blocking findings must identify an error in the AUDIT REPORT itself, such as an invented fact, incorrect judgment or omitted required review response. " +
  "For each required ID, check that the audit includes a grounded assessment; do not require the underlying proposal to satisfy every requirement before its audit can be valid. " +
  "Evaluate proposed future delivery as proposed work. Do not demand completed-project test records or existing implementation as proof of a proposed method unless the buyer explicitly requires them with the bid. " +
  "Respect the supplied commercial review scope: missing lines from a scoped projection do not establish global BOQ omissions. Distinguish an explicit request for reconciliation from an assertion that the entire draft is incomplete.";
export const VERIFICATION_PROMPT_V4 =
  "tenderdesk-grounding-v4-analysis-boundary";
export const VERIFICATION_INSTRUCTIONS_V4 =
  VERIFICATION_INSTRUCTIONS_V2 +
  " " +
  "When original_task is analyze_chunk, the candidate is a SOURCE-SEGMENT EXTRACTION, not a proposal response. " +
  "The top-level required_ids identify SOURCE BLOCKS. Each requirement_check evaluates whether its source block was processed faithfully and completely, not whether a proposal fulfills a buyer obligation. " +
  "Return supported for a complete grounded extraction, including accurately retained obligations, exceptions and unresolved conflicts. " +
  "When original_context.draft_input_version is 1, historical examples or unrelated reference material may contain no actual requests by this buyer: requirements=[] is valid when that is what the supplied segment establishes. " +
  "A source-block check is supported when such an empty inventory accurately reflects the source; do not mark it insufficient merely because there is no buyer requirement or proposal response to verify. " +
  "Missing formal RFP material or company proof is an input limitation, not by itself an error in a faithful extraction. Keep those limitations as advisory findings or explicit uncertainties. " +
  "Mark a source-block check insufficient or contradicted for an actual extraction defect, including an omitted buyer obligation, lost qualifier, invented requirement or falsely attributed reference fact. Never invent an obligation to make a source ID look like a requirement. " +
  "All factual assertions still need exact supporting source quotations. Source-location references to paragraphs or tables must match the cited source's supplied extraction markers; their locator numbers do not prove prices, dates or quantities. " +
  "For a corrective verification report, recheck verdicts against this source-block scope and retain every justified defect. Return every scoped source ID and content ID exactly; do not discard a check to avoid reporting a defect.";

// Version 5 changes instructions only. Content IDs, candidate/source quotations,
// report schema and factual evidence guards keep their existing contracts.
export const VERIFICATION_PROMPT_V5 =
  "tenderdesk-grounding-v5-analysis-metadata";
export const VERIFICATION_INSTRUCTIONS_V5 =
  VERIFICATION_INSTRUCTIONS_V4 +
  " " +
  "For a typed analyze_chunk candidate, requirements[*].category is application classification metadata, with the allowed values scope, functional, technical, security, integration, data, operations, deliverables, timeline, team, eligibility, commercial, contractual and submission. " +
  "An exact enum value at that typed category path does not assert a buyer obligation, company capability or commercial commitment. Process its content ID, but do not manufacture a claim, missing-evidence defect, assumption or question solely because that label is not quoted in the source. " +
  "This distinction applies only to the category field visible in the typed candidate. It is not a word-based exemption: the same words inside requirements[*].text, interpretation, acceptance_evidence, owner_question, summary or other narrative retain their ordinary meaning and require normal verification. " +
  "Do not exclude source_semantics, mandatory, actor, negation, conditions, exceptions, quantities, dates, consequences, scope or any narrative assertion from review. A category label cannot turn an optional buyer clause into a mandatory obligation or establish that the company meets it. " +
  "Report genuine narrative factual claims with exact evidence and retain every justified contradiction or missing-source defect. Keep every processed content ID and required source ID exactly; never invent IDs, silently add missing IDs or remove checks to make a report pass.";

export function analysisVerificationCoverage(
  context: unknown,
  requiredIds: string[],
) {
  if (
    !context ||
    typeof context !== "object" ||
    !("original_task" in context) ||
    context.original_task !== "analyze_chunk"
  )
    return undefined;
  const original =
    "original_context" in context ? context.original_context : undefined;
  return {
    kind: "source_block_extraction",
    required_source_ids: requiredIds,
    allow_empty_inventory_for_reference_material: Boolean(
      original &&
      typeof original === "object" &&
      "draft_input_version" in original &&
      original.draft_input_version === 1,
    ),
  };
}
export const verificationPolicyText = (revision: VerificationRevision) =>
  revision === 5
    ? VERIFICATION_INSTRUCTIONS_V5
    : revision === 4
      ? VERIFICATION_INSTRUCTIONS_V4
      : revision === 3
        ? VERIFICATION_INSTRUCTIONS_V3
        : VERIFICATION_INSTRUCTIONS_V2;
export const verificationPolicyVersion = (revision: VerificationRevision) =>
  revision === 5
    ? VERIFICATION_PROMPT_V5
    : revision === 4
      ? VERIFICATION_PROMPT_V4
      : revision === 3
        ? VERIFICATION_PROMPT_V3
        : VERIFICATION_PROMPT_V2;
