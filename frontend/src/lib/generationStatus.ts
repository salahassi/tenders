export type GenerationProgress = {
  kind: string;
  status: string;
  error_code?: string | null;
};

export const generationNeedsAttention = (plan: GenerationProgress) =>
  ["blocked", "failed"].includes(plan.status);

const errorMessages: Record<string, string> = {
  DATA_AUTHORIZATION_REQUIRED:
    "Processing stopped while checking which inputs can be used. Select Resume saved work here to continue with your configured models.",
  DATA_POLICY_BLOCKED:
    "The workspace data policy excludes content used by this request. Review the attached files and company evidence before resuming.",
  MODEL_NOT_CONFIGURED:
    "No configured model is available for this task. Set up a model under Models & providers, then resume the saved work.",
  MODEL_CORRECTION_EXHAUSTED:
    "The generated response did not pass the required checks after its correction attempts. Your completed work is saved. Open attempts and details to review the failed step.",
  GENERATION_HANDLER_FAILED:
    "A processing error stopped this request. Your completed work is saved. Resume saved work to try again.",
  STALE_INPUT:
    "The evidence changed while this request was being processed. Review the changed files and use the recovery options below.",
  REASSESSMENT_SUPERSEDED:
    "A newer assessment replaced this request. Use the current assessment below.",
  NOTICE_DETAILS_REFRESHED:
    "The original notice was updated. Processing continues in a request using its current evidence.",
  NOTICE_DETAILS_REQUIRED:
    "The original notice needs to be read before assessment can continue. Open attempts and details to check its progress.",
};

export function generationStatusMessage(plan: GenerationProgress): string {
  if (plan.status === "completed")
    return plan.kind === "proposal"
      ? "Your proposal is ready. Open it to review and download."
      : "Assessment complete. Review the result for this opportunity.";
  if (plan.status === "canceled")
    return [
      "REASSESSMENT_SUPERSEDED",
      "NOTICE_DETAILS_REFRESHED",
      "NOTICE_DETAILS_REQUIRED",
    ].includes(plan.error_code || "")
      ? errorMessages[plan.error_code!]
      : "This request was canceled. Saved results are retained.";
  if (
    plan.error_code === "MODEL_ROUND_EXHAUSTED" &&
    ["queued", "running", "retry_wait", "quota_wait"].includes(plan.status)
  )
    return "Waiting for an available provider. The system will retry automatically; your completed work is saved.";
  if (plan.error_code && errorMessages[plan.error_code])
    return errorMessages[plan.error_code];
  switch (plan.status) {
    case "queued":
      return "Waiting to start. Processing continues automatically.";
    case "running":
      return plan.kind === "proposal"
        ? "Your proposal is being prepared. Completed steps are saved."
        : "Your current evidence is being assessed.";
    case "retry_wait":
    case "quota_wait":
      return "Waiting to retry. Processing will continue automatically; your completed work is saved.";
    case "blocked":
    case "failed":
      return "Processing stopped. Your completed work is saved. Open attempts and details to review the failed step and recovery options.";
    default:
      return "Processing status is being updated.";
  }
}

const stageLabels: Record<string, string> = {
  assessment: "Assessing fit",
  analysis: "Reading tender requirements",
  planning: "Planning the proposal",
  drafting: "Writing the proposal",
  commercial: "Preparing commercial details",
  review: "Checking the proposal",
  reconciliation: "Completing final checks",
  completed: "Complete",
};
export const generationStageLabel = (stage: string) =>
  stageLabels[stage] || stage.replaceAll("_", " ");
