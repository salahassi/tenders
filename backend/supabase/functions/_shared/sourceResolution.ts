import { z } from "zod";
import {
  obligationTupleSchema,
  sourceAuthorityFor,
  sourceObligationReviewSchema,
  sourceSemanticsSchema,
  sourceSpanSchema,
  resolveSourceSpan,
  type SourceObligationReviewV1,
  type SourceSpanV1,
} from "./sourceEvidence.ts";

const unresolvedReason = z.enum([
  "PREDECESSOR_REVISION_UNPINNED",
  "PREDECESSOR_REVISION_CHANGED",
  "SUPERSESSION_AUTHORITY_INCOMPLETE",
  "REVIEW_SOURCE_STALE",
  "SUPERSESSION_CONFLICT",
]);
export const sourceResolutionSchema = z
  .object({
    version: z.literal(1),
    active_reviews: z.array(sourceObligationReviewSchema),
    supersessions: z.array(
      z
        .object({
          predecessor: sourceObligationReviewSchema,
          replacement: sourceObligationReviewSchema,
        })
        .strict(),
    ),
    unresolved_edges: z.array(
      z
        .object({
          predecessor_review_id: z.uuid(),
          replacement_review_id: z.uuid(),
          replacement_revision: z.number().int().positive(),
          reason: unresolvedReason,
        })
        .strict(),
    ),
  })
  .strict();
export type SourceResolutionV1 = z.infer<typeof sourceResolutionSchema>;
type Row = Record<string, any>;
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const sourceCandidateIdentity = (value: Row) =>
  canonical(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id")),
  );
function failure(code: string, path: string): never {
  throw Object.assign(new Error(code), { code, source_path: path });
}
export function sourceResolutionContext(
  context: any,
): SourceResolutionV1 | null {
  const direct =
    context?.source_resolution_version === 1
      ? context
      : context?.original_context?.source_resolution_version === 1
        ? context.original_context
        : null;
  if (!direct) return null;
  const value = sourceResolutionSchema.parse(direct.source_resolution);
  if (value.unresolved_edges.length)
    failure(
      "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
      "$.source_resolution.unresolved_edges",
    );
  const active = new Map<string, SourceObligationReviewV1>();
  const reviews = new Map<string, SourceObligationReviewV1>();
  const edges = new Map<string, string>();
  const remember = (review: SourceObligationReviewV1) => {
    if (review.status !== "confirmed")
      failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_resolution");
    const prior = reviews.get(review.id);
    if (prior && !equal(prior, review))
      failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_resolution");
    reviews.set(review.id, review);
  };
  for (const review of value.active_reviews) {
    if (active.has(review.id))
      failure(
        "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
        "$.source_resolution.active_reviews",
      );
    remember(review);
    active.set(review.id, review);
  }
  for (const edge of value.supersessions) {
    remember(edge.predecessor);
    remember(edge.replacement);
    if (edges.has(edge.predecessor.id) || active.has(edge.predecessor.id))
      failure(
        "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
        "$.source_resolution.supersessions",
      );
    if (edge.predecessor.opportunity_id !== edge.replacement.opportunity_id)
      failure(
        "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
        "$.source_resolution.supersessions",
      );
    if (
      !edge.predecessor.spans.every((old) =>
        edge.replacement.spans.some(
          (current) =>
            current.authority.status === "confirmed" &&
            current.authority.role === "buyer_addendum" &&
            current.authority.supersedes?.entity_id === old.entity_id &&
            current.authority.supersedes?.content_hash === old.content_hash,
        ),
      )
    )
      failure(
        "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
        "$.source_resolution.supersessions",
      );
    edges.set(edge.predecessor.id, edge.replacement.id);
  }
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    let current = start;
    while (edges.has(current)) {
      if (seen.has(current))
        failure(
          "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
          "$.source_resolution.supersessions",
        );
      seen.add(current);
      current = edges.get(current)!;
    }
    if (!active.has(current))
      failure(
        "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
        "$.source_resolution.supersessions",
      );
  }
  return value;
}
const provenance = (s: SourceSpanV1) => ({
  entity_kind: s.entity_kind,
  entity_id: s.entity_id,
  content_hash: s.content_hash,
  extraction_version: s.extraction_version,
  block_id: s.block_id,
  block_hash: s.block_hash,
  coordinate: s.coordinate,
  locator: s.locator,
  authority: s.authority,
});
const overlaps = (a: SourceSpanV1, b: SourceSpanV1) =>
  equal(provenance(a), provenance(b)) && a.start < b.end && b.start < a.end;
