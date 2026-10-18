import { assessmentProgress, assessmentActive } from "./discovery";
import type { AppState, Opportunity } from "../types";

export interface FitPreview {
  mode: "unassessed" | "processing" | "recorded";
  level: string;
  confidence: "Medium" | "Low" | "Not assessed";
  basis: string;
  summary: string;
  reasons: Array<{
    label: string;
    noticeEvidence: string;
    knowledgeTitle: string;
    knowledgeEvidence: string;
  }>;
  unknowns: string[];
  message?: string;
}

/** Display only recorded evidence; an absent result does not imply disconnection. */
export function getFitPreview(
  _state: AppState,
  _opportunity: Opportunity,
): FitPreview {
  const a = _opportunity.assessment;
  if ((!a || a.stale) && _opportunity.discovery) {
    const progress = assessmentProgress(_opportunity);
    return {
      mode: assessmentActive(_opportunity) ? "processing" : "unassessed",
      level: progress.label,
      confidence: "Not assessed",
      basis: "Assessment progress",
      summary: progress.message,
      reasons: [],
      unknowns: [],
      message: _opportunity.discovery.error
        ? `Processing detail: ${_opportunity.discovery.error.replaceAll("_", " ")}`
        : undefined,
    };
  }
  if (a)
    return {
      mode: "recorded",
      level: a.stale
        ? "Insufficient information"
        : a.routing === "excluded"
          ? "Outside scope"
          : a.routing === "recommended"
            ? "High"
            : a.routing === "low_fit" || a.routing === "excluded"
              ? "Low"
              : "Insufficient information",
      confidence: a.stale || a.coverage < 60 ? "Low" : "Medium",
      basis: a.method || "Recorded assessment",
      summary: a.summary,
      reasons: [
        ...(a.scopeEvidence?.length
          ? [
              {
                label: "Scope assessment",
                noticeEvidence: a.scopeEvidence.join("; "),
                knowledgeTitle: "Configured service scope",
                knowledgeEvidence:
                  "Software, digital transformation and AI services; hardware and unrelated procurement excluded.",
              },
            ]
          : []),
        ...Object.entries(a.factors).map(([label, f]) => ({
          label: `${label} · ${f.rating === null ? "Unknown" : f.rating + " / 4"}`,
          noticeEvidence:
            f.notice_evidence.map((e) => e.quote).join("; ") || "Unknown",
          knowledgeTitle: "Verified evidence",
          knowledgeEvidence:
            f.company_evidence.map((e) => e.quote).join("; ") || "Unknown",
        })),
      ],
      unknowns: [...a.missing, ...a.risks],
      message: a.stale
        ? "Evidence changed. Reassess before using this result."
        : `Evidence coverage ${a.coverage}%. Routing: ${a.routing.replaceAll("_", " ")}. Your bid decision is unchanged.`,
    };
  return {
    mode: "unassessed",
    level: "Assessment required",
    confidence: "Not assessed",
    basis: "No assessment performed",
    summary: "This opportunity has no recorded assessment yet.",
    reasons: [],
    unknowns: [],
    message:
      "Open the opportunity to request an assessment or follow its processing progress.",
  };
}
