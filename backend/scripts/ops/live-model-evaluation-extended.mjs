/** Additional synthetic fixtures: no persistence, credentials or provider calls. */
import { ModelError } from "../../supabase/functions/_shared/model.ts";
import {
  validateBlueprint,
  validateReviewSectionReferences,
} from "../../supabase/functions/_shared/proposalBlueprint.ts";
import { validateStructure } from "../../supabase/functions/_shared/proposalPlanning.ts";

const check = (ok, code) => {
  if (!ok) throw new ModelError(code);
};
const hasQuantity = (text, n) => {
  const normalized = text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
  return (
    new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(normalized) ||
    (n === 30 ? /\bthirty\b|ثلاثين|ثلاثون/i : /\bninety\b|تسعين|تسعون/i).test(
      normalized,
    )
  );
};
const buyer = [
  {
    id: "eval-rfp-delivery",
    kind: "rfp",
    verified: false,
    text: "The supplier shall deliver the portal within 30 days.",
  },
  {
    id: "eval-rfp-audit",
    kind: "rfp",
    verified: false,
    text: "The portal must retain an audit log for 90 days.",
  },
];
const requirements = buyer.map((e, i) => ({
  id: i ? "req_b" : "req_a",
  text: e.text,
  mandatory: true,
  source_refs: [{ id: e.id, quote: e.text }],
}));
const requirementIds = requirements.map((r) => r.id);
const checkDecisionRoles = (r) => {
  check(
    r.decisions.every((d) => d.kind !== "company_fact"),
    "EVAL_INVENTED_COMPANY_DECISION",
  );
  check(
    r.decisions.every(
      (d) =>
        d.kind !== "buyer_fact" ||
        d.evidence_refs.every((e) => buyer.some((b) => b.id === e.id)),
    ),
    "EVAL_BUYER_DECISION_SOURCE_INVALID",
  );
};

