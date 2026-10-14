import type { Opportunity } from "../types";

export const isSelected = (opportunity: Opportunity) =>
  ["shortlisted", "in_progress", "submitted"].includes(opportunity.status);

export const opportunityStatusLabel = (status: Opportunity["status"]) =>
  ({
    new: "Awaiting your decision",
    deferred: "Awaiting your decision",
    declined: "Archived",
    shortlisted: "Ready to start",
    in_progress: "Preparing proposal",
    submitted: "Submitted",
  })[status];

export function deadlineSourceLabel(opportunity: Opportunity) {
  if (!opportunity.deadline) return "No closing date supplied";
  if (opportunity.deadlineSource) return opportunity.deadlineSource;
  if (opportunity.reference.startsWith("DEMO-"))
    return "Synthetic example date";
  return "Source not recorded";
}
