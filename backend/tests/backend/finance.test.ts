// @vitest-environment node
import { it, expect } from "vitest";
import {
  calculateEstimate,
  calculateDelivery,
  type EstimateInput,
  type Rate,
} from "../../supabase/functions/_shared/finance";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rate = (n: number, cost: string): Rate => ({
  id: id(n),
  revision: 1,
  title: "Synthetic approved rate",
  unit: "unit",
  currency: "SAR",
  unit_cost: cost,
  approved: true,
  zero_confirmed: false,
  valid_from: "2020-01-01",
  valid_until: "2099-01-01",
  content_hash: "a".repeat(64),
});
const input: EstimateInput = {
  currency: "SAR",
  precision: 2,
  method: "markup",
  percentage: "20",
  contingency: "10",
  taxes: [{ category: "synthetic", rate: "15", confirmed: true }],
  fx: [],
  lines: [
    {
      id: id(10),
      description: "Synthetic labor",
      quantity: "10",
      rate_id: id(1),
      period_count: "1",
      unit: "unit",
      included_in_base: true,
      charge_group: "one_time",
      tax_category: "synthetic",
      requirement_ids: [id(20)],
      section_ids: ["approach"],
      deliverable: "Working implementation",
      basis: "Synthetic effort fixture",
      duration_basis: "One-time delivery",
    },
    {
      id: id(11),
      description: "Synthetic hardware",
      quantity: "2",
      rate_id: id(2),
      period_count: "1",
      unit: "unit",
      included_in_base: true,
      charge_group: "one_time",
      tax_category: "synthetic",
      requirement_ids: [id(20)],
      section_ids: ["approach"],
      deliverable: "Delivered equipment",
      basis: "Synthetic quantity fixture",
      duration_basis: "One-time delivery",
    },
  ],
  payment_basis: "base_gross",
  payment_basis_confirmed: true,
  payments: [
    { title: "First milestone", percent: "33.3333" },
    { title: "Second milestone", percent: "33.3333" },
    { title: "Final milestone", percent: "33.3334" },
  ],
  validity_date: "2099-01-01",
  commercial_terms: "Synthetic commercial terms for automated tests.",
  assumptions_confirmed: true,
};
const rates = [rate(1, "1000"), rate(2, "500")];
it("matches the specification fixture and distinguishes markup from margin", () => {
  expect(calculateEstimate(input, rates)).toMatchObject({
    direct_cost: "11000.00000000",
    contingency: "1100.00000000",
    net_price: "14520.00000000",
    tax: "2178.00000000",
    gross_total: "16698.00000000",
  });
  expect(
    calculateEstimate({ ...input, method: "margin" }, rates).net_price,
  ).toBe("15125.00000000");
  expect(() =>
    calculateEstimate({ ...input, method: "margin", percentage: "100" }, rates),
  ).toThrow();
});
it("excludes unselected options and requires confirmed recurring periods, tax and FX", () => {
  const recurring = {
    ...input.lines[1],
    included_in_base: false,
    charge_group: "recurring" as const,
    period_count: "12",
  };
  expect(
    calculateEstimate({ ...input, lines: [input.lines[0], recurring] }, rates),
  ).toMatchObject({
    direct_cost: "10000.00000000",
    optional_gross: "18216.00000000",
  });
  expect(() =>
    calculateEstimate({ ...input, fx: [] }, [
      rates[0],
      { ...rates[1], currency: "USD" },
    ]),
  ).toThrow("exchange rate");
  expect(() =>
    calculateEstimate(
      { ...input, taxes: [{ ...input.taxes[0], confirmed: false }] },
      rates,
    ),
  ).toThrow("tax treatment");
  expect(() =>
    calculateEstimate(
      { ...input, lines: [{ ...input.lines[0], period_count: "" }] },
      rates,
    ),
  ).toThrow();
});
it("uses decimal FX per group and allocates the payment rounding remainder to the last milestone", () => {
  const result = calculateEstimate(
    {
      ...input,
      percentage: "0",
      contingency: "0",
      taxes: [{ category: "synthetic", rate: "0", confirmed: true }],
      lines: [{ ...input.lines[0], quantity: "1" }],
      fx: [
        {
          currency: "USD",
          rate: "3.75",
          effective_date: "2026-01-01",
          source: "Synthetic Owner FX record",
          confirmed: true,
        },
      ],
    },
    [{ ...rates[0], currency: "USD", unit_cost: "1" }],
  );
  expect(result.gross_total).toBe("3.75000000");
  expect(result.payments.map((p) => p.amount)).toEqual([
    "1.25",
    "1.25",
    "1.25",
  ]);
  const odd = calculateEstimate(
    {
      ...input,
      percentage: "0",
      contingency: "0",
      taxes: [{ category: "synthetic", rate: "0", confirmed: true }],
      lines: [{ ...input.lines[0], quantity: "1" }],
    },
    [{ ...rates[0], unit_cost: "1" }],
  );
  expect(odd.payments.map((p) => p.amount)).toEqual(["0.33", "0.33", "0.34"]);
});
it("rejects expired/unapproved rates, silent zero prices and ambiguous totals", () => {
  for (const r of [
    { ...rates[0], approved: false },
    { ...rates[0], valid_until: "2020-01-01" },
    { ...rates[0], unit_cost: "0" },
  ])
    expect(() => calculateEstimate(input, [r, rates[1]])).toThrow();
  expect(() =>
    calculateEstimate({ ...input, payment_basis_confirmed: false }, rates),
  ).toThrow("percentage basis");
  expect(() =>
    calculateEstimate(
      { ...input, payments: [{ title: "Only payment", percent: "99" }] },
      rates,
    ),
  ).toThrow("exactly to 100");
});
const delivery = {
  roles: [
    {
      role: "Engineer",
      available_fte: "2",
      confirmed: true,
      basis: "Synthetic capacity fixture",
    },
  ],
  tasks: [
    {
      key: "a",
      title: "Implement",
      predecessors: [],
      role: "Engineer",
      effort_days: "20",
      allocation: "2",
      duration_days: "10",
      basis: "Synthetic effort basis",
      confirmed: true,
    },
    {
      key: "b",
      title: "Verify",
      predecessors: ["a"],
      role: "Engineer",
      effort_days: "5",
      allocation: "1",
      duration_days: "5",
      basis: "Synthetic test basis",
      confirmed: true,
    },
  ],
};
it("separates effort from dependency-based duration", () => {
  expect(calculateDelivery(delivery)).toMatchObject({
    duration_workdays: "15.000000",
    effort_person_days: "25.000000",
  });
});
it("rejects dependency cycles, impossible duration, unavailable roles and overlapping capacity", () => {
  for (const changed of [
    {
      ...delivery,
      tasks: [{ ...delivery.tasks[0], predecessors: ["b"] }, delivery.tasks[1]],
    },
    { ...delivery, tasks: [{ ...delivery.tasks[0], duration_days: "5" }] },
    { ...delivery, roles: [{ ...delivery.roles[0], confirmed: false }] },
    {
      ...delivery,
      tasks: [delivery.tasks[0], { ...delivery.tasks[1], predecessors: [] }],
    },
  ])
    expect(() => calculateDelivery(changed)).toThrow();
});
