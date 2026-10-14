import type {
  AppState,
  DocumentRecord,
  Opportunity,
  Proposal,
  ProposalReview,
} from "../types";
import { getPricingReview } from "./pricingReview";

export interface ProposalReviewQuestion {
  id: string;
  question: string;
  reason: string;
  source: string;
  target: string;
  existingAnswer?: string;
}

/** Each file keeps its review target; similarly named files are not merged. */
export function getReviewDocuments(review?: ProposalReview): Array<{
  target: {
    kind: "question" | "section" | "general";
    id: string;
    title?: string;
  };
  document: DocumentRecord;
}> {
  if (!review) return [];
  return [
    ...review.answers.flatMap((answer) =>
      (answer.attachments || []).map((document) => ({
        target: { kind: "question" as const, id: answer.questionId },
        document,
      })),
    ),
    ...(review.sectionChanges || []).flatMap((change) =>
      (change.attachments || []).map((document) => ({
        target: {
          kind: "section" as const,
          id: change.sectionId,
          title: change.sectionTitle,
        },
        document,
      })),
    ),
    ...(review.attachments || []).map((document) => ({
      target: { kind: "general" as const, id: "additional-comments" },
      document,
    })),
  ];
}

/** Display recorded questions and explicit missing-input markers. No model inference. */
export function getProposalReviewQuestions(
  proposal: Proposal,
  opportunity: Opportunity,
): ProposalReviewQuestion[] {
  const questions: ProposalReviewQuestion[] = opportunity.gaps.map((gap) => ({
    id: `gap:${gap.id}`,
    question: gap.question,
    reason: gap.required
      ? "This recorded question needs an answer before the response can be finalized."
      : "This recorded clarification can affect the proposed scope or assumptions.",
    source: "Recorded opportunity question; confirm against the RFP",
    target: "Proposal scope and assumptions",
    existingAnswer: gap.answer,
  }));
  for (const section of proposal.sections) {
    const markers = [
      ...section.body.matchAll(/\[INPUT REQUIRED\s*:\s*([^\]]+)\]/gi),
    ];
    if (!section.body.trim() && !markers.length) {
      questions.push({
        id: `section:${section.id}:empty`,
        question: `What information should be used to complete “${section.title}”?`,
        reason: "The saved proposal contains an empty section.",
        source: `Current proposal · ${section.title}`,
        target: section.title,
      });
    }
    for (const [index, marker] of markers.entries()) {
      questions.push({
        id: `section:${section.id}:${index}`,
        question: marker[1].trim(),
        reason:
          "The saved proposal explicitly marks this information as missing.",
        source: `Current proposal · ${section.title}`,
        target: section.title,
      });
    }
  }
  for (const requirement of opportunity.requirements) {
    if (requirement.mandatory && requirement.status === "open") {
      questions.push({
        id: `requirement:${requirement.id}`,
        question: `What should the proposal state to address: ${requirement.text}`,
        reason:
          "This mandatory requirement is still recorded as open. A recorded status is not an AI verification of the current response.",
        source: requirement.source || "RFP reference not recorded",
        target:
          proposal.sections
            .filter(
              (section) =>
                section.evidence.includes(requirement.id) ||
                section.evidence.includes(requirement.source),
            )
            .map((section) => section.title)
            .join(", ") || "Relevant proposal response",
        existingAnswer: requirement.response,
      });
    }
  }
  const pricing = getPricingReview(proposal, opportunity);
  for (const item of pricing.questions) {
    questions.push({
      id: `pricing:${item.id}`,
      question: item.question,
      reason:
        "The cost estimate needs this input or justification before it can be incorporated into a regenerated proposal.",
      source: item.lineId
        ? `Recorded pricing line · ${proposal.lines.find((line) => line.id === item.lineId)?.description || item.lineId}`
        : "Proposal pricing assumptions",
      target: "Pricing and commercial response",
    });
  }
  return questions;
}

/** A change detector for review context, not an authorization or security hash. */
export function getReviewSourceSignature(
  state: AppState,
  proposal: Proposal,
  opportunity: Opportunity,
): string {
  const snapshot = JSON.stringify({
    proposal: {
      id: proposal.id,
      title: proposal.title,
      version: proposal.version,
      sections: proposal.sections,
      lines: proposal.lines,
      includePricing: proposal.includePricing,
      currency: proposal.currency,
      pricingMode: proposal.pricingMode,
      percentage: proposal.percentage,
      contingency: proposal.contingency,
      tax: proposal.tax,
    },
    opportunity: {
      id: opportunity.id,
      reference: opportunity.reference,
      title: opportunity.title,
      buyer: opportunity.buyer,
      language: opportunity.language,
      documents: opportunity.documents.map(({ id, hash, text, status }) => ({
        id,
        hash,
        text,
        status,
      })),
      requirements: opportunity.requirements,
      gaps: opportunity.gaps,
    },
    companyName: state.settings.companyName,
    notes: state.knowledge,
    companyFiles: state.knowledgeDocuments
      .filter((document) => document.enabled)
      .map(({ id, hash, text, status }) => ({ id, hash, text, status })),
  });
  let first = 2166136261,
    second = 5381;
  for (let index = 0; index < snapshot.length; index++) {
    const code = snapshot.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `review-v1:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function isReviewStale(
  state: AppState,
  proposal: Proposal,
  opportunity: Opportunity,
): boolean {
  return (
    !!proposal.review &&
    (proposal.review.baseVersion !== proposal.version ||
      proposal.review.sourceSignature !==
        getReviewSourceSignature(state, proposal, opportunity))
  );
}
