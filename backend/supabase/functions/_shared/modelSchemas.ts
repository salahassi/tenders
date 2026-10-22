import { z } from "zod";
import { sourcePageSchema } from "./sourceModel.ts";
import {
  proposalBlueprintSchema,
  proposalStructureSchema,
} from "./proposalBlueprintSchema.ts";

const short = z.string().max(3000),
  id = z.string().min(1).max(200),
  ids = z.array(id).max(128),
  quote = z.object({ id, quote: z.string().min(1).max(3000) }).strict();
const factor = z
  .object({
    rating: z.number().int().min(0).max(4).nullable(),
    reason: short,
    notice_evidence: z.array(quote).max(8),
    company_evidence: z.array(quote).max(8),
  })
  .strict();
const question = z
  .object({
    question: short.min(1),
    blocking_level: z.enum(["generation", "finalization", "advisory"]),
    requirement_ids: ids,
  })
  .strict();
export const blockSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("paragraph"), text: z.string().max(20000) })
    .strict(),
  z.object({ type: z.literal("bullet"), text: z.string().max(10000) }).strict(),
  z
    .object({
      type: z.literal("table"),
      headers: z.array(z.string().max(500)).min(1).max(10),
      rows: z.array(z.array(z.string().max(2000)).max(10)).max(50),
    })
    .strict(),
]);
export const primaryModelSchemas = {
  plan_structure: proposalStructureSchema,
  plan_blueprint: proposalBlueprintSchema,
  inspect_source_page: sourcePageSchema,
  connection_probe: z.object({ status: z.literal("ready") }).strict(),
  summarize_review: z
    .object({
      processed_review_ids: ids,
      directives: z
        .array(
          z
            .object({
              instruction: short.min(1),
              source_refs: z.array(quote).min(1).max(8),
            })
            .strict(),
        )
        .max(30),
      questions: z.array(question).max(30),
    })
    .strict(),
  classify_opportunity: z
    .object({
      factors: z
        .object({
          capability: factor,
          scope: factor,
          sector: factor,
          prerequisite: factor,
        })
        .strict(),
      scope_decision: z
        .object({
          status: z.enum(["in_scope", "out_of_scope", "uncertain"]),
          reason: short.min(1),
          notice_evidence: z.array(quote).min(1).max(8),
          company_evidence: z.array(quote).max(8).optional(),
          keyword_evidence: z
            .array(
              z
                .object({
                  kind: z.enum(["include", "exclude"]),
                  keyword: z.string().min(1).max(100),
                })
                .strict(),
            )
            .max(24)
            .optional(),
        })
        .strict()
        .optional(),
      critical_unknown: z.boolean(),
      reason_summary: short,
      missing_information: z.array(short).max(20),
      risk_flags: z.array(short).max(20),
      suggested_tags: z.array(z.string().max(200)).max(20),
    })
    .strict(),
  analyze_chunk: z
    .object({
      processed_block_ids: ids,
      requirements: z
        .array(
          z
            .object({
              text: short.min(1),
              category: z.enum([
                "scope",
                "functional",
                "technical",
                "security",
                "integration",
                "data",
                "operations",
                "deliverables",
                "timeline",
                "team",
                "eligibility",
                "commercial",
                "contractual",
                "submission",
              ]),
              mandatory: z.boolean(),
              source_refs: z.array(quote).min(1).max(8),
              interpretation: short,
              acceptance_evidence: short,
              owner_question: short.nullable(),
            })
            .strict(),
        )
        .max(100),
      questions: z.array(question).max(30),
      separate_volumes: z.boolean(),
      summary: short,
    })
    .strict(),
  plan_proposal: z
    .object({
      processed_requirement_ids: ids,
      sections: z
        .array(
          z
            .object({
              key: z.string().regex(/^[a-z0-9_-]{1,100}$/),
              title: z.string().min(1).max(1000),
              purpose: short,
              volume: z.enum(["technical", "financial", "shared"]),
              requirement_ids: ids,
            })
            .strict(),
        )
        .min(1)
        .max(30),
      questions: z.array(question).max(30),
    })
    .strict(),
  draft_section: z
    .object({
      key: id,
      title: z.string().min(1).max(1000),
      content_blocks: z.array(blockSchema).min(1).max(100),
      requirement_ids: ids,
      evidence_refs: z.array(quote).max(100),
      company_claims: z
        .array(
          z
            .object({ claim: short, source_id: id, quote: short.min(1) })
            .strict(),
        )
        .max(50),
      assumptions: z.array(short).max(50),
      questions: z.array(question).max(50),
    })
    .strict(),
  plan_commercial: z
    .object({
      lines: z
        .array(
          z
            .object({
              description: short,
              quantity: z
                .string()
                .regex(/^\d{1,9}(\.\d{1,6})?$/)
                .nullable(),
              unit: z.string().max(100),
              rate_id: id.nullable(),
              period_count: z
                .string()
                .regex(/^\d{1,6}(\.\d{1,6})?$/)
                .nullable(),
              included_in_base: z.boolean(),
              charge_group: z.enum(["one_time", "recurring", "optional"]),
              tax_category: z.string().max(100),
              requirement_ids: ids,
              section_ids: ids,
              deliverable: short,
              basis: short,
            })
            .strict(),
        )
        .max(100),
      tasks: z
        .array(
          z
            .object({
              key: id,
              title: short,
              predecessors: ids,
              role: short,
              effort_days: z.string().nullable(),
              allocation: z.string().nullable(),
              duration_days: z.string().nullable(),
              basis: short,
            })
            .strict(),
        )
        .max(100),
      questions: z.array(question).max(50),
    })
    .strict(),
  review_proposal: z
    .object({
      processed_requirement_ids: ids,
      responses: z
        .array(
          z
            .object({
              requirement_id: id,
              status: z.enum([
                "answered",
                "partial",
                "missing",
                "clarification_required",
                "not_applicable_approved",
              ]),
              section_ids: ids,
              evidence_refs: z.array(quote).max(20),
              rationale: short,
            })
            .strict(),
        )
        .max(50),
      findings: z
        .array(
          z
            .object({
              severity: z.enum(["blocking", "advisory"]),
              category: short,
              detail: short,
              section_ids: ids,
              requirement_ids: ids,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
} as const;
export type PrimaryModelTask = keyof typeof primaryModelSchemas;
export const primaryModelTasks = Object.keys(primaryModelSchemas) as [
  PrimaryModelTask,
  ...PrimaryModelTask[],
];
export function repairOutputSchema(task: PrimaryModelTask) {
  return z
    .object({
      target_task: z.literal(task),
      result: primaryModelSchemas[task],
      changes: z.array(short).max(30),
    })
    .strict();
}
export const modelSchemas = {
  ...primaryModelSchemas,
  verify_grounding: z
    .object({
      checked_candidate_hash: z.string().regex(/^[a-f0-9]{64}$/),
      reviewed_all_content: z.literal(true),
      processed_content_ids: z.array(id).max(2048),
      claims: z
        .array(
          z
            .object({
              id,
              claim: short.min(1),
              candidate_quote: short.min(1),
              kind: z.enum([
                "company_fact",
                "tender_fact",
                "proposed_solution",
                "assumption",
                "commercial_commitment",
              ]),
              status: z.enum(["supported", "contradicted", "insufficient"]),
              source_refs: z.array(quote).max(20),
              finding: short,
            })
            .strict(),
        )
        .max(128),
      processed_requirement_ids: ids,
      requirement_checks: z
        .array(
          z
            .object({
              requirement_id: id,
              status: z.enum(["supported", "contradicted", "insufficient"]),
              candidate_quote: short,
              source_refs: z.array(quote).max(20),
              finding: short,
            })
            .strict(),
        )
        .max(128),
      findings: z
        .array(
          z
            .object({
              severity: z.enum(["blocking", "advisory"]),
              code: z.string().regex(/^[A-Z_]{1,80}$/),
              detail: short,
              claim_ids: ids,
              requirement_ids: ids,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  repair_result: z.union(
    primaryModelTasks.map(repairOutputSchema) as [
      ReturnType<typeof repairOutputSchema>,
      ReturnType<typeof repairOutputSchema>,
      ...ReturnType<typeof repairOutputSchema>[],
    ],
  ),
} as const;
// Stored aggregate reports combine independently validated provider responses.
// Keep per-request response bounds unchanged while validating the full merged
// report with the same field schemas and a bounded document-sized collection.
export const aggregateVerificationSchema = modelSchemas.verify_grounding.extend(
  {
    claims: z
      .array(modelSchemas.verify_grounding.shape.claims.element)
      .max(2048),
    findings: z
      .array(modelSchemas.verify_grounding.shape.findings.element)
      .max(2048),
  },
);
export type ModelTask = keyof typeof modelSchemas;
