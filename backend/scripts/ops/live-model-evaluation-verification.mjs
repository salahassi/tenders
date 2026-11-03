/** Fresh synthetic analysis verification; no saved production verdict is replayed. */
import {
  ModelError,
  sha256,
  validateModelResult,
} from "../../supabase/functions/_shared/model.ts";
import {
  candidateContent,
  groundingDefects,
  groundingOptions,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding.ts";

export async function verificationFixtures() {
  const sources = [
    {
      id: "eval-reference-source",
      kind: "rfp",
      verified: false,
      text:
        "[Paragraph 56] This historical case study describes completed portal work for a different buyer.\n" +
        "[Paragraph 57] It is supplied only as reference material and contains no procurement request or obligations from the current buyer.",
      locator: {
        kind: "extracted_character_range",
        structural_markers: ["Paragraph 56", "Paragraph 57"],
      },
    },
    {
      id: "eval-obligation-source",
      kind: "rfp",
      verified: false,
      text: "The current buyer requests a public information portal. The supplier shall deliver the portal within 30 days. The portal must retain an audit log for 90 days.",
    },
  ];
  return Promise.all(
    sources.map(async (source, index) => {
      const evidence = [source];
      const required = [source.id];
      const originalContext = {
        draft_input_version: 1,
        locator: source.locator,
        segment: { start: 0, end: Array.from(source.text).length },
        instruction:
          "Extract all requirements and ambiguities in this exact segment, including mandatory eligibility, commercial and submission rules. Preserve conflicts as questions; a later addendum is evidence, not authority to invent a resolution.",
      };
      const candidate = {
        processed_block_ids: required,
        requirements: [],
        questions: [],
        separate_volumes: false,
        summary:
          index === 0
            ? "تصف الفقرات 56–57 عملاً منجزًا لمشترٍ آخر، وهي مادة مرجعية لا تتضمن طلب شراء أو التزامات من المشتري الحالي."
            : "The current buyer requests a public information portal.",
      };
      // Both candidates pass extraction structure. The second is intentionally
      // semantically incomplete, which the independent verifier must detect.
      validateModelResult("analyze_chunk", candidate, evidence, required, {
        draftInputVersion: 1,
      });
      const hash = await sha256(JSON.stringify(candidate));
      return {
        id:
          index === 0
            ? "analysis_reference_empty_v4"
            : "analysis_obligation_omission_v4",
        task: "verify_grounding",
        language: index === 0 ? "ar" : "en",
        semanticRevision: 4,
        verificationRevision: 4,
        evidence,
        required,
        context: {
          original_task: "analyze_chunk",
          original_context: originalContext,
          candidate_hash: hash,
          content_units: candidateContent(candidate),
          response_style: "compact-verification-v2",
        },
        assertion_scope:
          index === 0
            ? "canonical_grounding_and_supported_source_block_with_no_extraction_defects_in_reference_only_inventory"
            : "canonical_grounding_and_source_associated_detection_of_omitted_delivery_or_audit_obligation",
        domainValidate: (r) =>
          validateGroundingReport(
            r,
            candidate,
            hash,
            evidence,
            required,
            undefined,
            groundingOptions(originalContext),
          ),
        assert: (r) => {
          if (index === 0) {
            if (
              groundingDefects(r).length ||
              !r.requirement_checks.every(
                (check) => check.status === "supported",
              )
            )
              throw new ModelError("EVAL_REFERENCE_INVENTORY_FALSE_DEFECT");
            return;
          }
          const identifiesOmission = (detail) =>
            /omit|missing|not (?:extract|captur|retain|includ|reflect)|fail.{0,20}(?:include|extract|capture|retain|reflect)|lack|incomplete|absent|skip|empty|غياب|أغفل|يغفل|لم.{0,30}(?:استخراج|يتضمن|تشمل)|فارغ/i.test(
              detail,
            ) &&
            /audit|retention|log|deliver|30|90|تدقيق|احتفاظ|سجل|تسليم/i.test(
              detail,
            );
          const found = groundingDefects(r).some(
            (defect) =>
              (defect.requirement_id === source.id &&
                identifiesOmission(defect.detail)) ||
              (defect.severity === "blocking" &&
                (defect.requirement_ids.includes(source.id) ||
                  r.claims.some(
                    (claim) =>
                      defect.claim_ids.includes(claim.id) &&
                      claim.source_refs.some((ref) => ref.id === source.id),
                  )) &&
                identifiesOmission(defect.detail)),
          );
          if (!found)
            throw new ModelError("EVAL_BUYER_OBLIGATION_OMISSION_UNDETECTED");
        },
      };
    }),
  );
}
