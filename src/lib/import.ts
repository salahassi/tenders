import Papa from "papaparse";
import type { Opportunity } from "../types";
import { uid } from "./format";
export interface ImportRow {
  row: number;
  title: string;
  buyer: string;
  reference: string;
  url: string;
  description: string;
  category: string;
  error: string | null;
  duplicate: boolean;
}
export function parseOpportunityCsv(
  text: string,
  existing: Opportunity[],
): ImportRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    delimiter: ",",
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length)
    throw new Error(`CSV could not be read: ${parsed.errors[0].message}`);
  if (!parsed.meta.fields?.includes("title"))
    throw new Error("The CSV must have a title column.");
  if (parsed.data.length > 100)
    throw new Error("Import up to 100 rows at a time.");
  const seen = new Set<string>();
  return parsed.data.map((r, i) => {
    const title = (r.title || "").trim();
    const reference = (r.external_id || r.procurement_reference || "").trim();
    const url = (r.canonical_url || "").trim();
    let error: string | null = null;
    if (!title || (!reference && !url))
      error = "A title and an external_id or canonical_url are required.";
    if (url) {
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" || u.username || u.password)
          error = "Use an HTTPS URL without credentials.";
      } catch {
        error = "Invalid canonical_url.";
      }
    }
    if (Object.values(r).some((v) => v.length > 100000))
      error = "A field is too large.";
    const key = reference ? `ref:${reference}` : `url:${url}`;
    const duplicate =
      seen.has(key) ||
      existing.some((o) =>
        reference ? o.reference === reference : o.sourceUrl === url,
      );
    seen.add(key);
    return {
      row: i + 2,
      title,
      buyer: r.buyer_name?.trim() || "Buyer not provided",
      reference,
      url,
      description: r.description || "",
      category: r.sector_tags || "Other",
      error,
      duplicate,
    };
  });
}
export function fromImportRow(row: ImportRow): Opportunity {
  return {
    id: uid("opp"),
    title: row.title,
    reference: row.reference || uid("import"),
    buyer: row.buyer,
    sourceUrl: row.url,
    description: row.description,
    category: row.category,
    tags: ["Manual import"],
    deadline: "",
    score: null,
    coverage: 0,
    status: "new",
    sourceId: "manual",
    value: null,
    saved: false,
    createdAt: new Date().toISOString(),
    documents: [],
    requirements: [],
    gaps: [
      {
        id: uid("gap"),
        question: "Confirm the submission deadline and timezone.",
        answer: "",
        required: true,
      },
    ],
    acquisition: "not_requested",
    language: "en",
  };
}
export function opportunitiesToCsv(items: Opportunity[]): string {
  return Papa.unparse(
    items.map((o) => ({
      title: o.title,
      buyer_name: o.buyer,
      external_id: o.reference,
      canonical_url: o.sourceUrl,
      description: o.description,
      deadline: o.deadline,
      status: o.status,
      fit_score: o.score ?? "",
      evidence_coverage: o.coverage,
    })),
    { escapeFormulae: true },
  );
}
export function downloadText(
  content: string,
  name: string,
  type = "text/plain",
) {
  const u = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
