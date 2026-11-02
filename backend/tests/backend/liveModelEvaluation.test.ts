// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtures,
  evaluate,
  LIMITS,
  validateTargets,
} from "../../scripts/ops/live-model-evaluation.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { validateModelResult } from "../../supabase/functions/_shared/model";
const target = {
  provider: "qwencloud",
  model: "synthetic-qwen",
  project_ref: "ap-southeast-1",
  key: "private-evaluation-key",
  capabilities: defaultCapabilities("qwencloud"),
};
afterEach(() => vi.restoreAllMocks());
it("covers eight bounded cases, cross-language extraction, failed-quote repair and unsupported factual claims", async () => {
  const cases = await fixtures();
  expect(cases).toHaveLength(8);
  expect(cases.find((x) => x.id === "analysis_en_to_ar")).toMatchObject({
    language: "ar",
    task: "analyze_chunk",
  });
  expect(cases.find((x) => x.id === "analysis_ar_to_en")).toMatchObject({
    language: "en",
    task: "analyze_chunk",
  });
  const repair = cases.find((x) => x.id === "repair_wrong_quote");
  expect(() =>
    validateModelResult(
      "analyze_chunk",
      repair.context.candidate,
      repair.evidence,
      repair.required,
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(LIMITS.generations).toBe(32);
});
it("rejects duplicate targets, unsupported provider and absent credentials before any call", () => {
  expect(() => validateTargets([target, target])).toThrow(
    "EVAL_DUPLICATE_TARGET",
  );
  expect(() =>
    validateTargets([{ ...target, provider: "unapproved" }]),
  ).toThrow("EVAL_TARGET_INVALID");
  expect(() => validateTargets([{ ...target, key: "" }])).toThrow(
    "EVAL_CREDENTIAL_MISSING",
  );
});
it("records real transport rejection as failed cases without leaking credentials or reporting success", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: RequestInit[] = [];
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    calls.push(init!);
    return Response.json(
      { error: { code: "invalid_api_key" } },
      { status: 401 },
    );
  }) as typeof fetch;
  const report = await evaluate([target], fetcher, async () => {});
  expect(report.passed).toBe(false);
  expect(report.generations).toBe(8);
  expect(report.results).toHaveLength(8);
  expect(report.results.every((r: any) => !r.passed)).toBe(true);
  expect(report.production_records_created).toBe(0);
  expect(JSON.stringify(report)).not.toContain(target.key);
  for (const call of calls) {
    expect(call.redirect).toBe("error");
    expect(JSON.parse(call.body as string).max_tokens).toBe(4096);
  }
});
it("does not accept preserved evidence IDs when obligations or quantities changed", async () => {
  const f = (await fixtures()).find((x) => x.id === "analysis_en_to_ar");
  const result = {
    requirements: f.evidence.map((e: any) => ({
      mandatory: false,
      text: "7 days",
      source_refs: [{ id: e.id, quote: e.text }],
    })),
  };
  expect(() => f.assert(result)).toThrow("EVAL_REQUIREMENT_MEANING_CHANGED");
});
it("runs all eight actual prompt and validator paths with independent valid fixture responses", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const responseFor = (p: any) => {
    const analyze = () => ({
      processed_block_ids: p.required_ids,
      requirements: p.evidence.map((e: any, i: number) => ({
        text: p.writing_guide.startsWith("اكتب")
          ? `يجب التنفيذ خلال ${i ? 90 : 30} يومًا`
          : `Required within ${i ? 90 : 30} days`,
        category: "timeline",
        mandatory: true,
        source_refs: [{ id: e.id, quote: e.text }],
        interpretation: "",
        acceptance_evidence: "",
        owner_question: null,
      })),
      questions: [],
      separate_volumes: false,
      summary: "Synthetic requirements",
    });
    const context = p.untrusted_data;
    if (p.task === "connection_probe") return { status: "ready" };
    if (p.task === "analyze_chunk") return analyze();
    if (p.task === "repair_result")
      return {
        target_task: "analyze_chunk",
        result: analyze(),
        changes: ["Fixed source quote."],
      };
    if (p.task === "classify_opportunity")
      return {
        factors: Object.fromEntries(
          ["capability", "scope", "sector", "prerequisite"].map((k) => [
            k,
            {
              rating: null,
              reason: "Company evidence is missing.",
              notice_evidence: [],
              company_evidence: [],
            },
          ]),
        ),
        critical_unknown: true,
        reason_summary: "Missing company proof.",
        missing_information: ["Company proof"],
        risk_flags: [],
        suggested_tags: [],
      };
    if (p.task === "draft_section")
      return {
        key: "delivery",
        title: "خطة التسليم",
        content_blocks: [
          {
            type: "paragraph",
            text: "نقترح مراجعة المتطلبات ثم التنفيذ والاختبار.",
          },
        ],
        requirement_ids: p.required_ids,
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      };
    return {
      checked_candidate_hash: context.candidate_hash,
      reviewed_all_content: true,
      processed_content_ids: ["content-0"],
      claims: [
        {
          id: "claim-1",
          claim: context.candidate.statement,
          candidate_quote: context.candidate.statement,
          kind: "company_fact",
          status: "insufficient",
          source_refs: [],
          finding: "No company evidence.",
        },
      ],
      processed_requirement_ids: [],
      requirement_checks: [],
      findings: [
        {
          severity: "blocking",
          code: "NO_COMPANY_EVIDENCE",
          detail: "Certification not supported.",
          claim_ids: ["claim-1"],
          requirement_ids: [],
        },
      ],
    };
  };
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const prompt = JSON.parse(
      body.messages[1].content.split("\nJSON schema: ")[0],
    );
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(responseFor(prompt)) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    });
  }) as typeof fetch;
  const report = await evaluate([target], fetcher, async () => {});
  expect(
    report.results.map((r: any) => ({ case: r.case, code: r.code })),
  ).toEqual(
    expect.arrayContaining([
      { case: "grounding_unsupported_company_claim", code: "SUCCEEDED" },
    ]),
  );
  expect(report.passed).toBe(true);
  expect(report.generations).toBe(8);
  expect(report.unknown_usage_cases).toBe(0);
});
it.each(["failed", "cancelled"])(
  "bounds background polling on a terminal %s response",
  async (status) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const methods: string[] = [];
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET")
        return Response.json({
          id: "fixture-response",
          status,
          usage: { input_tokens: 2, output_tokens: 0 },
        });
      if (methods.length === 1)
        return Response.json({ id: "fixture-response", status: "queued" });
      return Response.json(
        { error: { code: "invalid_api_key" } },
        { status: 401 },
      );
    }) as typeof fetch;
    const report = await evaluate(
      [
        {
          ...target,
          provider: "openai",
          capabilities: defaultCapabilities("openai"),
        },
      ],
      fetcher,
      async () => {},
    );
    expect(methods.filter((x) => x === "GET")).toHaveLength(1);
    expect(methods.filter((x) => x === "DELETE")).toHaveLength(1);
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].cleanup).toBe("deleted");
    expect(report.generations).toBe(8);
  },
);
