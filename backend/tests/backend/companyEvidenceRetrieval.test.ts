// @vitest-environment node
import { expect, it } from "vitest";
import {
  retrieveCompanyEvidence,
  encodedSize,
  COMPANY_EVIDENCE_BYTE_LIMIT,
} from "../../supabase/functions/_shared/companyEvidenceRetrieval";
import { taskInput, generationValidationEvidence, nextStage } from "../../supabase/functions/_shared/generation";
import { validateModelResult } from "../../supabase/functions/_shared/model";

function source(
  id: string,
  text: string,
  kind: "company" | "style" = "company",
  verified = true,
) {
  return {
    id,
    text,
    kind,
    verified,
    reference: {
      entity_kind: "knowledge",
      entity_id: id,
      content_hash: "a".repeat(64),
    },
  };
}
const requirement = (id: string, text: string) => ({ id, text });
const ids = (result: ReturnType<typeof retrieveCompanyEvidence>) =>
  result.evidence.map((s) => s.id);

// Gold sources and wording are authored independently of the lexical selector.
// These assertions establish retrieval of the decisive record, not model truth.
it.each([
  [
    "Arabic request / English record",
    "إثبات خبرة في أتمتة إجراءات الموافقات",
    "Delivered an approval workflow automation project.",
  ],
  [
    "English request / Arabic record",
    "Demonstrate approval workflow automation experience.",
    "نفذنا مشروع أتمتة إجراءات الموافقات.",
  ],
  [
    "synonyms without shared literal terms",
    "Demonstrate expertise in connecting systems.",
    "Implemented enterprise interoperability services.",
  ],
])("retains the seventh decisive source for %s", (_label, query, gold) => {
  const sources = Array.from({ length: 6 }, (_, i) =>
    source(`source-${i}`, "General office address information."),
  );
  sources.push(source("source-7", gold));
  const result = retrieveCompanyEvidence(sources, [requirement("R1", query)]);
  expect(ids(result)).toContain("source-7");
  expect(result.evidence.find((s) => s.id === "source-7")!.text).toBe(gold);
  expect(result.coverage).toMatchObject({
    selection_complete: true,
    available_sources: 7,
    supplied_sources: 7,
    capability_absence_proven: false,
  });
  expect(result.coverage.requirement_coverage[0].semantic_support).toBe(
    "not_evaluated",
  );
});

it("retains late decisive evidence, its negation and adjacent qualification verbatim", () => {
  const text =
    "Company overview. ".repeat(180) +
    "\nDelivered a workflow project. This does not establish certification. Certification application remains pending.";
  const original = source("late", text);
  const result = retrieveCompanyEvidence(
    [original],
    [requirement("R1", "Workflow certification")],
  );
  expect(text.indexOf("Delivered")).toBeGreaterThan(2000);
  expect(result.evidence).toEqual([original]);
});

it("admits or excludes all blocks of one source together, retaining the next-block qualifier", () => {
  const first = source("block-1", "Workflow certification application."),
    second = source(
      "block-2",
      "Status: pending. No certificate has been issued.",
    );
  second.reference = { ...first.reference };
  const budget = encodedSize(first) + encodedSize(second);
  const result = retrieveCompanyEvidence(
    [first, second],
    [requirement("R1", "Workflow certification")],
    budget,
  );
  expect(result.evidence).toEqual([first, second]);
  const limited = retrieveCompanyEvidence(
    [first, second],
    [requirement("R1", "Workflow certification")],
    budget - 1,
  );
  expect(limited.evidence).toEqual([]);
  expect(limited.coverage).toMatchObject({
    omitted_sources: 1,
    available_blocks: 2,
    supplied_blocks: 0,
    gap: "context_capacity",
    capability_absence_proven: false,
  });
  expect(limited.omitted[0].source_ids).toEqual(["block-1", "block-2"]);
});

it("preserves frozen block sequence within a document instead of sorting random block IDs", () => {
  const first = source("z-heading", "Certification scope:"),
    second = source(
      "a-condition",
      "Only an application; no certificate has been issued.",
    );
  second.reference = { ...first.reference };
  expect(
    retrieveCompanyEvidence(
      [first, second],
      [requirement("R1", "Certification")],
    ).evidence,
  ).toEqual([first, second]);
});

