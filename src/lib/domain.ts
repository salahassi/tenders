import type { AppState, Opportunity, Proposal, Role } from "../types";
import { calculateFinance } from "./finance";

export type Capability =
  | "read"
  | "edit"
  | "review"
  | "approve"
  | "manage_sources"
  | "manage_settings"
  | "manage_users"
  | "acquisition_approve"
  | "record_submission"
  | "export_draft"
  | "export_final";
export function can(role: Role, action: Capability | string): boolean {
  const everyone = ["read", "review", "export_draft"];
  const editors = ["edit"];
  const owners = [
    "approve",
    "manage_sources",
    "manage_settings",
    "manage_users",
    "acquisition_approve",
    "record_submission",
    "export_final",
  ];
  if (!["Owner", "Editor", "Reviewer"].includes(role)) return false;
  if (everyone.includes(action)) return true;
  if (editors.includes(action)) return role === "Owner" || role === "Editor";
  return owners.includes(action) && role === "Owner";
}

/** UI demo enforcement only. Connected authorization belongs on the server. */
export function canApplyMutation(previous: AppState, next: AppState): boolean {
  const role = previous.settings.role;
  if (role === "Owner") return true;
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (!equal({ ...previous.settings, role: next.settings.role }, next.settings))
    return false;
  if (!equal(previous.audit, next.audit)) return false;
  if (role === "Reviewer") {
    if (
      !equal(previous.opportunities, next.opportunities) ||
      !equal(previous.sources, next.sources) ||
      !equal(previous.knowledge, next.knowledge) ||
      !equal(previous.jobs, next.jobs)
    )
      return false;
    if (previous.proposals.length !== next.proposals.length) return false;
    return next.proposals.every((item) => {
      const before = previous.proposals.find((p) => p.id === item.id);
      if (
        !before ||
        content(before) !== content(item) ||
        before.approvalVersion !== item.approvalVersion ||
        before.version !== item.version
      )
        return false;
      const {
        comments: _beforeComments,
        status: _beforeStatus,
        updatedAt: _beforeTime,
        ...beforeFields
      } = before;
      const {
        comments: _nextComments,
        status: _nextStatus,
        updatedAt: _nextTime,
        ...nextFields
      } = item;
      if (!equal(beforeFields, nextFields)) return false;
      return (
        before.status === item.status ||
        (before.status === "in_review" && item.status === "draft")
      );
    });
  }
  // Editors may propose a source but cannot change approved connector settings.
  if (
    previous.sources.some(
      (source) =>
        !next.sources.some(
          (item) => item.id === source.id && equal(item, source),
        ),
    )
  )
    return false;
  if (
    next.sources.some(
      (source) =>
        !previous.sources.some((item) => item.id === source.id) &&
        source.status !== "proposed",
    )
  )
    return false;
  if (
    next.knowledge.some(
      (item) =>
        item.verified &&
        !previous.knowledge.some((before) => equal(before, item)),
    )
  )
    return false;
  if (
    next.proposals.some(
      (item) =>
        item.status === "approved" &&
        !previous.proposals.some(
          (before) =>
            before.id === item.id &&
            before.status === "approved" &&
            before.approvalVersion === item.approvalVersion,
        ),
    )
  )
    return false;
  if (
    previous.opportunities.some(
      (item) => !next.opportunities.some((after) => after.id === item.id),
    ) ||
    previous.knowledge.some(
      (item) => !next.knowledge.some((after) => after.id === item.id),
    ) ||
    previous.proposals.some(
      (item) =>
        item.status === "approved" &&
        !next.proposals.some((after) => after.id === item.id),
    )
  )
    return false;
  if (
    next.opportunities.some((item) => {
      const before = previous.opportunities.find((p) => p.id === item.id);
      return (
        (item.status === "submitted" && before?.status !== "submitted") ||
        (item.acquisition === "approved" && before?.acquisition !== "approved")
      );
    })
  )
    return false;
  return true;
}

export function getApprovalBlockers(
  state: AppState,
  proposal: Proposal,
): string[] {
  const blockers = [...calculateFinance(proposal).errors];
  const opportunity = state.opportunities.find(
    (item) => item.id === proposal.opportunityId,
  );
  if (!opportunity) return ["The linked opportunity is missing.", ...blockers];
  if (!opportunity.documents.length)
    blockers.push("Add a reviewed RFP document.");
  if (opportunity.documents.some((document) => document.status !== "ready"))
    blockers.push("Resolve document extraction issues.");
  if (!opportunity.requirements.length)
    blockers.push("Confirm a requirement inventory.");
  for (const requirement of opportunity.requirements) {
    if (
      requirement.mandatory &&
      (requirement.status === "open" || !requirement.response.trim())
    )
      blockers.push(`Resolve mandatory requirement: ${requirement.text}`);
    if (requirement.mandatory && !requirement.source.trim())
      blockers.push(`Add source evidence for: ${requirement.text}`);
  }
  for (const gap of opportunity.gaps)
    if (gap.required && !gap.answer.trim())
      blockers.push(`Answer: ${gap.question}`);
  if (!proposal.title.trim()) blockers.push("Add a proposal title.");
  if (!proposal.sections.length) blockers.push("Add proposal sections.");
  if (
    !proposal.sections.some((section) =>
      /commercial|financial|pricing|payment|offer validity|تجاري|الدفع|صلاحية/i.test(
        section.title,
      ),
    )
  )
    blockers.push(
      "Add commercial terms covering offer validity and payment milestones.",
    );
  for (const section of proposal.sections) {
    if (!section.title.trim() || !section.body.trim())
      blockers.push(`Complete section: ${section.title || "Untitled section"}`);
    if (/\[\s*INPUT REQUIRED\s*:/i.test(section.body))
      blockers.push(`Resolve input markers in ${section.title}.`);
  }
  return [...new Set(blockers)];
}

function content(proposal: Proposal) {
  return JSON.stringify({
    title: proposal.title,
    sections: proposal.sections,
    lines: proposal.lines,
    pricingMode: proposal.pricingMode,
    percentage: proposal.percentage,
    contingency: proposal.contingency,
    tax: proposal.tax,
  });
}
function evidence(opportunity: Opportunity | undefined) {
  if (!opportunity) return "";
  return JSON.stringify({
    title: opportunity.title,
    buyer: opportunity.buyer,
    language: opportunity.language,
    documents: opportunity.documents,
    requirements: opportunity.requirements,
    gaps: opportunity.gaps,
  });
}
/** Editing content or its supporting evidence creates a new content version.
 * Comments, role simulation, decision changes, and reading notifications do not. */
export function invalidateChangedApprovals(
  previous: AppState,
  next: AppState,
): AppState {
  const sharedChanged =
    previous.settings.companyName !== next.settings.companyName ||
    JSON.stringify(previous.knowledge) !== JSON.stringify(next.knowledge);
  return {
    ...next,
    proposals: next.proposals.map((proposal) => {
      const before = previous.proposals.find((item) => item.id === proposal.id);
      if (!before) return proposal;
      const changed =
        content(before) !== content(proposal) ||
        evidence(
          previous.opportunities.find(
            (item) => item.id === proposal.opportunityId,
          ),
        ) !==
          evidence(
            next.opportunities.find(
              (item) => item.id === proposal.opportunityId,
            ),
          ) ||
        sharedChanged;
      if (!changed) return proposal;
      return {
        ...proposal,
        status: "draft" as const,
        approvalVersion: null,
        version: Math.max(before.version + 1, proposal.version),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}
