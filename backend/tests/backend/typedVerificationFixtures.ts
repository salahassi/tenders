import type { ModelTask } from "../../supabase/functions/_shared/model.ts";
const question = {
  question: "Confirm the proposed scope.",
  blocking_level: "advisory",
  requirement_ids: [],
};
const requirement = {
  text: "The buyer requests an optional workshop.",
  category: "deliverables",
  mandatory: false,
  source_refs: [
    { id: "source", quote: "The buyer requests an optional workshop." },
  ],
  interpretation: "Buyer permits the workshop.",
  acceptance_evidence: "Workshop record.",
  owner_question: null,
};
const factor = {
  rating: null,
  reason: "Company proof is not supplied.",
  notice_evidence: [],
  company_evidence: [],
};
const decision = {
  key: "method",
  statement: "Proposed delivery approach.",
  kind: "proposed_decision",
  requirement_ids: [],
  evidence_refs: [],
};
const section = {
  key: "approach",
  title: "Proposed approach",
  purpose: "Explain the proposed scope.",
  volume: "technical",
  mode: "narrative",
};
const analysis = {
  processed_block_ids: ["source"],
  requirements: [requirement],
  questions: [question],
  separate_volumes: false,
  summary: "Optional buyer workshop.",
};
export const typedVerificationFixtures: Record<
  ModelTask,
  { candidate: any; path: (string | number)[]; replacement: unknown }
> = {
  analyze_chunk: {
    candidate: analysis,
    path: ["requirements", 0, "mandatory"],
    replacement: true,
  },
  classify_opportunity: {
    candidate: {
      factors: {
        capability: factor,
        scope: factor,
        sector: factor,
        prerequisite: factor,
      },
      critical_unknown: true,
      reason_summary: "Fit cannot be established from absent proof.",
      missing_information: ["Company evidence"],
      risk_flags: [],
      suggested_tags: [],
    },
    path: ["factors", "capability", "rating"],
    replacement: 0,
  },
  summarize_review: {
    candidate: {
      processed_review_ids: ["review"],
      directives: [
        {
          instruction: "Clarify delivery assumptions.",
          source_refs: [
            { id: "review", quote: "Clarify delivery assumptions." },
          ],
        },
      ],
      questions: [question],
    },
    path: ["questions", 0, "blocking_level"],
    replacement: "finalization",
  },
  plan_structure: {
    candidate: {
      version: 3,
      sections: [{ ...section, requirement_ids: [] }],
      decisions: [decision],
      questions: [question],
    },
    path: ["decisions", 0, "kind"],
    replacement: "buyer_fact",
  },
  plan_blueprint: {
    candidate: {
      version: 2,
      processed_requirement_ids: [],
      sections: [
        {
          ...section,
          units: [
            {
              key: "method",
              title: "Delivery method",
              purpose: "Describe assumptions.",
              requirement_ids: [],
              secondary_links: [],
              target_words: 100,
              decision_ids: ["method"],
            },
          ],
        },
      ],
      decisions: [decision],
      questions: [question],
    },
    path: ["sections", 0, "units", 0, "target_words"],
    replacement: 200,
  },
  plan_proposal: {
    candidate: {
      processed_requirement_ids: [],
      sections: [
        {
          key: "approach",
          title: "Approach",
          purpose: "Describe scope.",
          volume: "technical",
          requirement_ids: [],
        },
      ],
      questions: [question],
    },
    path: ["sections", 0, "volume"],
    replacement: "financial",
  },
  draft_section: {
    candidate: {
      key: "approach",
      title: "Approach",
      content_blocks: [
        {
          type: "table",
          headers: ["Item", "Response"],
          rows: [
            ["Workshop", "Proposed"],
            ["Timing", "Confirmation required"],
          ],
        },
      ],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: ["Timing needs buyer confirmation."],
      questions: [question],
    },
    path: ["questions", 0, "blocking_level"],
    replacement: "finalization",
  },
  plan_commercial: {
    candidate: {
      lines: [
        {
          description: "Optional workshop",
          quantity: null,
          unit: "workshop",
          rate_id: null,
          period_count: null,
          included_in_base: false,
          charge_group: "optional",
          tax_category: "Unconfirmed",
          requirement_ids: [],
          section_ids: [],
          deliverable: "Workshop record",
          basis: "Subject to buyer confirmation.",
        },
      ],
      tasks: [],
      questions: [question],
    },
    path: ["lines", 0, "included_in_base"],
    replacement: true,
  },
  review_proposal: {
    candidate: {
      processed_requirement_ids: [],
      responses: [],
      findings: [
        {
          severity: "advisory",
          category: "Assumption",
          detail: "Confirm the proposed timing.",
          section_ids: [],
          requirement_ids: [],
        },
      ],
    },
    path: ["findings", 0, "severity"],
    replacement: "blocking",
  },
  inspect_source_page: {
    candidate: {
      page_kind: "listing",
      reason_quote: "Public tender listing",
      notices: [
        {
          title: "Operations workshop",
          link_id: "L1",
          reference: null,
          buyer: null,
          deadline_raw: null,
          evidence_quote: "Operations workshop notice on the public listing.",
        },
      ],
      follow_link_id: null,
      candidate_link_ids: [],
    },
    path: ["notices", 0, "buyer"],
    replacement: "Synthetic buyer",
  },
  connection_probe: {
    candidate: { status: "ready" },
    path: ["status"],
    replacement: "invalid",
  },
  verify_grounding: {
    candidate: {
      checked_candidate_hash: "a".repeat(64),
      reviewed_all_content: true,
      processed_content_ids: ["content-0"],
      claims: [
        {
          id: "claim",
          claim: "Proposed scope.",
          candidate_quote: "Proposed scope.",
          kind: "assumption",
          status: "supported",
          source_refs: [],
          finding: "Explicitly proposed.",
        },
      ],
      processed_requirement_ids: [],
      requirement_checks: [],
      findings: [],
    },
    path: ["checked_candidate_hash"],
    replacement: "b".repeat(64),
  },
  repair_result: {
    candidate: {
      target_task: "analyze_chunk",
      result: analysis,
      changes: ["Corrected quotation only."],
    },
    path: ["result", "requirements", 0, "mandatory"],
    replacement: true,
  },
};
export function changedFixture(task: ModelTask) {
  const fixture = typedVerificationFixtures[task],
    candidate = structuredClone(fixture.candidate);
  let parent: any = candidate;
  for (const key of fixture.path.slice(0, -1)) parent = parent[key];
  parent[fixture.path.at(-1)!] = fixture.replacement;
  return candidate;
}