it("balances scarce evidence space between distinct requirements and reports all omissions", () => {
  const sources = [
    source("a", "Integration API experience."),
    source("b", "Integration API history."),
    source("c", "Accessibility delivery experience."),
  ];
  const result = retrieveCompanyEvidence(
    sources,
    [requirement("R1", "Integration API"), requirement("R2", "Accessibility")],
    encodedSize(sources[0]) + encodedSize(sources[2]),
  );
  expect(ids(result)).toEqual(["a", "c"]);
  expect(result.omitted.map((s) => s.source_ids)).toEqual([["b"]]);
  expect(result.coverage.selection_complete).toBe(false);
  expect(
    result.coverage.requirement_coverage.every((r) => r.retrieval_gap),
  ).toBe(true);
});

it("does not silently infer absence when cross-language evidence cannot fit", () => {
  const result = retrieveCompanyEvidence(
    [source("ar", "نفذنا مشروع أتمتة إجراءات الموافقات.")],
    [requirement("R1", "Approval automation")],
    1,
  );
  expect(result.evidence).toEqual([]);
  expect(result.coverage).toMatchObject({
    available_sources: 1,
    omitted_sources: 1,
    gap: "context_capacity",
    capability_absence_proven: false,
  });
  expect(result.coverage.requirement_coverage).toEqual([
    {
      requirement_id: "R1",
      lexical_match_source_ids: [],
      semantic_support: "not_evaluated",
      retrieval_gap: true,
    },
  ]);
});

it("prioritizes a cited company claim for review without cropping its source", () => {
  const a = source("a", "Workflow capabilities."),
    z = source(
      "z",
      "Approved workflow certificate, limited to the listed scope.",
    );
  const result = retrieveCompanyEvidence(
    [a, z],
    [requirement("R1", "Workflow")],
    encodedSize(z),
    ["z"],
  );
  expect(result.evidence).toEqual([z]);
  expect(result.coverage.cited_source_coverage_complete).toBe(true);
});

it("uses stable tie ordering independently of input array order", () => {
  const a = source("a", "Workflow expertise."),
    b = source("b", "Workflow expertise.");
  const reqs = [requirement("R1", "Workflow")];
  expect(retrieveCompanyEvidence([a, b], reqs, encodedSize(a))).toEqual(
    retrieveCompanyEvidence([b, a], reqs, encodedSize(a)),
  );
  expect(ids(retrieveCompanyEvidence([b, a], reqs, encodedSize(a)))).toEqual([
    "a",
  ]);
});

it("excludes unverified and style lookalikes and distinguishes absent verified records", () => {
  const result = retrieveCompanyEvidence(
    [
      source("unverified", "Workflow expertise.", "company", false),
      source("style", "We hold every certificate.", "style"),
    ],
    [requirement("R1", "Workflow")],
  );
  expect(result.evidence).toEqual([]);
  expect(result.omitted).toEqual([]);
  expect(result.coverage).toMatchObject({
    available_sources: 0,
    gap: "no_verified_source_in_snapshot",
    capability_absence_proven: false,
  });
});

it.each([0, -1, Infinity, NaN])(
  "does not exceed unusable byte budget %s",
  (budget) => {
    const result = retrieveCompanyEvidence(
      [source("a", "Workflow expertise.")],
      [],
      budget,
    );
    expect(result.evidence).toEqual([]);
    expect(result.coverage.byte_budget).toBe(0);
  },
);

function context(task = "draft_section"): any {
  return {
    plan: {
      frozen_context: {
        company_retrieval_version: 1,
        notice: {
          ...source("notice", "Workflow opportunity."),
          kind: "notice",
        },
        blocks: [],
        reviews: [],
        rates: [],
        knowledge: Array.from({ length: 7 }, (_, i) =>
          source(`c${i}`, "Company information. ".repeat(110)),
        ),
        template: { id: "test", required_sections: [] },
      },
    },
    step: {
      task,
      input: {
        requirement_ids: ["R1"],
        section: {
          key: "approach",
          title: "Workflow",
          requirement_ids: ["R1"],
        },
      },
    },
    steps: [],
    requirements: [
      {
        id: "R1",
        text: "Workflow",
        category: "technical",
        mandatory: true,
        source_refs: [],
      },
    ],
  };
}
it.each(["draft_section", "plan_commercial", "review_proposal"])(
  "integrates complete verified evidence and exact manifest for %s",
  (task) => {
    const ctx = context(task),
      input = taskInput(ctx);
    expect(input.evidence.filter((s) => s.kind === "company")).toEqual(
      ctx.plan.frozen_context.knowledge,
    );
    expect(input.manifest).toEqual([
      ...(task === "draft_section"
        ? [ctx.plan.frozen_context.notice.reference]
        : []),
      ...ctx.plan.frozen_context.knowledge.map((s: any) => s.reference),
    ]);
    expect(input.context.company_evidence_coverage).toMatchObject({
      version: 1,
      selection_complete: true,
      supplied_sources: 7,
    });
    expect(
      input.context.company_evidence_coverage.supplied_bytes,
    ).toBeLessThanOrEqual(COMPANY_EVIDENCE_BYTE_LIMIT);
  },
);

