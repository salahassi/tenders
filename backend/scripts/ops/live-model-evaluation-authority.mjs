/** Paired synthetic authority checks; only typed candidate fields differ. */
import {
  ModelError,
  sha256,
  validateModelResult,
} from "../../supabase/functions/_shared/model.ts";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph.ts";
import {
  candidateContent,
  groundingDefects,
  groundingOptions,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding.ts";

export async function authorityFixtures() {
  const source = {
    id: "eval-buyer-brief-source",
    kind: "rfp",
    verified: false,
    text: "This buyer brief supports a useful working proposal draft. The buyer requests an optional workshop. No formal RFP has been supplied.",
  };
  const evidence = [source];
  const required = [source.id];
  const originalContext = {
    draft_input_version: 1,
    segment: { start: 0, end: Array.from(source.text).length },
    instruction:
      "Extract all requirements and ambiguities in this exact segment, including mandatory eligibility, commercial and submission rules. Preserve conflicts as questions; a later addendum is evidence, not authority to invent a resolution.",
  };
  return Promise.all(
    [false, true].map(async (strengthened) => {
      const candidate = {
        processed_block_ids: required,
        requirements: [
          {
            text: "Provide an optional workshop.",
            category: "deliverables",
            mandatory: strengthened,
            source_refs: [
              {
                id: source.id,
                quote: "The buyer requests an optional workshop.",
              },
            ],
            interpretation: "",
            acceptance_evidence: "",
            owner_question: null,
          },
        ],
        questions: [
          {
            question:
              "Could the buyer provide a formal RFP if one becomes available?",
            blocking_level: strengthened ? "generation" : "advisory",
            requirement_ids: [],
          },
        ],
        separate_volumes: false,
        summary:
          "The buyer requests an optional workshop for a working proposal draft. No formal RFP has been supplied.",
      };
      validateModelResult("analyze_chunk", candidate, evidence, required, {
        draftInputVersion: 1,
      });
      const hash = await sha256(JSON.stringify(candidate));
      // Exercise the production format pin in ephemeral fixture memory. This
      // store/preflight has no database, routing configuration or provider calls.
      let format = null;
      const context = await verificationContext(
        {
          action: async (operation, payload) => {
            if (operation === "result_get") return format;
            if (operation === "result_put")
              return (format = { value: payload.value });
            throw new ModelError("EVAL_FIXTURE_FORMAT_OPERATION_INVALID");
          },
        },
        { preflight: async () => ({ providers: [] }) },
        {
          original_task: "analyze_chunk",
          original_context: originalContext,
          candidate_hash: hash,
          candidate,
          candidate_text: JSON.stringify(candidate),
          content_units: candidateContent(candidate),
        },
        [],
      );
      if (
        format?.value.version !== 3 ||
        context.candidate !== candidate ||
        context.response_style !== "compact-verification-v3"
      )
        throw new ModelError("EVAL_ANALYSIS_TYPED_FORMAT_MISSING");
      return {
        id: strengthened
          ? "analysis_optional_authority_strengthened_v3"
          : "analysis_optional_authority_supported_v3",
        task: "verify_grounding",
        language: "en",
        semanticRevision: 4,
        verificationRevision: 4,
        evidence,
        required,
        context,
        assertion_scope: strengthened
          ? "canonical_grounding_and_source_associated_detection_of_optional_workshop_promoted_to_mandatory"
          : "canonical_grounding_and_supported_optional_scope_with_nonblocking_missing_formal_rfp_question",
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
          const defects = groundingDefects(r);
          if (!strengthened) {
            if (
              defects.length ||
              !r.requirement_checks.every((c) => c.status === "supported")
            )
              throw new ModelError("EVAL_OPTIONAL_SCOPE_FALSE_DEFECT");
            return;
          }
          const identifiesStrengthening = (defect) => {
            const quotes = [
              ...(defect.source_refs ?? []),
              ...r.claims
                .filter((claim) => defect.claim_ids?.includes(claim.id))
                .flatMap((claim) => claim.source_refs),
            ].map((ref) => ref.quote);
            return (
              /mandatory|obligat|compulsory|strengthen|إلزام|الزام/i.test(
                defect.detail,
              ) &&
              /optional|discretionary|non.?mandatory|اختياري/i.test(
                [defect.detail, ...quotes].join("\n"),
              )
            );
          };
          const linkedToSource = (defect) =>
            defect.requirement_id === source.id ||
            defect.source_refs?.some((ref) => ref.id === source.id) ||
            defect.requirement_ids?.includes(source.id) ||
            r.claims.some(
              (claim) =>
                defect.claim_ids?.includes(claim.id) &&
                claim.source_refs.some((ref) => ref.id === source.id),
            );
          if (
            !defects.some(
              (defect) =>
                linkedToSource(defect) && identifiesStrengthening(defect),
            )
          )
            throw new ModelError(
              "EVAL_OPTIONAL_AUTHORITY_STRENGTHENING_UNDETECTED",
            );
        },
      };
    }),
  );
}
