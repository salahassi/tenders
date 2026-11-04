// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  ModelError,
  modelPrompt,
  sha256,
  validateModelResult,
  type ModelTask,
} from "../../supabase/functions/_shared/model";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { sourceTaskOutputSchema } from "../../supabase/functions/_shared/sourceEvidence";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph";
import {
  newVerificationBatchPin,
  verificationBatchContext,
} from "../../supabase/functions/_shared/modelVerificationBatchContext";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";

const file = readFileSync(
  new URL(
    "./fixtures/g09-qualification/typed-decision-pairs-v3.json",
    import.meta.url,
  ),
);
const oracle = JSON.parse(file.toString());
const frozenHash =
  "390c74f3b314902eb8462be972fc6f680c59d8bc50093a3b20a0ec709fb0f99b";
const noNetwork = vi.fn(() => {
  throw Error("Qualification is offline");
});
vi.stubGlobal("fetch", noNetwork);
afterEach(() => expect(noNetwork).not.toHaveBeenCalled());
const pairReceipts: any[] = [];
afterAll(() => {
  vi.unstubAllGlobals();
  if (process.env.G09_TYPED_REPORT)
    writeFileSync(
      process.env.G09_TYPED_REPORT,
      JSON.stringify(
        {
          version: 1,
          corpus_sha256: frozenHash,
          provider_calls: 0,
          label_scope:
            "Typed transport/coverage and deterministic domain gates; not model semantic qualification",
          expected_pairs: oracle.pairs.length,
          evaluated_pairs: pairReceipts.length,
          nonrecursive_boundary_cases: 16,
          pairs: pairReceipts.sort((a, b) => a.id.localeCompare(b.id)),
        },
        null,
        2,
      ) + "\n",
    );
});
function at(value: any, path: (string | number)[]) {
  for (const key of path) value = value[key];
  return value;
}
function changed(candidate: any, path: (string | number)[], value: unknown) {
  const clone = structuredClone(candidate);
  at(clone, path.slice(0, -1))[path.at(-1)!] = structuredClone(value);
  return clone;
}
function memory() {
  const rows = new Map<string, any>();
  return {
    action: async (action: string, input: any) => {
      if (action === "result_get") return rows.get(input.key) ?? null;
      if (action === "result_put") {
        const row = { value: input.value };
        rows.set(input.key, row);
        return row;
      }
      throw Error("Unexpected graph operation");
    },
  };
}
function resolve(value: any, units: { id: string; text: string }[]): any {
  if (Array.isArray(value)) return value.map((v) => resolve(v, units));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && value.content_unit_id) {
      const unit = units.find((unit) => unit.id === value.content_unit_id);
      // Outside-batch prose stays a reference; it is not empty or false.
      return unit ? unit.text : value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolve(child, units)]),
    );
  }
  return value;
}
const options = {
  scopePolicy: {
    scope: "company_knowledge" as const,
    include_keywords: [],
    exclude_keywords: [],
  },
};
it("binds pre-outcome oracles and accounts for all 13 task boundaries", () => {
  expect(createHash("sha256").update(file).digest("hex")).toBe(frozenHash);
  const transported = [...new Set(oracle.pairs.map((pair: any) => pair.task))];
  expect([...transported, ...oracle.nonrecursive_boundaries].sort()).toEqual(
    Object.keys(modelSchemas).sort(),
  );
  expect(oracle.pairs).toHaveLength(76);
  expect(new Set(oracle.pairs.map((pair: any) => pair.id)).size).toBe(76);
});

