import { z } from "zod";

const key = z.string().regex(/^[a-z0-9_-]{1,100}$/);
const ids = z.array(z.string().min(1).max(200)).max(2000);
const text = z.string().min(1).max(3000);
const reference = z
  .object({ id: z.string().min(1).max(200), quote: text })
  .strict();

/** Planning output describes ownership and shared decisions, never approval. */
export const proposalBlueprintSchema = z
  .object({
    version: z.literal(2),
    processed_requirement_ids: ids,
    sections: z
      .array(
        z
          .object({
            key,
            title: z.string().min(1).max(1000),
            purpose: text,
            volume: z.enum(["technical", "financial", "shared"]),
            mode: z.enum([
              "narrative",
              "executive_summary",
              "compliance_matrix",
            ]),
            units: z
              .array(
                z
                  .object({
                    key,
                    title: z.string().min(1).max(1000),
                    purpose: text,
                    requirement_ids: ids.max(128),
                    // Additional locations must have an explicit reason (for example an RFP
                    // form). They link to the primary answer, rather than claiming ownership.
                    secondary_links: z
                      .array(
                        z
                          .object({
                            requirement_id: z.string().min(1).max(200),
                            reason: text,
                          })
                          .strict(),
                      )
                      .max(128),
                    target_words: z.number().int().min(100).max(2500),
                    decision_ids: z.array(key).max(64),
                  })
                  .strict(),
              )
              .max(24),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    decisions: z
      .array(
        z
          .object({
            key,
            statement: text,
            kind: z.enum([
              "buyer_fact",
              "company_fact",
              "proposed_decision",
              "unresolved_input",
            ]),
            requirement_ids: ids.max(128),
            evidence_refs: z.array(reference).max(8),
          })
          .strict(),
      )
      .max(64),
    questions: z
      .array(
        z
          .object({
            question: text,
            blocking_level: z.enum(["generation", "finalization", "advisory"]),
            requirement_ids: ids.max(128),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type ProposalBlueprint = z.infer<typeof proposalBlueprintSchema>;

/** A compact global map. Requirements have a single owner, and shared decisions
 * are emitted once. Detail jobs cannot rewrite this accepted contract. */
export const proposalStructureSchema = z
  .object({
    version: z.literal(3),
    sections: z
      .array(
        z
          .object({
            key,
            title: z.string().min(1).max(200),
            purpose: z.string().min(1).max(600),
            volume: z.enum(["technical", "financial", "shared"]),
            mode: z.enum([
              "narrative",
              "executive_summary",
              "compliance_matrix",
            ]),
            requirement_ids: ids,
          })
          .strict(),
      )
      .min(1)
      .max(64),
    decisions: proposalBlueprintSchema.shape.decisions,
    questions: proposalBlueprintSchema.shape.questions,
  })
  .strict();
export type ProposalStructure = z.infer<typeof proposalStructureSchema>;
