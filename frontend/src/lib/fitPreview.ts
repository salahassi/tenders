import type { AppState, Opportunity } from "../types";

export interface FitPreview {
  mode: "unassessed";
  level:
    "High" | "Medium" | "Low" | "Insufficient information" | "Not assessed";
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

/** Until real assessment is activated, never manufacture fit from local fixtures. */
export function getFitPreview(
  _state: AppState,
  _opportunity: Opportunity,
): FitPreview {
  return {
    mode: "unassessed",
    level: "Not assessed",
    confidence: "Not assessed",
    basis: "No assessment performed",
    summary:
      "This opportunity has no assessment yet. AI assessment is not activated.",
    reasons: [],
    unknowns: [],
    message: "Assessment needed — AI is not connected",
  };
}
