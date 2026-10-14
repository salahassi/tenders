import { z } from "zod";

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
      kind: z.enum(["rfp", "company", "review"]),
      opportunity_id: uuid.optional(),
      knowledge_item_id: uuid.optional(),
      review_input_id: uuid.optional(),
      original_name: z.string().min(1).max(1000),
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
    status: z
      .enum(["ready", "needs_ocr", "needs_processing", "error"])
      .default("needs_processing"),
  })
  .strict()
  .refine(
    (v) => v.status !== "ready" || !!v.extracted_text.trim(),
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
