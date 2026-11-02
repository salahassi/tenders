// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  evaluate,
  fixtures,
  EXTENDED_LIMITS,
  validateTargets,
} from "../../scripts/ops/live-model-evaluation.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import {
  modelPrompt,
  sha256,
  validateModelResult,
} from "../../supabase/functions/_shared/model";

const target = {
  provider: "qwencloud",
  model: "synthetic-qwen",
  project_ref: "ap-southeast-1",
  key: "private-evaluation-key",
  capabilities: defaultCapabilities("qwencloud"),
};
afterEach(() => vi.restoreAllMocks());

const planningSections = [
  {
    key: "delivery",
    title: "Delivery and audit",
    purpose: "Address delivery and audit obligations.",
    volume: "technical",
    mode: "narrative",
    requirement_ids: ["req_a", "req_b"],
  },
];
function responseFor(p: any): any {
  const c = p.untrusted_data;
  if (p.task === "plan_proposal")
    return {
      processed_requirement_ids: p.required_ids,
      sections: planningSections.map(({ mode, ...s }) => s),
      questions: [],
    };
  if (p.task === "plan_structure")
    return {
      version: 3,
      sections: planningSections,
      decisions: [],
      questions: [],
    };
  if (p.task === "plan_blueprint")
    return {
      version: 2,
      processed_requirement_ids: c.blueprint_requirement_ids,
      sections: planningSections.map(({ requirement_ids, ...s }) => ({
        ...s,
        units: [
          {
            key: "delivery-unit",
            title: "Delivery and audit",
            purpose: "Respond to both obligations.",
            requirement_ids,
            secondary_links: [],
            decision_ids: [],
            target_words: 250,
          },
        ],
      })),
      decisions: [],
      questions: [],
    };
  if (p.task === "plan_commercial")
    return {
      lines: [
        {
          description: "Training workshops",
          quantity: "2",
          unit: "workshop",
          rate_id: "eval-approved-workshop-rate",
          period_count: null,
          included_in_base: true,
          charge_group: "one_time",
          tax_category: "",
          requirement_ids: ["req_workshops"],
          section_ids: ["delivery"],
          deliverable: "Two workshops",
          basis: "Explicit buyer quantity and supplied approved rate.",
        },
        {
          description: "Portal support",
          quantity: null,
          unit: "",
          rate_id: null,
          period_count: null,
          included_in_base: true,
          charge_group: "recurring",
          tax_category: "",
          requirement_ids: ["req_support"],
          section_ids: ["delivery"],
          deliverable: "Support",
          basis: "Rate, quantity and period not supplied.",
        },
      ],
      tasks: [],
      questions: [
        {
          question:
            "Confirm the support rate, quantity, period and tax treatment.",
          blocking_level: "finalization",
          requirement_ids: ["req_support"],
        },
      ],
    };
  if (p.task === "review_proposal")
    return {
      processed_requirement_ids: p.required_ids,
      responses: p.required_ids.map((id: string) => ({
        requirement_id: id,
        status: id === "req_a" ? "answered" : "missing",
        section_ids: ["delivery"],
        evidence_refs: [],
        rationale:
          id === "req_a"
            ? "The prose proposes delivery in 30 days."
            : "The draft does not address audit retention.",
      })),
      findings: [
        {
          severity: "blocking",
          category: "coverage",
          detail: "Add the audit retention response.",
          section_ids: ["delivery"],
          requirement_ids: ["req_b"],
        },
      ],
    };
  if (p.task === "summarize_review")
    return {
      processed_review_ids: p.required_ids,
      directives: p.evidence.map((e: any, i: number) => ({
        instruction: i
          ? "أضف استجابة الاحتفاظ بالسجل لمدة ٩٠ يومًا"
          : "أبقِ مدة التسليم ثلاثين يومًا",
        source_refs: [{ id: e.id, quote: e.text }],
      })),
      questions: [],
    };
  if (p.task === "inspect_source_page")
    return {
      page_kind: "listing",
      reason_quote: "Open procurement notices.",
      notices: [
        {
          title: "Public portal implementation",
          link_id: "L1",
          reference: "EVAL-2026-01",
          buyer: "Example City Authority",
          deadline_raw: "2026-12-15",
          evidence_quote:
            "Reference: EVAL-2026-01. Public portal implementation. Submission deadline: 2026-12-15.",
        },
      ],
      follow_link_id: null,
      candidate_link_ids: [],
    };
  return {
    processed_block_ids: p.required_ids,
    requirements: p.evidence
      .filter((e: any) => e.kind === "rfp")
      .map((e: any) => ({
        text: `The portal must record audit event ${e.text.match(/EV\d{2}/)[0]}.`,
        category: "security",
        mandatory: true,
        source_refs: [{ id: e.id, quote: e.text.split(".")[0] + "." }],
        interpretation: "",
        acceptance_evidence: "",
        owner_question: null,
      })),
    questions: [],
    separate_volumes: false,
    summary: "Eight mandatory audit events.",
  };
}
const prompt = (f: any) =>
  JSON.parse(
    modelPrompt(
      f.task,
      f.context,
      f.evidence,
      f.required,
      f.language,
      false,
      2,
      f.task === "analyze_chunk" ? 4 : 2,
    ),
  );

