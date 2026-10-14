import { describe, expect, it } from "vitest";
import { createSeedState } from "./fixtures/workspace";
import {
  getProposalReviewQuestions,
  getReviewSourceSignature,
  isReviewStale,
} from "../lib/proposalReview";
import { invalidateChangedApprovals } from "../lib/domain";
import { parseBackup, serializeBackup } from "../lib/legacyBackup";
import { buildAgentInput } from "../lib/agentInput";

describe("proposal review inputs and file version separation", () => {
  function fixture() {
    const state = createSeedState(new Date("2026-10-14T12:00:00Z"));
    const proposal = state.proposals[0];
    const opportunity = state.opportunities.find(
      (o) => o.id === proposal.opportunityId,
    )!;
    return { state, proposal, opportunity };
  }
  it("collects actual missing markers and stored questions without inventing a document outline", () => {
    const { proposal, opportunity } = fixture();
    const questions = getProposalReviewQuestions(proposal, opportunity);
    expect(
      questions.some((q) => q.id === `gap:${opportunity.gaps[0].id}`),
    ).toBe(true);
    expect(
      questions.some(
        (q) =>
          q.target === "Commercial assumptions" &&
          q.question.includes("validity period"),
      ),
    ).toBe(true);
    expect(proposal.sections).toHaveLength(5);
  });
  it("preserves content, version, and approval while saving review inputs and an unexecuted request", () => {
    const { state, proposal, opportunity } = fixture();
    const next = structuredClone(state);
    const review = {
      baseVersion: proposal.version,
      sourceSignature: getReviewSourceSignature(state, proposal, opportunity),
      answers: [
        {
          questionId: `gap:${opportunity.gaps[0].id}`,
          answer: "تتوفر واجهات التكامل وبيئة الاختبار.",
        },
      ],
      instructions: "Revise the delivery schedule and explain pricing effects.",
      savedAt: "2026-10-14T12:00:00Z",
    };
    next.proposals[0].review = {
      ...review,
      regeneration: {
        baseVersion: review.baseVersion,
        sourceSignature: review.sourceSignature,
        answers: review.answers,
        instructions: review.instructions,
        id: "request-1",
        requestedAt: review.savedAt,
        status: "awaiting_connection",
      },
    };
    const updated = invalidateChangedApprovals(state, next);
    expect(updated.proposals[0].sections).toEqual(proposal.sections);
    expect(updated.proposals[0].version).toBe(proposal.version);
    expect(updated.proposals[0].approvalVersion).toBe(proposal.approvalVersion);
    expect(isReviewStale(updated, updated.proposals[0], opportunity)).toBe(
      false,
    );
    const restored = parseBackup(serializeBackup(updated));
    expect(restored.proposals[0].review).toEqual(updated.proposals[0].review);
    expect(restored.proposals[0].review?.regeneration?.status).toBe(
      "awaiting_connection",
    );
    const handoff = buildAgentInput(
      restored,
      opportunity,
      restored.proposals[0],
    );
    expect(handoff.task).toBe("regenerate_proposal");
    expect(handoff.reviewInputs?.answers[0].answer).toContain("واجهات التكامل");
    expect(handoff.proposal?.sections).toEqual(proposal.sections);
  });
  it("detects new RFP or company evidence without pretending a new proposal file exists", () => {
    const { state, proposal, opportunity } = fixture();
    proposal.review = {
      baseVersion: proposal.version,
      sourceSignature: getReviewSourceSignature(state, proposal, opportunity),
      answers: [],
      instructions: "Review scope",
      savedAt: "2026-10-14T12:00:00Z",
    };
    const next = structuredClone(state);
    next.opportunities[0].documents[0].text +=
      "\nAddendum: require an additional interface.";
    const updated = invalidateChangedApprovals(state, next);
    expect(updated.proposals[0].version).toBe(proposal.version);
    expect(updated.proposals[0].sections).toEqual(proposal.sections);
    expect(
      isReviewStale(updated, updated.proposals[0], updated.opportunities[0]),
    ).toBe(true);
    const companyChanged = structuredClone(state);
    companyChanged.knowledge[0].content += " New capability evidence.";
    expect(
      isReviewStale(companyChanged, companyChanged.proposals[0], opportunity),
    ).toBe(true);
  });
  it("accepts ordinary RFP uploads with unspecified classification without relabeling them", () => {
    const { state } = fixture();
    state.opportunities[0].documents[0].classification = "unspecified";
    expect(
      parseBackup(serializeBackup(state)).opportunities[0].documents[0]
        .classification,
    ).toBe("unspecified");
  });
  it("round-trips separately scoped file-only answers and section comments without applying them to the file", () => {
    const { state, proposal, opportunity } = fixture();
    const document = {
      ...opportunity.documents[0],
      id: "review-team-file",
      name: "team.txt",
      text: "Team roles and availability supplied for this question.",
      status: "ready" as const,
    };
    const unreadable = {
      ...document,
      id: "review-image",
      name: "schedule.png",
      status: "needs_ocr" as const,
      text: "partial content must not be treated as complete",
    };
    const next = structuredClone(state);
    const inputs = {
      answers: [
        { questionId: "gap:team", answer: "", attachments: [document] },
      ],
      sectionChanges: [
        {
          sectionId: proposal.sections[0].id,
          sectionTitle: proposal.sections[0].title,
          comment: "عدّل نطاق العمل وفق المرفق.",
          attachments: [document],
        },
        {
          sectionId: proposal.sections[1].id,
          sectionTitle: proposal.sections[1].title,
          comment: "",
          attachments: [unreadable],
        },
      ],
      instructions: "Preserve earlier general notes.",
      attachments: [document],
      baseVersion: proposal.version,
      sourceSignature: getReviewSourceSignature(state, proposal, opportunity),
    };
    next.proposals[0].review = {
      ...inputs,
      savedAt: "2026-10-14T14:00:00Z",
      regeneration: {
        ...inputs,
        id: "request-files",
        requestedAt: "2026-10-14T14:00:00Z",
        status: "awaiting_connection",
      },
    };
    const restored = parseBackup(
      serializeBackup(invalidateChangedApprovals(state, next)),
    );
    expect(restored.proposals[0].review).toEqual(next.proposals[0].review);
    expect(restored.proposals[0].sections).toEqual(proposal.sections);
    expect(restored.proposals[0].version).toBe(proposal.version);
    const input = buildAgentInput(restored, opportunity, restored.proposals[0]);
    expect(input.reviewInputs?.answers[0]).toMatchObject({
      questionId: "gap:team",
      answer: "",
      attachments: [{ id: document.id, text: document.text }],
    });
    expect(input.reviewInputs?.sectionChanges?.[1].attachments?.[0].text).toBe(
      "",
    );
    expect(
      input.reviewInputs?.regeneration?.sectionChanges?.[1].attachments?.[0]
        .text,
    ).toBe("");
    expect(input.reviewDocuments.map((item) => item.target.kind)).toEqual([
      "question",
      "section",
      "section",
      "general",
    ]);
    expect(
      input.extractionLimitations.reviewAttachmentsNeedingProcessing,
    ).toEqual([
      {
        target: {
          kind: "section",
          id: proposal.sections[1].id,
          title: proposal.sections[1].title,
        },
        id: unreadable.id,
        name: unreadable.name,
        status: "needs_ocr",
      },
    ]);
  });
});
