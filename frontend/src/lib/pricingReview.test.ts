import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { getPricingReview } from "./pricingReview";

const fixture = () => {
  const state = createSeedState(new Date("2026-10-14T12:00:00Z"));
  return { proposal: state.proposals[0], opportunity: state.opportunities[0] };
};

describe("RFP pricing review", () => {
  it("shows a labeled trace for all three untouched examples, with correct arithmetic", () => {
    const state = createSeedState(new Date("2027-01-01T08:00:00Z"));
    for (const proposal of state.proposals) {
      const opportunity = state.opportunities.find(
        (item) => item.id === proposal.opportunityId,
      )!;
      const review = getPricingReview(proposal, opportunity);
      expect(review.kind).toBe("design_example");
      expect(review.finance).toMatchObject({
        isValid: true,
        total: 16698,
        optionalTotal: 2000,
      });
      expect(review.lines[0].requirements.map((item) => item.id)).toEqual([
        `${opportunity.id}-r1`,
        `${opportunity.id}-r2`,
        `${opportunity.id}-r3`,
      ]);
      expect(review.lines[0].sections.map((item) => item.id)).toEqual([
        "scope",
        "architecture",
        "delivery",
      ]);
      expect(review.lines[0].estimateJustification).toContain(
        "not stated by the buyer",
      );
      expect(review.lines[1].estimateJustification).toContain(
        "does not specify a session count",
      );
    }
  });

  it("does not invent a proposal response for the optional analytics line", () => {
    const { proposal, opportunity } = fixture();
    const option = getPricingReview(proposal, opportunity).lines[2];
    expect(option.requirements.map((item) => item.id)).toEqual(["opp-1-r5"]);
    expect(option.sections).toEqual([]);
    expect(option.missingInputs.join(" ")).toContain(
      "Define the optional analytics deliverable",
    );
  });

  it.each([
    "document",
    "requirement",
    "section",
    "line",
    "terms",
    "additional-document",
  ] as const)("drops synthetic evidence when the %s changes", (change) => {
    const { proposal, opportunity } = fixture();
    if (change === "document")
      opportunity.documents[0].text =
        "A different RFP while the old fixture hash remains.";
    if (change === "requirement")
      opportunity.requirements[0].text = "Deliver a different implementation.";
    if (change === "section") proposal.sections[1].body = "Different scope.";
    if (change === "line") proposal.lines[0].quantity = "100";
    if (change === "terms") proposal.tax = "";
    if (change === "additional-document")
      opportunity.documents.push({
        ...opportunity.documents[0],
        id: "addendum",
        text: "Scope replaced.",
      });
    const review = getPricingReview(proposal, opportunity);
    expect(review.kind).toBe("recorded_estimate");
    expect(review.lines.every((line) => line.linkage === "unlinked")).toBe(
      true,
    );
    expect(review.lines[0].requirements).toEqual([]);
    expect(review.currency).toBe(proposal.currency ?? null);
  });

  it("never generates costs from a newly uploaded RFP or mutates saved data", () => {
    const { proposal, opportunity } = fixture();
    proposal.lines = [];
    const before = JSON.stringify({ proposal, opportunity });
    const review = getPricingReview(proposal, opportunity);
    expect(review.kind).toBe("empty");
    expect(review.finance).toBeNull();
    expect(review.questions).toEqual([]);
    expect(JSON.stringify({ proposal, opportunity })).toBe(before);
  });

  it("keeps missing rates, quantities and tax unknown rather than zero", () => {
    const { proposal, opportunity } = fixture();
    proposal.lines[0].rate = "";
    proposal.lines[1].quantity = "";
    proposal.tax = "";
    const review = getPricingReview(proposal, opportunity);
    expect(review.lines[0].amount).toBeNull();
    expect(review.lines[1].amount).toBeNull();
    expect(review.finance?.isValid).toBe(false);
    expect(review.lines[0].missingInputs.join(" ")).toContain("unit rate");
    expect(review.lines[1].missingInputs.join(" ")).toContain(
      "quantity or estimated effort",
    );
    expect(proposal.tax).toBe("");
  });

  it("labels supplied basis as unverified and drops references if current evidence changes", () => {
    const { proposal, opportunity } = fixture();
    proposal.lines[0].basis = {
      rfpRequirementIds: ["opp-1-r1"],
      proposalSectionIds: ["scope"],
      deliverable: "Implementation",
      estimateJustification: "Recorded estimate supplied by user",
      rateSource: "Recorded rate card",
    };
    let review = getPricingReview(proposal, opportunity);
    expect(review.lines[0].linkage).toBe("recorded_unverified");
    expect(review.lines[0].missingInputs.join(" ")).toContain(
      "Reconfirm the recorded scope links",
    );
    opportunity.documents[0].text = "Updated RFP without the former clause.";
    review = getPricingReview(proposal, opportunity);
    expect(review.lines[0].linkage).toBe("unlinked");
    expect(review.lines[0].requirements).toEqual([]);
  });

  it("uses decimal rounding for line display and preserves saved inclusion choice", () => {
    const { proposal, opportunity } = fixture();
    proposal.includePricing = false;
    proposal.lines[0].quantity = "1";
    proposal.lines[0].rate = "1.005";
    const before = JSON.stringify(proposal);
    expect(getPricingReview(proposal, opportunity).lines[0].amount).toBe(1.01);
    expect(JSON.stringify(proposal)).toBe(before);
  });

  it("respects the recorded currency and never infers currency for custom estimates", () => {
    const { proposal, opportunity } = fixture();
    proposal.id = "custom-proposal";
    proposal.currency = "USD";
    expect(getPricingReview(proposal, opportunity).currency).toBe("USD");
    delete proposal.currency;
    expect(getPricingReview(proposal, opportunity).currency).toBeNull();
    proposal.currency = "usd";
    expect(getPricingReview(proposal, opportunity).currency).toBeNull();
  });

  it("invalidates synthetic trace for an explicit non-SAR currency while preserving legacy examples", () => {
    const { proposal, opportunity } = fixture();
    delete proposal.currency;
    expect(getPricingReview(proposal, opportunity)).toMatchObject({
      kind: "design_example",
      currency: "SAR",
    });
    proposal.currency = "USD";
    expect(getPricingReview(proposal, opportunity)).toMatchObject({
      kind: "recorded_estimate",
      currency: "USD",
    });
    expect(getPricingReview(proposal, opportunity).lines[0].linkage).toBe(
      "unlinked",
    );
  });
});