it("rejects unknown suites, OpenAI and more than two models before extended transport", async () => {
  expect(EXTENDED_LIMITS.generations).toBe(16);
  expect(() =>
    validateTargets([{ ...target, provider: "openai" }], "extended"),
  ).toThrow("EVAL_TARGET_INVALID");
  expect(() =>
    validateTargets(
      [target, { ...target, model: "q2" }, { ...target, model: "q3" }],
      "extended",
    ),
  ).toThrow("EVAL_TARGET_COUNT_INVALID");
  expect(() => validateTargets([target], "invalid" as any)).toThrow(
    "EVAL_SUITE_INVALID",
  );
  const fetcher = vi.fn();
  await expect(
    evaluate(
      [{ ...target, provider: "openai" }],
      fetcher,
      undefined,
      undefined,
      "extended",
    ),
  ).rejects.toThrow("EVAL_TARGET_INVALID");
  expect(fetcher).not.toHaveBeenCalled();
});

it("runs every remaining primary task family with actual adapter and canonical/domain validators within sixteen calls", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    expect(body.max_tokens).toBe(4096);
    const p = JSON.parse(body.messages[1].content.split("\nJSON schema: ")[0]);
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(responseFor(p)) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    });
  }) as typeof fetch;
  const report = await evaluate(
    [target, { ...target, model: "qwen-second" }],
    fetcher,
    async () => {},
    undefined,
    "extended",
  );
  expect(report.results.map((r: any) => [r.case, r.code])).toEqual(
    expect.arrayContaining([["proposal_blueprint_ownership", "SUCCEEDED"]]),
  );
  expect(
    report.passed,
    JSON.stringify(report.results.filter((r: any) => !r.passed)),
  ).toBe(true);
  expect(report.suite).toBe("extended");
  expect(report.generations).toBe(16);
  expect(report.production_records_created).toBe(0);
  expect(report.unknown_usage_cases).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(16);
  expect(new Set(report.results.map((r: any) => r.task))).toEqual(
    new Set([
      "plan_proposal",
      "plan_structure",
      "plan_blueprint",
      "plan_commercial",
      "review_proposal",
      "summarize_review",
      "inspect_source_page",
      "analyze_chunk",
    ]),
  );
});

