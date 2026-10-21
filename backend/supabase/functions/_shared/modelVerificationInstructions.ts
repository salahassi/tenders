// Immutable application policy. Never interpolate provider, user or document
// instructions here. New wording requires a new phase-pinned policy version.
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
