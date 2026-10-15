import { z } from "zod";
import {
  estimateInputSchema,
  deliveryInputSchema,
  decimalText,
} from "./finance.ts";

export const uuid = z.uuid();
export const invitationTokenSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const invitationCreateSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
    role: z.enum(["Owner", "Editor", "Reviewer"]),
    token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const invitationRevokeSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict();
const text = z.string().max(100000);
const title = z.string().trim().min(1).max(1000);
const revision = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
export const safeUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        (!u.port || u.port === "443") &&
        !/^localhost$|\.localhost$|\.local$|\.internal$|^[\d.]+$|:/i.test(
          u.hostname,
        )
      );
    } catch {
      return false;
    }
  }, "Use a public HTTPS URL without embedded credentials.");
const host = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i);
export const commandSchemas = {
  "rate.save": z
    .object({
      id: uuid.optional(),
      expected_revision: z.number().int().min(0),
      title,
      unit: z.string().min(1).max(100),
      currency: z.string().regex(/^[A-Z]{3}$/),
      unit_cost: decimalText,
      zero_confirmed: z.boolean(),
      valid_from: z.iso.date(),
      valid_until: z.iso.date(),
      source_reference: z.string().min(1).max(3000),
      public_approved: z.boolean(),
    })
    .strict(),
  "rate.approve": z.object({ id: uuid, expected_revision: revision }).strict(),
  "template.save": z
    .object({
      id: uuid.optional(),
      expected_revision: z.number().int().min(0),
      title,
      language: z.enum(["en", "ar"]),
      volume_mode: z.enum(["combined", "separate"]),
      required_sections: z
        .array(
          z
            .object({
              key: z.string().regex(/^[a-z0-9_-]{1,100}$/),
              title,
              purpose: z.string().max(3000),
              volume: z.enum(["technical", "financial", "shared"]),
              applicable: z.boolean(),
              rationale: z.string().max(3000),
            })
            .strict()
            .refine(
              (v) => v.applicable || v.rationale.trim().length >= 10,
              "Explain omitted sections.",
            ),
        )
        .min(1)
        .max(40),
      fixed_blocks: z
        .array(
          z
            .object({
              key: z.string().regex(/^[a-z0-9_-]{1,100}$/),
              title,
              body: z.string().min(1).max(20000),
              volume: z.enum(["technical", "financial", "shared"]),
            })
            .strict(),
        )
        .max(20),
      style_config: z
        .object({
          accent_color: z.string().regex(/^#[0-9a-f]{6}$/i),
          company_name: z.string().max(200),
          footer: z.string().max(500),
        })
        .strict(),
    })
    .strict(),
  "template.approve": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "estimate.prepare": z
    .object({
      proposal_version_id: uuid,
      expected_revision: revision,
      input: estimateInputSchema,
    })
    .strict(),
  "delivery.prepare": z
    .object({
      proposal_version_id: uuid,
      expected_revision: revision,
      input: deliveryInputSchema,
    })
    .strict(),
  "estimate.approve": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "delivery.approve": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "inventory.confirm": z
    .object({ proposal_version_id: uuid, expected_revision: revision })
    .strict(),
  "question.resolve": z
    .object({
      id: uuid,
      expected_revision: revision,
      status: z.enum(["resolved", "not_applicable_with_reason"]),
      answer: text.min(1),
      answer_source: z.string().min(1).max(3000),
      reason: z.string().min(10).max(3000),
    })
    .strict(),
  "compliance.save": z
    .object({
      proposal_version_id: uuid,
      requirement_id: uuid,
      expected_revision: z.number().int().min(0),
      status: z.enum([
        "answered",
        "partial",
        "missing",
        "clarification_required",
        "not_applicable_approved",
      ]),
      section_keys: z.array(z.string().min(1).max(200)).max(100),
      evidence_refs: z
        .array(
          z.object({ id: uuid, quote: z.string().min(1).max(3000) }).strict(),
        )
        .max(100),
      rationale: z.string().min(10).max(3000),
    })
    .strict(),
  "review.verdict": z
    .object({
      proposal_version_id: uuid,
      expected_revision: z.number().int().min(0),
      verdict: z.enum(["recommend", "changes_requested"]),
      comment: z.string().min(1).max(3000),
    })
    .strict(),
  "review.resolve": z
    .object({
      id: uuid,
      expected_revision: revision,
      reason: z.string().min(10).max(3000),
    })
    .strict(),
  "proposal.approve": z
    .object({
      proposal_version_id: uuid,
      expected_revision: revision,
      reason: z.string().min(10).max(3000),
    })
    .strict(),
  "opportunity.assess": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "proposal.generate": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "generation.retry": z
    .object({ id: uuid, expected_revision: revision, reason: text.min(1) })
    .strict(),
  "generation.cancel": z
    .object({ id: uuid, expected_revision: revision, reason: text.min(1) })
    .strict(),
  "model.configure": z
    .object({
      expected_revision: z.number().int().min(0),
      enabled: z.boolean(),
      provider: z.enum(["gemini_free", "qwen_free"]),
      model: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
      project_ref: z.string().min(1).max(120),
      free_only: z.literal(true),
      billing_verified: z.boolean(),
      free_quota_only: z.boolean(),
      quota_ends_at: z.iso.datetime({ offset: true }),
      quota_remaining_tokens: z.number().int().positive().max(1e12),
      calls_per_day: z.number().int().min(1).max(50),
      input_per_day: z.number().int().min(1000).max(250000),
      output_per_day: z.number().int().min(1000).max(50000),
    })
    .strict(),
  "content.authorize": z
    .object({
      entity_kind: z.enum([
        "document",
        "knowledge",
        "notice",
        "review",
        "rate",
      ]),
      entity_id: uuid,
      content_hash: hash,
      provider: z.enum(["gemini_free", "qwen_free"]),
      attestation: z.literal("nonconfidential_nonpersonal"),
    })
    .strict(),
  "content.revoke": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "usage.resolve": z
    .object({
      id: uuid,
      expected_revision: revision,
      actual_input: z.number().int().min(0).max(1e12),
      actual_output: z.number().int().min(0).max(1e12),
      thinking_tokens: z.number().int().min(0).max(1e12).nullable(),
      reason: z.string().trim().min(10).max(3000),
    })
    .strict(),
  "source.create": z
    .object({
      client_id: uuid.optional(),
      name: z.string().trim().min(1).max(200),
      kind: z.enum(["rss", "json_feed", "link_directory", "manual"]),
      url: safeUrl.optional(),
      approved_hosts: z.array(host).max(10).default([]),
      policy_note: text.default(""),
      tags: z.array(z.string().max(200)).max(100).default([]),
      poll_interval_hours: z.number().int().min(1).max(168).default(6),
    })
    .strict()
    .refine(
      (v) => v.kind === "manual" || !!v.url,
      "A collection source needs its URL.",
    ),
  "source.configure": z
    .object({
      id: uuid,
      expected_revision: revision,
      url: safeUrl,
      kind: z.enum(["rss", "json_feed", "link_directory"]),
      approved_hosts: z.array(host).min(1).max(10),
      policy_note: text.min(1),
      poll_interval_hours: z.number().int().min(1).max(168),
      adapter_config: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  "source.collect": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "import.preview": z
    .object({
      kind: z.enum(["sources", "tenders"]),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    })
    .strict(),
  "import.commit": z
    .object({ id: uuid, expected_revision: revision, preview_hash: hash })
    .strict(),
  "source.action": z
    .object({
      id: uuid,
      action: z.enum(["approve", "pause", "reject"]),
      reason: text.min(1),
      expected_revision: revision,
    })
    .strict(),
  "opportunity.create": z
    .object({
      client_id: uuid.optional(),
      source_id: uuid,
      title,
      description: text.default(""),
      buyer: z.string().max(1000).default(""),
      reference: z.string().max(1000).default(""),
      canonical_url: safeUrl.optional(),
      language: z.enum(["en", "ar"]).default("en"),
      deadline_raw: z.string().max(1000).optional(),
      deadline_at: z.iso.datetime({ offset: true }).optional(),
      deadline_timezone: z.string().max(100).optional(),
      category: z.string().max(200).default(""),
      tags: z.array(z.string().max(200)).max(100).default([]),
      decision: z
        .enum(["undecided", "shortlisted", "deferred", "declined"])
        .default("undecided"),
    })
    .strict()
    .refine(
      (v) => !!v.canonical_url || !!v.reference,
      "Supply the source URL or reference.",
    ),
  "opportunity.decision": z
    .object({
      id: uuid,
      target_state: z.enum([
        "undecided",
        "shortlisted",
        "deferred",
        "declined",
      ]),
      reason: text.min(1),
      expected_revision: revision,
    })
    .strict(),
  "knowledge.save": z
    .object({
      client_id: uuid.optional(),
      id: uuid.optional(),
      category: z.enum([
        "capability",
        "company",
        "exclusion",
        "rate",
        "template",
        "team",
        "previous_proposal",
        "other",
      ]),
      title,
      content: text.default(""),
      enabled: z.boolean().default(true),
      evidence: text.default(""),
      expected_revision: revision.optional(),
    })
    .strict()
    .refine(
      (v) => !v.id || !!v.expected_revision,
      "Updating knowledge requires its revision.",
    ),
  "knowledge.verify": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "review.save": z
    .object({
      id: uuid,
      base_version_id: uuid,
      source_signature: z.string().min(1).max(1000),
      expected_revision: revision,
      inputs: z
        .array(
          z
            .object({
              id: uuid.optional(),
              client_id: uuid.optional(),
              target_kind: z.enum(["section", "question", "general"]),
              target_id: z.string().min(1).max(200),
              body: text.default(""),
              expected_revision: revision.optional(),
            })
            .strict()
            .refine(
              (v) => !v.id || !!v.expected_revision,
              "Updating a review input requires its revision.",
            ),
        )
        .max(200),
    })
    .strict(),
  "proposal.regenerate": z
    .object({
      id: uuid,
      base_version_id: uuid,
      expected_revision: revision,
      input_hash: hash,
    })
    .strict(),
  "document.prepare": z
    .object({
      client_id: uuid.optional(),
      kind: z.enum(["rfp", "company", "review"]),
      opportunity_id: uuid.optional(),
      knowledge_item_id: uuid.optional(),
      review_input_id: uuid.optional(),
      original_name: z.string().min(1).max(1000),
      eligibility_attested: z.literal(true),
      mime_type: z.enum(Object.values(MIME_TYPES)),
      size: z.number().int().positive().max(10485760),
      hash,
    })
    .strict()
    .superRefine((v, ctx) => {
      const ext = v.original_name
        .split(".")
        .pop()
        ?.toLowerCase() as keyof typeof MIME_TYPES;
      if (!ext || MIME_TYPES[ext] !== v.mime_type)
        ctx.addIssue({
          code: "custom",
          message: "File extension and MIME type do not match.",
        });
      if (
        (v.kind === "rfp" &&
          (!v.opportunity_id || v.knowledge_item_id || v.review_input_id)) ||
        (v.kind === "company" &&
          (!v.knowledge_item_id || v.opportunity_id || v.review_input_id)) ||
        (v.kind === "review" &&
          (!v.review_input_id || v.opportunity_id || v.knowledge_item_id))
      )
        ctx.addIssue({
          code: "custom",
          message: "Supply exactly the file's target record.",
        });
    }),
  "document.confirm": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "document.archive": z
    .object({ id: uuid, expected_revision: revision, reason: text.min(1) })
    .strict(),
  "document.precedence": z
    .object({
      id: uuid,
      expected_revision: revision,
      precedence: z.number().int().min(0).max(1000),
      supersedes_id: uuid.nullable(),
    })
    .strict(),
  "document.extraction": z
    .object({
      id: uuid,
      parts: z
        .array(
          z
            .object({
              ordinal: z.number().int().min(0).max(127),
              text: z.string().min(1).max(12000),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  "knowledge.document": z
    .object({
      id: uuid,
      expected_revision: revision,
      enabled: z.boolean(),
      category: z.enum([
        "company",
        "team",
        "previous_proposal",
        "template",
        "other",
      ]),
    })
    .strict(),
  "notification.read": z
    .object({ id: uuid, expected_revision: revision })
    .strict(),
  "membership.set": z
    .object({
      user_id: uuid,
      role: z.enum(["Owner", "Editor", "Reviewer"]),
      active: z.boolean(),
      reason: text.min(1),
      expected_revision: revision,
    })
    .strict(),
  "workspace.settings": z
    .object({
      expected_revision: revision,
      name: z.string().trim().min(1).max(120),
      daily_call_limit: z.number().int().min(1).max(50),
      input_token_limit: z.number().int().min(1000).max(250000),
      output_token_limit: z.number().int().min(1000).max(50000),
      poll_hours: z.number().int().min(6).max(168),
      retention_days: z.number().int().min(7).max(365),
    })
    .strict(),
  "opportunity.update": z
    .object({
      id: uuid,
      expected_revision: revision,
      title,
      description: text,
      buyer: z.string().max(1000),
      reference: z.string().max(1000),
      canonical_url: safeUrl.optional(),
      language: z.enum(["en", "ar"]),
      category: z.string().max(200),
      tags: z.array(z.string().max(200)).max(100),
      saved: z.boolean(),
      deadline_raw: z.string().max(1000).optional(),
      deadline_at: z.iso.datetime({ offset: true }).optional(),
      deadline_timezone: z.string().max(100).optional(),
    })
    .strict(),
  "job.action": z
    .object({
      id: uuid,
      expected_revision: revision,
      action: z.enum(["cancel", "retry"]),
      reason: text.min(1),
    })
    .strict(),
} as const;
export type CommandName = keyof typeof commandSchemas;
export const completeUploadSchema = z
  .object({
    extracted_text: z.string().max(200000).default(""),
    from_parts: z.boolean().optional(),
    status: z
      .enum(["ready", "needs_ocr", "needs_processing", "error"])
      .default("needs_processing"),
  })
  .strict()
  .refine(
    (v) => v.status !== "ready" || v.from_parts || !!v.extracted_text.trim(),
    "Readable extraction text is required for ready status.",
  );
export const applicationLimits = {
  maxRequestBytes: 1048576,
  maxFileBytes: 10485760,
  maxFilesPerInput: 10,
  maxOriginalBytes: 262144000,
  maxDatabaseBytes: 262144000,
  maxPendingJobs: 500,
} as const;