it("rejects semantic mutations that can still satisfy the JSON schema", async () => {
  const cases = await fixtures("extended");
  const mutate = (task: string, change: (r: any) => void, error: string) => {
    const f = cases.find((x: any) => x.task === task)!;
    const value = structuredClone(responseFor(prompt(f)));
    change(value);
    // These defects need the domain or golden checks in addition to JSON parsing.
    expect(() => f.assert(value)).toThrow(error);
  };
  mutate(
    "plan_structure",
    (r) => r.sections.push({ ...r.sections[0], key: "duplicate-owner" }),
    "MODEL_COVERAGE_INCOMPLETE",
  );
  mutate(
    "plan_blueprint",
    (r) => {
      r.sections[0].units[0].requirement_ids = ["req_a"];
    },
    "MODEL_COVERAGE_INCOMPLETE",
  );
  mutate(
    "plan_commercial",
    (r) => {
      r.lines[1].rate_id = "eval-approved-workshop-rate";
    },
    "EVAL_UNKNOWN_COMMERCIAL_INPUT_INVENTED",
  );
  mutate(
    "plan_commercial",
    (r) => {
      r.lines[0].charge_group = "recurring";
    },
    "EVAL_KNOWN_COMMERCIAL_INPUT_LOST",
  );
  mutate(
    "plan_commercial",
    (r) => {
      r.lines[0].section_ids = ["invented-section"];
    },
    "EVAL_COMMERCIAL_REFERENCE_INVALID",
  );
  mutate(
    "review_proposal",
    (r) => {
      r.responses[1].status = "answered";
    },
    "EVAL_MISSING_RESPONSE_ACCEPTED",
  );
  mutate(
    "review_proposal",
    (r) => {
      r.responses[0].section_ids = ["invented-section"];
    },
    "EVIDENCE_REFERENCE_INVALID",
  );
  mutate(
    "summarize_review",
    (r) => {
      r.directives[0].instruction = "Shorten delivery to 7 days.";
    },
    "EVAL_REVIEW_DIRECTIVE_OMITTED",
  );
  mutate(
    "inspect_source_page",
    (r) => {
      r.notices[0].link_id = "L2";
    },
    "EVAL_NOTICE_FIELDS_CHANGED",
  );
  mutate(
    "analyze_chunk",
    (r) => {
      r.requirements[0].text = "Record event EV010.";
    },
    "EVAL_LONG_REQUIREMENT_OMITTED",
  );
  const long = cases.find((x: any) => x.task === "analyze_chunk")!;
  const valid = responseFor(prompt(long));
  expect(() =>
    validateModelResult(long.task, valid, long.evidence, long.required),
  ).not.toThrow();
  valid.requirements[0].source_refs = [
    {
      id: "eval-company",
      quote: long.evidence.find((e: any) => e.kind === "company").text,
    },
  ];
  expect(() =>
    validateModelResult(long.task, valid, long.evidence, long.required),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("preserves the exact eight core prompts from the completed live evaluation", async () => {
  const expected = [
    "be2af24bb7145fa907f63871903c0bf38b7c0fd97f95a4816714b82a005aaea8",
    "438fe54a6d4199a35742cb41d445f678c1158ffc2e15c1ca973cfe7d2e869bbb",
    "c44637a21c866a36e8484ab7219a4bc466b57e0308eed6571d5eb1cbc90ef2f5",
    "5d8707c0f1742d6d851bed7a026fd31252a6c9817d995f7ca034116dc4880a4a",
    "9bdd6429e1013fa0bd919cda4d07477fe6c31bec1196d74620bd09ee0ba6c14d",
    "56e86ea250a1987df6e9cd4bf53808e35eee6f147a1951df6bac436dddb13a34",
    "e55da98dad9331419548125387145f1ebc20eef92700913351ea3d2e3835410f",
    "9d48438a4324c512c04e48012d1d38b39e5231a09d8ad5a041c8bc2219d8209f",
  ];
  const hashes = await Promise.all(
    (await fixtures()).map((f) =>
      sha256(
        modelPrompt(
          f.task,
          f.context,
          f.evidence,
          f.required,
          f.language,
          f.task === "repair_result",
          2,
          ["analyze_chunk", "repair_result"].includes(f.task)
            ? 4
            : f.task === "classify_opportunity"
              ? 3
              : 2,
        ),
      ),
    ),
  );
  expect(hashes).toEqual(expected);
});
