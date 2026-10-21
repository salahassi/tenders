// @vitest-environment node
import { expect, it } from "vitest";
import { taskInput } from "../../supabase/functions/_shared/generation";
import {
  candidateContent,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";

const quote = "Architectural assessment\nDeliver a documented design.";
const sourceText = `# Description Qty Unit price Total
1 Discovery package 1
${"Review the existing process. ".repeat(30)}
2 Architecture package 1
${quote}
3 Delivery package 1
Train the internal team.`;
function source(id: string, kind: string, text: string) {
  return {
    id,
    kind,
    text,
    verified: kind === "company",
    reference: {
      entity_kind: kind === "rfp" ? "document" : "knowledge",
      entity_id: id,
      content_hash: "a".repeat(64),
    },
  };
}
function context(task = "draft_section") {
  const block = source("rfp-block", "rfp", sourceText);
  return {
    plan: {
      frozen_context: {
        notice: source("notice", "notice", "A public architecture tender."),
        blocks: [
          block,
          source("unselected", "rfp", "Unrelated document block."),
        ],
        knowledge: [] as any[],
        reviews: [],
        rates: [],
        template: { id: "professional-v1", required_sections: [] },
      },
    },
    step: {
      task,
      input: {
        requirement_ids: ["requirement"],
        section: {
          key: "approach",
          title: "Architecture",
          requirement_ids: ["requirement"],
        },
      },
    },
    steps: [],
    requirements: [
      {
        id: "requirement",
        text: "BOQ item 2 requires architectural assessment.",
        category: "technical",
        mandatory: true,
        interpretation: "Explain the design.",
        acceptance_evidence: "A reviewed design.",
        owner_question: null,
        source_refs: [{ id: block.id, quote }],
      },
    ],
  };
}
it("preserves table context for a cited requirement and validates its correct row label", () => {
  const input = taskInput(context());
  const block = input.evidence.find((e) => e.id === "rfp-block")!;
  expect(block.text).toBe(sourceText);
  expect(input.evidence.some((e) => e.id === "unselected")).toBe(false);
  expect(input.manifest).toEqual([
    context().plan.frozen_context.blocks[0].reference,
  ]);
  const candidate = {
    content_blocks: [
      { type: "paragraph", text: context().requirements[0].text },
    ],
  };
  const report = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((u) => u.id),
    claims: [
      {
        id: "claim",
        claim: candidate.content_blocks[0].text,
        candidate_quote: candidate.content_blocks[0].text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: block.id, quote }],
        finding: "Supported table row.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      input.evidence,
      [],
    ),
  ).not.toThrow();
  report.claims[0].candidate_quote = "BOQ item 2 requires 2 architects.";
  candidate.content_blocks[0].text = report.claims[0].candidate_quote;
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      input.evidence,
      [],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("accepts the same whitespace-normalized citations accepted during analysis without fabricating excerpts", () => {
  const ctx = context();
  ctx.requirements[0].source_refs[0].quote = quote.replace("\n", " ");
  expect(taskInput(ctx).evidence.find((e) => e.id === "rfp-block")!.text).toBe(
    sourceText,
  );
  ctx.requirements[0].source_refs[0].quote = "A statement absent from the RFP.";
  expect(() => taskInput(ctx)).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("includes a selected bounded RFP block once even when multiple requirements cite it", () => {
  const ctx = context();
  ctx.requirements.push({ ...ctx.requirements[0], id: "second" });
  ctx.step.input.requirement_ids.push("second");
  const input = taskInput(ctx);
  expect(input.evidence.filter((e) => e.id === "rfp-block")).toHaveLength(1);
  expect(input.evidence[0].text).not.toContain(
    "[Separate excerpt from the same source]",
  );
  expect(input.manifest).toHaveLength(1);
});
it("does not broaden Company Knowledge selection or its supplied snippets", () => {
  const ctx = context();
  ctx.plan.frozen_context.knowledge = Array.from({ length: 8 }, (_, i) =>
    source("company-" + i, "company", "Architecture expertise. ".repeat(200)),
  );
  const input = taskInput(ctx);
  expect(input.evidence.filter((e) => e.kind === "company")).toHaveLength(6);
  expect(
    input.evidence
      .filter((e) => e.kind === "company")
      .every((e) => e.text.length === 2000),
  ).toBe(true);
  expect(
    input.evidence.some((e) => e.id === "company-6" || e.id === "company-7"),
  ).toBe(false);
});
it("preserves existing analysis segmentation and request identity", () => {
  const ctx = context("analyze_chunk") as any;
  ctx.step.input = { block_id: "rfp-block", start: 45, end: 400 };
  const input = taskInput(ctx);
  expect(input.evidence).toEqual([
    {
      ...ctx.plan.frozen_context.blocks[0],
      text: Array.from(sourceText).slice(45, 400).join(""),
    },
  ]);
  expect(input.requiredIds).toEqual(["rfp-block"]);
  expect(input.context.segment).toEqual({ start: 45, end: 400 });
  expect(input.manifest).toEqual([ctx.plan.frozen_context.blocks[0].reference]);
});
