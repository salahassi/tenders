// @vitest-environment node
import { expect, it } from "vitest";
import {
  applySemanticPatch,
  buildSemanticPatchScope,
  semanticPatchOutputSchema,
} from "../../supabase/functions/_shared/modelSemanticPatch";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { validateModelResult } from "../../supabase/functions/_shared/model";
import { typedVerificationFixtures } from "./typedVerificationFixtures";

function analysis() {
  const candidate = structuredClone(
    typedVerificationFixtures.analyze_chunk.candidate,
  );
  candidate.requirements.push({
    ...structuredClone(candidate.requirements[0]),
    text: "A separate supported obligation must remain unchanged.",
    mandatory: true,
  });
  return candidate;
}
const evidence = [
  {
    id: "source",
    kind: "rfp" as const,
    verified: false,
    text: "The buyer requests an optional workshop.",
  },
];
function wire(
  scope: Awaited<ReturnType<typeof buildSemanticPatchScope>>,
  replacements: Record<string, unknown>,
) {
  return {
    version: 1,
    target_task: scope.target_task,
    base_candidate_hash: scope.candidate_hash,
    scope_hash: scope.scope_hash,
    operations: Object.entries(replacements).map(([path, value]) => {
      const allowed = scope.paths.find((item) => item.path === path)!;
      return {
        operation: allowed.operation,
        path,
        unit_id: allowed.unit_id,
        previous_hash: allowed.previous_hash,
        reason_ids: allowed.reason_ids,
        value,
      };
    }),
  };
}
it("returns a real patch wire and applies two quote replacements without rewriting any obligation", async () => {
  const candidate = analysis();
  candidate.requirements[0].source_refs[0].quote = "wrong first quote";
  candidate.requirements[1].source_refs[0].quote = "wrong second quote";
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate,
    diagnostics: [0, 1].map((index) => ({
      code: "EVIDENCE_REFERENCE_INVALID",
      reason: "source_quote_mismatch",
      paths: [`$.requirements[${index}].source_refs[0].quote`],
    })),
  });
  expect(scope.paths.map((item) => item.path)).toEqual([
    "$.requirements[0].source_refs[0].quote",
    "$.requirements[1].source_refs[0].quote",
  ]);
  const schema = semanticPatchOutputSchema(
    scope,
    candidate,
    modelSchemas.analyze_chunk,
  );
  expect(
    schema.safeParse({
      target_task: "analyze_chunk",
      result: candidate,
      changes: [],
    }).success,
  ).toBe(false);
  const patch = wire(
    scope,
    Object.fromEntries(
      scope.paths.map((item) => [item.path, evidence[0].text]),
    ),
  );
  const applied = await applySemanticPatch(
    candidate,
    patch,
    scope,
    modelSchemas.analyze_chunk,
  );
  expect(
    applied.result.requirements.map((item: any) => [item.text, item.mandatory]),
  ).toEqual(
    candidate.requirements.map((item: any) => [item.text, item.mandatory]),
  );
  expect(candidate.requirements[0].source_refs[0].quote).toBe(
    "wrong first quote",
  );
  expect(() =>
    validateModelResult("analyze_chunk", applied.result, evidence, ["source"]),
  ).not.toThrow();
  expect(applied.receipt.candidate_hash).not.toBe(scope.candidate_hash);
  expect(applied.receipt.base_candidate_hash).toBe(scope.candidate_hash);
});
it("expands an identified semantic unit with recorded dependencies while preserving a separate requirement", async () => {
  const candidate = analysis();
  candidate.requirements[0].mandatory = true;
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate,
    trustedFindings: true,
    findings: [
      {
        candidate_quote: candidate.requirements[0].text,
        kind: "tender_fact",
        status: "contradicted",
        detail: "Optional work was promoted to mandatory.",
      },
    ],
  });
  expect(scope.paths.map((item) => item.path)).toContain(
    "$.requirements[0].mandatory",
  );
  expect(
    scope.paths.every((item) => !item.path.startsWith("$.requirements[1]")),
  ).toBe(true);
  const patch = wire(scope, {
    "$.requirements[0].mandatory": false,
    "$.requirements[0].interpretation":
      "The workshop is permitted, not required.",
  });
  const applied = await applySemanticPatch(
    candidate,
    patch,
    scope,
    modelSchemas.analyze_chunk,
  );
  expect(applied.result.requirements[0].mandatory).toBe(false);
  expect(applied.result.requirements[1]).toEqual(candidate.requirements[1]);
  expect(
    applied.receipt.applied.every((item) =>
      item.dependencies.some(
        (dependency) =>
          dependency.reason === "same_requirements_semantic_dependency",
      ),
    ),
  ).toBe(true);
});
it("does not let the model widen quote-only scope, change its base/unit identity, duplicate a patch, reorder or delete requirements", async () => {
  const candidate = analysis(),
    path = "$.requirements[0].source_refs[0].quote";
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate,
    diagnostics: [
      {
        code: "EVIDENCE_REFERENCE_INVALID",
        reason: "source_quote_mismatch",
        paths: [path],
      },
    ],
  });
  const valid = wire(scope, { [path]: evidence[0].text });
  const bad = [
    { ...valid, base_candidate_hash: "0".repeat(64) },
    { ...valid, scope_hash: "0".repeat(64) },
    {
      ...valid,
      operations: [{ ...valid.operations[0], unit_id: "0".repeat(64) }],
    },
    {
      ...valid,
      operations: [{ ...valid.operations[0], previous_hash: "0".repeat(64) }],
    },
    {
      ...valid,
      operations: [
        {
          ...valid.operations[0],
          path: "$.requirements[0].mandatory",
          value: false,
        },
      ],
    },
    {
      ...valid,
      operations: [
        {
          ...valid.operations[0],
          operation: "remove",
          path: "$.requirements[0]",
          value: null,
        },
      ],
    },
    { ...valid, operations: [valid.operations[0], valid.operations[0]] },
    {
      ...valid,
      dependency_requests: [
        { path: "$.requirements[1]", reason: "model prefers" },
      ],
    },
  ];
  for (const proposed of bad)
    await expect(
      applySemanticPatch(
        candidate,
        proposed,
        scope,
        modelSchemas.analyze_chunk,
      ),
    ).rejects.toThrow();
  await expect(
    applySemanticPatch(
      { ...candidate, requirements: [...candidate.requirements].reverse() },
      valid,
      scope,
      modelSchemas.analyze_chunk,
    ),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
});
it("keeps unresolved and overflow findings visible without granting broad document scope", async () => {
  const candidate = analysis();
  const ambiguous = candidate.requirements[0].text;
  candidate.requirements[1].text = ambiguous;
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate,
    omittedDiagnosticCount: 7,
    trustedFindings: true,
    findings: [
      { candidate_quote: ambiguous, detail: "Cannot uniquely locate." },
      { severity: "blocking", detail: "No source or candidate locator." },
    ],
  });
  expect(scope.paths).toEqual([]);
  expect(scope.omitted_diagnostic_count).toBe(7);
  expect(scope.unresolved_finding_ids).toEqual(["finding-0", "finding-1"]);
  expect(() =>
    semanticPatchOutputSchema(scope, candidate, modelSchemas.analyze_chunk),
  ).toThrow("MODEL_CORRECTION_EXHAUSTED");
});
it("removes an unsupported company declaration only alongside an explicitly scoped narrative/question correction", async () => {
  const candidate = structuredClone(
    typedVerificationFixtures.draft_section.candidate,
  );
  const claim = "We hold the current synthetic certification.";
  candidate.content_blocks = [{ type: "paragraph", text: claim }];
  candidate.company_claims = [
    { claim, source_id: "unverified", quote: "Style example" },
  ];
  const scope = await buildSemanticPatchScope({
    task: "draft_section",
    candidate,
    diagnostics: [
      {
        code: "UNSUPPORTED_COMPANY_CLAIM",
        reason: "unsupported_company_claim",
        paths: ["$.company_claims[0].claim"],
      },
    ],
  });
  expect(
    scope.paths.find((item) => item.path === "$.company_claims[0]")?.operation,
  ).toBe("remove");
  const proposed = wire(scope, {
    "$.company_claims[0]": null,
    "$.content_blocks[0].text":
      "Certification evidence must be confirmed before making a credential claim.",
    "$.questions": {
      question: "Please provide current certification evidence.",
      blocking_level: "finalization",
      requirement_ids: [],
    },
  });
  const applied = await applySemanticPatch(
    candidate,
    proposed,
    scope,
    modelSchemas.draft_section,
  );
  expect(applied.result.company_claims).toEqual([]);
  expect(applied.result.questions).toHaveLength(candidate.questions.length + 1);
  expect(applied.result.content_blocks[0].text).not.toBe(claim);
  await expect(
    applySemanticPatch(
      candidate,
      wire(scope, { "$.company_claims[0]": null }),
      scope,
      modelSchemas.draft_section,
    ),
  ).rejects.toThrow("MODEL_OUTPUT_INVALID");
  expect(() =>
    validateModelResult("draft_section", applied.result, [], [], {
      independentGrounding: true,
    }),
  ).not.toThrow();
});
it("ignores untrusted verifier hints when constructing authority to edit", async () => {
  const candidate = analysis();
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate,
    findings: [{ candidate_quote: candidate.requirements[0].text }],
    trustedFindings: false,
  });
  expect(scope.paths).toEqual([]);
});

