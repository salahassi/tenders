// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  evaluate,
  fixtures,
  limitsForSuite,
  validateTargets,
} from "../../scripts/ops/live-model-evaluation.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";

const targets = ["deepseek-v4-pro", "qwen3.8-max"].map((model) => ({
  provider: "qwencloud",
  model,
  project_ref: "ap-southeast-1",
  key: "synthetic-private-key",
  capabilities: defaultCapabilities("qwencloud"),
}));
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const prompt = (f: any) =>
  modelPrompt(
    f.task,
    f.context,
    f.evidence,
    f.required,
    f.language,
    false,
    f.verificationRevision,
    f.semanticRevision,
  );
function responseFor(p: any) {
  const c = p.untrusted_data,
    source = p.evidence[0];
  const strengthened = c.candidate.requirements[0].mandatory;
  const quote = c.candidate.requirements[0].text;
  return {
    checked_candidate_hash: c.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: c.content_units.map((u: any) => u.id),
    claims: [
      {
        id: "workshop-claim",
        claim: quote,
        candidate_quote: quote,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: source.id, quote: source.text }],
        finding: "The prose preserves the optional requested workshop.",
      },
    ],
    processed_requirement_ids: p.required_ids,
    requirement_checks: [
      {
        requirement_id: source.id,
        status: strengthened ? "contradicted" : "supported",
        candidate_quote: quote,
        source_refs: [{ id: source.id, quote: source.text }],
        finding: strengthened
          ? "The structured mandatory flag incorrectly strengthens the optional workshop into a mandatory obligation."
          : "The optional requested workshop and advisory question faithfully retain the buyer brief's authority.",
      },
    ],
    findings: [],
  };
}
function transport(mutate: (r: any, p: any) => void = () => {}) {
  return vi.fn(async (_url: any, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body.max_tokens).toBe(4096);
    const p = JSON.parse(body.messages[1].content.split("\nJSON schema: ")[0]);
    expect(p.prompt_version).toContain(
      "tenderdesk-grounding-v4-analysis-boundary",
    );
    expect(p.untrusted_data.response_style).toBe("compact-verification-v3");
    expect(p.untrusted_data).not.toHaveProperty("candidate_text");
    expect(p.untrusted_data.candidate.requirements[0].mandatory).toBeTypeOf(
      "boolean",
    );
    expect(
      p.untrusted_data.candidate.requirements[0].owner_question,
    ).toBeNull();
    const report = responseFor(p);
    mutate(report, p);
    return Response.json({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(report) } },
      ],
      usage: { prompt_tokens: 110, completion_tokens: 90 },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

it("uses the production format3 pin and isolates changed typed authority fields", async () => {
  const [supported, strengthened] = await fixtures("analysis_authority");
  const expected = structuredClone(supported.context.candidate);
  expected.requirements[0].mandatory = true;
  expected.questions[0].blocking_level = "generation";
  expect(strengthened.context.candidate).toEqual(expected);
  expect(supported.context.candidate.questions[0].blocking_level).toBe(
    "advisory",
  );
  expect(strengthened.evidence).toEqual(supported.evidence);
  expect(strengthened.context.original_context).toEqual(
    supported.context.original_context,
  );
  for (const f of [supported, strengthened]) {
    expect(f.context.candidate_hash).toBe(
      await sha256(JSON.stringify(f.context.candidate)),
    );
    expect(f.context.response_style).toBe("compact-verification-v3");
    expect(f.context).not.toHaveProperty("candidate_text");
    expect(f.verificationRevision).toBe(4);
    expect(f.semanticRevision).toBe(4);
    expect(() =>
      f.domainValidate(responseFor(JSON.parse(prompt(f)))),
    ).not.toThrow();
  }
});

it("runs exactly four real-adapter/domain-validation requests and records exact prompt hashes", async () => {
  expect(limitsForSuite("analysis_authority")).toMatchObject({
    models: 2,
    generations: 4,
  });
  const fetcher = transport();
  const report = await evaluate(
    targets,
    fetcher,
    async () => {},
    undefined,
    "analysis_authority",
  );
  expect(report.passed, JSON.stringify(report.results)).toBe(true);
  expect(report.generations).toBe(4);
  expect(report.requests).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(report.production_records_created).toBe(0);
  expect(report.unknown_usage_cases).toBe(0);
  const cases = await fixtures("analysis_authority");
  expect(report.results.map((r: any) => [r.model, r.case])).toEqual(
    targets.flatMap((t) => cases.map((f) => [t.model, f.id])),
  );
  for (const r of report.results) {
    const f = cases.find((f) => f.id === r.case);
    expect(r.prompt_sha256).toBe(await sha256(prompt(f)));
    expect(r.attempts[0].status).toBe("SUCCEEDED");
  }
});

it("rejects unselected providers/models/counts before any transport", async () => {
  for (const invalid of [
    targets.slice(0, 1),
    [targets[0], targets[0]],
    [targets[0], { ...targets[1], model: "other-qwen" }],
    [...targets, targets[0]],
    [targets[0], { ...targets[1], provider: "openai" }],
  ]) {
    const fetcher = vi.fn();
    expect(() => validateTargets(invalid, "analysis_authority")).toThrow();
    await expect(
      evaluate(invalid, fetcher, undefined, undefined, "analysis_authority"),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("fails a false supported authority verdict with known usage and private diagnostic evidence", async () => {
  const report = await evaluate(
    targets,
    transport((r) => {
      r.requirement_checks[0].status = "supported";
      r.requirement_checks[0].finding = "Everything is supported.";
    }),
    async () => {},
    undefined,
    "analysis_authority",
  );
  expect(report.generations).toBe(4);
  expect(report.results.filter((r: any) => r.passed)).toHaveLength(2);
  for (const r of report.results.filter((r: any) => !r.passed)) {
    expect(r.code).toBe("EVAL_OPTIONAL_AUTHORITY_STRENGTHENING_UNDETECTED");
    expect(r.synthetic_candidate.requirement_checks[0].status).toBe(
      "supported",
    );
    expect(r.usage).toMatchObject({ input: 110, output: 90 });
  }
});

it("requires precise source-associated authority defects and allows claim-linked canonical findings", async () => {
  const [good, bad] = await fixtures("analysis_authority");
  const positive = responseFor(JSON.parse(prompt(good)));
  positive.requirement_checks[0].status = "insufficient";
  expect(() => good.domainValidate(positive)).not.toThrow();
  expect(() => good.assert(positive)).toThrow(
    "EVAL_OPTIONAL_SCOPE_FALSE_DEFECT",
  );
  const negative = responseFor(JSON.parse(prompt(bad)));
  negative.requirement_checks[0].finding =
    "The mandatory flag is unsupported by the buyer brief.";
  expect(() => bad.domainValidate(negative)).not.toThrow();
  expect(() => bad.assert(negative)).not.toThrow();
  negative.requirement_checks[0].finding =
    "The extraction omitted the requested optional workshop.";
  expect(() => bad.domainValidate(negative)).not.toThrow();
  expect(() => bad.assert(negative)).toThrow(
    "EVAL_OPTIONAL_AUTHORITY_STRENGTHENING_UNDETECTED",
  );
  negative.requirement_checks[0].finding =
    "There is no formal RFP, so generation must stop.";
  expect(() => bad.domainValidate(negative)).not.toThrow();
  expect(() => bad.assert(negative)).toThrow(
    "EVAL_OPTIONAL_AUTHORITY_STRENGTHENING_UNDETECTED",
  );
  negative.requirement_checks[0].status = "supported";
  (negative.findings as any[]).push({
    severity: "blocking",
    code: "OPTIONAL_SCOPE_STRENGTHENED",
    detail:
      "The optional workshop was incorrectly marked mandatory in the typed candidate.",
    claim_ids: [negative.claims[0].id],
    requirement_ids: [],
  });
  expect(() => bad.domainValidate(negative)).not.toThrow();
  expect(() => bad.assert(negative)).not.toThrow();
  (negative.findings[0] as any).claim_ids = [];
  expect(() => bad.assert(negative)).toThrow(
    "EVAL_OPTIONAL_AUTHORITY_STRENGTHENING_UNDETECTED",
  );
});

it("runs canonical hash validation before recording provider success and stays within four POSTs", async () => {
  const fetcher = transport((r) => {
    r.checked_candidate_hash = "0".repeat(64);
  });
  const report = await evaluate(
    targets,
    fetcher,
    async () => {},
    undefined,
    "analysis_authority",
  );
  expect(report.generations).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(
    report.results.every(
      (r: any) =>
        !r.passed && r.attempts[0].status === "MODEL_COVERAGE_INCOMPLETE",
    ),
  ).toBe(true);
  expect(report.unknown_usage_cases).toBe(0);
});
