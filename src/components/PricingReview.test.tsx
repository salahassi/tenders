import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingReview from "./PricingReview";
import { createSeedState } from "../lib/seed";

const fixture = () => {
  const state = createSeedState(new Date("2026-10-14T10:00:00Z"));
  return { proposal: state.proposals[0], opportunity: state.opportunities[0] };
};

describe("pricing review controls", () => {
  afterEach(cleanup);
  it("explains saved export exclusion and sends focused feedback without changing line inputs", async () => {
    const data = fixture();
    const before = JSON.stringify(data.proposal);
    const onRequestChange = vi.fn();
    render(<PricingReview {...data} onRequestChange={onRequestChange} />);
    expect(
      screen.getByText(
        "Cost estimate awaiting inclusion in regenerated proposal.",
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Request pricing change" })[1],
    );
    expect(onRequestChange).toHaveBeenCalledWith(
      expect.stringContaining("Confirm training audience"),
    );
    expect(JSON.stringify(data.proposal)).toBe(before);
  });

  it("disables feedback actions for read-only viewers", () => {
    render(<PricingReview {...fixture()} readOnly onRequestChange={vi.fn()} />);
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
  });

  it("does not display a partial total when tax or a rate is unknown", () => {
    const data = fixture();
    data.proposal.tax = "";
    delete data.proposal.currency;
    data.proposal.lines[0].rate = "";
    render(<PricingReview {...data} onRequestChange={vi.fn()} />);
    expect(screen.getByText("Total pending required inputs")).toBeVisible();
    expect(screen.queryByText("Recorded total")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(screen.getByText("Rate unknown per unit")).toBeVisible();
  });

  it("uses the recorded currency for line totals and the saved estimate", () => {
    const data = fixture();
    data.proposal.currency = "USD";
    render(<PricingReview {...data} onRequestChange={vi.fn()} />);
    expect(screen.getByText("10,000.00 USD")).toBeVisible();
    expect(screen.getByText("16,698.00 USD")).toBeVisible();
    expect(screen.queryByText(/10,000.00 SAR/)).not.toBeInTheDocument();
  });
});