it("preserves the historical unpinned task input and paid request content", () => {
  const ctx = context();
  delete ctx.plan.frozen_context.company_retrieval_version;
  const input = taskInput(ctx);
  expect(input.evidence.filter((s) => s.kind === "company")).toHaveLength(6);
  expect(input.evidence.every((s) => s.text.length === 2000)).toBe(true);
  expect(input.context).not.toHaveProperty("company_evidence_coverage");
  expect(input.context).not.toHaveProperty("company_retrieval_version");
});

it("reduces company evidence when the existing buyer context consumes capacity and retains buyer text", () => {
  const ctx = context();
  const buyerText = "Buyer requirement and qualifications. ".repeat(1500);
  ctx.plan.frozen_context.blocks = [
    { ...source("buyer", buyerText), kind: "rfp" },
  ];
  ctx.requirements[0].source_refs = [
    { id: "buyer", quote: "Buyer requirement" },
  ];
  const input = taskInput(ctx);
  expect(input.evidence.find((s) => s.id === "buyer")!.text).toBe(buyerText);
  expect(input.evidence.some((s) => s.kind === "company")).toBe(false);
  expect(input.context.company_evidence_coverage).toMatchObject({
    selection_complete: false,
    supplied_bytes: 0,
    gap: "context_capacity",
  });
});

it("new targeted followup reaches a late omitted source but cannot promote its partial quote to company proof", () => {
  const ctx = context();
  ctx.plan.frozen_context.company_followup_version = 1;
  const filler = "Unrelated historical material. ".repeat(1800);
  ctx.plan.frozen_context.knowledge = [source("large", filler + "\n\nIntroduction.\n\nWe deliver workflow approval systems.\n\nEvidence note.\n\n" + filler + "\n\nOnly for private systems.")];
  const input = taskInput(ctx);
  const partial = input.evidence.find(e => e.id === "large")!;
  expect(partial.text).toContain("Only for private systems.");
  expect(partial.verified).toBe(false);
  expect(input.context.company_claim_eligible_source_ids).toEqual([]);
  expect(input.manifest).toContainEqual(ctx.plan.frozen_context.knowledge[0].reference);
  const validation = generationValidationEvidence(ctx, input);
  expect(validation.find(e => e.id === "large")?.text).toBe(ctx.plan.frozen_context.knowledge[0].text);
  expect(validation.find(e => e.id === "large")?.verified).toBe(false);
  const candidate = {key:"approach",title:"Workflow",content_blocks:[{type:"paragraph",text:"We deliver workflow approval systems."}],requirement_ids:["R1"],evidence_refs:[],company_claims:[{claim:"We deliver workflow approval systems.",source_id:"large",quote:"We deliver workflow approval systems."}],assumptions:[],questions:[]};
  expect(() => validateModelResult("draft_section",candidate,validation,["R1"],{independentGrounding:true})).toThrow();
});
it("assembly persists substantive gaps despite model answered labels and still returns all draft content", async () => {
  const ctx = context();
  ctx.plan.stage = "review";
  ctx.plan.frozen_context.proposal_consistency_version = 1;
  const draft = {key:"approach",title:"Workflow",volume:"technical",content_blocks:[{type:"paragraph",text:"We comply with every requirement."}],requirement_ids:["R1"],evidence_refs:[],company_claims:[],assumptions:[],questions:[]};
  ctx.steps = [{task:"draft_section",status:"completed",input:{section:{key:"approach",volume:"technical"}},output:draft},
    {task:"review_proposal",status:"completed",input:{},output:{responses:[{requirement_id:"R1",status:"answered",rationale:"Model says complete",section_ids:["approach"]}],findings:[]}}];
  const result = await nextStage(ctx);
  expect(result.next_stage).toBe("completed");
  expect(result.final_result!.sections[0].body).toBe("We comply with every requirement.");
  expect(result.final_result!.consistency_report.substantive_complete).toBe(false);
  expect(result.final_result!.consistency_report.coverage[0].missing_fields).toContain("response");
  expect(result.final_result!.questions.some((q:any) => q.reason === "REQUIREMENT_RESPONSE_INCOMPLETE")).toBe(true);
});
