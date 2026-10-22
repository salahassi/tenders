// @vitest-environment node
import { expect, it } from "vitest";
import { proposalReviewEvidence } from "../../supabase/functions/_shared/proposalReviewEvidence";
import { validateModelResult } from "../../supabase/functions/_shared/model";
import { validateGroundingReport } from "../../supabase/functions/_shared/modelGrounding";

it("cites actual draft wording once without turning it into company evidence", () => {
  const text =
    "We propose hourly backups; existing staffing needs confirmation.";
  const context = {
    sections: [
      {
        key: "backup",
        title: "Backup",
        volume: "technical",
        content_blocks: [{ type: "paragraph", text }],
      },
    ],
    commercial_draft: {
      status: "proposed_unconfirmed",
      lines: [{ title: "Hosting", rate: null }],
      tasks: [],
      questions: [],
    },
    commercial_review_scope: { complete: false },
    shared_decisions: [
      { key: "residency", statement: "Propose domestic hosting" },
    ],
    response_locations: [{ section_key: "backup" }],
    instruction: "Audit the draft.",
  };
  const source = proposalReviewEvidence("step", context);
  expect(source).toMatchObject({
    id: "proposal-review:step",
    kind: "review",
    verified: false,
  });
  expect(source.text).toContain(
    `draft.sections[0].content_blocks[0].text: ${text}`,
  );
  expect(source.text).toContain("draft.counts.commercial_lines: 1");
  expect(JSON.stringify(context)).not.toContain(text);
  expect(context.sections[0].key).toBe("backup");
  const candidate = { summary: "The draft proposes hourly backups." };
  const report: any = {
    reviewed_all_content: true,
    checked_candidate_hash: "a".repeat(64),
    processed_content_ids: ["content-0"],
    processed_requirement_ids: [],
    claims: [
      {
        id: "c",
        kind: "tender_fact",
        claim: candidate.summary,
        candidate_quote: candidate.summary,
        status: "supported",
        source_refs: [{ id: source.id, quote: text }],
        finding: "The draft states this proposal, not existing capability.",
      },
    ],
    requirement_checks: [],
    findings: [],
  };
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      report.checked_candidate_hash,
      [source],
      [],
    ),
  ).not.toThrow();
  const companyClaim = structuredClone(report);
  companyClaim.claims[0].kind = "company_fact";
  expect(() =>
    validateModelResult("verify_grounding", companyClaim, [source], []),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  const invented = structuredClone(report);
  invented.claims[0].source_refs[0].quote =
    "The company has certified backup engineers.";
  expect(() =>
    validateModelResult("verify_grounding", invented, [source], []),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
