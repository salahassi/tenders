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
export const deliveryPayloadSchema = z
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
