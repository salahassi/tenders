// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { processGeneration } from "../../supabase/functions/_shared/generation";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import {
  ModelDeferred,
  validateScopeDecision,
} from "../../supabase/functions/_shared/model";

vi.mock("../../supabase/functions/_shared/modelGraph", () => ({
  executeGuardedModel: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["review_proposal", "plan_commercial", "draft_section"] as const)(
  "gives schema-valid %s scope failures typed correction diagnostics",
  async (task) => {
    let validate: (value: unknown) => void = () => {
      throw Error("missing validator");
    };
    vi.mocked(executeGuardedModel).mockImplementation(async (options) => {
      validate = options.validate!;
      throw new ModelDeferred();
    });
    const ctx = {
      plan: {
        frozen_context: {
          language: "en",
          notice: {
            id: "notice",
            text: "Synthetic buyer scope.",
            kind: "notice",
            verified: false,
          },
          blocks: [],
          knowledge: [],
          reviews: [],
          rates: [],
          template: { id: "template", required_sections: [] },
        },
      },
      step: {
        id: "step",
        task,
        repair_count: 0,
        input: {
          requirement_ids: [],
          section: { key: "expected", title: "Approach" },
        },
      },
      steps: [],
      requirements: [],
    };
    const internal = vi.fn(async (name) =>
      name === "generation_context" ? ctx : null,
    );
    await processGeneration(
      { internal } as any,
      { models: {} } as any,
      { id: "job", lease_token: "lease" },
      fetch,
    );
    expect(executeGuardedModel).toHaveBeenCalledOnce();
    const candidate =
      task === "review_proposal"
        ? {
            processed_requirement_ids: [],
            responses: [],
            findings: [
              {
                severity: "blocking",
                category: "scope",
                detail: "Review requested.",
                section_ids: ["unknown"],
                requirement_ids: [],
              },
            ],
          }
        : task === "plan_commercial"
          ? {
              lines: [
                {
                  description: "Implementation effort",
                  quantity: null,
                  unit: "day",
                  rate_id: null,
                  period_count: null,
                  included_in_base: true,
                  charge_group: "one_time",
                  tax_category: "unknown",
                  requirement_ids: [],
                  section_ids: ["unknown"],
                  deliverable: "Workflow",
                  basis: "Buyer requirements",
                },
              ],
              tasks: [],
              questions: [],
            }
          : {
              key: "unknown",
              title: "Approach",
              content_blocks: [
                { type: "paragraph", text: "Proposed workflow." },
              ],
              requirement_ids: [],
              evidence_refs: [],
              company_claims: [],
              assumptions: [],
              questions: [],
            };
    expect(() => validate(candidate)).toThrow(
      expect.objectContaining({
        code: "EVIDENCE_REFERENCE_INVALID",
        validationDiagnostics: [
          expect.objectContaining({
            reason:
              task === "draft_section"
                ? "invalid_scope"
                : "invalid_finding_reference",
            paths:
              task === "draft_section"
                ? ["$.key"]
                : task === "plan_commercial"
                  ? ["$.lines"]
                  : ["$.responses", "$.findings"],
          }),
        ],
      }),
    );
    expect(internal).toHaveBeenCalledTimes(1);
  },
);

it("gives keyword scope mismatches typed diagnostics without copying the supplied keyword", () => {
  expect(() =>
    validateScopeDecision(
      {
        scope_decision: {
          status: "in_scope",
          company_evidence: [],
          keyword_evidence: [{ kind: "include", keyword: "unsupported" }],
        },
      },
      {
        scope: "keywords",
        include_keywords: ["software"],
        exclude_keywords: [],
      } as any,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "EVIDENCE_REFERENCE_INVALID",
      validationDiagnostics: [
        {
          code: "EVIDENCE_REFERENCE_INVALID",
          reason: "invalid_scope",
          paths: [
            "$.scope_decision.company_evidence",
            "$.scope_decision.keyword_evidence",
          ],
        },
      ],
    }),
  );
});
