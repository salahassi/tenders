import type { Opportunity } from "../types";

export const needsDecision = (o: Opportunity) =>
  o.status === "new" || o.status === "deferred";
export const isExpired = (o: Opportunity) => o.discovery?.expired === true;
export const inReviewInbox = (o: Opportunity) =>
  needsDecision(o) &&
  !isExpired(o) &&
  (o.discovery?.inboxVisible ??
    (!!o.assessment &&
      !o.assessment.stale &&
      o.assessment.routing !== "excluded"));
export const outOfScope = (o: Opportunity) =>
  needsDecision(o) &&
  !isExpired(o) &&
  !!o.assessment &&
  !o.assessment.stale &&
  o.assessment.routing === "excluded";
export const assessmentActive = (o: Opportunity) =>
  !!o.discovery &&
  ["queued", "running", "retry_wait", "quota_wait"].includes(o.discovery.state);
function progressState(o: Opportunity) {
  switch (o.discovery?.state) {
    case "running":
      return { label: "Assessing", message: "An assessment job is running." };
    case "queued":
      return {
        label: "Assessment queued",
        message: "The assessment is in the processing queue.",
      };
    case "retry_wait":
      if (o.discovery.error === "MODEL_ROUND_EXHAUSTED")
        return {
          label: "Waiting for an available provider",
          message:
            "No provider returned a valid result. Assessment retries automatically using your provider order.",
        };
      return {
        label: "Assessment retry scheduled",
        message: "The assessment will retry after a temporary failure.",
      };
    case "quota_wait":
      return {
        label: "Waiting for model quota",
        message: "The assessment will resume when a model can accept it.",
      };
    case "blocked":
      return {
        label: "Assessment blocked",
        message:
          "Assessment needs attention. Open processing details to resolve the blocker.",
      };
    case "failed":
      return {
        label: "Assessment failed",
        message: "Open processing details to review the failure and retry.",
      };
    case "pending_schedule":
      return {
        label: "Awaiting scheduling",
        message:
          "Collected and awaiting an assessment job. It is not yet in the review inbox.",
      };
    default:
      return {
        label: "Assessment required",
        message:
          "No assessment job is active. Open processing details to request one.",
      };
  }
}

export function assessmentProgress(o: Opportunity) {
  const progress = progressState(o);
  if (!o.discovery || o.discovery.state === "assessed") return progress;
  const attempts = o.discovery.attempts ?? 0;
  const next = o.discovery.nextAttempt;
  const upcoming =
    ["retry_wait", "quota_wait"].includes(o.discovery.state) &&
    next &&
    Number.isFinite(Date.parse(next))
      ? ` Next attempt: ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Riyadh" }).format(new Date(next))} Riyadh.`
      : "";
  return {
    ...progress,
    message: `${progress.message} Attempts: ${attempts}.${upcoming}`,
  };
}