it("appends a missing planning unit without allowing an existing section to disappear", async () => {
  const candidate = structuredClone(
    typedVerificationFixtures.plan_structure.candidate,
  );
  const scope = await buildSemanticPatchScope({
    task: "plan_structure",
    candidate,
    diagnostics: [
      {
        code: "MODEL_COVERAGE_INCOMPLETE",
        reason: "required_content_missing",
        paths: ["$.sections"],
        requirement_ids: ["R2"],
      },
    ],
  });
  expect(scope.paths[0].operation).toBe("append");
  const section = {
    ...candidate.sections[0],
    key: "new-unit",
    requirement_ids: ["R2"],
  };
  const patch = wire(scope, { "$.sections": section });
  const applied = await applySemanticPatch(
    candidate,
    patch,
    scope,
    modelSchemas.plan_structure,
  );
  expect(applied.result.sections[0]).toEqual(candidate.sections[0]);
  expect(applied.result.sections[1]).toEqual(section);
  await expect(
    applySemanticPatch(
      candidate,
      {
        ...patch,
        operations: [
          { ...patch.operations[0], operation: "replace", value: [section] },
        ],
      },
      scope,
      modelSchemas.plan_structure,
    ),
  ).rejects.toThrow();
});

it("recalculates the dependent minimum duration with decimal arithmetic and preserves unrelated task assumptions", async () => {
  const candidate = structuredClone(
    typedVerificationFixtures.plan_commercial.candidate,
  );
  candidate.tasks = [
    {
      key: "work",
      title: "Proposed implementation",
      predecessors: [],
      role: "Engineer",
      effort_days: "2",
      allocation: "0.5",
      duration_days: "4",
      basis: "Proposed staffing assumptions.",
    },
    {
      key: "other",
      title: "Other task",
      predecessors: [],
      role: "Engineer",
      effort_days: null,
      allocation: null,
      duration_days: null,
      basis: "Unconfirmed.",
    },
  ];
  const scope = await buildSemanticPatchScope({
    task: "plan_commercial",
    candidate,
    diagnostics: [
      {
        code: "EVIDENCE_REFERENCE_INVALID",
        reason: "numeric_evidence_mismatch",
        paths: ["$.tasks[0].effort_days"],
      },
    ],
  });
  const applied = await applySemanticPatch(
    candidate,
    wire(scope, { "$.tasks[0].effort_days": "6" }),
    scope,
    modelSchemas.plan_commercial,
  );
  expect(applied.result.tasks[0].duration_days).toBe("12");
  expect(applied.result.tasks[1]).toEqual(candidate.tasks[1]);
  expect(applied.receipt.derived).toEqual([
    {
      path: "$.tasks[0].duration_days",
      rule: "duration_at_least_effort_divided_by_allocation",
      minimum: "12",
      value: "12",
    },
  ]);
});
