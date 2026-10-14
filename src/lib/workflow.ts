import type { Opportunity, Proposal } from "../types";

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

export type OpportunityStage =
  "awaiting_rfp" | "rfp_needs_text" | "ready_to_generate" | "proposal_created";

export function getOpportunityStage(
  opportunity: Opportunity,
  proposals: Proposal[],
): OpportunityStage {
  if (proposals.some((proposal) => proposal.opportunityId === opportunity.id))
    return "proposal_created";
  if (!opportunity.documents.length) return "awaiting_rfp";
  if (opportunity.documents.some((document) => document.status !== "ready"))
    return "rfp_needs_text";
  return "ready_to_generate";
}

export const opportunityStageLabel = (stage: OpportunityStage) =>
  ({
    awaiting_rfp: "Awaiting RFP",
    rfp_needs_text: "Needs readable RFP",
    ready_to_generate: "Ready to generate",
    proposal_created: "Has proposal",
  })[stage];

export const opportunityStageHelp: Record<OpportunityStage | "all", string> = {
  all: "Your selected opportunities only. Open one, obtain the buyer’s RFP and upload it, then generate the proposal linked to that opportunity. The stage follows its RFP files and proposal automatically.",
  awaiting_rfp:
    "No RFP has been uploaded for this opportunity. Obtain the buyer’s RFP from the original notice or buyer, then upload it inside the opportunity.",
  rfp_needs_text:
    "An uploaded RFP file could not be fully read. Open the opportunity and replace or remove unreadable files so the agent can use the RFP text.",
  ready_to_generate:
    "The uploaded RFP files are readable and no proposal exists yet. Open the opportunity and choose Generate proposal. AI generation is awaiting the backend connection.",
  proposal_created:
    "A proposal is already linked to this opportunity. Open it from the opportunity or Proposals to edit its sections and generate a Word file. External submission can be recorded separately inside the opportunity.",
};

export function deadlineSourceLabel(opportunity: Opportunity) {
  if (!opportunity.deadline) return "No closing date supplied";
  if (opportunity.deadlineSource) return opportunity.deadlineSource;
  if (opportunity.reference.startsWith("DEMO-"))
    return "Synthetic example date";
  return "Source not recorded";
}