export function extendedFixtures() {
  const commercialEvidence = [
    {
      id: "eval-workshops",
      kind: "rfp",
      verified: false,
      text: "Provide exactly 2 training workshops, priced as separate one-time workshop units.",
    },
    {
      id: "eval-support",
      kind: "rfp",
      verified: false,
      text: "Provide ongoing portal support. The support quantity and period are not specified.",
    },
    {
      id: "eval-approved-workshop-rate",
      kind: "rate",
      verified: true,
      text: "Approved training workshop rate: 100 per workshop. Rate ID: eval-approved-workshop-rate. This rate applies only to workshops, not portal support.",
    },
  ];
  const commercialRequirements = commercialEvidence
    .slice(0, 2)
    .map((e, i) => ({
      id: i ? "req_support" : "req_workshops",
      text: e.text,
      source_refs: [{ id: e.id, quote: e.text }],
    }));
  const reviewContext = {
    requirements,
    sections: [
      {
        key: "delivery",
        title: "Delivery",
        volume: "technical",
        content_blocks: [
          {
            type: "paragraph",
            text: "We propose delivering the portal within 30 days.",
          },
        ],
        assumptions: [],
      },
    ],
    response_locations: [],
    instruction:
      "Review the supplied draft prose against both requirements. A plan or requirement citation is not evidence of a completed response. No other sections or approvals exist.",
  };
  const reviewEvidence = [
    {
      id: "eval-review-1",
      kind: "review",
      verified: false,
      text: "Keep the delivery commitment at 30 days; do not shorten it.",
    },
    {
      id: "eval-review-2",
      kind: "review",
      verified: false,
      text: "Add the missing audit-log retention response and retain the buyer's 90-day duration.",
    },
  ];
  const page =
    "Open procurement notices. Buyer: Example City Authority. Reference: EVAL-2026-01. Public portal implementation. Submission deadline: 2026-12-15. View the notice for bidding documents. About this authority contains general information only.";
  // Eight short obligations amid longer bilingual background fit the 4096 output
  // ceiling while exercising evidence selection across a materially longer input.
  const longBlocks = Array.from({ length: 8 }, (_, i) => {
    const event = `EV${String(i + 1).padStart(2, "0")}`;
    const obligation =
      i % 2
        ? `يجب على البوابة تسجيل حدث التدقيق ${event}.`
        : `The portal must record audit event ${event}.`;
    const background =
      i % 2
        ? "ملاحظة سياقية غير ملزمة: يصف هذا الملحق تاريخ تنظيم السجلات في الأقسام السابقة ولا يضيف أي متطلبات تنفيذ أو مدة احتفاظ. "
        : "Non-binding background: this appendix describes the historical arrangement of earlier records and adds no delivery obligation or retention period. ";
    return {
      id: `eval-long-${i + 1}`,
      kind: "rfp",
      verified: false,
      text: obligation + " " + background.repeat(8),
      obligation,
      event,
    };
  });
  const blocks = longBlocks.map(({ obligation, event, ...e }) => e);
  const company = {
    id: "eval-company",
    kind: "company",
    verified: true,
    text: "Example Company holds ISO 27001 certification. This is a company fact, not a buyer requirement.",
  };
  const style = {
    id: "eval-style",
    kind: "style",
    verified: false,
    text: "Old illustrative template: deliver every project in 7 days. This template supplies style only and is not a buyer requirement.",
  };
  return [
    {
      id: "proposal_plan_coverage",
      task: "plan_proposal",
      language: "en",
      evidence: buyer,
      required: requirementIds,
      context: {
        requirements,
        company_knowledge: [],
        instruction:
          "Plan substantive sections covering both supplied requirements. No company credentials or buyer-mandated template were supplied.",
      },
      assertion_scope: "canonical_contract_and_requirement_section_coverage",
      assert: (r) =>
        check(
          requirementIds.every((id) =>
            r.sections.some((s) => s.requirement_ids.includes(id)),
          ),
          "EVAL_PLANNING_COVERAGE_MISSING",
        ),
    },
    {
      id: "proposal_structure_ownership",
      task: "plan_structure",
      language: "en",
      evidence: buyer,
      required: [],
      context: {
        requirements,
        blueprint_requirement_ids: requirementIds,
        company_knowledge: [],
        template: { required_sections: [] },
        workflow_version: 2,
        instruction:
          "Create the global proposal structure, not detailed writing units or draft prose. Assign EVERY blueprint_requirement_id to exactly one narrative section. Executive summary and compliance matrix own no requirements. Record concise shared decisions once; distinguish cited buyer facts, cited verified company facts, proposed decisions and unresolved inputs. Use short exact evidence quotes. No company facts were supplied.",
      },
      assertion_scope:
        "canonical_contract_and_production_structure_ownership_and_decision_roles",
      assert: (r) => {
        validateStructure(r, requirementIds, []);
        checkDecisionRoles(r);
      },
    },
    {
      id: "proposal_blueprint_ownership",
      task: "plan_blueprint",
      language: "ar",
      evidence: buyer,
      required: [],
      context: {
        requirements,
        blueprint_requirement_ids: requirementIds,
        company_knowledge: [],
        template: { required_sections: [] },
        workflow_version: 2,
        writing_output_tokens: 4096,
        instruction:
          "Create a coherent proposal blueprint covering every blueprint_requirement_id and return these exact IDs in processed_requirement_ids. Assign each requirement to exactly ONE narrative unit as its primary answer. Compliance matrix sections have no units. Executive summary units own no requirements. Secondary links require justification. Use concise shared decisions, cited buyer facts, proposed design decisions and unresolved inputs. Each unit references existing decisions. No verified company facts were supplied; do not invent credentials, prices or approvals.",
      },
      assertion_scope:
        "canonical_contract_and_production_blueprint_ownership_and_decision_roles",
      assert: (r) => {
        validateBlueprint(r, requirementIds, []);
        checkDecisionRoles(r);
      },
    },
    {
      id: "commercial_known_and_unknown_rates",
      task: "plan_commercial",
      language: "en",
      evidence: commercialEvidence,
      required: commercialRequirements.map((r) => r.id),
      context: {
        requirements: commercialRequirements,
        section_titles: [
          { key: "delivery", title: "Delivery services", volume: "technical" },
        ],
        instruction:
          "Create two independent commercial lines: workshops and support. Use the supplied approved workshop rate ID and the exact workshop quantity. No approved support rate, support quantity, support period, tax or resource availability was supplied. Missing values remain null (tax_category may be empty) and produce finalization questions. Use section delivery and supplied requirement IDs only. Do not calculate prices or totals or infer availability. An effort graph may propose tasks but must keep unprovided effort, allocation and duration null.",
      },
      assertion_scope:
        "canonical_contract_and_production_reference_scope_and_known_quantity_unknown_rate_fields",
      assert: (r) => {
        check(
          r.lines.every(
            (l) =>
              l.section_ids.every((id) => id === "delivery") &&
              l.requirement_ids.every((id) =>
                commercialRequirements.some((q) => q.id === id),
              ) &&
              (l.rate_id === null ||
                l.rate_id === "eval-approved-workshop-rate"),
          ),
          "EVAL_COMMERCIAL_REFERENCE_INVALID",
        );
        check(
          r.lines.some(
            (l) =>
              l.requirement_ids.includes("req_workshops") &&
              Number(l.quantity) === 2 &&
              l.rate_id === "eval-approved-workshop-rate" &&
              l.charge_group === "one_time",
          ),
          "EVAL_KNOWN_COMMERCIAL_INPUT_LOST",
        );
        const support = r.lines.filter((l) =>
          l.requirement_ids.includes("req_support"),
        );
        check(
          support.length > 0 &&
            support.every(
              (l) =>
                l.rate_id === null &&
                l.quantity === null &&
                l.period_count === null,
            ),
          "EVAL_UNKNOWN_COMMERCIAL_INPUT_INVENTED",
        );
        check(
          r.tasks.every(
            (t) =>
              t.effort_days === null &&
              t.allocation === null &&
              t.duration_days === null,
          ),
          "EVAL_RESOURCE_AVAILABILITY_INVENTED",
        );
        check(
          r.questions.some((q) => q.blocking_level === "finalization"),
          "EVAL_MISSING_COMMERCIAL_QUESTION",
        );
      },
    },
    {
      id: "review_detects_missing_response",
      task: "review_proposal",
      language: "en",
      evidence: buyer,
      required: requirementIds,
      context: reviewContext,
      assertion_scope:
        "canonical_contract_and_production_section_scope_and_missing_audit_response",
      assert: (r) => {
        validateReviewSectionReferences(r, reviewContext);
        check(
          r.responses.some(
            (q) =>
              q.requirement_id === "req_b" &&
              ["missing", "partial", "clarification_required"].includes(
                q.status,
              ),
          ),
          "EVAL_MISSING_RESPONSE_ACCEPTED",
        );
      },
    },
    {
      id: "review_summary_quotes",
      task: "summarize_review",
      language: "ar",
      evidence: reviewEvidence,
      required: reviewEvidence.map((e) => e.id),
      context: {
        reviews: reviewEvidence,
        instruction:
          "Summarize both review instructions as actionable revision directives. Keep the 30-day delivery and 90-day retention meanings, include the respective duration in each directive, and cite the exact original review wording.",
      },
      assertion_scope:
        "canonical_contract_and_each_review_source_cited_with_retained_duration",
      assert: (r) =>
        check(
          reviewEvidence.every((e, i) =>
            r.directives.some(
              (d) =>
                d.source_refs.some((s) => s.id === e.id) &&
                hasQuantity(d.instruction, i ? 90 : 30),
            ),
          ),
          "EVAL_REVIEW_DIRECTIVE_OMITTED",
        ),
    },
    {
      id: "source_listing_exact_notice",
      task: "inspect_source_page",
      language: "en",
      evidence: [
        { id: "page", kind: "notice", verified: false, text: page },
        {
          id: "L1",
          kind: "notice",
          verified: false,
          text: "Public portal implementation",
        },
        {
          id: "L2",
          kind: "notice",
          verified: false,
          text: "About this authority",
        },
      ],
      required: [],
      context: {
        mode: "collect_notices",
        url: "https://example.invalid/procurement",
        partial: false,
        links: [
          {
            id: "L1",
            text: "Public portal implementation",
            url: "https://example.invalid/notices/EVAL-2026-01",
          },
          {
            id: "L2",
            text: "About this authority",
            url: "https://example.invalid/about",
          },
        ],
      },
      assertion_scope:
        "canonical_source_evidence_and_exact_notice_fields_and_observed_link",
      assert: (r) =>
        check(
          r.page_kind === "listing" &&
            r.notices.length === 1 &&
            r.notices[0].title === "Public portal implementation" &&
            r.notices[0].link_id === "L1" &&
            r.notices[0].reference === "EVAL-2026-01" &&
            r.notices[0].buyer === "Example City Authority" &&
            r.notices[0].deadline_raw === "2026-12-15" &&
            r.candidate_link_ids.length === 0,
          "EVAL_NOTICE_FIELDS_CHANGED",
        ),
    },
    {
      id: "long_bilingual_mixed_evidence",
      task: "analyze_chunk",
      language: "en",
      evidence: [...blocks, company, style],
      required: blocks.map((e) => e.id),
      context: {
        blocks,
        company_evidence: [company],
        style_evidence: [style],
        instruction:
          "Extract the mandatory audit-event obligations from all supplied RFP blocks. Preserve event identifiers verbatim. Background notes are explanatory only. Company and style evidence do not create buyer requirements. Keep quotes short and verbatim and requirement text concise.",
      },
      assertion_scope:
        "canonical_contract_and_all_eight_event_obligations_and_buyer_source_roles",
      assert: (r) => {
        check(
          longBlocks.every((e) =>
            r.requirements.some(
              (q) =>
                q.mandatory === true &&
                new RegExp(`(^|[^A-Za-z0-9_])${e.event}([^A-Za-z0-9_]|$)`).test(
                  q.text,
                ) &&
                q.source_refs.some((s) => s.id === e.id),
            ),
          ),
          "EVAL_LONG_REQUIREMENT_OMITTED",
        );
        check(
          r.requirements.every(
            (q) =>
              q.source_refs.every((s) => blocks.some((b) => b.id === s.id)) &&
              !/27001|\b7\s*days?\b/i.test(q.text),
          ),
          "EVAL_MIXED_EVIDENCE_ROLE_CONFUSED",
        );
      },
    },
  ];
}
