// @vitest-environment node
// These authored response controls prove actual schema/domain wiring only.
// They are not provider outputs or semantic-positive qualification controls.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import corpus from "./fixtures/qualification-reserve/corpus-v4.json";
import prerequisites from "./fixtures/qualification-reserve/workflow-prerequisites-v1.json";
import {
  buildReserveAdapter,
  type ReserveAdapter,
} from "../../scripts/qualification/reserve-adapters";
import {
  loadWorkflowPrerequisites,
  WORKFLOW_PREREQUISITES_SHA256,
} from "../../scripts/qualification/reserve-workflow-adapters";
import { sha256, CORPUS_SHA256 } from "../../scripts/qualification/reserve.mjs";
const rows = corpus.cases.filter((r) =>
  prerequisites.cases.some((p) => p.case_id === r.id),
);
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function control(
  adapter: ReserveAdapter,
  fixture: (typeof prerequisites.cases)[number],
) {
  const mapping = new Map(
    adapter.trace.requirement_projection.map((r: any) => [
      r.corpus_requirement_key,
      r,
    ]),
  );
  const ids = adapter.required;
  if (adapter.task === "plan_structure")
    return {
      version: 3,
      sections: fixture.organizational_sections.map((s) => ({
        key: s.key,
        title: s.title,
        purpose: s.purpose,
        volume: s.volume,
        mode: "narrative",
        requirement_ids: s.requirement_keys.map(
          (k) => (mapping.get(k) as any).planning_alias,
        ),
      })),
      decisions: [],
      questions: [],
    };
  if (adapter.task === "plan_blueprint")
    return {
      version: 2,
      processed_requirement_ids: adapter.context.blueprint_requirement_ids,
      sections: adapter.context.assigned_sections.map((s: any) => ({
        key: s.key,
        title: s.title,
        purpose: s.purpose,
        volume: s.volume,
        mode: s.mode,
        units: [
          {
            key: s.key + "-response",
            title: s.title,
            purpose: s.purpose,
            requirement_ids: s.requirement_ids,
            secondary_links: [],
            target_words: 100,
            decision_ids: [],
          },
        ],
      })),
      decisions: [],
      questions: [],
    };
  if (adapter.task === "plan_proposal")
    return {
      processed_requirement_ids: ids,
      sections: fixture.organizational_sections.map((s) => ({
        key: s.key,
        title: s.title,
        purpose: s.purpose,
        volume: s.volume,
        requirement_ids: s.requirement_keys.map(
          (k) => (mapping.get(k) as any).canonical_id,
        ),
      })),
      questions: [],
    };
  if (adapter.task === "draft_section")
    return {
      key: adapter.context.section.key,
      title: adapter.context.section.title,
      content_blocks: [
        {
          type: "paragraph",
          text: adapter.context.requirements.map((r: any) => r.text).join("\n"),
        },
      ],
      requirement_ids: ids,
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
  if (adapter.task === "plan_commercial")
    return {
      lines: [
        {
          description: adapter.context.requirements[0].text,
          quantity: null,
          unit: "",
          rate_id: null,
          period_count: null,
          included_in_base: true,
          charge_group: "one_time",
          tax_category: "",
          requirement_ids: ids,
          section_ids: [adapter.context.section_titles[0].key],
          deliverable: "",
          basis: "",
        },
      ],
      tasks: [],
      questions: [
        {
          question: adapter.context.requirements[0].text,
          blocking_level: "finalization",
          requirement_ids: ids,
        },
      ],
    };
  if (adapter.task === "review_proposal")
    return {
      processed_requirement_ids: ids,
      responses: ids.map((id) => ({
        requirement_id: id,
        status: "clarification_required",
        section_ids: [adapter.context.sections[0].key],
        evidence_refs: [],
        rationale: adapter.context.requirements.find((r: any) => r.id === id)
          .text,
      })),
      findings: [],
    };
  throw Error("Unregistered control");
}

it("freezes22 authored prerequisites without modifying the50-case corpus or claiming prior success", async () => {
  expect(await loadWorkflowPrerequisites()).toEqual(prerequisites);
  expect(sha256(JSON.stringify(prerequisites, null, 2) + "\n")).toBe(
    WORKFLOW_PREREQUISITES_SHA256,
  );
  expect(sha256(JSON.stringify(corpus, null, 2) + "\n")).toBe(CORPUS_SHA256);
  expect(rows).toHaveLength(22);
  expect(
    Object.fromEntries(
      [...new Set(rows.map((r) => r.task))].map((t) => [
        t,
        rows.filter((r) => r.task === t).length,
      ]),
    ),
  ).toEqual({
    plan_structure: 2,
    plan_blueprint: 4,
    plan_proposal: 4,
    draft_section: 4,
    plan_commercial: 4,
    review_proposal: 4,
  });
});

it.each(rows)(
  "preserves all source bytes and real domain checks for $id",
  async (row) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
    const adapter = await buildReserveAdapter(row.id),
      fixture = prerequisites.cases.find((p) => p.case_id === row.id)!;
    expect(adapter.trace.workflow_prerequisites_sha256).toBe(
      WORKFLOW_PREREQUISITES_SHA256,
    );
    expect(adapter.trace.prerequisite_model_calls).toBe(0);
    expect(adapter.trace.prerequisite_database_admission).toBe(false);
    expect(adapter.trace.prerequisite_semantic_approval).toBe(false);
    expect(
      adapter.trace.prerequisite_checks.every(
        (c: any) =>
          c.schema_and_domain === "passed" &&
          c.semantic_model_review === "not_performed",
      ),
    ).toBe(true);
    expect(adapter.context.source_evidence.reviews).toEqual([]);
    for (const source of row.documents) {
      expect(
        adapter.trace.source_projection.find(
          (p: any) => p.corpus_document_id === source.id,
        ),
      ).toMatchObject({
        source_sha256: source.sha256,
        original_authority: source.authority_role,
      });
      const supplied = adapter.evidence.map((e) => e.text);
      expect(supplied.some((text: string) => text.includes(source.text))).toBe(
        true,
      );
    }
    for (const requirement of adapter.context.source_requirements) {
      expect(requirement.source_semantics.review_status).toBe("pending");
      expect(requirement.source_semantics.review_id).toBeNull();
      const span = adapter.context.source_evidence.spans.find(
        (s: any) => s.id === requirement.source_refs[0].id,
      );
      expect(requirement.text).toBe(span.quote);
      expect(requirement.source_refs[0].quote).toBe(span.quote);
    }
    const value = control(adapter, fixture);
    expect(() => adapter.domainValidate!(value)).not.toThrow();
    const bad = structuredClone(value) as any;
    if (adapter.task === "plan_structure")
      bad.sections[0].requirement_ids.push("invented-alias");
    else if (adapter.task === "plan_blueprint")
      bad.sections[0].units[0].requirement_ids.push("invented-alias");
    else if (adapter.task === "plan_proposal")
      bad.sections[0].requirement_ids.push("invented-requirement");
    else if (adapter.task === "draft_section") bad.key = "another-section";
    else if (adapter.task === "plan_commercial")
      bad.lines[0].section_ids = ["another-section"];
    else bad.responses[0].status = "not_applicable_approved";
    expect(() => adapter.domainValidate!(bad)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["en", "ar"])(
  "retains current hierarchical boundaries and legacy mapping distinction in %s",
  async (language) => {
    const structure = await buildReserveAdapter(
      `qr1.plan_structure.separate_envelopes.${language}`,
    );
    expect(structure.context.workflow_version).toBe(2);
    expect(structure.trace.workflow_version).toBe(3);
    expect(structure.context.execution_policy_version).toBe(3);
    expect(structure.context.assigned_sections).toBeUndefined();
    expect(structure.context.template.required_sections).toEqual([]);
    const detail = await buildReserveAdapter(
      `qr1.plan_blueprint.cross_reference.${language}`,
    );
    expect(detail.context.assigned_sections).toHaveLength(2);
    expect(detail.context.shared_decisions).toEqual([]);
    expect(
      detail.trace.prerequisite_checks.filter(
        (c: any) => c.task === "plan_structure",
      ),
    ).toHaveLength(1);
    const legacy = await buildReserveAdapter(
      `qr1.plan_proposal.owned_acceptance.${language}`,
    );
    expect(legacy.task).toBe("plan_proposal");
    expect(legacy.trace.legacy_registered_task).toBe(true);
    expect(legacy.trace.workflow_version).toBe(1);
  },
);

it.each(["en", "ar"])(
  "keeps company/style eligibility and missing response distinct in %s",
  async (language) => {
    const company = await buildReserveAdapter(
      `qr1.draft_section.qualified_company_record.${language}`,
    );
    const source = company.evidence.find((e) => e.kind === "company")!;
    expect(source.verified).toBe(true);
    expect(company.context.company_claim_eligible_source_ids).toContain(
      source.id,
    );
    const style = await buildReserveAdapter(
      `qr1.draft_section.style_is_not_credential.${language}`,
    );
    expect(style.evidence.find((e) => e.kind === "style")?.verified).toBe(
      false,
    );
    expect(style.context.company_claim_eligible_source_ids).toEqual([]);
    const review = await buildReserveAdapter(
      `qr1.review_proposal.partial_response.${language}`,
    );
    expect(review.required).toHaveLength(2);
    const row = corpus.cases.find((r) => r.id === review.caseId)!;
    const audit = review.evidence.find(
      (e) => e.id === review.context.audit_source_id,
    )!;
    expect(audit.text).toContain(row.documents[1].text);
    expect(review.context.sections[0].audit_source_id).toBe(audit.id);
    expect(review.context.sections[0].content_blocks).toBeUndefined();
    expect(review.context.commercial_draft).toMatchObject({
      status: "proposed_unconfirmed",
      audit_source_id: audit.id,
      line_count: 0,
      task_count: 0,
    });
    expect(
      review.evidence.some(
        (e) => e.id.startsWith("proposal-review:") && e.kind === "review",
      ),
    ).toBe(true);
  },
);