const contains = (outer: SourceSpanV1, inner: SourceSpanV1) =>
  equal(provenance(outer), provenance(inner)) &&
  outer.start <= inner.start &&
  outer.end >= inner.end;
function tuple(requirement: Row) {
  const semantics = sourceSemanticsSchema.parse(requirement.source_semantics);
  return obligationTupleSchema.parse(
    Object.fromEntries(
      Object.keys(obligationTupleSchema.shape).map((key) => [
        key,
        (semantics as any)[key],
      ]),
    ),
  );
}
function selectedSpans(requirement: Row, context: any): SourceSpanV1[] {
  const catalog = context.source_evidence?.spans;
  if (!Array.isArray(catalog))
    failure("SOURCE_SPAN_STALE", "$.source_evidence.spans");
  const map = new Map(catalog.map((span: any) => [span.id, span]));
  const selected = (requirement.source_semantics?.source_span_ids || []).map(
    (id: string) => {
      const found = map.get(id);
      if (!found)
        failure("SOURCE_SPAN_STALE", "$.source_semantics.source_span_ids");
      return sourceSpanSchema.parse(found);
    },
  );
  if (
    new Set(selected.map((span: SourceSpanV1) => span.id)).size !==
    selected.length
  )
    failure(
      "SOURCE_SPAN_IDENTITY_INVALID",
      "$.source_semantics.source_span_ids",
    );
  if (
    !equal(
      requirement.source_refs,
      selected.map((span: SourceSpanV1) => ({
        id: span.id,
        quote: span.quote,
      })),
    ) ||
    requirement.text !==
      selected
        .map((span: SourceSpanV1) => span.quote)
        .join("\n[Separate source passage]\n")
  )
    failure("SOURCE_SPAN_TEXT_INVALID", "$.source_refs");
  return selected;
}
function covers(selected: SourceSpanV1[], review: SourceObligationReviewV1) {
  return (
    review.spans.every((span) => selected.some((s) => contains(s, span))) &&
    selected.every((span) => review.spans.some((s) => overlaps(span, s)))
  );
}
function explicitlyCurrent(requirement: Row, review: SourceObligationReviewV1) {
  const expected = reviewedSourceRequirement(review);
  return (
    equal(requirement.source_semantics, expected.source_semantics) &&
    equal(requirement.source_refs, expected.source_refs)
  );
}
const atomFields = [
  "quantities",
  "dates",
  "conditions",
  "exceptions",
  "consequences",
] as const;
const hasAtoms = (meaning: SourceObligationReviewV1["semantics"]) =>
  atomFields.some((field) => meaning[field].length);
const reusesAtom = (
  a: SourceObligationReviewV1["semantics"],
  b: SourceObligationReviewV1["semantics"],
) =>
  atomFields.some((field) =>
    b[field].some((item) =>
      a[field].some((candidate) => equal(candidate, item)),
    ),
  );
/** Equality identifies an already reviewed unit; it never infers equivalence
 * from prose, number proximity, chronology, filenames or authority precedence. */
export function retiredSourceUnit(requirement: Row, context: any) {
  const resolution = sourceResolutionContext(context);
  if (!resolution) return null;
  const meaning = tuple(requirement),
    selected = selectedSpans(requirement, context);
  if (
    resolution.active_reviews.some((review) =>
      explicitlyCurrent(requirement, review),
    )
  )
    return null;
  const matching = resolution.supersessions.filter(
    ({ predecessor }) =>
      equal(meaning, predecessor.semantics) && covers(selected, predecessor),
  );
  const activeMatches = resolution.active_reviews.filter(
    (review) =>
      hasAtoms(review.semantics) &&
      equal(meaning, review.semantics) &&
      covers(selected, review),
  );
  for (const { predecessor } of resolution.supersessions)
    if (
      !hasAtoms(predecessor.semantics) &&
      selected.some((span) =>
        predecessor.spans.some((old) => overlaps(span, old)),
      ) &&
      !explicitlyCurrent(requirement, predecessor)
    )
      failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_semantics");
  if (
    matching.length > 1 ||
    activeMatches.length > 1 ||
    (matching.length && activeMatches.length)
  )
    failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_semantics");
  if (matching.length) {
    if (
      !hasAtoms(matching[0].predecessor.semantics) &&
      requirement.source_semantics.review_id !== matching[0].predecessor.id
    )
      failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_semantics");
    return matching[0];
  }
  if (activeMatches.length) return null;
  for (const { predecessor } of resolution.supersessions)
    if (
      selected.some((span) =>
        predecessor.spans.some((old) => overlaps(span, old)),
      ) &&
      (!hasAtoms(predecessor.semantics) ||
        reusesAtom(meaning, predecessor.semantics))
    )
      failure("SOURCE_OBLIGATION_RESOLUTION_REQUIRED", "$.source_semantics");
  return null;
}
export function assertCurrentSourceRequirements(
  context: any,
  requirements: Row[],
) {
  if (!sourceResolutionContext(context)) return;
  for (const [index, requirement] of requirements.entries())
    if (retiredSourceUnit(requirement, context))
      failure(
        "SOURCE_OBLIGATION_SUPERSEDED",
        `$.source_requirements[${index}].source_semantics`,
      );
}
/** The source side is copied from a current authorized review. This does not
 * confirm any generated response, company claim or final proposal approval. */
