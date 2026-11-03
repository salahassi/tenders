// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  evaluate,
  fixtures,
  validateTargets,
  VERIFICATION_LIMITS,
} from "../../scripts/ops/live-model-evaluation.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { modelPrompt } from "../../supabase/functions/_shared/model";

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

function responseFor(p: any) {
  const context = p.untrusted_data;
  const source = p.evidence[0];
  const omitted = source.id === "eval-obligation-source";
  const summary = context.content_units[0].text;
  return {
    checked_candidate_hash: context.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: context.content_units.map((unit: any) => unit.id),
    claims: [
      {
        id: "summary-claim",
        claim: summary,
        candidate_quote: summary,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: source.id, quote: source.text }],
        finding: "The summary accurately reflects the quoted source.",
      },
    ],
    processed_requirement_ids: p.required_ids,
    requirement_checks: [
      {
        requirement_id: source.id,
        status: omitted ? "insufficient" : "supported",
        candidate_quote: summary,
        source_refs: [{ id: source.id, quote: source.text }],
        finding: omitted
          ? "The extraction omits the mandatory delivery deadline and audit log retention requirement."
          : "The reference material contains no current buyer obligations to extract.",
      },
    ],
    findings: [],
  };
}
const asPrompt = (fixture: any) =>
  JSON.parse(
    modelPrompt(
      fixture.task,
      fixture.context,
      fixture.evidence,
      fixture.required,
      fixture.language,
      false,
      fixture.verificationRevision,
      fixture.semanticRevision,
    ),
  );