it.each(oracle.pairs as Record<string, any>[])(
  "preserves $id through whole and split typed verification",
  async (pair: any) => {
    const task = pair.task as ModelTask;
    const original = structuredClone(oracle.bases[pair.base ?? task]);
    // Source tuples here qualify transport only. An explicit empty catalog
    // satisfies the typed context envelope without inventing authorized spans
    // or human reviews; separate sourceEvidence tests exercise those gates.
    const sourceContext =
      pair.context?.source_contract_version === 1
        ? {
            ...pair.context,
            source_evidence: { version: 1, spans: [], reviews: [] },
          }
        : {};
    let domainOutcome: any = { observed: "not_executed_transport_only" };
    expect(at(original, pair.path)).toEqual(pair.before);
    const mutation = changed(original, pair.path, pair.after);
    const schema = sourceTaskOutputSchema(
      task,
      sourceContext,
      modelSchemas[task],
    );
    for (const candidate of [original, mutation])
      expect(() => schema.parse(candidate)).not.toThrow();
    const snapshots = [original, mutation].map((value) =>
      JSON.stringify(value),
    );
    if (pair.domain !== "source_contract_transport_only") {
      expect(
        validateModelResult(
          task,
          original,
          oracle.evidence,
          oracle.required_ids[task],
          options,
        ),
      ).toEqual(original);
      if (pair.domain === "reject") {
        let error: unknown;
        try {
          validateModelResult(
            task,
            mutation,
            oracle.evidence,
            oracle.required_ids[task],
            options,
          );
        } catch (caught) {
          error = caught;
        }
        expect(error, pair.independent_oracle).toBeInstanceOf(ModelError);
        expect((error as ModelError).code).toBe(pair.error_code);
        domainOutcome = {
          observed: "mutation_rejected",
          code: (error as ModelError).code,
          paths: (error as ModelError).validationDiagnostics.flatMap(
            (d) => d.paths,
          ),
        };
        expect(
          (error as ModelError).validationDiagnostics.length,
        ).toBeGreaterThan(0);
      } else {
        // Schema-valid decisions need semantic review. We assert visibility, not
        // that a deterministic validator or an unavailable model understood them.
        domainOutcome = {
          observed: "mutation_domain_admitted_requires_semantic_review",
        };
        try {
          validateModelResult(
            task,
            mutation,
            oracle.evidence,
            oracle.required_ids[task],
            options,
          );
        } catch (error) {
          // Stronger independently diagnosed domain guards are permitted. Never
          // weaken one merely to make a transport-only mutation pass validation.
          expect(error).toBeInstanceOf(ModelError);
          domainOutcome = {
            observed: "stronger_domain_rejection",
            code: (error as ModelError).code,
            paths: (error as ModelError).validationDiagnostics.flatMap(
              (d) => d.paths,
            ),
          };
          expect(
            (error as ModelError).validationDiagnostics.length,
          ).toBeGreaterThan(0);
        }
      }
    }
    const hashes: string[] = [];
    const actualValues: unknown[] = [];
    for (const [index, candidate] of [original, mutation].entries()) {
      const units = candidateContent(candidate),
        hash = await sha256(JSON.stringify(candidate));
      hashes.push(hash);
      const context = {
        original_task: task,
        original_context: sourceContext,
        candidate,
        candidate_hash: hash,
        candidate_text: units.map((unit) => unit.text).join("\n"),
        content_units: units,
      };
      const wire = await verificationContext(
        memory(),
        { preflight: async () => ({ providers: [] }) } as any,
        context,
        [],
      );
      expect(at(wire.candidate, pair.path)).toEqual(
        index === 0 ? pair.before : pair.after,
      );
      expect(wire.candidate).toEqual(candidate);
      expect(wire.candidate_hash).toBe(hash);
      expect(wire).not.toHaveProperty("independent_oracle");
      const promptRevision =
        task === "analyze_chunk" && pair.context?.source_contract_version === 1
          ? 5
          : 4;
      const prompt = JSON.parse(
        modelPrompt(
          "verify_grounding",
          wire,
          oracle.evidence,
          [],
          "en",
          false,
          promptRevision,
        ),
      );
      expect(prompt.untrusted_data).toEqual(wire);
      expect(prompt).not.toHaveProperty("independent_oracle");
      const scoped = [
        units.filter((_, i) => i % 2 === 0),
        units.filter((_, i) => i % 2 !== 0),
      ];
      expect(scoped.every((scope) => scope.length > 0)).toBe(true);
      const batches = scoped.map((content_units) =>
        verificationBatchContext(
          {
            original_task: task,
            original_context: context.original_context,
            candidate_hash: hash,
            content_units,
            verification_scope: "content_batch",
          },
          candidate,
          newVerificationBatchPin(task),
        ),
      );
      for (const [i, batch] of batches.entries()) {
        expect(batch.content_units).toEqual(scoped[i]);
        expect(batch.candidate_hash).toBe(hash);
        expect(
          JSON.parse(
            modelPrompt(
              "verify_grounding",
              batch,
              oracle.evidence,
              [],
              "en",
              false,
              promptRevision,
            ),
          ).untrusted_data,
        ).toEqual(batch);
        if (task !== "analyze_chunk") {
          expect(batch.candidate).toBeUndefined();
          expect(batch.typed_content_manifest.scoped_content_ids).toEqual(
            scoped[i].map((unit) => unit.id),
          );
          expect(batch.typed_content_manifest.content_unit_ids).toEqual(
            units.map((unit) => unit.id),
          );
          // Reconstructing the complete typed structure from separately scoped
          // units preserves the manually specified value, hierarchy and type.
          expect(resolve(batch.typed_candidate_structure, units)).toEqual(
            candidate,
          );
          const outside = scoped[1 - i][0];
          expect(
            batch.content_units.some((unit: any) => unit.id === outside.id),
          ).toBe(false);
        } else expect(batch.candidate).toEqual(candidate);
      }
      actualValues.push(
        at(
          task === "analyze_chunk"
            ? batches[0].candidate
            : resolve(batches[0].typed_candidate_structure, units),
          pair.path,
        ),
      );
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(actualValues).toEqual([pair.before, pair.after]);
    expect([original, mutation].map((value) => JSON.stringify(value))).toEqual(
      snapshots,
    );
    pairReceipts.push({
      id: pair.id,
      task,
      path: pair.path,
      hashes,
      typed_whole_and_scoped_preserved: true,
      ...domainOutcome,
    });
  },
);

function reportFixture() {
  const text = "The supplier may offer an optional workshop.";
  const candidate = { text };
  const report = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: ["content-0"],
    claims: [
      {
        id: "C1",
        claim: text,
        candidate_quote: text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "rfp", quote: text }],
        finding: "The source permits optional scope.",
      },
    ],
    processed_requirement_ids: ["R1"],
    requirement_checks: [
      {
        requirement_id: "R1",
        status: "supported",
        candidate_quote: text,
        source_refs: [{ id: "rfp", quote: text }],
        finding: "The exact permission is retained.",
      },
    ],
    findings: [
      {
        severity: "advisory",
        code: "SCHEDULE_REVIEW",
        detail: "Confirm the workshop schedule.",
        claim_ids: ["C1"],
        requirement_ids: ["R1"],
      },
    ],
  };
  return { candidate, report };
}
it.each([
  ["claim contradiction", ["claims", 0, "status"], "contradicted"],
  ["claim insufficient proof", ["claims", 0, "status"], "insufficient"],
  [
    "requirement contradiction",
    ["requirement_checks", 0, "status"],
    "contradicted",
  ],
  [
    "requirement insufficient proof",
    ["requirement_checks", 0, "status"],
    "insufficient",
  ],
  ["blocking finding", ["findings", 0, "severity"], "blocking"],
] as const)(
  "verify_grounding retains %s as an unresolved defect",
  (_label, path, value) => {
    const { candidate, report } = reportFixture();
    validateGroundingReport(
      report,
      candidate,
      report.checked_candidate_hash,
      oracle.evidence,
      ["R1"],
    );
    expect(groundingDefects(report)).toEqual([]);
    const mutation = changed(report, [...path], value);
    validateGroundingReport(
      mutation,
      candidate,
      report.checked_candidate_hash,
      oracle.evidence,
      ["R1"],
    );
    expect(groundingDefects(mutation)).not.toEqual([]);
  },
);
it.each([
  [
    "candidate identity",
    ["checked_candidate_hash"],
    "b".repeat(64),
    "MODEL_COVERAGE_INCOMPLETE",
  ],
  [
    "content identity",
    ["processed_content_ids", 0],
    "invented-content",
    "MODEL_COVERAGE_INCOMPLETE",
  ],
  [
    "requirement identity",
    ["requirement_checks", 0, "requirement_id"],
    "R2",
    "MODEL_COVERAGE_INCOMPLETE",
  ],
  [
    "candidate quotation",
    ["claims", 0, "candidate_quote"],
    "An invented mandatory commitment.",
    "EVIDENCE_REFERENCE_INVALID",
  ],
  [
    "source span quotation",
    ["claims", 0, "source_refs", 0, "quote"],
    "The supplier must provide a workshop.",
    "EVIDENCE_REFERENCE_INVALID",
  ],
  [
    "finding ownership",
    ["findings", 0, "claim_ids", 0],
    "unseen-claim",
    "EVIDENCE_REFERENCE_INVALID",
  ],
] as const)(
  "verify_grounding rejects a changed %s without certifying itself",
  (_label, path, value, code) => {
    const { candidate, report } = reportFixture();
    expect(() =>
      validateGroundingReport(
        changed(report, [...path], value),
        candidate,
        report.checked_candidate_hash,
        oracle.evidence,
        ["R1"],
      ),
    ).toThrow(code);
    expect(() => newVerificationBatchPin("verify_grounding")).toThrow(
      "MODEL_IDENTITY_CHANGED",
    );
  },
);
it.each([
  "classify_opportunity.null_zero_capability",
  "draft_section.company_claim_ownership",
  "review_proposal.owner_approval",
  "inspect_source_page.deadline_absent",
])("repair_result applies the complete target gate for %s", (id) => {
  const pair = oracle.pairs.find((pair: any) => pair.id === id),
    original = oracle.bases[pair.task];
  const output = {
    target_task: pair.task,
    result: structuredClone(original),
    changes: ["Scoped correction."],
  };
  expect(() =>
    validateModelResult(
      "repair_result",
      output,
      oracle.evidence,
      oracle.required_ids[pair.task],
      options,
    ),
  ).not.toThrow();
  output.result = changed(original, pair.path, pair.after);
  expect(() =>
    validateModelResult(
      "repair_result",
      output,
      oracle.evidence,
      oracle.required_ids[pair.task],
      options,
    ),
  ).toThrow(pair.error_code);
  expect(() => newVerificationBatchPin("repair_result")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
  expect(() =>
    modelSchemas.repair_result.parse({
      ...output,
      target_task: "connection_probe",
    }),
  ).toThrow();
});
it("connection_probe is ready-schema only and cannot assert business quality or another target", () => {
  expect(
    validateModelResult("connection_probe", { status: "ready" }, []),
  ).toEqual({ status: "ready" });
  for (const unsupported of [
    { status: "ready", business_quality: "verified" },
    { status: "ready", model_id: "another-model" },
    { status: "qualified" },
  ])
    expect(() =>
      validateModelResult("connection_probe", unsupported, []),
    ).toThrow();
  expect(() => newVerificationBatchPin("connection_probe")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});
