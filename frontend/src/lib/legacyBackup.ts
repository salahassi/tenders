import { z } from "zod";
import type { AppState } from "../types";

const text = z.string().max(2_000_000),
  id = z.string().min(1).max(200);
const date = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");
const count = z.number().int().nonnegative();
const optionalHttpsUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an HTTPS URL without embedded credentials");
const requirement = z.object({
  id,
  text,
  source: text,
  mandatory: z.boolean(),
  status: z.enum(["open", "addressed", "not_applicable"]),
  response: text,
});
const gap = z.object({
  id,
  question: text,
  answer: text,
  required: z.boolean(),
});
const documentRecord = z.object({
  id,
  name: text,
  size: count.max(10 * 1024 * 1024),
  uploadedAt: date,
  text,
  status: z.enum(["ready", "needs_ocr", "needs_processing", "error"]),
  classification: z.enum(["synthetic", "public", "sanitized", "unspecified"]),
  hash: text,
});
const opportunity = z.object({
  id,
  reference: text,
  title: text,
  buyer: text,
  description: text,
  category: text,
  tags: z.array(text).max(100),
  deadline: z
    .string()
    .refine(
      (value) => !value || Number.isFinite(Date.parse(value)),
      "Invalid deadline",
    ),
  score: z.number().min(0).max(100).nullable(),
  coverage: z.number().min(0).max(100),
  status: z.enum([
    "new",
    "shortlisted",
    "deferred",
    "declined",
    "in_progress",
    "submitted",
  ]),
  sourceId: id,
  value: z.number().nonnegative().nullable(),
  saved: z.boolean(),
  createdAt: date,
  documents: z.array(documentRecord).max(10),
  requirements: z.array(requirement).max(3000),
  gaps: z.array(gap).max(3000),
  acquisition: z.enum([
    "not_requested",
    "requested",
    "approved",
    "document_available",
  ]),
  language: z.enum(["en", "ar"]),
  sourceUrl: optionalHttpsUrl,
  deadlineSource: text.optional(),
});
const section = z.object({
  id,
  title: text,
  body: text,
  evidence: z.array(text).max(1000),
});
const reviewAttachments = z.array(documentRecord).max(10).optional();
const reviewAnswer = z.object({
  questionId: id,
  answer: text,
  attachments: reviewAttachments,
});
const sectionChange = z.object({
  sectionId: id,
  sectionTitle: text,
  comment: text,
  attachments: reviewAttachments,
});
const proposal = z.object({
  id,
  opportunityId: id,
  title: text,
  status: z.enum(["draft", "in_review", "approved"]),
  version: z.number().int().min(1),
  sections: z.array(section).max(100),
  lines: z
    .array(
      z.object({
        id,
        description: text,
        quantity: text,
        unit: text,
        rate: text,
        optional: z.boolean(),
        basis: z
          .object({
            rfpRequirementIds: z.array(id).max(3000),
            proposalSectionIds: z.array(id).max(100),
            deliverable: text,
            estimateJustification: text,
            rateSource: text,
          })
          .optional(),
      }),
    )
    .max(1000),
  pricingMode: z.enum(["markup", "margin"]),
  includePricing: z.boolean().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  percentage: text,
  contingency: text,
  tax: text,
  approvalVersion: z.number().int().min(1).nullable(),
  updatedAt: date,
  comments: z
    .array(z.object({ id, body: text, at: date, author: text }))
    .max(3000),
  review: z
    .object({
      baseVersion: z.number().int().min(1),
      sourceSignature: text,
      answers: z.array(reviewAnswer).max(3000),
      instructions: text,
      sectionChanges: z.array(sectionChange).max(200).optional(),
      attachments: reviewAttachments,
      savedAt: date,
      regeneration: z
        .object({
          id,
          requestedAt: date,
          status: z.literal("awaiting_connection"),
          baseVersion: z.number().int().min(1),
          sourceSignature: text,
          answers: z.array(reviewAnswer).max(3000),
          instructions: text,
          sectionChanges: z.array(sectionChange).max(200).optional(),
          attachments: reviewAttachments,
        })
        .optional(),
    })
    .optional(),
});
const source = z.object({
  id,
  name: text,
  type: z.enum(["rss", "json_feed", "link_directory", "manual"]),
  url: optionalHttpsUrl,
  status: z.enum(["proposed", "approved", "paused", "rejected"]),
  health: z.enum(["healthy", "unknown", "unavailable", "blocked"]),
  lastRun: date.nullable(),
  nextRun: date.nullable(),
  count,
  policy: text,
  tags: z.array(text).max(100),
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  opportunities: z.array(opportunity).max(2000),
  proposals: z.array(proposal).max(2000),
  sources: z.array(source).max(100),
  knowledgeDocuments: z
    .array(
      documentRecord.extend({
        category: z.enum([
          "company",
          "team",
          "previous_proposal",
          "template",
          "other",
        ]),
        enabled: z.boolean(),
      }),
    )
    .max(200)
    .default([]),
  knowledge: z
    .array(
      z.object({
        id,
        category: z.enum([
          "capability",
          "company",
          "exclusion",
          "rate",
          "template",
        ]),
        title: text,
        content: text,
        verified: z.boolean(),
        evidence: text,
      }),
    )
    .max(3000),
  jobs: z
    .array(
      z.object({
        id,
        type: text,
        target: text,
        status: z.enum([
          "queued",
          "running",
          "completed",
          "failed",
          "blocked",
          "cancelled",
        ]),
        progress: z.number().min(0).max(100),
        attempt: count,
        message: text,
        createdAt: date,
      }),
    )
    .max(5000),
  notifications: z
    .array(
      z.object({
        id,
        title: text,
        body: text,
        href: z
          .string()
          .max(500)
          .refine(
            (value) =>
              value.startsWith("/") &&
              !value.startsWith("//") &&
              !value.includes("\\"),
            "Notifications must link to an internal route",
          ),
        read: z.boolean(),
        createdAt: date,
      }),
    )
    .max(5000),
  audit: z
    .array(z.object({ id, action: text, target: text, at: date, actor: text }))
    .max(10000),
  settings: z.object({
    role: z.enum(["Owner", "Editor", "Reviewer"]),
    companyName: text,
    dailyCallLimit: count.max(50),
    inputTokenLimit: count.max(250000),
    outputTokenLimit: count.max(50000),
    pollHours: z.number().min(1).max(168),
    retentionDays: z.number().int().min(1).max(365),
  }),
});

