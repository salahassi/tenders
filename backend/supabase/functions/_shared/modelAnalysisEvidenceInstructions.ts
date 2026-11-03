import type { Evidence, ModelTask } from "./model.ts";
import {
  modelValidationCodes,
  modelValidationReasons,
  validationDiagnostic,
  type ModelValidationCode,
  type ModelValidationReason,
} from "./modelValidationDiagnostics.ts";

// Immutable phase policy: changes require a new revision, never replacement of
// instructions attached to an accepted or retained provider request.
export const ANALYSIS_EVIDENCE_PROMPT_V1 = "evidence-v1";
export const ANALYSIS_EVIDENCE_INSTRUCTIONS_V1 =
  "For analysis and its repair or verification, distinguish source-block IDs from extracted requirement IDs. " +
  "In an analysis result, including a repaired analysis result, copy processed_block_ids from the supplied top-level required_ids exactly once; do not create new processed IDs. " +
  "In a verification report, use processed_requirement_ids for those scoped required_ids and processed_content_ids for the scoped content_units; do not add analysis-only fields to the verifier schema. " +
  "A source_refs.id must be an existing evidence.id, never a document filename, a content-unit ID, a requirement ID or a shortened source ID. " +
  "Each source_refs.quote must be one contiguous span copied from that same evidence.text. Preserve its original language, words, punctuation and numeral forms even when the generated explanation is in another language. " +
  "Do not translate, paraphrase, insert ellipses or join separated passages inside a quotation. Use separate references for separated spans. " +
  "Keep every cited number, exception and obligation with the words that establish its meaning; an unrelated matching number is not support. " +
  "Only the requirement_source_kinds in the supplied analysis_evidence_contract may support extracted buyer requirements. Company, rate, review and style sources have separate roles and cannot create buyer requirements. " +
  "An allowed source kind is not proof that a document is this buyer's RFP: inspect the source and supplied input limitations; historical examples and arbitrary reference files do not establish buyer obligations. " +
  "Keep known buyer obligations while separating missing company proof into owner_question or questions. Never mark a missing capability as a proven failure. " +
  "For repair, use the typed repair_actions to revisit the exact failing fields and their original sources. Change only unsupported content and the affected references, retain valid content and every processed source-block ID. " +
  "Do not manufacture a quotation or remove a known buyer obligation to satisfy validation. Recheck all quotes and source roles before returning the complete target schema.";

export function analysisEvidenceApplies(task: ModelTask, context: any) {
  return (
    task === "analyze_chunk" ||
    (task === "repair_result" && context?.target_task === "analyze_chunk") ||
    (task === "verify_grounding" && context?.original_task === "analyze_chunk")
  );
}

const repairInstructions: Partial<Record<ModelValidationReason, string>> = {
  source_missing:
    "Resolve the supplied source ID against evidence.id; use the exact existing ID only when its text supports this claim.",
  quote_empty:
    "Copy a nonempty contiguous source span that supports the claim.",
  source_quote_mismatch:
    "Recopy one contiguous span from the identified evidence.text in its original language. Split separated passages into separate references.",
  source_kind_mismatch:
    "Use a source with the required role; a real quote from the wrong kind of source cannot prove the claim.",
  company_not_verified:
    "Use currently verified company evidence or preserve the missing proof as a question or explicit uncertainty.",
  numeric_evidence_mismatch:
    "Check each asserted number against its cited quotation, including units and conditions; correct the assertion or cite its actual supporting span.",
  required_ids_mismatch:
    "Copy every scoped required_id exactly once; do not replace source-block IDs with generated requirement IDs.",
  content_ids_mismatch:
    "Copy every scoped content-unit ID exactly once; keep these IDs separate from source IDs.",
  required_content_missing:
    "Restore the omitted required coverage using supplied evidence, or explicitly identify the missing input without dropping a known obligation.",
};

/** Metadata is derived from the same evidence envelope the validator uses. */
export function analysisEvidenceContract(
  task: ModelTask,
  context: any,
  evidence: Evidence[],
) {
  const original =
    task === "analyze_chunk" ? context : context?.original_context;
  const diagnostics = Array.isArray(context?.validation_diagnostics)
    ? context.validation_diagnostics
    : [];
  return {
    version: 1,
    requirement_source_kinds:
      original?.draft_input_version === 1 ? ["rfp", "notice"] : ["rfp"],
    sources: evidence.map(({ id, kind, verified }) => ({ id, kind, verified })),
    repair_actions: diagnostics.slice(0, 32).flatMap((d: any) => {
      if (
        !d ||
        !modelValidationCodes.includes(d.code) ||
        !modelValidationReasons.includes(d.reason)
      )
        return [];
      const safe = validationDiagnostic(
        d.code as ModelValidationCode,
        d.reason as ModelValidationReason,
        d,
      );
      return [
        {
          ...safe,
          instruction:
            repairInstructions[safe.reason] ??
            "Recheck the indicated field against the original evidence and scoped identifiers, preserving unresolved facts honestly.",
        },
      ];
    }),
  };
}
