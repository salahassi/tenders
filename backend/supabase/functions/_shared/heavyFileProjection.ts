/** Shared HTTP projection policy. The browser uses the same classification to
 * sequence its own requests; the API independently enforces admission. Full
 * business fields are preserved, and heavy table pages never use lookahead. */
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
