import { z } from "zod";
import { primaryModelSchemas } from "./modelSchemas.ts";
import { sourceSemanticsSchema } from "./sourceEvidence.ts";
import {
  assessProposalConsistency,
  type ConsistencyInput,
} from "./proposalConsistency.ts";
import {
  deliveryPayloadV2Schema,
  type DeliveryPayload,
} from "./deliveryContract.ts";
import { deliveryRenderingGapSummary } from "./deliveryExport.ts";
import { AppError } from "./http.ts";

const text = z.string().trim().min(1).max(3000);
const fact = z
  .object({
    key: text,
    kind: z.enum(["quantity", "money", "date", "decision"]),
    value: text.nullable(),
    unit: text.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    quote: text,
    decision_id: text.optional(),
  })
  .strict();
export const authoringBodySchema = z
  .object({
    version: z.literal(1),
    requirements: z
      .array(
        z
          .object({
            id: z.uuid(),
            text: z.string().min(1).max(96000),
            mandatory: z.boolean(),
            source_refs: z
              .array(
                z
                  .object({ id: text, quote: z.string().min(1).max(12000) })
                  .strict(),
              )
              .min(1)
              .max(8),
            source_semantics: sourceSemanticsSchema,
            source_review_reason: text.optional(),
          })
          .strict(),
      )
      .max(200),
    sections: z
      .array(
        primaryModelSchemas.draft_section
          .extend({ volume: z.enum(["technical", "financial", "shared"]) })
          .strict(),
      )
      .max(100),
    fulfillment: z
      .array(
        z
          .object({
            requirement_id: z.uuid(),
            response_section_key: text,
            response_excerpt: z.string().max(20000),
            method: z.string().max(3000),
            deliverable: z.string().max(3000),
            acceptance_evidence: z.string().max(3000),
            conditions_preserved: z.array(text).max(32),
            exceptions_preserved: z.array(text).max(32),
            consequences_preserved: z.array(text).max(32),
            facts: z.array(fact).max(100),
            qualifier_equivalences: z
              .array(
                z
                  .object({
                    kind: z.enum(["conditions", "exceptions", "consequences"]),
                    source_index: z.number().int().nonnegative(),
                    source_quote: text,
                    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
                    response_quote: text,
                  })
                  .strict(),
              )
              .max(96)
              .optional(),
          })
          .strict(),
      )
      .max(200),
    section_facts: z
      .array(
        z.object({ section_key: text, facts: z.array(fact).max(100) }).strict(),
      )
      .max(100)
      .optional(),
    confirmed_shared_decisions: z
      .array(
        z
          .object({ id: text, statement: text, facts: z.array(fact).max(100) })
          .strict(),
      )
      .max(100),
    pending_inputs: z
      .array(
        z
          .object({
            id: text,
            question: text,
            required_for: z.enum(["substantive_completion", "final_approval"]),
            requirement_ids: z.array(z.uuid()).max(200),
          })
          .strict(),
      )
      .max(100),
    // Reuse is a conscious scoped decision with an exact current verified source.
    // There is no inferred approved library or automatic carry-over of claims.
    reuse: z
      .array(
        z
          .object({
            source_id: z.uuid(),
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
            quote: text,
            section_key: text,
            fit_reason: text,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type AuthoringBody = z.infer<typeof authoringBodySchema>;
export function assertAuthoringClaims(body: AuthoringBody) {
  for (const section of body.sections)
    for (const claim of section.company_claims) {
      if (
        !body.reuse.some(
          (item) =>
            item.source_id === claim.source_id &&
            item.quote === claim.quote &&
            item.section_key === section.key,
        ) ||
        !section.content_blocks.some((block) =>
          block.type === "table"
            ? block.rows.flat().some((cell) => cell.includes(claim.claim))
            : block.text.includes(claim.claim),
        )
      )
        throw new AppError(
          422,
          "AUTHORING_REUSE_UNVERIFIED",
          "Every company claim needs explicit current verified evidence and a fit decision.",
        );
    }
}
export const authoringOpenSchema = z
  .object({
    snapshot_id: z.uuid(),
    expected_delivery_revision: z.number().int().nonnegative(),
  })
  .strict();
export const authoringSaveSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    body: authoringBodySchema,
  })
  .strict();
export const authoringClaimSchema = z
  .object({ expected_revision: z.number().int().positive(), note: text })
  .strict();
export const authoringReviewSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    reason: text,
    inventory_review: z
      .object({
        source_ids: z.array(z.uuid()).min(1),
        coverage_statement: text,
      })
      .strict(),
    responses: z
      .array(
        z
          .object({
            requirement_id: z.uuid(),
            response_excerpt: z.string().min(1).max(20000),
            rationale: text,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type AuthoringContext = {
  session: {
    id: string;
    workspace_id: string;
    proposal_id: string;
    opportunity_id: string;
    revision: number;
    responsible_actor_id: string | null;
  };
  revision: { id: string; body_hash: string; body: AuthoringBody };
  snapshot: { payload: DeliveryPayload; [key: string]: any };
  sources: ConsistencyInput["sources"];
  context_hash: string;
  source_manifest?: DeliveryPayload["source_manifest"];
  inventory_missing_ids?: string[];
};

export async function reviewAuthoredResponse(
  context: AuthoringContext,
  actor: string,
  review: z.infer<typeof authoringReviewSchema>,
  reviewId: string,
) {
  const body = authoringBodySchema.parse(context.revision.body);
  if (context.session.revision !== review.expected_revision)
    throw new AppError(
      409,
      "REVISION_CONFLICT",
      "The response changed. Reload before reviewing.",
    );
  const sources = new Set(
    (context.source_manifest || context.snapshot.payload.source_manifest).map(
      (ref) => ref.entity_id,
    ),
  );
  if (
    review.inventory_review.source_ids.length !== sources.size ||
    new Set(review.inventory_review.source_ids).size !== sources.size ||
    review.inventory_review.source_ids.some((id) => !sources.has(id))
  )
    throw new AppError(
      422,
      "AUTHORING_INVENTORY_REVIEW_REQUIRED",
      "Review the complete current source inventory.",
    );
  if (
    review.responses.length !== body.requirements.length ||
    new Set(review.responses.map((item) => item.requirement_id)).size !==
      body.requirements.length ||
    review.responses.some(
      (item) =>
        !body.fulfillment.some(
          (f) =>
            f.requirement_id === item.requirement_id &&
            f.response_excerpt === item.response_excerpt,
        ),
    )
  )
    throw new AppError(
      422,
      "AUTHORING_REVIEW_SCOPE_INVALID",
      "Each saved response needs an explicit, exact review binding.",
    );
  const input: ConsistencyInput = {
    requirements: body.requirements,
    sections: body.sections,
    fulfillment: body.fulfillment,
    sources: context.sources,
    section_facts: body.section_facts,
    confirmed_shared_decisions: body.confirmed_shared_decisions,
    separate_volumes: context.snapshot.payload.separate_volumes,
    input_complete:
      context.snapshot.payload.input_state === "available" &&
      !body.pending_inputs.some(
        (g) => g.required_for === "substantive_completion",
      ) &&
      !body.sections.some((section) =>
        section.questions.some((q) => q.blocking_level === "generation"),
      ),
    human_review: {
      review_id: reviewId,
      actor_id: actor,
      requirement_ids: review.responses.map((item) => item.requirement_id),
      confirmed: true,
    },
  };
  const report = await assessProposalConsistency(input);
  if (context.inventory_missing_ids?.length) {
    report.substantive_complete = false;
    report.diagnostics.push({
      id: "authoring-inventory-incomplete",
      code: "REQUIREMENT_INVENTORY_INCOMPLETE",
      severity: "blocking",
      paths: ["$.requirements"],
      requirement_ids: context.inventory_missing_ids,
      section_keys: [],
      decision_ids: [],
      detail:
        "Known current buyer obligations are missing from the response inventory.",
    });
  }
  const payload = buildAuthoredPayload(context, reviewId, report);
  const volumes = payload.separate_volumes
    ? (["technical", "financial"] as const)
    : (["combined"] as const);
  const renderGaps = volumes
    .flatMap(
      (volume) =>
        deliveryRenderingGapSummary({ ...context.snapshot, payload }, volume)
          .gaps,
    )
    .filter((g) => g.origin === "rendering");
  if (renderGaps.length) {
    report.substantive_complete = false;
    report.diagnostics.push({
      id: "authoring-render-gaps",
      code: "DELIVERY_RENDERING_GAPS",
      severity: "blocking",
      paths: renderGaps.map((g) => g.field_path),
      requirement_ids: [],
      section_keys: [...new Set(renderGaps.map((g) => g.section_key))],
      decision_ids: [],
      detail:
        "The delivered file would omit or withhold content. Resolve these gaps before substantive completion.",
    });
  }
  return { report, payload: buildAuthoredPayload(context, reviewId, report) };
}

export function buildAuthoredPayload(
  context: AuthoringContext,
  reviewId: string | null = null,
  report: Awaited<ReturnType<typeof assessProposalConsistency>> | null = null,
) {
  const body = authoringBodySchema.parse(context.revision.body),
    base = context.snapshot.payload;
  assertAuthoringClaims(body);
  const substantive = report?.substantive_complete === true;
  const ar = base.language === "ar",
    l = (en: string, arabic: string) => (ar ? arabic : en);
  const gaps = body.pending_inputs.map((g) => ({
    id: g.id,
    section_key: "pending-inputs",
    field_path: `$.pending_inputs.${g.id}`,
    reason: "MODEL_INPUT_REQUIRED" as const,
    label: g.question,
    required_for: g.required_for,
    source_ids: [] as string[],
  }));
  body.sections.forEach((section, i) => {
    section.questions.forEach((q, j) =>
      gaps.push({
        id: `authoring-question-${i}-${j}`,
        section_key: "pending-inputs",
        field_path: `$.sections[${i}].questions[${j}]`,
        reason: "MODEL_INPUT_REQUIRED",
        label: q.question,
        required_for:
          q.blocking_level === "generation"
            ? "substantive_completion"
            : "final_approval",
        source_ids: [],
      }),
    );
    section.assumptions.forEach((assumption, j) =>
      gaps.push({
        id: `authoring-assumption-${i}-${j}`,
        section_key: "pending-inputs",
        field_path: `$.sections[${i}].assumptions[${j}]`,
        reason: "MODEL_INPUT_REQUIRED",
        label: l("Confirm assumption: ", "تأكيد الافتراض: ") + assumption,
        required_for: "final_approval",
        source_ids: [],
      }),
    );
  });
  if (!substantive)
    gaps.push({
      id: "authoring-review-required",
      section_key: "pending-inputs",
      field_path: "$.authoring",
      reason: "MODEL_INPUT_REQUIRED",
      label: l(
        "Complete every source obligation and review the current responses before substantive completion.",
        "استكمل الإجابة على كل التزام في المصدر وراجع الاستجابات الحالية قبل اعتبار المسودة مكتملة المحتوى.",
      ),
      required_for: "substantive_completion",
      source_ids: [],
    });
  gaps.push({
    id: "authoring-final-approval",
    section_key: "pending-inputs",
    field_path: "$.approval_state",
    reason: "MODEL_INPUT_REQUIRED",
    label: l(
      "Final approval and commercial authorization remain required before external use.",
      "ما زال الاعتماد النهائي والتفويض التجاري مطلوبين قبل الاستخدام الخارجي.",
    ),
    required_for: "final_approval",
    source_ids: [],
  });
  const manifest = context.source_manifest || base.source_manifest;
  const sourceIds = [...new Set(manifest.map((ref) => ref.entity_id))];
  return deliveryPayloadV2Schema.parse({
    ...base,
    source_manifest: manifest,
    version: 2,
    content_state: substantive ? "substantive_draft" : "authored_draft",
    assurance_state: reviewId ? "human_reviewed" : "unreviewed",
    substantive_complete: substantive,
    notice: substantive
      ? l(
          "The saved responses received a current source-bound human review. This draft has not received final approval.",
          "راجعت جهة مخولة الاستجابات المحفوظة وربطتها بالمصادر الحالية. هذه المسودة غير معتمدة نهائيًا.",
        )
      : l(
          "Authored responses are saved. Unanswered obligations and pending reviews remain explicit; no model availability is required to continue writing.",
          "حُفظت الاستجابات المكتوبة. المتطلبات غير المجاب عنها والمراجعات المعلقة موضحة؛ يمكن متابعة الكتابة دون توفر أي نموذج.",
        ),
    sections: [
      ...body.sections.map((section) => ({
        section_key: section.key,
        title: section.title,
        volume: section.volume,
        kind: "response" as const,
        content_blocks: section.content_blocks,
        source_ids: sourceIds,
        provenance: {
          origin: "authorized_structured_authoring",
          revision_id: context.revision.id,
          body_hash: context.revision.body_hash,
          review_id: reviewId,
        },
      })),
      {
        section_key: "pending-inputs",
        title: l(
          "Pending inputs and final review",
          "المدخلات المعلقة والمراجعة النهائية",
        ),
        volume: "shared",
        kind: "response",
        content_blocks: gaps.map((g) => ({
          type: "placeholder",
          gap_id: g.id,
        })),
        source_ids: [],
        provenance: null,
      },
    ],
    gaps,
    authoring: {
      session_id: context.session.id,
      revision_id: context.revision.id,
      body_hash: context.revision.body_hash,
      review_id: reviewId,
      report,
    },
  });
}
