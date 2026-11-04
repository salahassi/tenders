import { ModelError } from "./model.ts";
import { isCandidateMetadataField } from "./modelGrounding.ts";

// Reuse the durable graph result's 1 MiB envelope ceiling for additional
// typed context (20261020143042_durable_model_graph.sql). This is a per-request
// structural bound, never an application daily token/call quota.
export const MAX_TYPED_STRUCTURE_BYTES = 1048576;
const literalControlFields = new Set([
  "type",
  "kind",
  "status",
  "severity",
  "category",
  "blocking_level",
  "volume",
  "mode",
  "charge_group",
  "page_kind",
  "unit",
  "tax_category",
  "quantity",
  "period_count",
  "effort_days",
  "allocation",
  "duration_days",
  "target_task",
]);

/** Preserve field hierarchy and primitive types without repeating every prose
 * string in each content batch. Metadata such as source IDs/quotations remains
 * literal; narrative strings point to the same canonical content-unit IDs. */
export function typedCandidateStructure(candidate: unknown) {
  const units: { id: string; text: string }[] = [];
  const visit = (value: any, metadata = false, field?: string): any => {
    if (metadata) return structuredClone(value);
    if (typeof value === "string" && value.trim()) {
      const id = `content-${units.length}`;
      units.push({ id, text: value });
      if (units.length > 2048) throw new ModelError("MODEL_CONTEXT_TOO_LARGE");
      return field && literalControlFields.has(field)
        ? value
        : { content_unit_id: id };
    }
    if (Array.isArray(value)) return value.map((child) => visit(child));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          visit(child, isCandidateMetadataField(key), key),
        ]),
      );
    return value;
  };
  const structure = visit(candidate);
  if (
    new TextEncoder().encode(JSON.stringify(structure)).byteLength >
    MAX_TYPED_STRUCTURE_BYTES
  )
    throw new ModelError("MODEL_CONTEXT_TOO_LARGE");
  return { structure, units };
}

export const TYPED_BATCH_CONTEXT_INSTRUCTION =
  "typed_candidate_structure preserves the original candidate's field hierarchy, booleans, numbers, nulls, literal control fields and citation metadata. typed_content_manifest lists all canonical content IDs and this batch's subset; it does not widen the report scope. A {content_unit_id: ID} object is a reference to narrative text, not a replacement value or a claim. Resolve only IDs present in this batch's content_units; other text is reviewed in separate batches. Check the supplied text in its original field context, including related typed decisions. Do not invent missing text or report an omission merely because a referenced unit belongs to another batch. Report quotations and processed IDs remain restricted to this batch's content_units and required_ids. The candidate_hash refers to the complete original candidate, not this structure.";
