// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  taskInput,
  nextStage,
} from "../../supabase/functions/_shared/generation";
import {
  validateModelResult,
  executeModel,
  validateScopeDecision,
} from "../../supabase/functions/_shared/model";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";
import type { ServiceScope } from "../../supabase/functions/_shared/discovery";

const notice: any = {
  id: "notice",
  kind: "notice",
  text: "Synthetic tender for garden design and planting",
  reference: {
    entity_kind: "notice",
    entity_id: "notice",
    content_hash: "a".repeat(64),
  },
};
const company: any = {
  id: "company",
  kind: "company",
  verified: true,
  text: "Synthetic company designs gardens.",
  reference: {
    entity_kind: "knowledge",
    entity_id: "company",
    content_hash: "b".repeat(64),
  },
};
const empty = {
  rating: null,
  reason: "Unknown",
  notice_evidence: [],
  company_evidence: [],
};
function result() {
  return {
    factors: {
      capability: empty,
      scope: empty,
      sector: empty,
      prerequisite: empty,
    },
    critical_unknown: true,
    reason_summary: "Synthetic scope comparison",
    missing_information: [],
    risk_flags: [],
    suggested_tags: [],
    scope_decision: {
      status: "in_scope",
      reason: "Purchased deliverable matches selected scope",
      notice_evidence: [{ id: "notice", quote: "garden design" }],
      company_evidence: [] as any[],
      keyword_evidence: [] as any[],
    },
  };
}
function context(policy: ServiceScope, knowledge = [company]): any {
  return {
    plan: {
      stage: "assessment",
      frozen_context: {
        notice,
        knowledge,
        blocks: [],
        reviews: [],
        discovery_scope_policy: policy,
      },
    },
    step: { task: "classify_opportunity", input: {} },
    steps: [],
    requirements: [],
  };
}

it("passes arbitrary non-technology and Arabic criteria to the model, without classifying by keywords", () => {
  const policy: ServiceScope = {
    scope: "combined",
    include_keywords: ["تصميم الحدائق"],
    exclude_keywords: ["صيانة المباني"],
  };
  const input = taskInput(context(policy));
  expect(input.context.scope_policy).toEqual(policy);
  expect(input.evidence).toEqual([notice, company]);
  expect(input.context.instruction).toContain("never proof of expertise");
  expect(JSON.stringify(input.context)).not.toMatch(/software|hardware/i);
  expect(
    commandSchemas["discovery.configure"].safeParse({
      ...policy,
      expected_revision: 1,
      auto_public_notices: true,
      auto_company_knowledge: true,
      providers: ["groq_free"],
    }).success,
  ).toBe(true);
});

it("records an unsupported scope decision as failed and tries the next provider with measured usage", async () => {
  const policy: ServiceScope = {
    scope: "keywords",
    include_keywords: ["Garden design"],
    exclude_keywords: [],
  };
  const bad = result(),
    good = result();
  bad.scope_decision.keyword_evidence = [
    { kind: "include", keyword: "Unconfigured service" },
  ];
  good.scope_decision.keyword_evidence = [
    { kind: "include", keyword: "Garden design" },
  ];
  const base = {
    model: "owner-model",
    project_ref: "synthetic",
    enabled: true,
    free_only: false,
    billing_verified: false,
    free_quota_only: false,
    quota_mode: "provider_managed",
    verified_at: new Date().toISOString(),
    quota_ends_at: null,
  };
  const ledger: any = {
    preflight: async () => ({
      routing_mode: "round_robin",
      providers: [
        { ...base, provider: "groq_free" },
        { ...base, provider: "mistral_free" },
      ],
    }),
    beginAttempt: async (provider: string) => provider,
    reserve: async (...args: any[]) => args[4],
    settle: vi.fn(),
    endAttempt: vi.fn(),
    attempt: vi.fn(),
  };
  const send = vi.fn<typeof fetch>(async (url) =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(
              String(url).includes("groq.com") ? bad : good,
            ),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  );
  const environment = (provider: string) => ({
    provider,
    model: "owner-model",
    projectRef: "synthetic",
    key: "synthetic-key",
  });
  expect(
    await executeModel(
      "classify_opportunity",
      { scope_policy: policy },
      [notice],
      [],
      [notice.reference],
      {
        groq_free: environment("groq_free"),
        mistral_free: environment("mistral_free"),
      },
      ledger,
      "en",
      false,
      send,
    ),
  ).toEqual(good);
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    ledger.endAttempt.mock.calls.map((call: any[]) => call.slice(0, 2)),
  ).toEqual([
    ["groq_free", "EVIDENCE_REFERENCE_INVALID"],
    ["mistral_free", "SUCCEEDED"],
  ]);
  expect(ledger.settle.mock.calls.map((call: any[]) => call[1])).toEqual([
    { input: 100, output: 50, thinking: null },
    { input: 100, output: 50, thinking: null },
  ]);
});

