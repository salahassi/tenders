/** Synthetic complete legacy draft: no extracted requirement inventory. */
export function legacyWholeReviewContext(): any {
  const source = {
    id: "synthetic-reference",
    text: "Describe the proposed workflow, handover and unresolved tax inputs.",
    kind: "rfp", verified: false,
    reference: { entity_kind: "document", entity_id: "synthetic-document", content_hash: "a".repeat(64) },
  };
  const sections = [
    { key: "approach", title: "Proposed approach", volume: "technical", requirement_ids: [] },
    { key: "handover", title: "Handover", volume: "technical", requirement_ids: [] },
  ];
  return {
    plan: {
      id: "synthetic-plan", kind: "proposal", workflow_version: 1, stage: "commercial", status: "running",
      frozen_context: {
        title: "Synthetic workflow draft", language: "en", draft_input_version: 1,
        notice: { id: "synthetic-notice", text: "Synthetic opportunity.", kind: "notice", verified: false,
          reference: { entity_kind: "opportunity", entity_id: "synthetic-opportunity", content_hash: "b".repeat(64) } },
        blocks: [source], knowledge: [], reviews: [], rates: [],
        input_materials: { version: 1, documents: [] },
        template: { id: "synthetic-template", required_sections: [], fixed_blocks: [
          { key: "scope-note", title: "Scope note", volume: "shared", body: "Unresolved commitments need authorized confirmation." },
        ] },
      },
    },
    step: { id: "synthetic-review", task: "review_proposal", input: { requirement_ids: [] } },
    requirements: [],
    steps: [
      { id: "synthetic-planning", task: "plan_proposal", status: "completed", ordinal: 1,
        input: { requirement_ids: [] }, output: { sections } },
      ...sections.map((section, index) => ({
        id: "synthetic-draft-" + section.key, task: "draft_section", stage: "drafting", status: "completed", ordinal: index + 2,
        input: { section, requirement_ids: [], rfp_context_version: 1 },
        output: { section_key: section.key, title: section.title, volume: section.volume, requirement_ids: [],
          content_blocks: [{ type: "paragraph", text: index === 0 ? "We propose a staged workflow with explicit approval gates." : "We propose a tested handover and a buyer witness session." }],
          assumptions: [], company_claims: [], questions: [], evidence_refs: [{ id: source.id, quote: source.text }] },
      })),
      { id: "synthetic-commercial", task: "plan_commercial", stage: "commercial", status: "completed", ordinal: 4,
        input: { requirement_ids: [] }, output: {
          lines: [{ key: "delivery", description: "Proposed workflow delivery", section_ids: ["approach"], requirement_ids: [], quantity: null, unit: "service", rate_id: null, period_count: null, tax_category: "", charge_group: "one_time", basis: "Proposed work pending confirmation." }],
          tasks: [{ key: "handover-task", title: "Proposed handover", requirement_ids: [], predecessors: [], effort_days: null, allocation: null, duration_days: null, basis: "Subject to resource confirmation." }],
          questions: [{ question: "Confirm the approved tax category and applicable rate.", requirement_ids: [], blocking_level: "finalization" }],
        } },
    ],
  };
}

export function legacyWholeReviewInput(): any {
  return { requirement_ids: [], legacy_zero_inventory_review_version: 1,
    review_scope_version: 1, review_source_version: 1, coherence_review: true,
    section_keys: ["approach", "handover", "fixed-scope-note"] };
}
