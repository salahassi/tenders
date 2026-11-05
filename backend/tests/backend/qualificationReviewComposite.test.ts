import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildReviewComposite,
  compileReviewComposite,
  projectReviewComposite,
  reviewCompositeCoverage,
} from "../../scripts/qualification/reserve-review-composites.ts";
import {
  buildReserveAdapter,
  buildReserveReviewSegment,
} from "../../scripts/qualification/reserve-adapters.ts";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract.ts";
import type { ModelConfiguration } from "../../supabase/functions/_shared/model.ts";

const configuration: ModelConfiguration = {
  provider: "qwencloud",
  model: "synthetic-offline-model",
  project_ref: "synthetic-offline-project",
  enabled: true,
  automatic: true,
  free_only: false,
  billing_verified: true,
  free_quota_only: false,
  verified_at: "2026-11-04T00:00:00Z",
  quota_ends_at: null,
  quota_mode: "provider_managed",
  connection_id: "synthetic-connection",
  model_config_id: "synthetic-config",
  capabilities: defaultCapabilities("qwencloud"),
  profile: {
    revision: 1,
    max_output_tokens: 4096,
    reasoning: "none",
    require_native_strict: false,
  },
};
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const caseId = (language: string) =>
  `qr1.summarize_review.review_identity.${language}`;
