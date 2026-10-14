import { describe, expect, it } from "vitest";
import { calculateFinance } from "./finance";
import { createSeedState } from "./seed";

describe("deterministic proposal finance", () => {
  const fixture = () =>
    createSeedState(new Date("2026-10-14T10:00:00Z")).proposals[0];
  it("reproduces the agreed synthetic markup example and excludes optional costs", () => {
    const result = calculateFinance(fixture());
    expect(result).toMatchObject({
      subtotal: 11000,
      contingency: 1100,
      net: 14520,
      tax: 2178,
      total: 16698,
      optionalTotal: 2000,
      isValid: true,
    });
  });
  it("treats margin as a different calculation from markup", () => {
    const proposal = fixture();
    proposal.pricingMode = "margin";
    expect(calculateFinance(proposal)).toMatchObject({
      net: 15125,
      total: 17393.75,
    });
  });
  it("blocks unknown rates instead of silently approving zero", () => {
    const proposal = fixture();
    proposal.lines[0].rate = "";
    expect(calculateFinance(proposal).isValid).toBe(false);
    expect(
      calculateFinance(proposal).errors.some((error) =>
        error.includes("unit rate is required"),
      ),
    ).toBe(true);
    proposal.lines[0].rate = "0";
    expect(calculateFinance(proposal).isValid).toBe(true);
  });
  it("requires an explicit tax value and blocks impossible margins", () => {
    const proposal = fixture();
    proposal.tax = "";
    proposal.pricingMode = "margin";
    proposal.percentage = "100";
    expect(calculateFinance(proposal).errors).toContain(
      "Margin must be less than 100%.",
    );
    expect(
      calculateFinance(proposal).errors.some((error) =>
        error.startsWith("Tax percentage is required"),
      ),
    ).toBe(true);
  });
  it("uses decimal rounding rather than floating-point binary rounding", () => {
    const proposal = fixture();
    proposal.lines = [
      {
        id: "decimal",
        description: "Rounding fixture",
        quantity: "1",
        rate: "1.005",
        unit: "item",
        optional: false,
      },
    ];
    proposal.percentage = "0";
    proposal.contingency = "0";
    proposal.tax = "0";
    expect(calculateFinance(proposal).total).toBe(1.01);
  });
  it("rejects negative, infinite, and nonnumeric pricing input", () => {
    const proposal = fixture();
    proposal.lines[0].rate = "-10";
    proposal.lines[1].quantity = "Infinity";
    proposal.percentage = "twenty";
    const result = calculateFinance(proposal);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBe(3);
    expect(Number.isFinite(result.total)).toBe(true);
  });
});
