import { AppError } from "./http.ts";
import { z } from "zod";
import {
  assessProposalConsistency,
  type ConsistencyInput,
} from "./proposalConsistency.ts";
const text = z.string().trim().min(1).max(12000);
const id = z.string().min(1).max(200);
const fact = z
  .object({
    key: id,
    kind: z.enum(["quantity", "money", "date", "decision"]),
    value: text.nullable(),
    unit: id.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    quote: text,
    decision_id: id.optional(),
  })
  .strict();
export const proposalConsistencyReviewSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    binding_hash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(30).max(3000),
    reviewed_requirement_ids: z.array(z.uuid()).min(1).max(2000),
    confirmed_decision_ids: z.array(id).max(2000),
    section_facts: z
      .array(
        z.object({ section_key: id, facts: z.array(fact).max(100) }).strict(),
      )
      .max(2000)
      .default([]),
    fulfillment: z
      .array(
        z
          .object({
            requirement_id: z.uuid(),
            response_section_key: id,
            response_excerpt: text,
            method: text,
            deliverable: text,
            acceptance_evidence: text,
            qualifier_equivalences: z
              .array(
                z
                  .object({
                    kind: z.enum(["conditions", "exceptions", "consequences"]),
                    source_index: z.number().int().min(0).max(31),
                    source_quote: text,
                    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
                    response_quote: text,
                  })
                  .strict(),
              )
              .max(96)
              .optional(),
            conditions_preserved: z.array(text).max(32),
            exceptions_preserved: z.array(text).max(32),
            consequences_preserved: z.array(text).max(32),
            facts: z.array(fact).max(100),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

/** Actor and all source/section/decision content come from authenticated server
 * context. The caller supplies its scoped review, never a trusted pass flag. */
export async function reviewProposalConsistency(
  context: any,
  input: z.infer<typeof proposalConsistencyReviewSchema>,
  actorId: string,
) {
  if (context.binding_hash !== input.binding_hash)
    throw new AppError(
      409,
      "STALE_INPUT",
      "The proposal or its evidence changed. Reload the review.",
    );
  const requirements = context.input
    .requirements as ConsistencyInput["requirements"];
  if (
    new Set(input.reviewed_requirement_ids).size !==
      input.reviewed_requirement_ids.length ||
    input.reviewed_requirement_ids.some(
      (id) => !requirements.some((r) => r.id === id),
    ) ||
    new Set(input.confirmed_decision_ids).size !==
      input.confirmed_decision_ids.length ||
    input.confirmed_decision_ids.some(
      (id) => !context.shared_decisions.some((d: any) => d.id === id),
    )
  )
    throw new AppError(
      422,
      "INVALID_REVIEW_SCOPE",
      "Review only the requirements and decisions in this version.",
    );
  const review = {
    review_id: crypto.randomUUID(),
    actor_id: actorId,
    requirement_ids: input.reviewed_requirement_ids,
    confirmed: true,
  };
  const estimate = context.financial_truth;
  const financial =
    estimate?.calculated && estimate.currency
      ? {
          currency: estimate.currency,
          values: [
            ...["gross_total", "net_price", "tax", "direct_cost"].map(
              (key) => ({
                key: `estimate.${key}`,
                value: String(estimate.calculated[key]),
              }),
            ),
            ...(estimate.calculated.lines || []).flatMap((line: any) =>
              ["gross_total", "net_price", "tax", "direct_cost"].map((key) => ({
                key: `estimate.line:${line.id}.${key}`,
                value: String(line[key]),
              })),
            ),
          ],
        }
      : null;
  const report = await assessProposalConsistency({
    ...context.input,
    fulfillment: input.fulfillment,
    section_facts: input.section_facts,
    financial_truth: financial,
    confirmed_shared_decisions: context.shared_decisions.filter((d: any) =>
      input.confirmed_decision_ids.includes(d.id),
    ),
    human_review: review,
  });
  return { report, review };
}
