import Decimal from "decimal.js";
import type { FinanceLine, Opportunity, Proposal } from "../types";
import { calculateFinance, type FinanceResult } from "./finance";
import { createSeedState } from "./seed";

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
  linkage: "design_example" | "recorded_unverified" | "unlinked";
  requirements: { id: string; text: string; source: string }[];
  sections: { id: string; title: string }[];
  deliverable: string;
  estimateJustification: string;
  rateSource: string;
  assumptions: string[];
  missingInputs: string[];
}
export interface PricingReviewData {
  kind: "empty" | "design_example" | "recorded_estimate";
  lines: PricingLineReview[];
  questions: PricingReviewQuestion[];
  finance: FinanceResult | null;
  currency: string | null;
  totalsLabel: string;
  notice: string;
}

// A trace is a design example only while all of its supporting fixture content
// is unchanged. IDs, classification labels, or old document hashes alone are
// insufficient: persisted fixtures may have been edited by the user.
const baseline = createSeedState(new Date("2026-10-14T10:00:00Z"));
const documentContent = (opportunity: Opportunity) =>
  opportunity.documents.map(
    ({ uploadedAt: _uploadedAt, ...document }) => document,
  );
function isUnchangedExample(proposal: Proposal, opportunity: Opportunity) {
  const example = baseline.proposals.find((item) => item.id === proposal.id);
  const source = baseline.opportunities.find(
    (item) => item.id === opportunity.id,
  );
  if (!example || !source || example.opportunityId !== opportunity.id)
    return false;
  return (
    proposal.opportunityId === example.opportunityId &&
    (proposal.currency === undefined || proposal.currency === "SAR") &&
    proposal.title === example.title &&
    opportunity.title === source.title &&
    opportunity.buyer === source.buyer &&
    opportunity.description === source.description &&
    opportunity.reference === source.reference &&
    JSON.stringify(documentContent(opportunity)) ===
      JSON.stringify(documentContent(source)) &&
    JSON.stringify(opportunity.requirements) ===
      JSON.stringify(source.requirements) &&
    JSON.stringify(proposal.sections) === JSON.stringify(example.sections) &&
    JSON.stringify(proposal.lines) === JSON.stringify(example.lines) &&
    proposal.pricingMode === example.pricingMode &&
    proposal.percentage === example.percentage &&
    proposal.contingency === example.contingency &&
    proposal.tax === example.tax
  );
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

function exampleLine(
  line: FinanceLine,
  index: number,
  proposal: Proposal,
  opportunity: Opportunity,
): PricingLineReview {
  const requirements =
    index === 0 ? ["r1", "r2", "r3"] : index === 1 ? ["r4"] : ["r5"];
  const sectionIds =
    index === 0
      ? ["scope", "architecture", "delivery"]
      : index === 1
        ? ["delivery"]
        : [];
  const examples = [
    {
      deliverable:
        "Configured solution, access controls, integration, and acceptance checkpoints",
      estimateJustification:
        "Illustrative allocation: discovery and design 2 person-days + configuration and integration 5 + validation and handover 3 = 10 person-days. This allocation is not stated by the buyer or calculated from an effort assessment.",
      assumptions: [
        "A bounded implementation is assumed. Integration complexity, access, test data, staffing, and actual effort still need confirmation.",
      ],
      missingInputs: [
        "Confirm deliverable scope and an effort estimate before replacing the illustrative 10 person-days.",
      ],
    },
    {
      deliverable: "Administrator training and an operations handover",
      estimateJustification:
        "Two sessions are an illustrative planning assumption. The RFP asks for training and handover but does not specify a session count.",
      assumptions: [
        "Audience size, session duration, training materials, and delivery format are not specified.",
      ],
      missingInputs: [
        "Confirm training audience, session length and count, and handover materials.",
      ],
    },
    {
      deliverable: "Optional analytics discovery — proposed example scope",
      estimateJustification:
        "Two person-days are an illustrative allowance, not buyer-specified effort. The proposal has not yet described this optional deliverable.",
      assumptions: [
        "This option is excluded from the base total. An analytics requirement alone does not justify the scope or price of a discovery activity.",
      ],
      missingInputs: [
        "Define the optional analytics deliverable in the proposal and justify its effort, or remove this option.",
      ],
    },
  ];
  return {
    ...line,
    amount: lineAmount(line),
    linkage: "design_example",
    requirements: opportunity.requirements
      .filter((item) =>
        requirements.includes(item.id.replace(`${opportunity.id}-`, "")),
      )
      .map(({ id, text, source }) => ({ id, text, source })),
    sections: proposal.sections
      .filter((item) => sectionIds.includes(item.id))
      .map(({ id, title }) => ({ id, title })),
    ...examples[index],
    rateSource:
      "Fabricated pricing fixture; no actual company rate card or supplier quotation is attached.",
  };
}

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
      questions: [
        {
          id: "pricing-basis",
          question:
            "Provide the applicable rate card, currency, commercial terms, and any known quantity constraints. The connected agent will first derive proposed cost items and effort from the RFP and proposal response.",
        },
      ],
      finance: null,
      currency: recordedCurrency,
      totalsLabel: "Pricing has not been generated",
      notice:
        "The connected agent will map RFP requirements to proposed deliverables, estimate quantities or effort, and ask for missing rates and commercial decisions before calculating a price.",
    };
  const designExample = isUnchangedExample(proposal, opportunity);
  const lines = proposal.lines.map((line, index) =>
    designExample
      ? exampleLine(line, index, proposal, opportunity)
      : recordedLine(line, proposal, opportunity),
  );
  const questions: PricingReviewQuestion[] = lines
    .filter((line) => line.missingInputs.length)
    .map((line) => ({
      id: `pricing-${line.id}`,
      lineId: line.id,
      question: `${line.description}: ${line.missingInputs.join(" ")}`,
    }));
  if (designExample)
    questions.push({
      id: "pricing-rates",
      question:
        "Replace the example rates with an approved company rate card or supplier quotation, and confirm the offer currency.",
    });
  else
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
    kind: designExample ? "design_example" : "recorded_estimate",
    lines,
    questions,
    finance: calculateFinance(proposal),
    currency: recordedCurrency ?? (designExample ? "SAR" : null),
    totalsLabel: designExample
      ? "Synthetic design example · current recorded estimate"
      : "Current recorded estimate · requires review",
    notice: designExample
      ? "Design example using unchanged synthetic RFP and proposal content. The scope links explain the intended review experience; quantities, rates, and commercial percentages are illustrative inputs, not an AI assessment."
      : "Existing recorded amounts are shown for review. They have not been derived or verified by an agent. RFP linkage and cost assumptions must be established before relying on this estimate.",
  };
}
