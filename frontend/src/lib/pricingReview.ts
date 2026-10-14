import Decimal from "decimal.js";
import type { FinanceLine, Opportunity, Proposal } from "../types";
import { calculateFinance, type FinanceResult } from "./finance";

export interface PricingReviewQuestion {
  id: string;
  question: string;
  lineId?: string;
}
export interface PricingLineReview {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  rate: string;
  optional: boolean;
  amount: number | null;
  linkage: "recorded_unverified" | "unlinked";
  requirements: { id: string; text: string; source: string }[];
  sections: { id: string; title: string }[];
  deliverable: string;
  estimateJustification: string;
  rateSource: string;
  assumptions: string[];
  missingInputs: string[];
}
export interface PricingReviewData {
  kind: "empty" | "recorded_estimate";
  lines: PricingLineReview[];
  questions: PricingReviewQuestion[];
  finance: FinanceResult | null;
  currency: string | null;
  totalsLabel: string;
  notice: string;
}

const validNumber = (value: string, maximum: number, allowZero = true) => {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
  const number = new Decimal(value.trim());
  return (
    number.isFinite() && number.lte(maximum) && (allowZero || number.gt(0))
  );
};
const lineAmount = (line: FinanceLine) =>
  validNumber(line.quantity, 10_000_000, false) &&
  validNumber(line.rate, 1_000_000_000_000)
    ? new Decimal(line.quantity.trim())
        .mul(line.rate.trim())
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber()
    : null;

function recordedLine(
  line: FinanceLine,
  proposal: Proposal,
  opportunity: Opportunity,
): PricingLineReview {
  const basis = line.basis;
  // The schema has no source-version snapshot for saved pricing bases. Resolve
  // only existing references, and never call them verified or agent-generated.
  const referencedRequirements = opportunity.requirements.filter((item) =>
    basis?.rfpRequirementIds.includes(item.id),
  );
  const requirements = referencedRequirements.filter(
    (item) =>
      item.text.trim() &&
      opportunity.documents.some(
        (document) =>
          document.status === "ready" && document.text.includes(item.text),
      ),
  );
  const sections = proposal.sections.filter(
    (item) => basis?.proposalSectionIds.includes(item.id) && item.body.trim(),
  );
  const completeReferences =
    !!basis?.rfpRequirementIds.length &&
    !!basis.proposalSectionIds.length &&
    requirements.length === basis.rfpRequirementIds.length &&
    sections.length === basis.proposalSectionIds.length;
  const missingInputs: string[] = [];
  if (!completeReferences)
    missingInputs.push(
      "Identify the supporting RFP clause and the corresponding proposal response for this cost.",
    );
  if (!basis?.deliverable.trim())
    missingInputs.push("Specify the deliverable covered by this cost.");
  if (!basis?.estimateJustification.trim())
    missingInputs.push(
      "Explain the quantity or effort estimate, including assumptions and exclusions.",
    );
  if (!validNumber(line.quantity, 10_000_000, false))
    missingInputs.push("Provide the required quantity or estimated effort.");
  if (!line.unit.trim())
    missingInputs.push(
      "Specify the pricing unit, such as person-days, sessions, or licenses.",
    );
  if (!validNumber(line.rate, 1_000_000_000_000))
    missingInputs.push(
      "Provide the unit rate; an unknown rate must remain blank.",
    );
  if (!basis?.rateSource.trim())
    missingInputs.push(
      "Provide the approved rate card, cost basis, or supplier quotation.",
    );
  if (basis)
    missingInputs.push(
      "Reconfirm the recorded scope links and estimate against the current RFP and proposal version.",
    );
  return {
    ...line,
    amount: lineAmount(line),
    linkage: completeReferences ? "recorded_unverified" : "unlinked",
    requirements: completeReferences
      ? requirements.map(({ id, text, source }) => ({ id, text, source }))
      : [],
    sections: completeReferences
      ? sections.map(({ id, title }) => ({ id, title }))
      : [],
    deliverable: basis?.deliverable.trim() || "Deliverable not established",
    estimateJustification:
      basis?.estimateJustification.trim() ||
      "No effort or quantity justification is recorded.",
    rateSource: basis?.rateSource.trim() || "Rate source not recorded",
    assumptions: [
      "These are recorded inputs. No connected agent has derived or verified this estimate against the current documents.",
    ],
    missingInputs,
  };
}

export function getPricingReview(
  proposal: Proposal,
  opportunity: Opportunity,
): PricingReviewData {
  const recordedCurrency =
    proposal.currency && /^[A-Z]{3}$/.test(proposal.currency)
      ? proposal.currency
      : null;
  if (!proposal.lines.length)
    return {
      kind: "empty",
      lines: [],
      questions: [],
      finance: null,
      currency: recordedCurrency,
      totalsLabel: "Pricing has not been generated",
      notice:
        "The connected agent will map RFP requirements to proposed deliverables, estimate quantities or effort, and ask for missing rates and commercial decisions before calculating a price.",
    };
  const lines = proposal.lines.map((line) =>
    recordedLine(line, proposal, opportunity),
  );
  const questions: PricingReviewQuestion[] = lines
    .filter((line) => line.missingInputs.length)
    .map((line) => ({
      id: `pricing-${line.id}`,
      lineId: line.id,
      question: `${line.description}: ${line.missingInputs.join(" ")}`,
    }));
  questions.push({
    id: "pricing-currency",
    question: "Confirm the offer currency and the approved source of rates.",
  });
  questions.push({
    id: "pricing-commercial",
    question:
      "Confirm the markup or margin, contingency, applicable tax, payment milestones, validity period, and treatment of optional scope.",
  });
  return {
    kind: "recorded_estimate",
    lines,
    questions,
    finance: calculateFinance(proposal),
    currency: recordedCurrency,
    totalsLabel: "Current recorded estimate · requires review",
    notice:
      "Existing recorded amounts are shown for review. They have not been derived or verified by an agent. RFP linkage and cost assumptions must be established before relying on this estimate.",
  };
}