export function validateState(input: unknown): AppState {
  const result = stateSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Backup is invalid: ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message ?? ""}`,
    );
  const state = result.data;
  for (const collection of [
    state.opportunities,
    state.proposals,
    state.sources,
    state.knowledge,
    state.knowledgeDocuments,
    state.jobs,
    state.notifications,
    state.audit,
  ]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length)
      throw new Error("Backup contains duplicate record IDs.");
  }
  for (const item of state.opportunities)
    for (const collection of [item.documents, item.requirements, item.gaps])
      if (
        new Set(collection.map((record) => record.id)).size !==
        collection.length
      )
        throw new Error("Backup contains duplicate evidence IDs.");
  for (const item of state.proposals)
    for (const collection of [item.sections, item.lines, item.comments])
      if (
        new Set(collection.map((record) => record.id)).size !==
        collection.length
      )
        throw new Error("Backup contains duplicate proposal item IDs.");
  const sources = new Set(state.sources.map((item) => item.id));
  const opportunities = new Set(state.opportunities.map((item) => item.id));
  if (state.opportunities.some((item) => !sources.has(item.sourceId)))
    throw new Error("Backup contains an opportunity with a missing source.");
  if (state.proposals.some((item) => !opportunities.has(item.opportunityId)))
    throw new Error("Backup contains a proposal with a missing opportunity.");
  if (
    state.proposals.some(
      (item) =>
        item.status === "approved" && item.approvalVersion !== item.version,
    )
  )
    throw new Error("Backup contains an approval for a different version.");
  return state;
}
export function serializeBackup(state: AppState): string {
  const backup = JSON.stringify(
    {
      format: "tender-desk-demo-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: validateState(state),
    },
    null,
    2,
  );
  if (new TextEncoder().encode(backup).length > 25 * 1024 * 1024)
    throw new Error(
      "The workspace exceeds the 25 MiB JSON backup limit. Download your original files and proposal documents separately; a larger backup cannot be restored in this trial.",
    );
  return backup;
}
export function parseBackup(raw: string): AppState {
  if (new TextEncoder().encode(raw).length > 25 * 1024 * 1024)
    throw new Error("Backup exceeds the 25 MiB import limit.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  const envelope = z
    .object({
      format: z.literal("tender-desk-demo-backup"),
      version: z.literal(1),
      exportedAt: date,
      state: z.unknown(),
    })
    .safeParse(value);
  if (!envelope.success)
    throw new Error("This is not a supported Tender Desk demo backup.");
  return validateState(envelope.data.state);
}
