import type { ModelTask } from "./model.ts";
import {
  modelValidationCodes,
  modelValidationReasons,
  validationDiagnostic,
  type ModelValidationReason,
} from "./modelValidationDiagnostics.ts";

// Immutable policy: accepted phases retain their existing prompt revision.
export const PLANNING_COVERAGE_PROMPT_V1 = "plan-v1";
export const PLANNING_COVERAGE_INSTRUCTIONS_V1 =
  "For proposal structure and blueprint planning, every supplied blueprint_requirement_id needs exactly one primary narrative owner, even when company proof or delivery inputs are missing. " +
  "For plan_structure, put each ID in exactly one narrative section's requirement_ids. For plan_blueprint, put each ID in exactly one unit's requirement_ids within a narrative section. " +
  "Listing an ID in processed_requirement_ids, decisions, questions or secondary_links does not assign a primary owner. A blueprint containing only an executive summary or compliance matrix is invalid when buyer requirements exist. " +
  "Create substantive proposed response locations for known buyer requirements. Missing company credentials, staffing, capacity, infrastructure or approval belong in targeted questions or unresolved_input decisions, while the narrative owner still plans the proposed response and identifies what needs confirmation. Never invent company proof or remove a buyer obligation to avoid an unknown. " +
  "In a blueprint, executive-summary units own no requirements; compliance-matrix sections have no units. Other sections need at least one unit. Use unique section, unit and decision keys; every referenced decision key must exist. " +
  "For assigned_sections detail work, preserve the accepted section fields and ownership scope; use the frozen shared_decisions and return decisions:[] as instructed. Do not create owners outside the assigned scope. " +
  "For repair, use planning_coverage_contract.repair_actions to correct the indicated paths and model-visible IDs. Preserve valid decisions, evidence, questions and response locations while restoring missing primary ownership; do not satisfy coverage by copying IDs only into processed_requirement_ids or questions. Return the complete target schema. " +
  "For verification, inspect only the supplied candidate scope and return the verifier schema with its top-level required_ids and content_units IDs. A content_batch may omit other planned sections; do not infer a global ownership omission from that partial view. Planning coverage is not proof that the final proposal has answered the requirement.";

const planningTask = (task: unknown) =>
  task === "plan_blueprint" || task === "plan_structure";

export function planningCoverageApplies(task: ModelTask, context: any) {
  return (
    planningTask(task) ||
    (task === "repair_result" && planningTask(context?.target_task)) ||
    (task === "verify_grounding" && planningTask(context?.original_task))
  );
}

const repairInstructions: Partial<Record<ModelValidationReason, string>> = {
  required_ids_mismatch:
    "Restore the exact supplied processed requirement IDs; also retain one primary narrative owner for each ID.",
  required_content_missing:
    "Add the missing primary narrative ownership at the indicated paths. Questions, decisions and processed IDs cannot replace it; retain honest missing-input questions.",
  content_ids_mismatch:
    "Correct the indicated duplicate or invalid planning keys and their references without dropping requirement ownership. In a verifier report, retain exactly the scoped content-unit IDs instead.",
  invalid_scope:
    "Restore the indicated section mode and assigned scope. Executive summaries own no requirements and compliance matrices have no units; place required owners in narrative sections.",
  invalid_finding_reference:
    "Use only supplied requirement IDs and existing planning decision keys at the indicated paths; retain the accepted section scope.",
  source_missing:
    "Cite the supplied evidence for a buyer or verified company fact; represent unsupported company facts as unresolved inputs or proposed decisions without removing primary ownership.",
};

export function planningCoverageContract(task: ModelTask, context: any) {
  const target = planningTask(task)
    ? task
    : (context?.target_task ?? context?.original_task);
  const original = planningTask(task) ? context : context?.original_context;
  const diagnostics = Array.isArray(context?.validation_diagnostics)
    ? context.validation_diagnostics
    : [];
  return {
    version: 1,
    primary_requirement_ids: Array.isArray(original?.blueprint_requirement_ids)
      ? original.blueprint_requirement_ids.filter(
          (id: unknown) => typeof id === "string",
        )
      : [],
    ownership_path:
      target === "plan_structure"
        ? "$.sections[*].requirement_ids"
        : "$.sections[*].units[*].requirement_ids",
    scope: Array.isArray(original?.assigned_sections)
      ? "assigned_sections"
      : "global",
    repair_actions: diagnostics.slice(0, 32).flatMap((d: any) => {
      if (
        !d ||
        !modelValidationCodes.includes(d.code) ||
        !modelValidationReasons.includes(d.reason)
      )
        return [];
      const safe = validationDiagnostic(d.code, d.reason, d);
      return [
        {
          ...safe,
          instruction:
            repairInstructions[safe.reason] ??
            "Correct the indicated planning field against the supplied evidence and scope, preserving all required primary narrative owners.",
        },
      ];
    }),
  };
}
