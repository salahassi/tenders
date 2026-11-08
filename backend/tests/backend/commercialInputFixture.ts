/** Synthetic inputs only; never customer or company claims. */
export function commercialInputContext(): any {
  const source = {
    id: "rfp",
    text: "Provide a commercial delivery plan using the term RACI.",
    kind: "rfp",
    verified: false,
    reference: {
      entity_kind: "document",
      entity_id: "synthetic-rfp",
      content_hash: "a".repeat(64),
    },
  };
  return {
    plan: {
      id: "synthetic-plan",
      stage: "commercial",
      frozen_context: {
        notice: {
          id: "notice",
          text: "Synthetic tender.",
          kind: "notice",
          verified: false,
          reference: {
            entity_kind: "opportunity",
            entity_id: "synthetic-opportunity",
            content_hash: "b".repeat(64),
          },
        },
        blocks: [source],
        knowledge: [],
        reviews: [],
        rates: [],
        template: { id: "synthetic-template", required_sections: [] },
      },
    },
    step: {
      id: "synthetic-step",
      task: "plan_commercial",
      input: { requirement_ids: ["r-1"] },
    },
    requirements: [
      {
        id: "r-1",
        text: "Provide a commercial delivery plan.",
        category: "commercial",
        mandatory: true,
        interpretation: "Proposed delivery.",
        acceptance_evidence: "Review the plan.",
        owner_question: null,
        source_refs: [{ id: "rfp", quote: source.text }],
      },
    ],
    steps: [
      {
        task: "draft_section",
        status: "completed",
        input: {
          section: {
            key: "approach",
            title: "Proposed approach",
            volume: "technical",
            requirement_ids: ["r-1"],
          },
        },
        output: {
          section_key: "approach",
          title: "Proposed approach",
          volume: "technical",
          requirement_ids: ["r-1"],
          content_blocks: [
            { type: "paragraph", text: "Proposed delivery using RACI." },
          ],
          assumptions: [],
          evidence_refs: [{ id: "rfp", quote: source.text }],
          company_claims: [],
          questions: [],
        },
      },
    ],
  };
}