it("requires a cited selected source for definite scope and allows honest uncertainty without evidence", () => {
  const policy: ServiceScope = {
    scope: "company_knowledge",
    include_keywords: [],
    exclude_keywords: [],
  };
  const output = result();
  expect(() => validateScopeDecision(output, policy)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
  output.scope_decision.status = "uncertain";
  expect(() => validateScopeDecision(output, policy)).not.toThrow();
  output.scope_decision.status = "in_scope";
  output.scope_decision.company_evidence = [
    { id: company.id, quote: "designs gardens" },
  ];
  expect(() =>
    validateModelResult("classify_opportunity", output, [notice, company]),
  ).not.toThrow();
  expect(() => validateScopeDecision(output, policy)).not.toThrow();
  expect(() =>
    validateModelResult("classify_opportunity", output, [notice]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(() =>
    validateModelResult("classify_opportunity", output, [
      notice,
      { ...company, verified: false },
    ]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  output.scope_decision.company_evidence[0].quote = "invented experience";
  expect(() =>
    validateModelResult("classify_opportunity", output, [notice, company]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("validates configured term citations without treating them as credentials", async () => {
  const policy: ServiceScope = {
    scope: "keywords",
    include_keywords: ["Garden design"],
    exclude_keywords: ["Planting"],
  };
  const output = result();
  output.scope_decision.keyword_evidence = [
    { kind: "include", keyword: "Garden design" },
  ];
  expect(() => validateScopeDecision(output, policy)).not.toThrow();
  const ctx = context(policy, []);
  ctx.steps = [
    {
      stage: "assessment",
      task: "classify_opportunity",
      status: "completed",
      output,
    },
  ];
  const stage = await nextStage(ctx);
  expect(stage.final_result).toMatchObject({
    fit_score: null,
    evidence_coverage: 0,
    routing: "needs_review",
    result: { metadata: { scope_policy: policy, company_sources: [] } },
  });
  output.scope_decision.keyword_evidence[0].keyword = "Unconfigured sector";
  expect(() => validateScopeDecision(output, policy)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
  output.scope_decision.keyword_evidence = [
    { kind: "exclude", keyword: "Garden design" },
  ];
  expect(() => validateScopeDecision(output, policy)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
  output.scope_decision.keyword_evidence = [];
  output.scope_decision.company_evidence = [
    { id: company.id, quote: "designs gardens" },
  ];
  expect(() => validateScopeDecision(output, policy)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
  expect(() => validateScopeDecision({}, policy)).toThrow(
    "MODEL_OUTPUT_INVALID",
  );
});

it("combined scope can cite either source but company facts still require company quotations", () => {
  const policy: ServiceScope = {
    scope: "combined",
    include_keywords: ["Garden design"],
    exclude_keywords: [],
  };
  const output = result();
  output.scope_decision.keyword_evidence = [
    { kind: "include", keyword: "Garden design" },
  ];
  expect(() => validateScopeDecision(output, policy)).not.toThrow();
  expect(() =>
    validateScopeDecision(output, { ...policy, scope: "company_knowledge" }),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  output.factors.capability = {
    ...empty,
    rating: 4 as any,
    notice_evidence: [{ id: notice.id, quote: "garden design" }] as any,
  };
  expect(() =>
    validateModelResult("classify_opportunity", output, [notice, company]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
