// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  classificationScopePolicy,
  executeModel,
  fitScore,
  sha256,
  validateModelResult,
  type Evidence,
} from "../../supabase/functions/_shared/model";
import {
  recoverRevalidatedWriter,
  revalidateWriter,
} from "../../supabase/functions/_shared/modelRevalidatedWriter";
import type { ServiceScope } from "../../supabase/functions/_shared/discovery";

const notice: Evidence = {
  id: "synthetic-notice",
  kind: "notice",
  verified: false,
  text: "Synthetic procurement for garden design.",
};
const policy: ServiceScope = {
  scope: "combined",
  include_keywords: ["Garden design"],
  exclude_keywords: [],
};
function candidate() {
  const unknown = {
    rating: null,
    reason: "Company proof is unavailable.",
    notice_evidence: [],
    company_evidence: [],
  };
  return {
    factors: {
      capability: structuredClone(unknown),
      scope: {
        ...structuredClone(unknown),
        rating: 4 as number | null,
        reason: "Purchased work matches the selected interest.",
        notice_evidence: [{ id: notice.id, quote: "garden design" }],
      },
      sector: structuredClone(unknown),
      prerequisite: structuredClone(unknown),
    },
    scope_decision: {
      status: "in_scope",
      reason: "The purchase matches a configured interest.",
      notice_evidence: [{ id: notice.id, quote: "garden design" }],
      company_evidence: [],
      keyword_evidence: [{ kind: "include", keyword: "Garden design" }],
    },
    critical_unknown: true,
    reason_summary: "Company capacity and qualifications need confirmation.",
    missing_information: ["Provide verified company qualifications."],
    risk_flags: [],
    suggested_tags: [],
  };
}
const validate = (value: unknown, scopePolicy: ServiceScope = policy) =>
  validateModelResult("classify_opportunity", value, [notice], [], {
    scopePolicy,
  });

it.each(["keywords", "combined"] as const)(
  "accepts a cited numeric scope rating based on selected %s interests only",
  (scope) => {
    const result = candidate();
    expect(validate(result, { ...policy, scope })).toEqual(result);
    expect(fitScore(result as any, false)).toMatchObject({
      evidence_coverage: 25,
      routing: "needs_review",
    });
  },
);

