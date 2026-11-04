import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const deliverySourceSchema = z
  .object({
    entity_kind: z.enum(["notice", "document", "knowledge", "review", "rate"]),
    entity_id: z.uuid(),
    content_hash: hash,
  })
  .strict();
export const deliveryGapSchema = z
  .object({
    id: z.string().min(1).max(200),
    section_key: z.string().min(1).max(200),
    field_path: z.string().min(1).max(500),
    reason: z.enum([
      "RESPONSE_NOT_PREPARED",
      "INSUFFICIENT_INPUT",
      "UNREAD_INPUT",
      "COMPANY_EVIDENCE_REQUIRED",
      "COMMERCIAL_CONFIRMATION_REQUIRED",
      "LEGACY_ASSURANCE_REVIEW_REQUIRED",
      "MODEL_INPUT_REQUIRED",
    ]),
    label: z.string().min(1).max(10000),
    required_for: z.enum(["substantive_completion", "final_approval"]),
    source_ids: z.array(z.uuid()),
  })
  .strict();
export const deliveryBlockSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.enum(["paragraph", "bullet"]), text: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("table"),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    })
    .strict(),
  z
    .object({
      type: z.literal("placeholder"),
      gap_id: z.string().min(1).max(200),
    })
    .strict(),
]);
export const deliverySectionSchema = z
  .object({
    section_key: z.string().min(1),
    title: z.string().min(1),
    volume: z.enum(["technical", "financial", "shared"]),
    kind: z.enum(["source_extract", "response", "accepted_unit"]),
    content_blocks: z.array(deliveryBlockSchema),
    source_ids: z.array(z.uuid()),
    provenance: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export const deliveryPayloadV1Schema = z
  .object({
    version: z.literal(1),
    title: z.string(),
    language: z.enum(["ar", "en"]),
    template: z.record(z.string(), z.unknown()),
    separate_volumes: z.boolean(),
    input_state: z.enum(["available", "partial", "insufficient"]),
    content_state: z.enum(["template", "source_draft", "partial_draft"]),
    assurance_state: z.enum(["unreviewed", "legacy_reviewed"]),
    substantive_complete: z.literal(false),
    approval_state: z.literal("draft"),
    notice: z.string(),
    source_manifest: z.array(deliverySourceSchema),
    input_materials: z.record(z.string(), z.unknown()),
    sections: z.array(deliverySectionSchema).min(1),
    gaps: z.array(deliveryGapSchema),
  })
  .strict();

// New authoring assurance is opt-in. Never reinterpret a saved version-1 draft
// or render its historical bytes with version-2 labels.
export const deliveryPayloadV2Schema = deliveryPayloadV1Schema
  .extend({
    version: z.literal(2),
    content_state: z.enum(["authored_draft", "substantive_draft"]),
    assurance_state: z.enum(["unreviewed", "human_reviewed"]),
    substantive_complete: z.boolean(),
    authoring: z
      .object({
        session_id: z.uuid(),
        revision_id: z.uuid(),
        body_hash: hash,
        review_id: z.uuid().nullable(),
        report: z.record(z.string(), z.unknown()).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.substantive_complete !==
        (value.content_state === "substantive_draft") ||
      (value.substantive_complete &&
        (value.assurance_state !== "human_reviewed" ||
          !value.authoring.review_id ||
          value.gaps.some(
            (gap) => gap.required_for === "substantive_completion",
          )))
    )
      context.addIssue({
        code: "custom",
        message:
          "Substantive delivery requires current review and resolved completion gaps.",
      });
  });
export const generatedReceiptPinSchema = z
  .object({
    step_id: z.uuid(),
    receipt_id: z.uuid(),
    verification_receipt_id: z.uuid(),
    candidate_hash: hash,
  })
  .strict();
export const deliveryPayloadV3Schema = deliveryPayloadV1Schema
  .extend({
    version: z.literal(3),
    content_state: z.literal("generated_review_draft"),
    assurance_state: z.enum(["model_checked", "source_review_required"]),
    generation: z
      .object({
        proposal_version_id: z.uuid(),
        plan_id: z.uuid(),
        version_content_hash: hash,
        plan_input_hash: hash,
        machine_validation: z
          .object({
            version: z.literal(1),
            policy: z.literal("generated-delivery-v1"),
            passed: z.literal(true),
          })
          .passthrough(),
        machine_validation_hash: hash,
        receipt_pins: z.array(generatedReceiptPinSchema).min(1),
      })
      .strict(),
  })
  .strict();
export const deliveryPayloadSchema = z.union([
  deliveryPayloadV1Schema,
  deliveryPayloadV2Schema,
  deliveryPayloadV3Schema,
]);

export type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>;
export type DeliveryGap = z.infer<typeof deliveryGapSchema>;
export type DeliverySection = z.infer<typeof deliverySectionSchema>;
export type DeliverySource = z.infer<typeof deliverySourceSchema>;

export const deliveryPrepareSchema = z
  .object({
    opportunity_id: z.uuid(),
    expected_revision: z.number().int().positive(),
    intake_failure: z
      .enum([
        "EMPTY_FILE",
        "INVALID_FILE",
        "UNSUPPORTED_FORMAT",
        "EXTRACTION_LIMIT",
        "EXTRACTION_FAILED",
      ])
      .optional(),
  })
  .strict();
export const deliveryRefreshSchema = z
  .object({
    proposal_id: z.uuid(),
    expected_revision: z.number().int().positive(),
    expected_delivery_revision: z.number().int().nonnegative(),
  })
  .strict();

export const deliveryRetrySchema = z
  .object({
    snapshot_id: z.uuid(),
    expected_delivery_revision: z.number().int().nonnegative(),
  })
  .strict();
