import { Calculator, MessageSquarePlus } from "lucide-react";
import type { Opportunity, Proposal } from "../types";
import { getPricingReview } from "../lib/pricingReview";
import { Badge, Button } from "./ui";
import "./pricing-review.css";

const number = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function PricingReview({
  proposal,
  opportunity,
  onRequestChange,
  readOnly = false,
}: {
  proposal: Proposal;
  opportunity: Opportunity;
  onRequestChange: (text: string) => void;
  readOnly?: boolean;
}) {
  const review = getPricingReview(proposal, opportunity);
  const finance = review.finance;
  return (
    <section className="pricing-review" aria-label="Pricing review">
      <div className="pricing-review-heading">
        <h2>
          <Calculator size={18} /> Pricing and its basis
        </h2>
        <Badge tone={review.kind === "design_example" ? "blue" : "amber"}>
          {review.kind === "design_example"
            ? "Design example"
            : review.kind === "empty"
              ? "Awaiting generation"
              : "Needs review"}
        </Badge>
      </div>
      <p className="pricing-review-notice">{review.notice}</p>
      {!!review.lines.length && !proposal.includePricing && (
        <p className="pricing-review-warning">
          <strong>
            Cost estimate awaiting inclusion in regenerated proposal.
          </strong>{" "}
          The currently saved Word export excludes pricing. Reviewing this
          estimate does not change that file.
        </p>
      )}
      {!review.lines.length && (
        <div className="pricing-review-empty">
          <p>
            <strong>
              Requirements → deliverables → effort and quantities → sourced
              rates → justified price
            </strong>
          </p>
          <p>
            You review the proposed costs and answer specific questions. Missing
            values remain unknown until you supply or confirm them.
          </p>
        </div>
      )}
      <div className="pricing-review-lines">
        {review.lines.map((line) => (
          <article className="pricing-review-line" key={line.id}>
            <div className="pricing-review-line-heading">
              <h3 dir="auto">{line.description}</h3>
              {line.optional && (
                <Badge>Separate option · excluded from base</Badge>
              )}
            </div>
            <div
              className="pricing-review-calculation"
              aria-label={`Calculation for ${line.description}`}
            >
              <span>
                {line.quantity.trim() || "Quantity unknown"}{" "}
                {line.unit.trim() || "unit unknown"}
              </span>
              <span aria-hidden="true">×</span>
              <span>
                {line.rate.trim() || "Rate unknown"}
                {review.currency ? ` ${review.currency} per unit` : " per unit"}
              </span>
              <span aria-hidden="true">=</span>
              <strong>
                {line.amount === null
                  ? "Pending inputs"
                  : `${number(line.amount)}${review.currency ? ` ${review.currency}` : ""}`}
              </strong>
            </div>
            {line.linkage === "unlinked" ? (
              <p className="pricing-review-warning">
                <strong>RFP linkage not established.</strong> These numbers are
                recorded inputs; their connection to the requested scope has not
                been verified.
              </p>
            ) : (
              line.linkage === "recorded_unverified" && (
                <p className="pricing-review-warning">
                  Recorded references · revalidation required against the
                  current files. They are not a confirmed assessment.
                </p>
              )
            )}
            <dl className="pricing-review-basis">
              <div>
                <dt>RFP requirement</dt>
                <dd>
                  {line.requirements.length
                    ? line.requirements.map((requirement) => (
                        <p key={requirement.id} dir="auto">
                          <strong>{requirement.source}</strong>
                          <br />
                          {requirement.text}
                        </p>
                      ))
                    : "No supported clause is linked."}
                </dd>
              </div>
              <div>
                <dt>Proposal response</dt>
                <dd>
                  {line.sections.length
                    ? line.sections.map((section) => (
                        <p key={section.id} dir="auto">
                          {section.title}
                        </p>
                      ))
                    : "Proposal response missing or not linked."}
                </dd>
              </div>
              <div>
                <dt>Deliverable</dt>
                <dd dir="auto">{line.deliverable}</dd>
              </div>
              <div>
                <dt>Quantity / effort justification</dt>
                <dd dir="auto">{line.estimateJustification}</dd>
              </div>
              <div>
                <dt>Rate source</dt>
                <dd dir="auto">{line.rateSource}</dd>
              </div>
            </dl>
            <details className="pricing-review-assumptions">
              <summary>Assumptions and inputs to confirm</summary>
              <ul>
                {[...line.assumptions, ...line.missingInputs].map((item) => (
                  <li key={item} dir="auto">
                    {item}
                  </li>
                ))}
              </ul>
            </details>
            <Button
              size="sm"
              disabled={readOnly}
              onClick={() =>
                onRequestChange(
                  `Pricing review — ${line.description}: ${line.missingInputs.join(" ") || "Review the scope, quantities, rates, and their justification against the RFP and proposal response."}`,
                )
              }
            >
              <MessageSquarePlus size={15} /> Request pricing change
            </Button>
          </article>
        ))}
      </div>
      {finance && (
        <div className="pricing-review-totals">
          <h3>{review.totalsLabel}</h3>
          <p>
            {review.currency
              ? `Currency: ${review.currency}.`
              : "Currency not recorded; confirm before relying on these amounts."}{" "}
            Commercial percentages below are recorded inputs; tax applicability
            has not been assessed.
          </p>
          <dl className="pricing-review-terms">
            <div>
              <dt>{proposal.pricingMode === "margin" ? "Margin" : "Markup"}</dt>
              <dd>
                {proposal.percentage.trim()
                  ? `${proposal.percentage}%`
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt>Contingency</dt>
              <dd>
                {proposal.contingency.trim()
                  ? `${proposal.contingency}%`
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>{proposal.tax.trim() ? `${proposal.tax}%` : "Unknown"}</dd>
            </div>
          </dl>
          {finance.isValid ? (
            <dl className="pricing-review-amounts">
              <div>
                <dt>Included line costs</dt>
                <dd>{number(finance.subtotal)}</dd>
              </div>
              <div>
                <dt>Contingency amount</dt>
                <dd>{number(finance.contingency)}</dd>
              </div>
              <div>
                <dt>Price before tax</dt>
                <dd>{number(finance.net)}</dd>
              </div>
              <div>
                <dt>Tax amount</dt>
                <dd>{number(finance.tax)}</dd>
              </div>
              <div className="pricing-review-grand-total">
                <dt>Recorded total</dt>
                <dd>
                  {number(finance.total)}
                  {review.currency ? ` ${review.currency}` : ""}
                </dd>
              </div>
              {review.lines.some((line) => line.optional) && (
                <div>
                  <dt>Optional line costs · excluded</dt>
                  <dd>{number(finance.optionalTotal)}</dd>
                </div>
              )}
            </dl>
          ) : (
            <div className="pricing-review-warning">
              <strong>Total pending required inputs</strong>
              <ul>
                {finance.validationErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <Button
        disabled={readOnly}
        onClick={() =>
          onRequestChange(
            review.questions.map((item) => item.question).join("\n\n"),
          )
        }
      >
        <MessageSquarePlus size={16} />{" "}
        {review.lines.length
          ? "Review pricing assumptions"
          : "Provide pricing information"}
      </Button>
    </section>
  );
}
