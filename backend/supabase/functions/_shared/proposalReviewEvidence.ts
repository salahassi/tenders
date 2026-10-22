import type { Evidence } from "./model.ts";

function snapshotText(value: any, path = "draft"): string {
  if (Array.isArray(value))
    return value.length
      ? value.map((item, i) => snapshotText(item, `${path}[${i}]`)).join("\n")
      : `${path}: []`;
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => snapshotText(item, `${path}.${key}`))
      .join("\n");
  return `${path}: ${value === null ? "null" : String(value)}`;
}

/** A saved draft proves its own wording, never the truth of company claims.
 * Move prose into a citable snapshot once; keep keys for scope validation. */
export function proposalReviewEvidence(stepId: string, context: any): Evidence {
  const id = `proposal-review:${stepId}`;
  const draft = context.commercial_draft;
  const snapshot = {
    provenance:
      "Unconfirmed generated proposal content supplied for audit only",
    sections: context.sections,
    commercial_draft: draft,
    commercial_review_scope: context.commercial_review_scope,
    shared_decisions: context.shared_decisions,
    response_locations: context.response_locations,
    counts: {
      sections: context.sections.length,
      commercial_lines: draft.lines.length,
      commercial_tasks: draft.tasks.length,
    },
  };
  context.sections = context.sections.map((s: any) => ({
    key: s.key,
    title: s.title,
    volume: s.volume,
    audit_source_id: id,
  }));
  context.commercial_draft = {
    status: draft.status,
    audit_source_id: id,
    line_count: draft.lines.length,
    task_count: draft.tasks.length,
  };
  context.shared_decisions = (context.shared_decisions || []).map((d: any) => ({
    key: d.key,
    audit_source_id: id,
  }));
  context.audit_source_id = id;
  context.instruction +=
    " The supplied proposal-review source is an exact saved draft snapshot. Read its full sections, commercial fields and shared decisions. Cite it to establish what the draft says, what this supplied projection contains or omits, and proposed-method coverage. It is NOT verified company evidence, proof of existing capability, a buyer requirement, or an approved commercial commitment. Use original RFP sources for buyer rules and verified Company Knowledge for company facts. Do not request a separate evidence ID for this draft: use audit_source_id and exact quotations. Context section/index keys point to the snapshot; they are not substitutes for its prose. Correct unresolved business findings remain valid audit outcomes. A scoped projection cannot prove document-wide omissions.";
  return {
    id,
    kind: "review",
    verified: false,
    // Literal prose preserves newlines and quotes without JSON escapes.
    text: snapshotText(snapshot),
  };
}
