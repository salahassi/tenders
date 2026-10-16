import { Decimal } from "decimal.js";
import { z } from "zod";
const D = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
export const decimalText = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/);
const percent = z.string().regex(/^\d{1,3}(?:\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/),
  text = z.string().trim().min(1).max(3000),
  ids = z.array(z.string().min(1).max(200)).min(1).max(100);
export const estimateInputSchema = z
  .object({
    currency,
    precision: z.number().int().min(0).max(6),
    method: z.enum(["markup", "margin"]),
    percentage: percent,
    contingency: percent,
    taxes: z
      .array(
        z
          .object({
            category: z.string().min(1).max(100),
            rate: percent,
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    fx: z
      .array(
        z
          .object({
            currency,
            rate: decimalText,
            effective_date: z.iso.date(),
            source: text,
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    lines: z
      .array(
        z
          .object({
            id: z.uuid(),
            description: text,
            quantity: decimalText,
            rate_id: z.uuid(),
            period_count: decimalText,
            unit: z.string().min(1).max(100),
            included_in_base: z.boolean(),
            charge_group: z.enum(["one_time", "recurring", "optional"]),
            tax_category: z.string().min(1).max(100),
            requirement_ids: ids,
            section_ids: ids,
            deliverable: text,
            basis: text,
            duration_basis: text,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    payment_basis: z.enum(["base_net", "base_gross"]),
    payment_basis_confirmed: z.boolean(),
    payments: z
      .array(z.object({ title: text, percent }).strict())
      .min(1)
      .max(20),
    validity_date: z.iso.date(),
    commercial_terms: text,
    assumptions_confirmed: z.boolean(),
  })
  .strict();
export type EstimateInput = z.infer<typeof estimateInputSchema>;
export type Rate = {
  id: string;
  revision: number;
  title: string;
  unit: string;
  currency: string;
  unit_cost: string;
  approved: boolean;
  zero_confirmed: boolean;
  valid_from: string;
  valid_until: string;
  content_hash: string;
};
export class CommercialError extends Error {
  code: string;
  issues: string[];
  constructor(code: string, issues: string[]) {
    super(issues.join("; "));
    this.code = code;
    this.issues = issues;
  }
}
export function calculateEstimate(
  raw: unknown,
  rates: Rate[],
  today = new Date().toISOString().slice(0, 10),
) {
  const input = estimateInputSchema.parse(raw),
    errors: string[] = [],
    lineTotals: Record<string, string | boolean>[] = [];
  const issue = (s: string) => errors.push(s),
    n = (s: string) => new D(s),
    p = n(input.percentage),
    c = n(input.contingency);
  if (
    p.gt(input.method === "margin" ? 100 : 999) ||
    (input.method === "margin" && p.gte(100))
  )
    issue(
      "Margin must be below 100%; markup must be within the configured limit.",
    );
  if (c.gt(100)) issue("Contingency must not exceed 100%.");
  if (input.validity_date < today) issue("The offer validity date has passed.");
  if (!input.assumptions_confirmed)
    issue("Commercial assumptions need Owner confirmation.");
  if (!input.payment_basis_confirmed)
    issue("The payment percentage basis needs confirmation.");
  if (new Set(input.lines.map((l) => l.id)).size !== input.lines.length)
    issue("Line IDs must be unique.");
  if (new Set(input.taxes.map((t) => t.category)).size !== input.taxes.length)
    issue("Tax categories must be unique.");
  if (new Set(input.fx.map((x) => x.currency)).size !== input.fx.length)
    issue("Exchange-rate currencies must be unique.");
  if (!input.lines.some((l) => l.included_in_base))
    issue("Include at least one base line.");
  const groups = new Map<
    string,
    { cost: Decimal; optional: Decimal; rate: Decimal }
  >();
  const factor =
    input.method === "margin"
      ? p.lt(100)
        ? new D(1).div(new D(1).minus(p.div(100)))
        : new D(0)
      : new D(1).plus(p.div(100));
  const uplift = new D(1).plus(c.div(100)).mul(factor);
  let direct = new D(0),
    optionalGross = new D(0),
    roundedLines = new D(0);
  for (const line of input.lines) {
    const label = line.description,
      rate = rates.find((r) => r.id === line.rate_id),
      quantity = n(line.quantity),
      period = n(line.period_count),
      tax = input.taxes.find((t) => t.category === line.tax_category);
    if (quantity.lte(0) || period.lte(0))
      issue(
        `${label}: quantity and period count must be positive; missing is not zero.`,
      );
    if (line.charge_group === "one_time" && !period.eq(1))
      issue(`${label}: a one-time line must use period count 1.`);
    if (
      !rate ||
      !rate.approved ||
      rate.valid_from > today ||
      rate.valid_until < today
    ) {
      issue(`${label}: select a currently approved rate.`);
      continue;
    }
    if (rate.unit !== line.unit)
      issue(`${label}: the quantity unit does not match its approved rate.`);
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(rate.unit_cost)) {
      issue(`${label}: invalid catalog amount.`);
      continue;
    }
    const cost = n(rate.unit_cost);
    if (cost.isZero() && !rate.zero_confirmed)
      issue(`${label}: zero cost needs explicit confirmation.`);
    if (!tax || !tax.confirmed || n(tax.rate).gt(100)) {
      issue(`${label}: tax treatment is unresolved.`);
      continue;
    }
    let fx = new D(1);
    if (rate.currency !== input.currency) {
      const exchange = input.fx.find((x) => x.currency === rate.currency);
      if (
        !exchange ||
        !exchange.confirmed ||
        exchange.effective_date > today ||
        n(exchange.rate).lte(0)
      ) {
        issue(
          `${label}: a confirmed dated exchange rate and source are required.`,
        );
        continue;
      }
      fx = n(exchange.rate);
    }
    const amount = quantity.mul(cost).mul(period).mul(fx),
      net = amount.mul(uplift),
      taxAmount = net.mul(tax.rate).div(100),
      gross = net.plus(taxAmount);
    if (gross.gte("10000000000000000"))
      issue(`${label}: amount exceeds the supported numeric range.`);
    const group = groups.get(tax.category) || {
      cost: new D(0),
      optional: new D(0),
      rate: n(tax.rate),
    };
    if (line.included_in_base) {
      group.cost = group.cost.plus(amount);
      direct = direct.plus(amount);
      roundedLines = roundedLines.plus(gross.toDecimalPlaces(input.precision));
    } else {
      group.optional = group.optional.plus(amount);
      optionalGross = optionalGross.plus(gross);
    }
    groups.set(tax.category, group);
    lineTotals.push({
      id: line.id,
      included_in_base: line.included_in_base,
      charge_group: line.charge_group,
      direct_cost: amount.toFixed(8),
      net_price: net.toFixed(8),
      tax: taxAmount.toFixed(8),
      gross_total: gross.toFixed(8),
      display_gross: gross.toFixed(input.precision),
      rate_id: rate.id,
      rate_revision: String(rate.revision),
      rate_hash: rate.content_hash,
      exchange_rate: fx.toFixed(6),
    });
  }
  const paymentSum = input.payments.reduce(
    (sum, x) => sum.plus(x.percent),
    new D(0),
  );
  if (!paymentSum.eq(100))
    issue("Payment percentages must sum exactly to 100.");
  if (input.payments.some((x) => n(x.percent).lte(0) || n(x.percent).gt(100)))
    issue(
      "Each payment percentage must be greater than zero and no more than 100.",
    );
  if (errors.length)
    throw new CommercialError("ESTIMATE_INCOMPLETE", unique(errors));
  let net = new D(0),
    tax = new D(0);
  const groupTotals = [...groups].map(([category, g]) => {
    const contingency = g.cost.mul(c).div(100),
      basis = g.cost.plus(contingency),
      netPrice = basis.mul(factor),
      taxAmount = netPrice.mul(g.rate).div(100);
    net = net.plus(netPrice);
    tax = tax.plus(taxAmount);
    return {
      category,
      direct_cost: g.cost.toFixed(8),
      contingency: contingency.toFixed(8),
      net_price: netPrice.toFixed(8),
      tax_rate: g.rate.toFixed(4),
      tax: taxAmount.toFixed(8),
      gross_total: netPrice.plus(taxAmount).toFixed(8),
    };
  });
  const gross = net.plus(tax),
    paymentTotal = (
      input.payment_basis === "base_net" ? net : gross
    ).toDecimalPlaces(input.precision);
  let allocated = new D(0);
  if (
    [direct, net, tax, gross, optionalGross].some((value) =>
      value.gte("10000000000000000"),
    )
  )
    throw new CommercialError("ESTIMATE_RANGE_EXCEEDED", [
      "The total exceeds the supported numeric range.",
    ]);
  const payments = input.payments.map((payment, i) => {
    const amount =
      i === input.payments.length - 1
        ? paymentTotal.minus(allocated)
        : paymentTotal
            .mul(payment.percent)
            .div(100)
            .toDecimalPlaces(input.precision);
    allocated = allocated.plus(amount);
    return { ...payment, amount: amount.toFixed(input.precision) };
  });
  return {
    calculator_version: "decimal-v1",
    currency: input.currency,
    precision: input.precision,
    direct_cost: direct.toFixed(8),
    contingency: direct.mul(c).div(100).toFixed(8),
    net_price: net.toFixed(8),
    tax: tax.toFixed(8),
    gross_total: gross.toFixed(8),
    display_gross: gross.toFixed(input.precision),
    optional_gross: optionalGross.toFixed(8),
    rounding_adjustment: gross
      .toDecimalPlaces(input.precision)
      .minus(roundedLines)
      .toFixed(input.precision),
    groups: groupTotals,
    lines: lineTotals,
    payment_basis: input.payment_basis,
    payments,
  };
}
const unique = <T>(values: T[]) => Array.from(new Set(values));
export const deliveryInputSchema = z
  .object({
    roles: z
      .array(
        z
          .object({
            role: text,
            available_fte: decimalText,
            confirmed: z.boolean(),
            basis: text,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    tasks: z
      .array(
        z
          .object({
            key: z.string().min(1).max(100),
            title: text,
            predecessors: z.array(z.string().min(1).max(100)).max(100),
            role: text,
            effort_days: decimalText,
            allocation: decimalText,
            duration_days: decimalText,
            basis: text,
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function calculateDelivery(raw: unknown) {
  const input = deliveryInputSchema.parse(raw),
    issues: string[] = [],
    done = new Map<string, { start: Decimal; end: Decimal }>(),
    visiting = new Set<string>();
  if (new Set(input.tasks.map((t) => t.key)).size !== input.tasks.length)
    issues.push("Task keys must be unique.");
  if (new Set(input.roles.map((t) => t.role)).size !== input.roles.length)
    issues.push("Role names must be unique.");
  function visit(key: string): { start: Decimal; end: Decimal } {
    const saved = done.get(key);
    if (saved) return saved;
    const task = input.tasks.find((t) => t.key === key);
    if (!task) {
      issues.push(`Unknown predecessor: ${key}`);
      return { start: new D(0), end: new D(0) };
    }
    if (visiting.has(key)) {
      issues.push(`Circular dependency: ${key}`);
      return { start: new D(0), end: new D(0) };
    }
    visiting.add(key);
    let start = new D(0);
    for (const predecessor of task.predecessors)
      start = D.max(start, visit(predecessor).end);
    const role = input.roles.find((r) => r.role === task.role),
      effort = new D(task.effort_days),
      allocation = new D(task.allocation),
      duration = new D(task.duration_days);
    if (!role || !role.confirmed || new D(role.available_fte).lte(0))
      issues.push(`${task.title}: role availability is unconfirmed.`);
    if (!task.confirmed)
      issues.push(`${task.title}: delivery assumptions need confirmation.`);
    if (allocation.lte(0) || duration.lte(0) || effort.lte(0))
      issues.push(
        `${task.title}: effort, allocation and duration must be positive.`,
      );
    else if (effort.div(allocation).gt(duration))
      issues.push(
        `${task.title}: the duration cannot accommodate the stated effort and allocation.`,
      );
    const result = { start, end: start.plus(duration) };
    visiting.delete(key);
    done.set(key, result);
    return result;
  }
  for (const task of input.tasks) visit(task.key);
  for (const role of input.roles) {
    const tasks = input.tasks.filter((t) => t.role === role.role),
      boundaries = unique(
        tasks.flatMap((t) => {
          const time = done.get(t.key)!;
          return [time.start.toString(), time.end.toString()];
        }),
      );
    for (const boundary of boundaries) {
      const at = new D(boundary),
        allocated = tasks
          .filter(
            (t) =>
              done.get(t.key)!.start.lte(at) && done.get(t.key)!.end.gt(at),
          )
          .reduce((sum, t) => sum.plus(t.allocation), new D(0));
      if (allocated.gt(role.available_fte))
        issues.push(
          `${role.role}: parallel allocations exceed confirmed availability.`,
        );
    }
  }
  if (issues.length)
    throw new CommercialError("DELIVERY_INCOMPLETE", unique(issues));
  return {
    calculator_version: "dependency-v1",
    duration_workdays: D.max(...[...done.values()].map((x) => x.end)).toFixed(
      6,
    ),
    effort_person_days: input.tasks
      .reduce((sum, t) => sum.plus(t.effort_days), new D(0))
      .toFixed(6),
    tasks: input.tasks.map((t) => ({
      ...t,
      start_workday: done.get(t.key)!.start.toFixed(6),
      end_workday: done.get(t.key)!.end.toFixed(6),
    })),
  };
}
