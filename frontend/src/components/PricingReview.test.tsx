import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PricingReview from "./PricingReview";
import { createSeedState } from "../test/fixtures/workspace";

const fixture = () => {
  const state = createSeedState(new Date("2026-10-14T10:00:00Z"));
  return { proposal: state.proposals[0], opportunity: state.opportunities[0] };
};

describe("pricing review content", () => {
  afterEach(cleanup);
  it("shows the recorded estimate and its basis without changing saved line inputs", () => {
    const data = fixture();
    const before = JSON.stringify(data.proposal);
    render(<PricingReview {...data} />);
    expect(
      screen.getByText(
        "Cost estimate awaiting inclusion in regenerated proposal.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("RFP requirement")).toHaveLength(3);
    expect(screen.getAllByText("Quantity / effort justification")).toHaveLength(
      3,
    );
    expect(screen.getAllByText("Rate source")).toHaveLength(3);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(JSON.stringify(data.proposal)).toBe(before);
  });

  it("renders no pricing panel or generic input prompt when no cost lines exist", () => {
    const data = fixture();
    data.proposal.lines = [];
    const { container } = render(<PricingReview {...data} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Awaiting generation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not display a partial total when tax or a rate is unknown", () => {
    const data = fixture();
    data.proposal.tax = "";
    delete data.proposal.currency;
    data.proposal.lines[0].rate = "";
    render(<PricingReview {...data} />);
    expect(screen.getByText("Total pending required inputs")).toBeVisible();
    expect(screen.queryByText("Recorded total")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(screen.getByText("Rate unknown per unit")).toBeVisible();
  });

  it("uses the recorded currency for line totals and the saved estimate", () => {
    const data = fixture();
    data.proposal.currency = "USD";
    render(<PricingReview {...data} />);
    expect(screen.getByText("10,000.00 USD")).toBeVisible();
    expect(screen.getByText("16,698.00 USD")).toBeVisible();
    expect(screen.queryByText(/10,000.00 SAR/)).not.toBeInTheDocument();
  });
});
