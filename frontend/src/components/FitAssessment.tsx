import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import type { AppState, Opportunity } from "../types";
import { getFitPreview } from "../lib/fitPreview";
import { awaitingOcr } from "../lib/discovery";
import { Badge } from "./ui";
import "./fit-assessment.css";

export default function FitAssessment({
  state,
  opportunity,
  compact = false,
}: {
  state: AppState;
  opportunity: Opportunity;
  compact?: boolean;
}) {
  const fit = getFitPreview(state, opportunity);
  return (
    <section className="fit-assessment" aria-label="AI fit assessment">
      <div className="fit-heading">
        <strong>
          <Sparkles size={16} /> Likelihood of fit
        </strong>
        <Badge
          tone={
            awaitingOcr(opportunity)
              ? "purple"
              : fit.level === "High"
                ? "green"
                : fit.level === "Medium"
                  ? "amber"
                  : fit.level === "Low" || fit.level === "Outside scope"
                    ? "red"
                    : "neutral"
          }
        >
          {fit.level}
        </Badge>
      </div>
      <p className="fit-disclosure">
        {awaitingOcr(opportunity)
          ? "Scanned notice text extraction"
          : fit.mode === "recorded"
            ? fit.basis
            : fit.mode === "processing"
              ? "Assessment processing"
              : "Assessment needs attention"}
      </p>
      {opportunity.assessment?.scope === "uncertain" &&
        !opportunity.assessment.stale && (
          <p className="fit-disclosure" dir="auto">
            {opportunity.assessment.scopeReason?.trim() ||
              "Review the recorded evidence and open questions to resolve service scope."}
          </p>
        )}
      <p className="fit-summary">{fit.summary}</p>
      {compact && fit.mode !== "recorded" && (
        <Link className="text-link" to={`/opportunities/${opportunity.id}`}>
          Open processing details →
        </Link>
      )}
      {!!opportunity.assessment?.scopeEvidence?.length && (
        <p className="fit-disclosure" dir="auto">
          Published scope: {opportunity.assessment.scopeEvidence.join("; ")}
        </p>
      )}
      {opportunity.discovery?.expired && (
        <p className="fit-disclosure">
          The published submission deadline has passed.
        </p>
      )}
      {opportunity.noticeEvidence && (
        <div className="fit-disclosure">
          <p>Original notice details retrieved.</p>
          {opportunity.noticeEvidence.attachments.map((a, i) => (
            <p key={a.url}>
              <a href={a.url} target="_blank" rel="noreferrer">
                Public attachment {i + 1}
              </a>
              {a.status === "read"
                ? ` · ${a.includedPages} pages read`
                : a.includedPages
                  ? ` · ${a.includedPages} of ${a.totalPages ?? "unknown"} pages available to assessment; partial evidence`
                  : a.status === "needs_ocr"
                    ? " · Requires OCR"
                    : " · Not available to assessment"}
              {a.extraction === "ocr" && !!a.ocrReadPages?.length && (
                <span> · Text read from scan</span>
              )}
            </p>
          ))}
        </div>
      )}
      <details open={!compact}>
        <summary>
          {fit.mode === "recorded"
            ? "Evidence and gaps"
            : "What the assessment will use"}
        </summary>
        {fit.reasons.map((reason, index) => (
          <div className="fit-reason" key={index}>
            <strong>{reason.label}</strong>
            <dl>
              <dt>Notice evidence</dt>
              <dd dir="auto">{reason.noticeEvidence}</dd>
              <dt>Company Knowledge · {reason.knowledgeTitle}</dt>
              <dd dir="auto">{reason.knowledgeEvidence}</dd>
            </dl>
          </div>
        ))}
        {fit.unknowns.length > 0 && (
          <div className="fit-unknowns">
            <strong>Still to check</strong>
            <ul>
              {fit.unknowns.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="fit-basis">
              An unknown requirement is not a failed requirement.
            </p>
          </div>
        )}
        {fit.message && <p className="fit-basis">{fit.message}</p>}
        <p className="fit-basis">
          Preliminary fit can use the notice and available attachments before an
          RFP is uploaded. A full RFP can refine the assessment.
        </p>
        <Link className="text-link" to="/knowledge">
          Open Company Knowledge →
        </Link>
      </details>
      <p className="fit-footnote">
        Fit to company capabilities; eligibility and chance of winning are
        separate.
      </p>
    </section>
  );
}
