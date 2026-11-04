import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  identifier = z.string().min(1).max(200);
export const sourceAuthoritySchema = z
  .object({
    version: z.literal(1),
    decision_id: z.uuid().nullable(),
    revision: z.number().int().nonnegative(),
    role: z.enum([
      "buyer_rfp",
      "buyer_addendum",
      "supplier_proposal",
      "company_evidence",
      "reference",
      "unknown",
    ]),
    status: z.enum(["confirmed", "unconfirmed", "revoked"]),
    supersedes: z
      .object({ entity_id: z.uuid(), content_hash: hash })
      .strict()
      .nullable(),
    precedence: z.number().int().min(0).max(1000),
  })
  .strict();
export type SourceAuthorityV1 = z.infer<typeof sourceAuthoritySchema>;
export const sourceSpanSchema = z
  .object({
    version: z.literal(1),
    id: identifier,
    entity_kind: z.enum(["document", "notice", "knowledge", "review", "rate"]),
    entity_id: z.uuid(),
    content_hash: hash,
    extraction_version: z.string().min(1).max(40),
    block_id: identifier,
    block_hash: hash,
    coordinate: z.literal("unicode_code_point"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(24000),
    locator: z.record(z.string(), z.unknown()),
    authority: sourceAuthoritySchema,
  })
  .strict();
export type SourceSpanV1 = z.infer<typeof sourceSpanSchema>;
export const obligationTupleSchema = z
  .object({
    modality: z.enum([
      "required",
      "permitted",
      "prohibited",
      "informational",
      "unknown",
    ]),
    actor: z.string().min(1).max(1000).nullable(),
    negated: z.boolean().nullable(),
    conditions: z.array(z.string().min(1).max(3000)).max(32),
    exceptions: z.array(z.string().min(1).max(3000)).max(32),
    consequences: z.array(z.string().min(1).max(3000)).max(32),
    quantities: z
      .array(
        z
          .object({
            value: z.string().min(1).max(200),
            unit: z.string().min(1).max(200),
            currency: z.string().min(1).max(100).nullable(),
          })
          .strict(),
      )
      .max(32),
    dates: z
      .array(
        z
          .object({
            value: z.string().min(1).max(200),
            event: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ObligationTupleV1 = z.infer<typeof obligationTupleSchema>;
export const sourceSemanticsSchema = obligationTupleSchema
  .extend({
    version: z.literal(1),
    source_span_ids: z.array(identifier).min(1).max(8),
    authority_role: sourceAuthoritySchema.shape.role,
    authority_status: sourceAuthoritySchema.shape.status,
    review_status: z.enum(["pending", "confirmed"]),
    review_id: z.uuid().nullable(),
  })
  .strict();
export type SourceSemanticsV1 = z.infer<typeof sourceSemanticsSchema>;
export const sourceObligationReviewSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    revision: z.number().int().positive(),
    opportunity_id: z.uuid(),
    spans: z.array(sourceSpanSchema).min(1).max(8),
    semantics: obligationTupleSchema,
    reason: z.string().min(1).max(3000),
    status: z.enum(["confirmed", "revoked"]),
  })
  .strict();
export type SourceObligationReviewV1 = z.infer<
  typeof sourceObligationReviewSchema
>;
export const sourceEvidenceContractSchema = z
  .object({
    version: z.literal(1),
    spans: z.array(sourceSpanSchema),
    reviews: z.array(sourceObligationReviewSchema),
  })
  .strict();
export type SourceEvidenceContractV1 = z.infer<
  typeof sourceEvidenceContractSchema
>;
export function sourceContractContext(
  context: any,
): SourceEvidenceContractV1 | null {
  const direct =
    context?.source_contract_version === 1
      ? context
      : context?.original_context?.source_contract_version === 1
        ? context.original_context
        : null;
  return direct
    ? sourceEvidenceContractSchema.parse(direct.source_evidence)
    : null;
}
/** Opt-in only: the legacy registry and historical paid wire remain unchanged. */
export function sourceTaskOutputSchema(
  task: string,
  context: unknown,
  fallback: z.ZodType,
): z.ZodType {
  if (!sourceContractContext(context)) return fallback;
  if (
    task === "repair_result" &&
    (context as any)?.target_task === "analyze_chunk"
  ) {
    const original = fallback as z.ZodObject<any>;
    return original
      .extend({
        result: sourceTaskOutputSchema(
          "analyze_chunk",
          context,
          original.shape.result,
        ),
      })
      .strict();
  }
  if (task === "analyze_chunk") {
    const original = fallback as z.ZodObject<any>;
    return original
      .extend({
        requirements: z
          .array(
            original.shape.requirements.element
              .extend({
                source_semantics: sourceSemanticsSchema,
                text: z.string().min(1).max(192000),
                source_refs: z
                  .array(
                    z
                      .object({
                        id: identifier,
                        quote: z.string().min(1).max(24000),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(8),
              })
              .strict(),
          )
          .max(100),
      })
      .strict();
  }
  return fallback;
}
function failure(code: string, path: string): never {
  throw Object.assign(new Error(code), { code, source_path: path });
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function canonicalSourceSpanId(
  span: Pick<
    SourceSpanV1,
    | "entity_id"
    | "content_hash"
    | "block_id"
    | "start"
    | "end"
    | "extraction_version"
  >,
) {
  return `S1:${span.block_id}:${span.start}:${span.end}:${span.content_hash.slice(0, 16)}:${span.extraction_version}`;
}
export function resolveSourceSpan(
  span: SourceSpanV1,
  source: {
    id: string;
    text: string;
    reference: { entity_kind: string; entity_id: string; content_hash: string };
    block_hash: string;
    extraction_version: string;
  },
): string {
  sourceSpanSchema.parse(span);
  if (
    span.id !== canonicalSourceSpanId(span) ||
    span.block_id !== source.id ||
    span.entity_kind !== source.reference.entity_kind ||
    span.entity_id !== source.reference.entity_id ||
    span.content_hash !== source.reference.content_hash ||
    span.block_hash !== source.block_hash ||
    span.extraction_version !== source.extraction_version
  )
    failure("SOURCE_SPAN_STALE", "$.source_span");
  const points = Array.from(source.text);
  if (span.start >= span.end || span.end > points.length)
    failure("SOURCE_SPAN_RANGE_INVALID", "$.source_span");
  const quote = points.slice(span.start, span.end).join("");
  if (span.quote !== quote)
    failure("SOURCE_SPAN_TEXT_INVALID", "$.source_span.quote");
  return quote;
}
export async function assertSourceBlockHash(source: {
  text: string;
  block_hash: string;
}) {
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source.text),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== source.block_hash)
    failure("SOURCE_SPAN_STALE", "$.block_hash");
}
export function sourceAuthorityFor(
  spans: SourceSpanV1[],
): Pick<SourceSemanticsV1, "authority_role" | "authority_status"> {
  const authorities = spans.map((s) => s.authority);
  if (authorities.some((a) => a.status === "revoked"))
    return { authority_role: "unknown", authority_status: "revoked" };
  if (
    !authorities.length ||
    authorities.some((a) => a.status !== "confirmed" || a.role === "unknown")
  )
    return { authority_role: "unknown", authority_status: "unconfirmed" };
  const roles = new Set(authorities.map((a) => a.role));
  if (
    [...roles].every((role) => ["buyer_rfp", "buyer_addendum"].includes(role))
  )
    return {
      authority_role: roles.has("buyer_addendum")
        ? "buyer_addendum"
        : "buyer_rfp",
      authority_status: "confirmed",
    };
  return roles.size === 1
    ? { authority_role: authorities[0].role, authority_status: "confirmed" }
    : { authority_role: "unknown", authority_status: "unconfirmed" };
}
function reviewedSemantics(
  semantics: SourceSemanticsV1,
  spans: SourceSpanV1[],
  contract: SourceEvidenceContractV1,
  path: string,
) {
  const authority = sourceAuthorityFor(spans);
  if (
    semantics.authority_role !== authority.authority_role ||
    semantics.authority_status !== authority.authority_status
  )
    failure(
      "SOURCE_AUTHORITY_INVALID",
      `${path}.source_semantics.authority_role`,
    );
  const review = semantics.review_id
    ? contract.reviews.find(
        (r) => r.id === semantics.review_id && r.status === "confirmed",
      )
    : null;
  if (!review) {
    if (semantics.review_id !== null || semantics.review_status !== "pending")
      failure(
        "SOURCE_SEMANTICS_REVIEW_REQUIRED",
        `${path}.source_semantics.review_status`,
      );
    return;
  }
  if (semantics.review_status !== "confirmed" || !equal(review.spans, spans))
    failure("SOURCE_SEMANTICS_STALE", `${path}.source_semantics.review_id`);
  const tuple = obligationTupleSchema.parse(
    Object.fromEntries(
      Object.keys(obligationTupleSchema.shape).map((key) => [
        key,
        (semantics as any)[key],
      ]),
    ),
  );
  for (const key of Object.keys(
    obligationTupleSchema.shape,
  ) as (keyof ObligationTupleV1)[])
    if (!equal(tuple[key], review.semantics[key]))
      failure(
        "SOURCE_SEMANTICS_CONTRADICTION",
        `${path}.source_semantics.${key}`,
      );
}
export function validateSourceCandidate(
  task: string,
  value: any,
  context: any,
  evidence: unknown[],
): void {
  const contract = sourceContractContext(context);
  if (!contract) return;
  if (task === "repair_result")
    return validateSourceCandidate(
      value.target_task,
      value.result,
      context.original_context || context,
      evidence,
    );
  if (task === "draft_section") {
    const requirements = context.source_requirements || [];
    const ids = new Set(requirements.map((r: any) => r.id));
    if ((value.requirement_ids || []).some((id: string) => !ids.has(id)))
      failure("SOURCE_SPAN_IDENTITY_INVALID", "$.requirement_ids");
    // Validate the source-side obligation binding independently of company evidence.
    // Whether the response fulfils it is a separate scoped review/consistency gate.
    for (const requirement of requirements)
      validateSourceCandidate(
        "analyze_chunk",
        { requirements: [requirement] },
        context,
        evidence,
      );
    return;
  }
  if (task !== "analyze_chunk") return;
  const available = new Map(contract.spans.map((s) => [s.id, s]));
  if (available.size !== contract.spans.length)
    failure("SOURCE_SPAN_IDENTITY_INVALID", "$.source_evidence.spans");
  for (const [reqIndex, req] of value.requirements.entries()) {
    const path = `$.requirements[${reqIndex}]`;
    const semantics = sourceSemanticsSchema.parse(req.source_semantics),
      selected: SourceSpanV1[] = [];
    for (const id of semantics.source_span_ids) {
      const span = available.get(id);
      if (!span)
        failure(
          "SOURCE_SPAN_STALE",
          `${path}.source_semantics.source_span_ids`,
        );
      selected.push(span);
    }
    if (
      new Set(semantics.source_span_ids).size !== selected.length ||
      !equal(
        req.source_refs.map((r: any) => r.id),
        semantics.source_span_ids,
      )
    )
      failure("SOURCE_SPAN_IDENTITY_INVALID", `${path}.source_refs`);
    for (const [index, span] of selected.entries())
      if (req.source_refs[index].quote !== span.quote)
        failure(
          "SOURCE_SPAN_TEXT_INVALID",
          `${path}.source_refs[${index}].quote`,
        );
    reviewedSemantics(semantics, selected, contract, path);
    if (semantics.review_status === "confirmed") {
      const buyer =
        semantics.authority_status === "confirmed" &&
        ["buyer_rfp", "buyer_addendum"].includes(semantics.authority_role);
      if (
        req.mandatory !==
        (buyer && ["required", "prohibited"].includes(semantics.modality))
      )
        failure("SOURCE_SEMANTICS_CONTRADICTION", `${path}.mandatory`);
    }
  }
}
export function materializeSourceCandidate(
  task: string,
  value: any,
  context: any,
  evidence: unknown[],
  validate = true,
): any {
  const contract = sourceContractContext(context);
  if (!contract) return value;
  if (task === "repair_result")
    return {
      ...value,
      result: materializeSourceCandidate(
        value.target_task,
        value.result,
        context.original_context || context,
        evidence,
        validate,
      ),
    };
  if (task !== "analyze_chunk") return value;
  const spans = new Map(contract.spans.map((span) => [span.id, span]));
  let result: any;
  try {
    result = {
      ...value,
      requirements: value.requirements.map((req: any, index: number) => {
        const refs = req.source_refs.map((ref: any) => {
          const span = spans.get(ref.id);
          if (!span)
            failure(
              "SOURCE_SPAN_STALE",
              `$.requirements[${index}].source_refs`,
            );
          return { id: span.id, quote: span.quote };
        });
        const selected = refs.map((ref: any) => spans.get(ref.id)!);
        const reviews = contract.reviews.filter(
          (review) =>
            review.status === "confirmed" && equal(review.spans, selected),
        );
        const review = reviews.length === 1 ? reviews[0] : null;
        return {
          ...req,
          source_semantics: {
            ...req.source_semantics,
            ...sourceAuthorityFor(selected),
            source_span_ids: refs.map((ref: any) => ref.id),
            review_status: review ? "confirmed" : "pending",
            review_id: review?.id || null,
          },
          text: refs
            .map((ref: any) => ref.quote)
            .join("\n[Separate source passage]\n"),
          source_refs: refs,
        };
      }),
    };
  } catch (error: any) {
    error.source_diagnostics = collectSourceCandidateDiagnostics(
      task,
      value,
      context,
      evidence,
    );
    throw error;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 786432)
    failure("SOURCE_MATERIALIZATION_CAPACITY", "$.requirements");
  if (validate) validateSourceCandidate(task, result, context, evidence);
  return result;
}

/** Search normalization has a source map; stored quotes always use original code points. */
export function normalizeSourceWithMap(original: string) {
  const ranges: { start: number; end: number }[] = [];
  let text = "",
    offset = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(original)) {
    const start = offset;
    offset += Array.from(segment).length;
    for (const point of Array.from(segment.normalize("NFC"))) {
      if (/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]$/u.test(point)) continue;
      if (/\s/u.test(point)) {
        if (text.endsWith(" ")) {
          ranges[ranges.length - 1].end = offset;
          continue;
        }
        text += " ";
        ranges.push({ start, end: offset });
      } else {
        text += point;
        ranges.push({ start, end: offset });
      }
    }
  }
  return { text, ranges, coordinate: "unicode_code_point" as const };
}

/** Independent candidate failures, bounded for scoped repair. Never treats model assertions as review. */
export function collectSourceCandidateDiagnostics(
  task: string,
  value: any,
  context: any,
  evidence: unknown[],
): { code: string; source_path: string }[] {
  const contract = sourceContractContext(context);
  if (!contract) return [];
  if (task === "repair_result")
    return collectSourceCandidateDiagnostics(
      value.target_task,
      value.result,
      context.original_context || context,
      evidence,
    );
  if (task !== "analyze_chunk") return [];
  const errors: { code: string; source_path: string }[] = [];
  const add = (code: string, source_path: string) => {
    if (!errors.some((e) => e.code === code && e.source_path === source_path))
      errors.push({ code, source_path });
  };
  for (const [index, requirement] of (value.requirements || []).entries()) {
    const path = `$.requirements[${index}]`;
    try {
      validateSourceCandidate(
        task,
        { ...value, requirements: [requirement] },
        context,
        evidence,
      );
    } catch (error: any) {
      add(
        error.code || "SOURCE_SEMANTICS_INVALID",
        String(
          error.source_path || "$.requirements[0].source_semantics",
        ).replace("$.requirements[0]", path),
      );
    }
    const parsed = sourceSemanticsSchema.safeParse(
      requirement.source_semantics,
    );
    if (!parsed.success) continue;
    const semantics = parsed.data;
    const spans = semantics.source_span_ids.map((id) =>
      contract.spans.find((span) => span.id === id),
    );
    if (
      spans.some((span) => !span) ||
      !equal(
        requirement.source_refs,
        spans.map((span) => ({ id: span!.id, quote: span!.quote })),
      )
    )
      continue;
    const review = contract.reviews.find(
      (review) =>
        review.id === semantics.review_id &&
        review.status === "confirmed" &&
        equal(review.spans, spans),
    );
    if (!review) continue;
    for (const key of Object.keys(
      obligationTupleSchema.shape,
    ) as (keyof ObligationTupleV1)[])
      if (!equal(semantics[key], review.semantics[key]))
        add(
          "SOURCE_SEMANTICS_CONTRADICTION",
          `${path}.source_semantics.${key}`,
        );
    const mandatory =
      semantics.authority_status === "confirmed" &&
      ["buyer_rfp", "buyer_addendum"].includes(semantics.authority_role) &&
      ["required", "prohibited"].includes(semantics.modality);
    if (requirement.mandatory !== mandatory)
      add("SOURCE_SEMANTICS_CONTRADICTION", `${path}.mandatory`);
  }
  return errors;
}

/** Canonical identity retains distinct interpreted obligations sharing one passage. */
export function sourceRequirementIdentity(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(sourceRequirementIdentity).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${sourceRequirementIdentity((value as any)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
