import { describe, expect, it } from "vitest";
import { createSeedState } from "../test/fixtures/workspace";
import { getPricingReview } from "./pricingReview";

const fixture = () => {
  const state = createSeedState(new Date("2026-10-14T12:00:00Z"));
  return { proposal: state.proposals[0], opportunity: state.opportunities[0] };
};

describe("RFP pricing review", () => {
  it("keeps arithmetic but never attaches fabricated evidence or inferred currency", () => {
    const { proposal, opportunity } = fixture();
    delete proposal.currency;
    const review = getPricingReview(proposal, opportunity);
    expect(review.kind).toBe("recorded_estimate");
    expect(review.currency).toBeNull();
    expect(review.finance).toMatchObject({
      isValid: true,
      total: 16698,
      optionalTotal: 2000,
    });
    for (const line of review.lines) {
      expect(line.linkage).toBe("unlinked");
      expect(line.requirements).toEqual([]);
      expect(line.sections).toEqual([]);
    }
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

  it("uses only explicitly recorded currency for former fixture IDs", () => {
    const { proposal, opportunity } = fixture();
    delete proposal.currency;
    expect(getPricingReview(proposal, opportunity)).toMatchObject({
      kind: "recorded_estimate",
      currency: null,
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
