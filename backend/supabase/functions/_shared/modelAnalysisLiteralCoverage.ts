import {
  candidateContent,
  isCandidateMetadataField,
} from "./modelGrounding.ts";
import { modelSchemas } from "./modelSchemas.ts";
import {
  canonicalSourceSpanId,
  sourceContractContext,
  sourceTaskOutputSchema,
  validateSourceCandidate,
} from "./sourceEvidence.ts";
import type { Evidence, Reference } from "./model.ts";

export type AnalysisLiteralCoverage = {
  version: 1;
  kind: "source_literal_fidelity";
  candidate_hash: string;
  units: {
    content_id: string;
    path: string;
    source_span_ids: string[];
  }[];
};

/** Proves only application-materialized quotation fidelity. It does not prove
 * that a source is this buyer's requirement, a selection is complete, or any
 * interpretation/semantic decision is correct. Those remain independent review.
 * The graph already binds candidate_hash to the complete original candidate;
 * this projection never changes the candidate, its content IDs or its schema. */
export function analysisLiteralCoverage(
  context: any,
  evidence: Evidence[],
  requiredIds: string[],
): AnalysisLiteralCoverage | null {
  if (
    context?.original_task !== "analyze_chunk" ||
    context.original_context?.source_contract_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(context.candidate_hash ?? "") ||
    !context.candidate ||
    typeof context.candidate !== "object" ||
    Array.isArray(context.candidate)
  )
    return null;
  try {
    const candidate = context.candidate;
    const original = context.original_context;
    const contract = sourceContractContext(original);
    if (
      !contract ||
      !sourceTaskOutputSchema(
        "analyze_chunk",
        original,
        modelSchemas.analyze_chunk,
      ).safeParse(candidate).success ||
      !candidate.requirements.length
    )
      return null;
    validateSourceCandidate("analyze_chunk", candidate, original, evidence);
    const processed: string[] = candidate.processed_block_ids;
    if (
      new Set(processed).size !== processed.length ||
      new Set(requiredIds).size !== requiredIds.length ||
      (context.verification_scope === "content_batch"
        ? requiredIds.length !== 0
        : processed.length !== requiredIds.length ||
          !processed.every((id) => requiredIds.includes(id)))
    )
      return null;
    const sources = new Map(evidence.map((source) => [source.id, source]));
    if (sources.size !== evidence.length) return null;
    const spans = new Map(contract.spans.map((span) => [span.id, span]));
    const canonical = candidateContent(candidate);
    const byId = new Map(canonical.map((unit) => [unit.id, unit]));
    const scoped = context.content_units;
    if (
      !Array.isArray(scoped) ||
      new Set(scoped.map((unit: any) => unit?.id)).size !== scoped.length ||
      scoped.some(
        (unit: any) => !unit || byId.get(unit.id)?.text !== unit.text,
      ) ||
      (context.verification_scope !== "content_batch" &&
        scoped.length !== canonical.length)
    )
      return null;
    // Match the canonical walker on the original object, not schema.parse's
    // reordered object. JSONB/transport field ordering therefore remains exact.
    const paths: string[] = [];
    const visit = (value: any, path: string) => {
      if (typeof value === "string" && value.trim()) paths.push(path);
      else if (Array.isArray(value))
        value.forEach((child, index) => visit(child, `${path}[${index}]`));
      else if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value))
          if (!isCandidateMetadataField(key)) visit(child, `${path}.${key}`);
    };
    visit(candidate, "$");
    if (paths.length !== canonical.length) return null;
    const scopedIds = new Set(scoped.map((unit: any) => unit.id));
    const units: AnalysisLiteralCoverage["units"] = [];
    for (const [index, requirement] of candidate.requirements.entries()) {
      const selected = requirement.source_refs.map((ref: any) =>
        spans.get(ref.id),
      );
      if (
        selected.some((span: any) => {
          const source = (span && sources.get(span.id)) as
            (Evidence & { reference?: Reference }) | undefined;
          return (
            !span ||
            span.id !== canonicalSourceSpanId(span) ||
            !processed.includes(span.block_id) ||
            !source ||
            source.kind !==
              (span.entity_kind === "notice" ? "notice" : "rfp") ||
            source.verified !== false ||
            source.text !== span.quote ||
            source.reference?.entity_kind !== span.entity_kind ||
            source.reference?.entity_id !== span.entity_id ||
            source.reference?.content_hash !== span.content_hash
          );
        }) ||
        requirement.text !==
          selected
            .map((span: any) => span.quote)
            .join("\n[Separate source passage]\n")
      )
        return null;
      const path = `$.requirements[${index}].text`;
      const ordinal = paths.indexOf(path);
      if (ordinal < 0 || paths.lastIndexOf(path) !== ordinal) return null;
      const id = canonical[ordinal].id;
      if (scopedIds.has(id))
        units.push({
          content_id: id,
          path,
          source_span_ids: selected.map((span: any) => span.id),
        });
    }
    return units.length
      ? {
          version: 1,
          kind: "source_literal_fidelity",
          candidate_hash: context.candidate_hash,
          units,
        }
      : null;
  } catch {
    // No inferred exemption when a source/candidate/scope cannot be proved.
    return null;
  }
}