function transport(mutate: (report: any, p: any) => void = () => {}) {
  return vi.fn(async (_url: any, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body.max_tokens).toBe(4096);
    const p = JSON.parse(body.messages[1].content.split("\nJSON schema: ")[0]);
    expect(p.prompt_version).toContain(
      "tenderdesk-grounding-v4-analysis-boundary",
    );
    expect(p.verification_coverage_contract).toEqual({
      kind: "source_block_extraction",
      required_source_ids: p.required_ids,
      allow_empty_inventory_for_reference_material: true,
    });
    expect(p.untrusted_data).not.toHaveProperty("candidate");
    const report = responseFor(p);
    mutate(report, p);
    return Response.json({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(report) } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 80 },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

it("runs exactly four new requests with real adapter and domain checks while accepting the correct opposite verdicts", async () => {
  expect(VERIFICATION_LIMITS.models).toBe(2);
  expect(VERIFICATION_LIMITS.generations).toBe(4);
  const fetcher = transport();
  const report = await evaluate(
    targets,
    fetcher,
    async () => {},
    undefined,
    "analysis_verification",
  );
  expect(report.passed, JSON.stringify(report.results)).toBe(true);
  expect(report.generations).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(report.production_records_created).toBe(0);
  expect(report.unknown_usage_cases).toBe(0);
  expect(report.results.map((r: any) => [r.model, r.case])).toEqual(
    targets.flatMap((target) => [
      [target.model, "analysis_reference_empty_v4"],
      [target.model, "analysis_obligation_omission_v4"],
    ]),
  );
  expect(
    report.results.every((r: any) => r.attempts[0].status === "SUCCEEDED"),
  ).toBe(true);
});

it("rejects wrong models, missing named model, third model, and OpenAI before transport", async () => {
  for (const invalid of [
    targets.slice(0, 1),
    [targets[0], { ...targets[1], model: "other-qwen" }],
    [...targets, { ...targets[0], model: "third" }],
    [targets[0], { ...targets[1], provider: "openai" }],
  ]) {
    const fetcher = vi.fn();
    expect(() => validateTargets(invalid, "analysis_verification")).toThrow();
    await expect(
      evaluate(invalid, fetcher, undefined, undefined, "analysis_verification"),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("fails a false supported omission verdict and preserves its synthetic candidate privately", async () => {
  const fetcher = transport((r) => {
    r.requirement_checks[0].status = "supported";
    r.requirement_checks[0].finding = "All content is valid.";
  });
  const report = await evaluate(
    targets,
    fetcher,
    async () => {},
    undefined,
    "analysis_verification",
  );
  expect(report.generations).toBe(4);
  expect(report.results.filter((r: any) => r.passed)).toHaveLength(2);
  for (const failure of report.results.filter((r: any) => !r.passed)) {
    expect(failure.code).toBe("EVAL_BUYER_OBLIGATION_OMISSION_UNDETECTED");
    expect(failure.synthetic_candidate.requirement_checks[0].status).toBe(
      "supported",
    );
    expect(failure.usage).toMatchObject({ input: 100, output: 80 });
  }
});

it("does not accept a generic reference false defect as proof that a real obligation was detected", async () => {
  const cases = await fixtures("analysis_verification");
  const empty = responseFor(asPrompt(cases[0]));
  empty.requirement_checks[0].status = "insufficient";
  empty.requirement_checks[0].finding =
    "No buyer requirements exist to verify.";
  expect(() => cases[0].domainValidate(empty)).not.toThrow();
  expect(() => cases[0].assert(empty)).toThrow(
    "EVAL_REFERENCE_INVENTORY_FALSE_DEFECT",
  );
  const missed = responseFor(asPrompt(cases[1]));
  missed.requirement_checks[0].finding =
    "No buyer requirements exist to verify.";
  expect(() => cases[1].domainValidate(missed)).not.toThrow();
  expect(() => cases[1].assert(missed)).toThrow(
    "EVAL_BUYER_OBLIGATION_OMISSION_UNDETECTED",
  );
  missed.requirement_checks[0].status = "supported";
  (missed.findings as any[]).push({
    severity: "blocking",
    code: "OMITTED_BUYER_OBLIGATION",
    detail: "The extraction is missing audit log retention from the source.",
    claim_ids: [],
    requirement_ids: cases[1].required,
  });
  expect(() => cases[1].domainValidate(missed)).not.toThrow();
  expect(() => cases[1].assert(missed)).not.toThrow();
  for (const detail of [
    "The extraction fails to include the delivery deadline.",
    "The extraction lacks audit log retention.",
    "The audit retention extraction is incomplete.",
    "The delivery deadline is absent from the extracted inventory.",
    "The extraction skips audit retention.",
  ]) {
    missed.findings[0] = {
      ...(missed.findings[0] as any),
      detail,
      requirement_ids: [],
      claim_ids: [missed.claims[0].id],
    } as never;
    expect(() => cases[1].domainValidate(missed)).not.toThrow();
    expect(() => cases[1].assert(missed)).not.toThrow();
  }
  (missed.findings[0] as any).claim_ids = [];
  expect(() => cases[1].assert(missed)).toThrow(
    "EVAL_BUYER_OBLIGATION_OMISSION_UNDETECTED",
  );
});

it("uses frozen structural locators without treating their numbers as business quantities", async () => {
  const [fixture] = await fixtures("analysis_verification");
  const report = responseFor(asPrompt(fixture));
  expect(() => fixture.domainValidate(report)).not.toThrow();
  fixture.evidence[0].locator.structural_markers = ["Paragraph 56"];
  expect(() => fixture.domainValidate(report)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
});

it("rejects wrong candidate hashes through the domain validator before recording SUCCEEDED", async () => {
  const fetcher = transport((r) => {
    r.checked_candidate_hash = "0".repeat(64);
  });
  const report = await evaluate(
    targets,
    fetcher,
    async () => {},
    undefined,
    "analysis_verification",
  );
  expect(report.generations).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(
    report.results.every(
      (r: any) => !r.passed && r.code === "MODEL_ROUND_EXHAUSTED",
    ),
    JSON.stringify(report.results),
  ).toBe(true);
  expect(
    report.results.every(
      (r: any) => r.attempts[0].status === "MODEL_COVERAGE_INCOMPLETE",
    ),
  ).toBe(true);
  expect(report.unknown_usage_cases).toBe(0);
});
