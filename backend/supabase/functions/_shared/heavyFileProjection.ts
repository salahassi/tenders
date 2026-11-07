/** Shared HTTP projection policy. The browser uses the same classification to
 * sequence its own requests; the API independently enforces admission. Full
 * business fields are preserved. Full rows are read individually and HTTP pages
 * retain a bounded amount of small records; a large record travels alone. */
export const heavyFileReadResources: Readonly<Record<string, string>> = {
  exports: "export_requests",
  "generation-steps": "generation_steps",
  documents: "documents",
  "document-blocks": "document_blocks",
  "proposal-versions": "proposal_versions",
  "proposal-sections": "proposal_sections",
  imports: "import_batches",
  knowledge: "knowledge_items",
  snapshots: "advertisement_snapshots",
  estimates: "estimate_records",
  deliveries: "delivery_versions",
  jobs: "jobs",
  templates: "templates",
  packages: "document_packages",
  requirements: "requirements",
  reviews: "reviews",
  "review-inputs": "review_inputs",
  "regeneration-requests": "regeneration_requests",
  "fit-assessments": "fit_assessments",
  "source-runs": "source_runs",
  opportunities: "opportunities",
  questions: "questions",
  "audit-events": "audit_events",
  compliance: "compliance_responses",
};
const heavyTables = new Set(Object.values(heavyFileReadResources));
export function isHeavyFileTable(table: string, single = false): boolean {
  return (
    heavyTables.has(table) ||
    (single && ["generation_plans", "restore_sessions"].includes(table))
  );
}

/** Metadata-only lists retain their existing bounds. This classifier concerns
 * full file/content projections, not universal HTTP resource qualification. */
export function isHeavyFileRequest(method: string, rawPath: string): boolean {
  const path = rawPath.split("?", 1)[0];
  if (method.toUpperCase() === "GET") {
    const record = path.match(/^\/v1\/([a-z-]+)(?:\/([^/]+))?$/);
    if (
      record &&
      (Object.hasOwn(heavyFileReadResources, record[1]) ||
        (record[2] &&
          ["generation-plans", "restore-sessions"].includes(record[1])))
    )
      return true;
    return [
      /^\/v1\/delivery-artifacts\/[^/]+\/download$/,
      /^\/v1\/export-artifacts\/[^/]+\/download$/,
      /^\/v1\/exports\/[^/]+\/context$/,
      /^\/v1\/delivery-snapshots\/[^/]+\/(?:context|package)$/,
      /^\/v1\/proposal-authoring\/[^/]+\/context$/,
      /^\/v1\/proposal-versions\/[^/]+\/consistency$/,
      /^\/v1\/opportunities\/[^/]+\/source-review$/,
      /^\/v1\/documents\/[^/]+\/(?:extraction|download)$/,
      /^\/v1\/recovery\/manifest$/,
      /^\/v1\/recovery\/files\/(?:documents|export_artifacts|proposal_delivery_artifacts)\/[^/]+$/,
    ].some((route) => route.test(path));
  }
  if (method.toUpperCase() === "POST")
    return [
      /^\/v1\/(?:commands|estimates|deliveries|knowledge|opportunities)$/,
      /^\/v1\/opportunities\/[^/]+\/(?:decision|archive)$/,
      /^\/v1\/knowledge\/[^/]+\/verify$/,
      /^\/v1\/jobs\/[^/]+\/actions$/,
      /^\/v1\/proposals\/[^/]+\/regenerate$/,
      /^\/v1\/export-artifacts\/[^/]+\/complete$/,
      /^\/v1\/proposal-authoring\/open$/,
      /^\/v1\/proposal-authoring\/[^/]+\/(?:save|claim|review|refresh|adopt)$/,
      /^\/v1\/proposal-versions\/[^/]+\/consistency$/,
      /^\/v1\/documents\/[^/]+\/(?:complete-upload|extraction)$/,
      /^\/v1\/recovery\/(?:rows|restore)$/,
      /^\/v1\/recovery\/restore\/[^/]+\/(?:rows|commit)$/,
      /^\/v1\/recovery\/restore-files\/[^/]+\/complete$/,
    ].some((route) => route.test(path));
  if (method.toUpperCase() === "PATCH")
    return /^\/v1\/(?:knowledge|opportunities)\/[^/]+$/.test(path);
  if (method.toUpperCase() === "PUT")
    return /^\/v1\/proposals\/[^/]+\/review-inputs$/.test(path);
  return false;
}

/** Bound retained full rows without serializing or copying a potentially huge
 * text field. Six bytes per UTF-16 unit covers JSON escaping and UTF-8. This is
 * deliberately conservative; no field or record is truncated. */
export const FULL_LIST_PAGE_BYTES = 1024 * 1024;
export const FULL_LIST_PAGE_MS = 2000;

export function jsonBytesUpperBound(value: unknown, budget: number): number {
  if (value === null) return 4;
  if (typeof value === "string")
    return Math.min(budget + 1, value.length * 6 + 2);
  if (typeof value === "number") return String(value).length;
  if (typeof value === "boolean") return value ? 4 : 5;
  let size = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      size += 1 + jsonBytesUpperBound(item, Math.max(0, budget - size - 1));
      if (size > budget) return budget + 1;
    }
  } else if (value && typeof value === "object") {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      size += key.length * 6 + 4;
      if (size > budget) return budget + 1;
      size += jsonBytesUpperBound(
        (value as Record<string, unknown>)[key],
        budget - size,
      );
      if (size > budget) return budget + 1;
    }
  }
  return size;
}
