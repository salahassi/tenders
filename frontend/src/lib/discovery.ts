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
export function assessmentProgress(o: Opportunity) {
  switch (o.discovery?.state) {
    case "running":
      return { label: "Assessing", message: "An assessment job is running." };
    case "queued":
      return {
        label: "Assessment queued",
        message: "The assessment is in the processing queue.",
      };
    case "retry_wait":
      return {
        label: "Assessment retry scheduled",
        message: "The assessment will retry after a temporary failure.",
      };
    case "quota_wait":
      return {
        label: "Waiting for model quota",
        message: "The assessment will resume when a free model can accept it.",
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
