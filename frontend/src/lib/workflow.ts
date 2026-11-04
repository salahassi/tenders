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
  | "awaiting_rfp"
  | "rfp_needs_text"
  | "rfp_needs_review"
  | "ready_to_generate"
  | "proposal_created";

export function getOpportunityStage(
  opportunity: Opportunity,
  proposals: Proposal[],
): OpportunityStage {
  if (proposals.some((proposal) => proposal.opportunityId === opportunity.id))
    return "proposal_created";
  if (!opportunity.documents.length) return "awaiting_rfp";
  if (opportunity.documents.some((document) => document.status !== "ready"))
    return "rfp_needs_text";
  if (opportunity.documents.some((document) => !document.extractionConfirmed))
    return "rfp_needs_review";
  return "ready_to_generate";
}

export const opportunityStageLabel = (stage: OpportunityStage) =>
  ({
    awaiting_rfp: "Awaiting reference file",
    rfp_needs_text: "Draft ready · unread files",
    rfp_needs_review: "Draft ready · unchecked text",
    ready_to_generate: "Ready to draft",
    proposal_created: "Has proposal",
  })[stage];

export const opportunityStageHelp: Record<OpportunityStage | "all", string> = {
  all: "Your selected opportunities only. Open one, attach reference documents and create its linked proposal draft. The stage follows its files and proposal automatically.",
  awaiting_rfp:
    "Attach a reference document inside the opportunity to begin a draft. It can be an RFP, brief, previous proposal or another useful file.",
  rfp_needs_text:
    "Draft creation is available. Readable pages are retained; missing page text and unread files remain identified for processing. Available text and opportunity details can still be used.",
  rfp_needs_review:
    "Draft creation is available. Checking the extracted text is optional; review incomplete or conflicting information in the resulting draft.",
  ready_to_generate:
    "Create a draft from the available reference documents, even if they are not an RFP. Custom templates and company knowledge are optional.",
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