it.each([
  "no-factor-notice",
  "invented-factor-quote",
  "invented-decision-quote",
  "unknown-keyword",
  "wrong-keyword-kind",
  "no-keywords",
  "uncertain",
  "company-knowledge",
  "missing-policy",
  "malformed-policy",
])("rejects unsupported scope evidence: %s", (condition) => {
  const result = candidate();
  let scopePolicy: any = policy;
  if (condition === "no-factor-notice")
    result.factors.scope.notice_evidence = [];
  if (condition === "invented-factor-quote")
    result.factors.scope.notice_evidence[0].quote = "Invented service";
  if (condition === "invented-decision-quote")
    result.scope_decision.notice_evidence[0].quote = "Invented service";
  if (condition === "unknown-keyword")
    result.scope_decision.keyword_evidence[0].keyword = "Unconfigured service";
  if (condition === "wrong-keyword-kind")
    result.scope_decision.keyword_evidence[0].kind = "exclude";
  if (condition === "no-keywords") result.scope_decision.keyword_evidence = [];
  if (condition === "uncertain") result.scope_decision.status = "uncertain";
  if (condition === "company-knowledge")
    scopePolicy = { ...policy, scope: "company_knowledge" };
  if (condition === "missing-policy") scopePolicy = undefined;
  if (condition === "malformed-policy")
    scopePolicy = { ...policy, include_keywords: "Garden design" };
  expect(() =>
    validateModelResult("classify_opportunity", result, [notice], [], {
      scopePolicy,
    }),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it.each(["capability", "sector", "prerequisite"] as const)(
  "never treats selected interests as company proof for %s",
  (factor) => {
    const result = candidate();
    (result.factors[factor] as any) = structuredClone(result.factors.scope);
    expect(() => validate(result)).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);

it("revalidates the unchanged candidate against its original trusted policy", () => {
  const result = candidate();
  const options = {
    task: "classify_opportunity" as const,
    evidence: [notice],
    requiredIds: [],
    context: { scope_policy: policy },
  };
  expect(revalidateWriter(result, options)).toBe(true);
  expect(revalidateWriter(result, { ...options, context: {} })).toBe(false);
  expect(result).toEqual(candidate());
  expect(
    classificationScopePolicy("repair_result", {
      target_task: "classify_opportunity",
      original_context: options.context,
    }),
  ).toEqual(policy);
  expect(
    classificationScopePolicy("draft_section", options.context),
  ).toBeUndefined();
});

it("releases only the unchanged latest paid scope candidate for independent verification", async () => {
  const result = candidate();
  const hash = await sha256(JSON.stringify(result));
  const saved = {
    id: "synthetic-latest-candidate",
    value: {
      result: { target_task: "classify_opportunity", result, changes: [] },
      local_validation: { version: 1 },
    },
  };
  const action = vi.fn(async (name: string, payload?: any) => {
    if (name === "result_get") {
      if (payload.key === "candidate-2") return saved;
      if (payload.key === `writer-validation-repair-only-${hash}`)
        return {
          id: "synthetic-rejection",
          value: {
            coverage: "repair_only",
            result: { checked_candidate_hash: hash },
          },
        };
      return null;
    }
    if (name === "result_put") return { id: "synthetic-revalidation" };
    if (name === "recovery_ready" || name === "revalidated_writer_resume")
      return true;
    throw new Error(`Unexpected operation: ${name}`);
  });
  const update = vi.fn(async () => undefined);
  const options: any = {
    task: "classify_opportunity",
    context: { scope_policy: policy },
    evidence: [notice],
    requiredIds: [],
    manifest: [],
    job: { id: "synthetic-job", lease_token: "synthetic-lease" },
    backend: {
      internal: vi.fn(async () => ({ providers: [{}] })),
    },
    store: { action },
    state: {
      next: [],
      values: {
        repairCount: 2,
        candidateRef: saved.id,
        reportRef: "synthetic-rejection",
      },
    },
    update,
  };
  expect(await recoverRevalidatedWriter({ ...options, context: {} })).toBe(
    false,
  );
  expect(update).not.toHaveBeenCalled();
  expect(await recoverRevalidatedWriter(options)).toBe(true);
  expect(update).toHaveBeenCalledWith({ reportRef: "" });
  expect(action).toHaveBeenCalledWith("result_put", {
    key: `writer-local-revalidated-${saved.id}`,
    value: expect.objectContaining({
      candidate_id: saved.id,
      candidate_key: "candidate-2",
      candidate_hash: hash,
      repair_count: 2,
      received_candidate_budgets_unchanged: true,
      new_provider_requests: 0,
    }),
  });
  expect(saved.value.result.result).toEqual(candidate());
});

it.each(["classify_opportunity", "repair_result"] as const)(
  "uses the original configured scope policy when validating a %s response",
  async (task) => {
    const result = candidate();
    const response =
      task === "repair_result"
        ? {
            target_task: "classify_opportunity",
            result,
            changes: ["Preserved the cited scope comparison."],
          }
        : result;
    const context =
      task === "repair_result"
        ? {
            target_task: "classify_opportunity",
            original_context: { scope_policy: policy },
          }
        : { scope_policy: policy };
    const provider = {
      provider: "groq_free" as const,
      model: "synthetic-model",
      project_ref: "synthetic-project",
      enabled: true,
      free_only: false,
      billing_verified: false,
      free_quota_only: false,
      quota_mode: "provider_managed",
      verified_at: new Date().toISOString(),
      quota_ends_at: null,
    };
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(response) },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
    const ledger: any = {
      preflight: async () => ({
        routing_mode: "round_robin",
        providers: [provider],
      }),
      beginAttempt: async () => "synthetic-attempt",
      reserve: async () => "synthetic-usage",
      settle: vi.fn(),
      endAttempt: vi.fn(),
      attempt: vi.fn(),
    };
    expect(
      await executeModel(
        task,
        context,
        [notice],
        [],
        [],
        {
          groq_free: {
            provider: provider.provider,
            model: provider.model,
            projectRef: provider.project_ref,
            key: "synthetic-key",
          },
        },
        ledger,
        "en",
        task === "repair_result",
        send,
        2,
        { semanticRevision: 3 },
      ),
    ).toEqual(response);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledWith("synthetic-usage", {
      input: 100,
      output: 50,
      thinking: null,
    });
  },
);
