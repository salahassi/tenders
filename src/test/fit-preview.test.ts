// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getFitPreview } from "../lib/fitPreview";
import { createSeedState } from "../lib/seed";
import type { AppState, KnowledgeDocument, Opportunity } from "../types";

const seed = () => createSeedState(new Date("2026-11-10T10:30:00Z"));

describe("preliminary company-fit design examples", () => {
  it("shows a useful example before an RFP is uploaded, with exact notice and profile evidence", () => {
    const state = seed();
    const opportunity = state.opportunities[1];
    expect(opportunity.documents).toHaveLength(0);
    const preview = getFitPreview(state, opportunity);
    expect(preview.mode).toBe("example");
    expect(preview.level).toBe("High");
    expect(preview.basis).toBe("Notice description only");
    expect(preview.message).toContain("No AI ran and no RFP was used");
    for (const item of preview.reasons) {
      expect(opportunity.description).toContain(item.noticeEvidence);
      expect(state.knowledge).toContainEqual(
        expect.objectContaining({
          title: item.knowledgeTitle,
          content: item.knowledgeEvidence,
        }),
      );
    }
  });

  it("provides varied service fit and preserves insufficient information when only a title exists", () => {
    const state = seed();
    expect(getFitPreview(state, state.opportunities[3])).toMatchObject({
      level: "Medium",
      confidence: "Low",
    });
    expect(getFitPreview(state, state.opportunities[9])).toMatchObject({
      level: "Low",
      confidence: "Medium",
    });
    expect(getFitPreview(state, state.opportunities[6])).toMatchObject({
      level: "Insufficient information",
      reasons: [],
    });
    for (const opportunity of state.opportunities) {
      const preview = getFitPreview(state, opportunity);
      expect(preview.mode).toBe("example");
      for (const item of preview.reasons) {
        expect(opportunity.description).toContain(item.noticeEvidence);
      }
    }
  });

  it("does not borrow a fixture assessment for custom or imported data", () => {
    const state = seed();
    expect(
      getFitPreview(state, {
        ...state.opportunities[1],
        id: "imported-real-opportunity",
      }),
    ).toMatchObject({ mode: "unassessed", level: "Not assessed", reasons: [] });
    expect(
      getFitPreview(state, { ...state.opportunities[1], sourceId: "manual" }),
    ).toMatchObject({ mode: "unassessed", level: "Not assessed", reasons: [] });
  });

  it.each<[string, (opportunity: Opportunity) => void]>([
    [
      "reference",
      (item) => {
        item.reference = "REAL-2026";
      },
    ],
    [
      "title",
      (item) => {
        item.title = "A different tender";
      },
    ],
    [
      "buyer",
      (item) => {
        item.buyer = "Real buyer";
      },
    ],
    [
      "description",
      (item) => {
        item.description += " Requires certified product resale.";
      },
    ],
    [
      "source URL",
      (item) => {
        item.sourceUrl = "https://example.org/real-tender";
      },
    ],
  ])("invalidates an example after the notice %s changes", (_label, change) => {
    const state = seed();
    const opportunity = state.opportunities[1];
    change(opportunity);
    expect(getFitPreview(state, opportunity)).toMatchObject({
      mode: "unassessed",
      level: "Not assessed",
      message: "Inputs changed — assessment needed",
      reasons: [],
    });
  });

  it.each<[string, (state: AppState) => void]>([
    [
      "capability",
      (state) => {
        state.knowledge[0].content = "Different company services.";
      },
    ],
    [
      "exclusion",
      (state) => {
        state.knowledge[2].content = "Furniture is now included.";
      },
    ],
    [
      "company credential",
      (state) => {
        state.knowledge[3].content = "Registration supplied.";
      },
    ],
    [
      "missing capability",
      (state) => {
        state.knowledge = state.knowledge.filter((item) => item.id !== "k2");
      },
    ],
    [
      "new capability",
      (state) => {
        state.knowledge.push({
          ...state.knowledge[0],
          id: "new",
          content: "New company capability",
        });
      },
    ],
    [
      "company name",
      (state) => {
        state.settings.companyName = "Actual company";
      },
    ],
  ])("invalidates examples when the %s context changes", (_label, change) => {
    const state = seed();
    change(state);
    expect(getFitPreview(state, state.opportunities[1])).toMatchObject({
      mode: "unassessed",
      reasons: [],
    });
  });

  it("suppresses examples when company files enter the context, including unextracted files", () => {
    const state = seed();
    const document: KnowledgeDocument = {
      id: "team-file",
      name: "Team.pdf",
      size: 24,
      uploadedAt: "2026-10-14T12:00:00Z",
      text: "",
      status: "needs_ocr",
      classification: "public",
      hash: "real-file",
      category: "team",
      enabled: false,
    };
    state.knowledgeDocuments.push(document);
    expect(getFitPreview(state, state.opportunities[1]).mode).toBe("example");
    document.enabled = true;
    expect(getFitPreview(state, state.opportunities[1]).mode).toBe(
      "unassessed",
    );
  });

  it("never claims to read an existing synthetic RFP and suppresses examples after document changes", () => {
    const state = seed();
    const opportunity = state.opportunities[0];
    expect(opportunity.documents).not.toHaveLength(0);
    expect(getFitPreview(state, opportunity).message).toContain(
      "no RFP was used",
    );
    opportunity.documents[0].text += "New mandatory requirement.";
    expect(getFitPreview(state, opportunity).mode).toBe("unassessed");
    const withoutRfp = state.opportunities[1];
    withoutRfp.documents.push({
      ...opportunity.documents[0],
      id: "uploaded-rfp",
    });
    expect(getFitPreview(state, withoutRfp).mode).toBe("unassessed");
  });

  it("does not change fit based on deadlines, workflow state, or old numeric scores", () => {
    const state = seed();
    const opportunity = state.opportunities[1];
    const before = getFitPreview(state, opportunity);
    opportunity.deadline = "2000-01-01T00:00:00Z";
    opportunity.status = "submitted";
    opportunity.score = 0;
    opportunity.coverage = 0;
    expect(getFitPreview(state, opportunity)).toEqual(before);
  });

  it("does not mutate state and keeps returned examples independent", () => {
    const state = seed();
    const before = structuredClone(state);
    const preview = getFitPreview(state, state.opportunities[1]);
    preview.reasons[0].knowledgeEvidence = "Changed returned value";
    preview.unknowns.push("Changed returned array");
    expect(state).toEqual(before);
    const fresh = getFitPreview(state, state.opportunities[1]);
    expect(fresh.reasons[0].knowledgeEvidence).not.toBe(
      "Changed returned value",
    );
    expect(fresh.unknowns).not.toContain("Changed returned array");
  });
});
