import type { Opportunity } from "../types";

export const ocrPending = (status?: string, error?: string) =>
  status === "awaiting_ocr" ||
  (status === "retry_wait" &&
    ["NOTICE_OCR_PENDING", "SOURCE_OCR_PENDING"].includes(error || ""));
export const awaitingOcr = (o: Opportunity) =>
  ocrPending(o.discovery?.state, o.discovery?.error);

export const needsDecision = (o: Opportunity) =>
  o.status === "new" || o.status === "deferred";
export const isExpired = (o: Opportunity) => o.discovery?.expired === true;
export const inReviewInbox = (o: Opportunity) =>
  needsDecision(o) &&
  !isExpired(o) &&
  !awaitingOcr(o) &&
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
  [
    "queued",
    "running",
    "retry_wait",
    "quota_wait",
    "pending_schedule",
    "awaiting_ocr",
  ].includes(o.discovery.state);
export const scopeNeedsReview = (o: Opportunity) =>
  needsDecision(o) &&
  !isExpired(o) &&
  !!o.assessment &&
  !o.assessment.stale &&
  o.assessment.scope === "uncertain" &&
  o.assessment.routing !== "excluded" &&
  (!o.discovery || o.discovery.state === "assessed");

export type DiscoveryGroup =
  | "pending"
  | "scope"
  | "processing"
  | "ocr"
  | "attention"
  | "excluded"
  | "expired"
  | "archived"
  | "selected";

/** Keep completed uncertainty distinct from a failed or unscheduled assessment. */
export function discoveryGroup(o: Opportunity): DiscoveryGroup {
  if (o.status === "declined") return "archived";
  if (!needsDecision(o)) return "selected";
  if (isExpired(o)) return "expired";
  if (awaitingOcr(o)) return "ocr";
  if (inReviewInbox(o)) return "pending";
  if (outOfScope(o)) return "excluded";
  if (assessmentActive(o)) return "processing";
  if (scopeNeedsReview(o)) return "scope";
  return "attention";
}

export function groupDiscoveries(opportunities: Opportunity[]) {
  const groups: Partial<Record<DiscoveryGroup, Opportunity[]>> = {};
  for (const opportunity of opportunities) {
    const group = discoveryGroup(opportunity);
    (groups[group] ||= []).push(opportunity);
  }
  return groups;
}

const blockerMessages: Record<string, string> = {
  SOURCE_NOTICE_REDIRECTED:
    "The original notice link led to a page without readable tender details. Open the original notice and check its detail link before retrying.",
  MANUAL_SOURCE_REQUIRED:
    "The original notice could not be read automatically. Open it to check whether access or verification is required, then review processing details.",
  SOURCE_LOGIN_REQUIRED:
    "The notice requires sign-in. Open the original notice to access its documents and attach the RFP when available.",
  SOURCE_BROWSER_REQUIRED:
    "The notice needs JavaScript rendering. Open processing details to check the browser reading request.",
  NOTICE_DETAILS_NEED_OCR:
    "The notice is an image or scanned document. Its text must be extracted before assessment can continue.",
  NOTICE_OCR_LOW_CONFIDENCE:
    "The notice image or scan could not be read reliably. Open the original notice and provide a clearer document before retrying.",
  NOTICE_OCR_FAILED:
    "Text extraction from the notice image or scan failed. Open the original notice and review processing details before retrying.",
  NOTICE_DETAIL_SCHEMA_CHANGED:
    "The source page structure changed and the notice details could not be identified. The source reader needs updating before retrying.",
  NOTICE_DETAILS_CONTENT_UNRESOLVED:
    "The page loaded, but its tender details could not be identified. Open the original notice to check the content and its detail link.",
  DATA_POLICY_BLOCKED:
    "The current data policy prevented processing this content. Review the notice and company evidence in processing details before retrying.",
  DATA_AUTHORIZATION_REQUIRED:
    "Processing permission is missing for evidence used by this assessment. Review the data permissions in processing details.",
  MODEL_CORRECTION_EXHAUSTED:
    "The model response did not pass validation after its correction attempts. Open processing details to review the saved attempt and recovery options.",
  STALE_INPUT:
    "Evidence used by this assessment changed. Open processing details to request an assessment using the current evidence.",
};
function progressState(o: Opportunity) {
  if (awaitingOcr(o))
    return {
      label: "Awaiting OCR",
      message:
        "The scanned notice is queued for text extraction. Assessment will continue automatically after its text is available.",
    };
  switch (o.discovery?.state) {
    case "running":
      return { label: "Assessing", message: "An assessment job is running." };
    case "queued":
      return {
        label: "Assessment queued",
        message: "The assessment is in the processing queue.",
      };
    case "retry_wait":
      if (o.discovery.error === "MODEL_IN_PROGRESS")
        return {
          label: "Assessing",
          message:
            "The model request is in progress. The saved assessment will continue automatically when its response is ready.",
        };
      if (
        ["SOURCE_BROWSER_PENDING", "NOTICE_BROWSER_PENDING"].includes(
          o.discovery.error || "",
        )
      )
        return {
          label: "Reading original notice",
          message:
            "The notice is waiting for browser rendering. Assessment will continue after its details are available.",
        };
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
          blockerMessages[o.discovery.error || ""] ||
          "Assessment needs attention. Open processing details to resolve the blocker.",
      };
    case "failed":
      return {
        label: "Assessment failed",
        message:
          blockerMessages[o.discovery.error || ""] ||
          "Open processing details to review the failure and retry.",
      };
    case "pending_schedule":
      return {
        label: "Awaiting scheduling",
        message:
          "Collected and waiting for the scheduler to create its assessment job.",
      };
    default:
      if (o.assessment?.stale)
        return {
          label: "Reassessment required",
          message:
            "The saved assessment is no longer current and no new assessment is scheduled. Open processing details to request reassessment.",
        };
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
  // Parent assessment attempts and its retry timer do not describe OCR progress.
  if (awaitingOcr(o)) return progress;
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
