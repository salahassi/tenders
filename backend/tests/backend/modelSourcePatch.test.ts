// @vitest-environment node
import { expect, it } from "vitest";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import {
  ModelError,
  validateModelResult,
} from "../../supabase/functions/_shared/model";
import {
  canonicalSourceSpanId,
  materializeSourceCandidate,
  sourceTaskOutputSchema,
} from "../../supabase/functions/_shared/sourceEvidence";
import {
  applySemanticPatch,
  buildSemanticPatchScope,
} from "../../supabase/functions/_shared/modelSemanticPatch";

function fixture() {
  const id = "00000000-0000-4000-8000-000000000001",
    text = "The supplier must deliver within 30 days after approval.";
  const source = {
    version: 1,
    entity_kind: "document",
    entity_id: id,
    content_hash: "a".repeat(64),
    extraction_version: "native-v1",
    block_id: id,
    block_hash: "b".repeat(64),
    coordinate: "unicode_code_point",
    start: 0,
    end: Array.from(text).length,
    quote: text,
    locator: {},
    authority: {
      version: 1,
      decision_id: id,
      revision: 1,
      role: "buyer_rfp",
      status: "confirmed",
      supersedes: null,
      precedence: 0,
    },
  };
  const span = { ...source, id: canonicalSourceSpanId(source) };
  const semantics = {
    modality: "required",
    actor: "supplier",
    negated: false,
    conditions: ["after approval"],
    exceptions: [],
    consequences: [],
    quantities: [{ value: "30", unit: "days", currency: null }],
    dates: [],
  };
  const context = {
    source_contract_version: 1,
    repair_contract_version: 1,
    source_evidence: {
      version: 1,
      spans: [span],
      reviews: [
        {
          version: 1,
          id,
          revision: 1,
          opportunity_id: id,
          spans: [span],
          semantics,
          reason: "Synthetic fixed oracle",
          status: "confirmed",
        },
      ],
    },
  };
  const candidate = {
    processed_block_ids: [id],
    requirements: [
      {
        text,
        category: "timeline",
        mandatory: true,
        source_refs: [{ id: span.id, quote: text }],
        interpretation: "",
        acceptance_evidence: "",
        owner_question: null,
        source_semantics: {
          version: 1,
          ...structuredClone(semantics),
          source_span_ids: [span.id],
          authority_role: "buyer_rfp",
          authority_status: "confirmed",
          review_status: "confirmed",
          review_id: id,
        },
      },
    ],
    questions: [],
    separate_volumes: false,
    summary: text,
  };
  const evidence = [
    { id: span.id, text, kind: "rfp" as const, verified: false },
  ];
  return { context, candidate, evidence, required: [id] };
}
it("composes a semantic tuple patch against the human-reviewed source contract and never permits review identity mutation", async () => {
  const f = fixture();
  f.candidate.requirements[0].source_semantics.quantities[0].value = "7";
  let error: ModelError | undefined;
  try {
    validateModelResult("analyze_chunk", f.candidate, f.evidence, f.required, {
      sourceContext: f.context,
    });
  } catch (e) {
    error = e as ModelError;
  }
  expect(error?.code).toBe("EVIDENCE_REFERENCE_INVALID");
  expect(error?.validationDiagnostics[0].paths).toEqual([
    "$.requirements[0].source_semantics.quantities",
  ]);
  const scope = await buildSemanticPatchScope({
    task: "analyze_chunk",
    candidate: f.candidate,
    diagnostics: error!.validationDiagnostics,
  });
  expect(
    scope.paths.some((item) => /\.review_(?:id|status)$/.test(item.path)),
  ).toBe(false);
  const target = scope.paths.find(
    (item) => item.path === "$.requirements[0].source_semantics.quantities",
  )!;
  const schema = sourceTaskOutputSchema(
    "analyze_chunk",
    f.context,
    modelSchemas.analyze_chunk,
  );
  const patch = {
    version: 1,
    target_task: "analyze_chunk",
    base_candidate_hash: scope.candidate_hash,
    scope_hash: scope.scope_hash,
    operations: [
      {
        operation: "replace",
        path: target.path,
        unit_id: target.unit_id,
        previous_hash: target.previous_hash,
        reason_ids: target.reason_ids,
        value: [{ value: "30", unit: "days", currency: null }],
      },
    ],
  };
  const applied = await applySemanticPatch(f.candidate, patch, scope, schema);
  const canonical = materializeSourceCandidate(
    "analyze_chunk",
    applied.result,
    f.context,
    f.evidence,
    false,
  );
  expect(() =>
    validateModelResult("analyze_chunk", canonical, f.evidence, f.required, {
      sourceContext: f.context,
    }),
  ).not.toThrow();
  expect(canonical.requirements[0].source_semantics.review_id).toBe(
    f.candidate.requirements[0].source_semantics.review_id,
  );
  const stillWrong = structuredClone(canonical);
  stillWrong.requirements[0].source_semantics.conditions = [];
  expect(() =>
    validateModelResult("analyze_chunk", stillWrong, f.evidence, f.required, {
      sourceContext: f.context,
    }),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("collects 33 independent reviewed tuple faults as 32 diagnostics plus exact overflow after materialization", () => {
  const f = fixture();
  f.candidate.requirements = Array.from({ length: 33 }, () => {
    const item = structuredClone(f.candidate.requirements[0]);
    item.source_semantics.quantities[0].value = "7";
    return item;
  });
  const canonical = materializeSourceCandidate(
    "analyze_chunk",
    f.candidate,
    f.context,
    f.evidence,
    false,
  );
  try {
    validateModelResult("analyze_chunk", canonical, f.evidence, f.required, {
      sourceContext: f.context,
    });
    throw Error("Expected source tuple defects");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).validationDiagnostics).toHaveLength(32);
    expect((error as ModelError).omittedValidationDiagnosticCount).toBe(1);
    expect(
      new Set(
        (error as ModelError).validationDiagnostics.map(
          (item) => item.paths[0],
        ),
      ).size,
    ).toBe(32);
  }
});
it("lets application materialization discard forged review flags without giving the model approval authority", () => {
  const f = fixture();
  f.context.source_evidence.reviews = [];
  const canonical = materializeSourceCandidate(
    "analyze_chunk",
    f.candidate,
    f.context,
    f.evidence,
    false,
  );
  expect(canonical.requirements[0].source_semantics.review_status).toBe(
    "pending",
  );
  expect(canonical.requirements[0].source_semantics.review_id).toBeNull();
  expect(f.candidate.requirements[0].source_semantics.review_status).toBe(
    "confirmed",
  );
  expect(() =>
    validateModelResult("analyze_chunk", canonical, f.evidence, f.required, {
      sourceContext: f.context,
    }),
  ).not.toThrow();
});