async function fixture(language = "en") {
  const plan = await buildReviewComposite(caseId(language));
  const [first, second] = plan.segments.map((s) => s.evidence[0]);
  // Authored controls use exact source wording. These are neither model outputs
  // nor semantic judgments and cannot establish semantic qualification.
  const observations: any[] = [
    {
      index: 0,
      status: "completed",
      output: {
        processed_review_ids: [first.id],
        directives: [
          {
            instruction: first.text,
            source_refs: [{ id: first.id, quote: first.text }],
          },
        ],
        questions: [],
      },
    },
    {
      index: 1,
      status: "completed",
      output: {
        processed_review_ids: [second.id],
        directives: [],
        questions: [
          {
            question: second.text,
            blocking_level: "finalization",
            requirement_ids: [],
          },
        ],
      },
    },
  ];
  return { plan, observations, first, second };
}
it("keeps100 logical cells while exposing92 physical requests for88 constructible cells and12 unsupported cells", async () => {
  const value = await reviewCompositeCoverage();
  expect(value).toMatchObject({
    logical_cells_per_model: 100,
    constructible_logical_cells: 88,
    constructible_physical_requests: 92,
    unsupported_logical_cells: 12,
    live_activation_authorized: false,
    existing_activation_contract_compatible: false,
  });
  expect(value.cases).toHaveLength(50);
  expect(
    value.cases.filter(
      (r) => r.status === "offline_two_request_composite_constructible",
    ),
  ).toHaveLength(2);
  expect(
    value.cases.filter(
      (r) => r.status === "offline_single_request_constructible",
    ),
  ).toHaveLength(42);
});
it.each(["en", "ar"])(
  "compiles the%s pair as two independently pinned exact canonical requests without gold",
  async (language) => {
    const { plan } = await fixture(language);
    const compiled = await compileReviewComposite(plan, configuration);
    expect(compiled).toMatchObject({
      physical_requests_per_repetition: 2,
      logical_cells_per_repetition: 1,
      automatic_retries: 0,
      provider_calls: 0,
      reservations: 0,
      semantic_qualification: "not_evaluated",
      existing_activation_contract_compatible: false,
    });
    expect(new Set(compiled.request_pins.map((r) => r.input_sha256)).size).toBe(
      2,
    );
    for (const [index, segment] of plan.segments.entries()) {
      expect(segment.evidence).toHaveLength(1);
      expect(segment.trace.composite_segment.frozen_review_ids).toHaveLength(2);
      expect(compiled.requests[index].request.prompt).toContain(
        segment.evidence[0].text,
      );
      expect(compiled.requests[index].request.prompt).not.toContain(
        plan.segments[1 - index].evidence[0].text,
      );
      expect(compiled.requests[index].request.prompt).not.toMatch(
        /required_meaning|critical_gate|review_identity|qr1\./,
      );
    }
    await expect(buildReserveAdapter(caseId(language))).rejects.toThrow(
      "COMPOSITE_PRODUCTION_REQUEST_REQUIRED",
    );
  },
);
it.each(["en", "ar"])(
  "keeps%s rollback source and feasibility uncertainty separate through actual downstream assembly",
  async (language) => {
    const { plan, observations, first, second } = await fixture(language);
    const projected = await projectReviewComposite(plan, observations);
    expect(projected.status).toBe("completed");
    if (projected.status !== "completed")
      throw Error("Expected complete controlled projection");
    expect(projected.aggregate).toEqual({
      processed_review_ids: [first.id, second.id],
      directives: observations[0].output.directives,
      questions: observations[1].output.questions,
    });
    expect(projected.lineage).toMatchObject([
      { request_index: 0, review_id: first.id, kind: "directives" },
      { request_index: 1, review_id: second.id, kind: "questions" },
    ]);
    expect(
      projected.downstream_planning_context.review_directives,
    ).toMatchObject([
      {
        instruction: first.text,
        review_id: first.id,
        source_refs: [{ id: first.id, quote: first.text }],
      },
    ]);
    // Current taskInput forwards directives to planning, while questions retain
    // their constituent output/lineage for finalization; no fabricated directive.
    expect(
      projected.downstream_planning_context.review_directives,
    ).toHaveLength(1);
    expect(projected.semantic_qualification).toBe("not_evaluated");
  },
);
it.each([
  "swapped_processed_id",
  "foreign_quote_source",
  "invented_quote",
  "nonempty_question_ids",
])("rejects composite constituent%s", async (fault) => {
  const { plan, observations, second } = await fixture();
  if (fault === "swapped_processed_id")
    observations[0].output.processed_review_ids = [second.id];
  if (fault === "foreign_quote_source")
    observations[0].output.directives[0].source_refs[0].id = second.id;
  if (fault === "invented_quote")
    observations[0].output.directives[0].source_refs[0].quote =
      "invented promise";
  if (fault === "nonempty_question_ids")
    observations[1].output.questions[0].requirement_ids = [
      "invented-requirement",
    ];
  await expect(projectReviewComposite(plan, observations)).rejects.toThrow();
});
it.each([
  "missing",
  "duplicate",
  "reordered",
  "unrecognized_status",
  "extra_field",
])(
  "rejects%s receipts without shrinking or aliasing a physical slot",
  async (fault) => {
    const { plan, observations } = await fixture();
    if (fault === "missing") observations.pop();
    if (fault === "duplicate") observations[1] = observations[0];
    if (fault === "reordered") observations.reverse();
    if (fault === "unrecognized_status")
      observations[1].status = "assumed_complete";
    if (fault === "extra_field") observations[1].providerApproved = true;
    await expect(projectReviewComposite(plan, observations)).rejects.toThrow();
  },
);
it.each([
  "unavailable",
  "transport_error",
  "refused",
  "invalid_output",
  "not_attempted",
] as const)(
  "preserves failed%s child and exposes no partial success aggregate",
  async (status) => {
    const { plan, observations } = await fixture();
    observations[1] = { index: 1, status };
    const result = await projectReviewComposite(plan, observations);
    expect(result).toMatchObject({
      status: "incomplete",
      aggregate: null,
      downstream_planning_context: null,
      observations: [
        { index: 0, status: "completed" },
        { index: 1, status },
      ],
    });
  },
);
it("retains unattempted sibling after early failure without retrying or calling providers", async () => {
  const { plan } = await fixture();
  const result = await projectReviewComposite(plan, [
    { index: 0, status: "unavailable" },
    { index: 1, status: "not_attempted" },
  ]);
  expect(result.status).toBe("incomplete");
  expect(result.observations).toHaveLength(2);
});
it("rejects a foreign review identifier with its exact valid foreign quote at the selected request boundary", async () => {
  const { plan, observations, second } = await fixture();
  observations[0].output.directives[0].source_refs[0] = {
    id: second.id,
    quote: second.text,
  };
  await expect(projectReviewComposite(plan, observations)).rejects.toThrow();
});
it("preserves deeply frozen accepted observations and constituent hashes", async () => {
  const { plan, observations } = await fixture();
  const before = JSON.stringify(observations);
  function freeze(value: any) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  freeze(observations);
  const first = await projectReviewComposite(plan, observations);
  const second = await projectReviewComposite(plan, observations);
  expect(JSON.stringify(observations)).toBe(before);
  expect(first.constituent_output_sha256).toEqual(
    second.constituent_output_sha256,
  );
  expect(first.aggregate).toEqual(second.aggregate);
});
it("captures canonical case identity and constituent snapshots before caller mutations across awaits", async () => {
  const { plan, observations, first, second } = await fixture();
  const compiledPending = compileReviewComposite(plan, configuration);
  const projectedPending = projectReviewComposite(plan, observations);
  plan.case_id = caseId("ar");
  plan.segments.reverse();
  observations[1].output.questions[0].question =
    "Mutated after observation began";
  const [compiled, projected] = await Promise.all([
    compiledPending,
    projectedPending,
  ]);
  expect(compiled.case_id).toBe(caseId("en"));
  expect(compiled.request_pins.map((r) => r.source_review_id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(projected.lineage?.map((r) => r.review_id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(projected.aggregate?.questions[0].question).toBe(second.text);
});
it("validates and hashes a completed child even when its sibling failed", async () => {
  const { plan, observations } = await fixture();
  observations[1] = { index: 1, status: "transport_error" };
  const result = await projectReviewComposite(plan, observations);
  expect(result.observations[0]).toMatchObject({
    index: 0,
    status: "completed",
    canonical_validation: "passed",
    output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(result.aggregate).toBeNull();
  observations[0].output.directives[0].source_refs[0].quote = "invalid quote";
  await expect(projectReviewComposite(plan, observations)).rejects.toThrow();
});
it.each([
  "clone",
  "mutated_input",
  "reordered",
  "validator_swap",
  "retry_expansion",
])("rejects%s changes to the minted composite", async (fault) => {
  const { plan } = await fixture();
  if (fault === "clone")
    return expect(
      compileReviewComposite({ ...plan }, configuration),
    ).rejects.toThrow("RESERVE_COMPOSITE_CHANGED");
  if (fault === "mutated_input")
    plan.segments[0].context.target_id = "another-target";
  if (fault === "reordered") plan.segments.reverse();
  if (fault === "validator_swap") plan.segments[0].domainValidate = () => {};
  if (fault === "retry_expansion") (plan as any).automatic_retries = 1;
  await expect(compileReviewComposite(plan, configuration)).rejects.toThrow();
});
it.each([-1, 2, 0.5, NaN])("rejects invalid segment index%s", async (index) => {
  await expect(buildReserveReviewSegment(caseId("en"), index)).rejects.toThrow(
    "RESERVE_REVIEW_COMPOSITE_SELECTION_INVALID",
  );
});
it("cannot retarget a composite segment constructor to a different frozen scenario", async () => {
  await expect(
    buildReserveReviewSegment("qr1.summarize_review.advisory_note.en", 0),
  ).rejects.toThrow("RESERVE_REVIEW_COMPOSITE_SELECTION_INVALID");
});
