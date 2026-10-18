export type ScopeSource = "company_knowledge" | "keywords" | "combined";
export type ServiceScope = {
  scope: ScopeSource;
  include_keywords: string[];
  exclude_keywords: string[];
};
export const SCOPE_LABELS: Record<ScopeSource, string> = {
  company_knowledge: "Company Knowledge",
  keywords: "Keywords",
  combined: "Company Knowledge + keywords",
};
export function parseScopeKeywords(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\n,،]+/u)
    .map((term) => term.trim().replace(/\s+/gu, " "))
    .filter((term) => {
      if (!term || seen.has(term.toLowerCase())) return false;
      seen.add(term.toLowerCase());
      return true;
    });
}
export function scopeError(policy: ServiceScope): string {
  const lists = [policy.include_keywords, policy.exclude_keywords];
  if (
    lists.some(
      (terms) => terms.length > 24 || terms.some((term) => term.length > 100),
    )
  )
    return "Use up to 24 keywords in each list, with at most 100 characters per keyword.";
  if (policy.scope === "company_knowledge") return "";
  if (policy.scope === "keywords" && !policy.include_keywords.length)
    return "Add at least one keyword describing the services you want to pursue.";
  if (policy.scope === "combined" && !lists.some((terms) => terms.length))
    return "Add an interest or exclusion keyword, or select Company Knowledge only.";
  if (
    policy.include_keywords.some((term) =>
      policy.exclude_keywords.some(
        (excluded) => excluded.toLowerCase() === term.toLowerCase(),
      ),
    )
  )
    return "A keyword cannot be both an interest and an exclusion.";
  return "";
}
