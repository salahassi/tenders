import type { AppState } from "../types";
export function tenderCurrency(state: AppState, opportunityId: string): string {
  const opportunity = state.opportunities.find(
    (item) => item.id === opportunityId,
  );
  const source = state.sources.find(
    (item) => item.id === opportunity?.sourceId,
  );
  const country = source?.tags
    .find((tag) => /^country:(SA|JO|PS)$/.test(tag))
    ?.slice(8);
  // A starting suggestion only. Tender documents and the Owner's selection win.
  return country === "SA"
    ? "SAR"
    : country === "JO"
      ? "JOD"
      : country === "PS"
        ? "ILS"
        : "";
}
