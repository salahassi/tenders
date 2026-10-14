import Decimal from "decimal.js";
import type { Proposal } from "../types";

const D = Decimal.clone({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
export interface FinanceResult {
  subtotal: number;
  contingency: number;
  net: number;
  tax: number;
  total: number;
  /** Direct cost of unselected options; excluded from the offer total. */
  optionalTotal: number;
  errors: string[];
  validationErrors: string[];
  isValid: boolean;
}

export function calculateFinance(proposal: Proposal): FinanceResult {
  const errors: string[] = [];
  const parse = (
    value: string,
    label: string,
    maximum: number,
    allowZero = true,
  ): Decimal | null => {
    if (!value.trim()) {
      errors.push(`${label} is required; enter 0 only when zero is confirmed.`);
      return null;
    }
    if (!/^\d+(\.\d+)?$/.test(value.trim())) {
      errors.push(`${label} must be a nonnegative decimal number.`);
      return null;
    }
    const n = new D(value.trim());
    if (!n.isFinite() || n.greaterThan(maximum) || (!allowZero && n.isZero())) {
      errors.push(
        `${label} must be ${allowZero ? `between 0 and ${maximum}` : `greater than 0 and no more than ${maximum}`}.`,
      );
      return null;
    }
    return n;
  };
  let subtotal = new D(0),
    optional = new D(0);
  if (!proposal.lines.length || !proposal.lines.some((line) => !line.optional))
    errors.push("Add at least one included pricing line.");
  proposal.lines.forEach((line, index) => {
    const label = line.description.trim() || `Line ${index + 1}`;
    if (!line.description.trim())
      errors.push(`Line ${index + 1} needs a description.`);
    if (!line.unit.trim()) errors.push(`${label}: a pricing unit is required.`);
    const quantity = parse(
      line.quantity,
      `${label}: quantity`,
      10_000_000,
      false,
    );
    const rate = parse(line.rate, `${label}: unit rate`, 1_000_000_000_000);
    if (quantity && rate) {
      const cost = quantity.mul(rate);
      if (line.optional) optional = optional.plus(cost);
      else subtotal = subtotal.plus(cost);
    }
  });
  const contingencyRate = parse(
    proposal.contingency,
    "Contingency percentage",
    100,
  );
  const commercialRate = parse(
    proposal.percentage,
    `${proposal.pricingMode === "margin" ? "Margin" : "Markup"} percentage`,
    proposal.pricingMode === "margin" ? 100 : 1000,
  );
  const taxRate = parse(proposal.tax, "Tax percentage", 100);
  if (
    proposal.pricingMode === "margin" &&
    commercialRate?.greaterThanOrEqualTo(100)
  )
    errors.push("Margin must be less than 100%.");
  const contingency = subtotal.mul(contingencyRate ?? 0).div(100);
  const basis = subtotal.plus(contingency);
  const percent = (commercialRate ?? new D(0)).div(100);
  const net =
    proposal.pricingMode === "margin"
      ? percent.lessThan(1)
        ? basis.div(new D(1).minus(percent))
        : new D(0)
      : basis.mul(new D(1).plus(percent));
  const tax = net.mul(taxRate ?? 0).div(100);
  const rounded = (n: Decimal) =>
    n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  return {
    subtotal: rounded(subtotal),
    contingency: rounded(contingency),
    net: rounded(net),
    tax: rounded(tax),
    total: rounded(net.plus(tax)),
    optionalTotal: rounded(optional),
    errors,
    validationErrors: errors,
    isValid: errors.length === 0,
  };
}