export function reviewedSourceRequirement(
  review: SourceObligationReviewV1,
  metadata?: Row,
): Row {
  const authority = sourceAuthorityFor(review.spans);
  const text = review.spans
    .map((s) => s.quote)
    .join("\n[Separate source passage]\n");
  return {
    text,
    category: metadata?.category || "scope",
    mandatory:
      authority.authority_status === "confirmed" &&
      ["buyer_rfp", "buyer_addendum"].includes(authority.authority_role) &&
      ["required", "prohibited"].includes(review.semantics.modality),
    source_refs: review.spans.map((s) => ({ id: s.id, quote: s.quote })),
    interpretation: metadata?.interpretation || text,
    acceptance_evidence: metadata?.acceptance_evidence || "",
    owner_question: metadata?.owner_question || null,
    source_semantics: {
      ...structuredClone(review.semantics),
      version: 1,
      source_span_ids: review.spans.map((s) => s.id),
      ...authority,
      review_status: "confirmed",
      review_id: review.id,
    },
    source_review_reason: review.reason,
  };
}
export function matchesActiveSourceUnit(
  requirement: Row,
  review: SourceObligationReviewV1,
  context: any,
) {
  if (requirement.source_semantics?.review_status === "confirmed")
    return explicitlyCurrent(requirement, review);
  return (
    explicitlyCurrent(requirement, review) ||
    (hasAtoms(review.semantics) &&
      equal(tuple(requirement), review.semantics) &&
      covers(selectedSpans(requirement, context), review))
  );
}
export function validateSourceResolution(
  task: string,
  value: any,
  context: any,
) {
  if (task === "repair_result")
    return validateSourceResolution(
      value.target_task,
      value.result,
      context?.original_context || context,
    );
  if (!sourceResolutionContext(context)) return;
  if (task === "analyze_chunk") {
    for (const [index, requirement] of value.requirements.entries()) {
      try {
        retiredSourceUnit(requirement, context);
      } catch (error: any) {
        if (typeof error?.code === "string" && error.code.startsWith("SOURCE_"))
          failure(error.code, `$.requirements[${index}].source_semantics`);
        throw error;
      }
    }
    return;
  }
  assertCurrentSourceRequirements(context, context.source_requirements || []);
}
export function assertActiveSourceInventory(context: any, requirements: Row[]) {
  const resolution = sourceResolutionContext(context);
  if (!resolution) return;
  assertCurrentSourceRequirements(context, requirements);
  for (const review of resolution.active_reviews) {
    const canonical = reviewedSourceRequirement(review);
    if (
      !requirements.some(
        (r) =>
          equal(r.source_semantics, canonical.source_semantics) &&
          equal(r.source_refs, canonical.source_refs) &&
          r.text === canonical.text &&
          r.mandatory === canonical.mandatory,
      )
    )
      failure(
        "SOURCE_OBLIGATION_INVENTORY_INCOMPLETE",
        "$.source_requirements",
      );
  }
}
export function assertSourceResolutionSources(context: any) {
  const resolution = sourceResolutionContext(context);
  if (!resolution) return;
  const sources = [context.notice, ...(context.blocks || [])].filter(Boolean);
  for (const review of [
    ...resolution.active_reviews,
    ...resolution.supersessions.flatMap((edge) => [
      edge.predecessor,
      edge.replacement,
    ]),
  ])
    for (const span of review.spans) {
      const source = sources.find((s) => s.id === span.block_id);
      if (!source) failure("SOURCE_SPAN_STALE", "$.source_resolution");
      resolveSourceSpan(span, source);
      if (!equal(source.authority, span.authority))
        failure("SOURCE_SPAN_STALE", "$.source_resolution");
    }
}
