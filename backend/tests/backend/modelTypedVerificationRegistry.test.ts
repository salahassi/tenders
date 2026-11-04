// @vitest-environment node
import { typedCandidateStructure } from "../../supabase/functions/_shared/modelTypedCandidate";
import { afterEach, expect, it, vi } from "vitest";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph";
import {
  verificationPhaseUnstarted,
  type VerificationPhase,
} from "../../supabase/functions/_shared/modelVerificationFormat";
import {
  newVerificationBatchPin,
  verificationBatchContext,
} from "../../supabase/functions/_shared/modelVerificationBatchContext";
import { mergeVerificationReports } from "../../supabase/functions/_shared/modelVerification";
import {
  candidateContent,
  validateGroundingReport,
  groundingDefects,
} from "../../supabase/functions/_shared/modelGrounding";
import {
  modelSchemas,
  primaryModelTasks,
} from "../../supabase/functions/_shared/modelSchemas";
import {
  FreeModelProvider,
  executeModel,
  modelPrompt,
  sha256,
  validateModelResult,
  type ModelTask,
} from "../../supabase/functions/_shared/model";
import {
  typedVerificationFixtures,
  changedFixture,
} from "./typedVerificationFixtures";

afterEach(() => vi.restoreAllMocks());
function memory() {
  const records = new Map<string, any>();
  const action = vi.fn(async (operation: string, input: any) => {
    if (operation === "result_get") return records.get(input.key) ?? null;
    if (operation === "result_put") {
      const row = { value: structuredClone(input.value) };
      records.set(input.key, row);
      return row;
    }
    throw Error("Unexpected store operation");
  });
  return { records, action };
}
const ledger = () =>
  ({ preflight: vi.fn(async () => ({ providers: [] })) }) as any;
async function contextFor(task: ModelTask, candidate: any) {
  const units = candidateContent(candidate);
  return {
    original_task: task,
    original_context: {
      company_retrieval_version: 1,
      company_evidence_coverage: {
        semantic_support: "not_evaluated",
        capability_absence_proven: false,
      },
    },
    candidate,
    candidate_hash: await sha256(JSON.stringify(candidate)),
    candidate_text: units.map((u) => u.text).join("\n"),
    content_units: units,
  };
}
function reportFor(context: Awaited<ReturnType<typeof contextFor>>) {
  return {
    checked_candidate_hash: context.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: context.content_units.map((u) => u.id),
    claims: [
      {
        id: "claim",
        claim: "Synthetic assertion under test.",
        candidate_quote: context.content_units[0].text,
        kind: "assumption",
        status: "supported",
        source_refs: [],
        finding: "Explicit fixture assumption.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
}
const verifiedTasks = primaryModelTasks.filter(
  (task) => task !== "connection_probe",
);
it("accounts for every registered task and only the explicit nonrecursive/probe boundaries", () => {
  expect(Object.keys(typedVerificationFixtures).sort()).toEqual(
    Object.keys(modelSchemas).sort(),
  );
  expect(
    [
      ...verifiedTasks,
      "connection_probe",
      "verify_grounding",
      "repair_result",
    ].sort(),
  ).toEqual(Object.keys(modelSchemas).sort());
  for (const task of Object.keys(modelSchemas) as ModelTask[])
    expect(() =>
      modelSchemas[task].parse(typedVerificationFixtures[task].candidate),
    ).not.toThrow();
});

it.each(verifiedTasks)(
  "preserves decision-bearing type/path/ownership and scoped validation for %s",
  async (task) => {
    const candidate = modelSchemas[task].parse(
        typedVerificationFixtures[task].candidate,
      ),
      changed = modelSchemas[task].parse(changedFixture(task));
    const contexts = await Promise.all(
      [candidate, changed].map((c) => contextFor(task, c)),
    );
    const wires = await Promise.all(
      contexts.map((context) =>
        verificationContext(memory(), ledger(), context, []),
      ),
    );
    for (const [index, wire] of wires.entries()) {
      expect(wire.candidate).toEqual(contexts[index].candidate);
      expect(wire.original_context).toEqual(contexts[index].original_context);
      expect(wire.content_units).toEqual(contexts[index].content_units);
      expect(wire.candidate_text).toBeUndefined();
      expect(wire.response_style).toBe(
        task === "analyze_chunk"
          ? "compact-verification-v3"
          : "compact-verification-v4",
      );
      const report = reportFor(contexts[index]);
      expect(() =>
        validateGroundingReport(
          report,
          wire.candidate,
          wire.candidate_hash,
          [],
          [],
        ),
      ).not.toThrow();
      const falseHash = { ...report, checked_candidate_hash: "f".repeat(64) };
      expect(() =>
        validateGroundingReport(
          falseHash,
          wire.candidate,
          wire.candidate_hash,
          [],
          [],
        ),
      ).toThrow("MODEL_COVERAGE_INCOMPLETE");
      const omitted = {
        ...report,
        processed_content_ids: report.processed_content_ids.slice(1),
      };
      expect(() =>
        validateGroundingReport(
          omitted,
          wire.candidate,
          wire.candidate_hash,
          [],
          [],
        ),
      ).toThrow("MODEL_COVERAGE_INCOMPLETE");
      const scope = { units: wire.content_units.slice(0, 1) };
      const batch = verificationBatchContext(
        {
          original_task: task,
          original_context: wire.original_context,
          candidate_hash: wire.candidate_hash,
          content_units: scope.units,
          verification_scope: "content_batch",
        },
        wire.candidate,
        newVerificationBatchPin(task),
      );
      if (task === "analyze_chunk")
        expect(batch.candidate).toEqual(wire.candidate);
      else {
        expect(batch.candidate).toBeUndefined();
        expect(batch.typed_candidate_structure).toEqual(
          typedCandidateStructure(wire.candidate).structure,
        );
      }
      const outside = wire.content_units.find(
        (unit: any) => !scope.units[0].text.includes(unit.text),
      );
      expect(outside).toBeDefined();
      const scopedReport = {
        ...report,
        processed_content_ids: scope.units.map((u: any) => u.id),
        claims: [{ ...report.claims[0], candidate_quote: outside.text }],
      };
      expect(() =>
        validateGroundingReport(
          scopedReport,
          wire.candidate,
          wire.candidate_hash,
          [],
          [],
          scope,
        ),
      ).toThrow("EVIDENCE_REFERENCE_INVALID");
      const unresolved = {
        ...report,
        findings: [
          {
            severity: "blocking",
            code: "SYNTHETIC_UNRESOLVED",
            detail: "Known fixture defect remains unresolved.",
            claim_ids: ["claim"],
            requirement_ids: [],
          },
        ],
      };
      expect(() =>
        validateGroundingReport(
          unresolved,
          wire.candidate,
          wire.candidate_hash,
          [],
          [],
        ),
      ).not.toThrow();
      expect(groundingDefects(unresolved)).toHaveLength(1);
    }
    expect(wires[0].candidate).not.toEqual(wires[1].candidate);
    // Compare the visible content, not just candidate_hash metadata.
    const visible = wires.map(({ candidate_hash: _hash, ...wire }) =>
      JSON.stringify(wire),
    );
    expect(visible[0]).not.toBe(visible[1]);
  },
);

it.each(verifiedTasks)(
  "retains requirements-only context and validates complete aggregate coverage for %s",
  async (task) => {
    const candidate = modelSchemas[task].parse(
      typedVerificationFixtures[task].candidate,
    );
    const context = await contextFor(task, candidate);
    const base = reportFor(context);
    const coverage = { ...base, claims: [] };
    const wire = verificationBatchContext(
      { ...context, verification_scope: "requirements_only" },
      candidate,
      newVerificationBatchPin(task),
    );
    expect(wire.content_units).toEqual(context.content_units);
    if (task !== "analyze_chunk") {
      expect(wire.typed_content_manifest.scoped_content_ids).toEqual(
        context.content_units.map((unit) => unit.id),
      );
      expect(wire.typed_candidate_structure).toEqual(
        typedCandidateStructure(candidate).structure,
      );
    }
    const validateCoverage = (report: any) =>
      validateGroundingReport(
        report,
        candidate,
        context.candidate_hash,
        [],
        [],
        { units: context.content_units, requirementsOnly: true },
      );
    expect(() => validateCoverage(coverage)).not.toThrow();
    expect(() => validateCoverage(base)).toThrow("MODEL_COVERAGE_INCOMPLETE");
    const scopes = [
      context.content_units.slice(0, 1),
      context.content_units.slice(1),
    ];
    const reports = scopes.map((units) => ({
      ...base,
      processed_content_ids: units.map((unit) => unit.id),
      claims: [{ ...base.claims[0], candidate_quote: units[0].text }],
    }));
    for (const [index, report] of reports.entries())
      expect(() =>
        validateGroundingReport(
          report,
          candidate,
          context.candidate_hash,
          [],
          [],
          { units: scopes[index] },
        ),
      ).not.toThrow();
    const aggregate = mergeVerificationReports(
      context.candidate_hash,
      reports,
      coverage,
    );
    const validateAggregate = (report: any) =>
      validateGroundingReport(
        report,
        candidate,
        context.candidate_hash,
        [],
        [],
        undefined,
        { aggregateVerification: true },
      );
    expect(() => validateAggregate(aggregate)).not.toThrow();
    expect(new Set(aggregate.claims.map((claim: any) => claim.id)).size).toBe(
      2,
    );
    expect(() =>
      validateAggregate({
        ...aggregate,
        processed_content_ids: [
          ...aggregate.processed_content_ids,
          aggregate.processed_content_ids[0],
        ],
      }),
    ).toThrow("MODEL_COVERAGE_INCOMPLETE");
    expect(() =>
      validateAggregate({
        ...aggregate,
        processed_content_ids: [
          "invented",
          ...aggregate.processed_content_ids.slice(1),
        ],
      }),
    ).toThrow("MODEL_COVERAGE_INCOMPLETE");
    expect(() =>
      mergeVerificationReports(
        context.candidate_hash,
        [
          {
            ...reports[0],
            claims: [reports[0].claims[0], reports[0].claims[0]],
          },
        ],
        coverage,
      ),
    ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  },
);

it("validates repaired target content and verifier reports locally without recursively verifying their output", async () => {
  const repair = structuredClone(
    typedVerificationFixtures.repair_result.candidate,
  );
  const source = {
    id: "source",
    kind: "rfp" as const,
    verified: false,
    text: "The buyer requests an optional workshop.",
  };
  expect(() =>
    validateModelResult("repair_result", repair, [source], ["source"]),
  ).not.toThrow();
  repair.result.requirements[0].source_refs[0].quote = "Invented quotation.";
  expect(() =>
    validateModelResult("repair_result", repair, [source], ["source"]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  const candidate = { text: "Proposed scope." },
    hash = "a".repeat(64);
  expect(() =>
    validateGroundingReport(
      typedVerificationFixtures.verify_grounding.candidate,
      candidate,
      hash,
      [],
      [],
    ),
  ).not.toThrow();
  expect(() =>
    validateGroundingReport(
      changedFixture("verify_grounding"),
      candidate,
      hash,
      [],
      [],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  expect(() => newVerificationBatchPin("repair_result")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
  expect(() => newVerificationBatchPin("verify_grounding")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});

it("keeps connection_probe transport/schema-only and never presents its response as semantic verification", async () => {
  const generate = vi
    .spyOn(FreeModelProvider.prototype, "generate")
    .mockResolvedValue({
      text: JSON.stringify({ status: "ready" }),
      usage: { input: 1, output: 1, thinking: 0 },
      complete: true,
    });
  const fetcher = vi.fn(async () => {
    throw Error("No external HTTP allowed");
  });
  const config = {
    provider: "openai" as const,
    model: "synthetic-model",
    project_ref: "synthetic-project",
    enabled: true,
    quota_mode: "provider_managed" as const,
    free_only: false,
    billing_verified: false,
    free_quota_only: false,
    verified_at: new Date().toISOString(),
    quota_ends_at: null,
  };
  const calls: string[] = [];
  const result = await executeModel(
    "connection_probe",
    {},
    [],
    [],
    [],
    {
      openai: {
        provider: "openai",
        model: config.model,
        projectRef: config.project_ref,
        key: "synthetic-key",
      },
    },
    {
      preflight: async (_manifest, task) => {
        calls.push(task!);
        return { providers: [config], routing_mode: "round_robin" };
      },
      reserve: async () => "synthetic-receipt",
      settle: async () => {},
    },
    "en",
    false,
    fetcher as any,
  );
  expect(result).toEqual({ status: "ready" });
  expect(calls).toEqual(["connection_probe"]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() =>
    modelSchemas.connection_probe.parse(changedFixture("connection_probe")),
  ).toThrow();
  expect(() => newVerificationBatchPin("connection_probe")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});

async function phaseFixture() {
  const store = memory(),
    context = await contextFor(
      "plan_commercial",
      typedVerificationFixtures.plan_commercial.candidate,
    );
  const internal = vi.fn(async () => false);
  const phase: VerificationPhase = {
    backend: { internal } as any,
    job: { id: "job", lease_token: "lease" },
    requestPrefix: "step:fixture:verification-candidate",
    evidence: [],
    requiredIds: [],
    language: "en",
    repair: false,
  };
  return { store, context, internal, phase };
}
it.each([
  "semantic_pin",
  "verification_pin",
  "accepted",
  "settled",
  "unknown",
  "saved_round",
])(
  "keeps unpinned historical %s verification bytes unchanged instead of silently migrating",
  async (state) => {
    const { store, context, internal, phase } = await phaseFixture();
    const hash = await sha256(
      modelPrompt("verify_grounding", context, [], [], "en"),
    );
    if (state.endsWith("_pin"))
      store.records.set(
        `${state === "semantic_pin" ? "semantic" : "verification"}-instructions-${await sha256(phase.requestPrefix)}`,
        { value: { version: 2, legacy_input_hash: hash } },
      );
    else internal.mockResolvedValue(true);
    const wire = await verificationContext(store, ledger(), context, [], {
      phase,
    });
    expect(wire).toBe(context);
    expect(
      await sha256(modelPrompt("verify_grounding", wire, [], [], "en")),
    ).toBe(hash);
    expect(
      store.records.has(`verification-format-${context.candidate_hash}`),
    ).toBe(false);
    if (state.endsWith("_pin")) expect(internal).not.toHaveBeenCalled();
    else
      expect(internal).toHaveBeenCalledWith(
        "model_phase_started",
        expect.objectContaining({
          legacy_input_hash: hash,
          request_prefix: phase.requestPrefix,
        }),
      );
  },
);
it("pins fresh format4 once before instruction preparation and replays it without another phase check", async () => {
  const { store, context, internal, phase } = await phaseFixture();
  const wire = await verificationContext(store, ledger(), context, [], {
    phase,
  });
  expect(wire.response_style).toBe("compact-verification-v4");
  expect(internal).toHaveBeenCalledOnce();
  internal.mockResolvedValue(true);
  expect(
    await verificationContext(store, ledger(), context, [], { phase }),
  ).toEqual(wire);
  expect(internal).toHaveBeenCalledOnce();
});
it("uses a distinct phase-aware audit format and never changes an old audit payload", async () => {
  const { store, context, internal, phase } = await phaseFixture();
  const candidate = typedVerificationFixtures.review_proposal.candidate;
  const audit = {
    original_task: "review_proposal",
    original_context: {},
    candidate_hash: await sha256(JSON.stringify(candidate)),
    content_units: candidateContent(candidate),
    verification_scope: "whole_audit_report",
    audit_validation_policy: 3,
  };
  const wire = await verificationContext(store, ledger(), audit, [], {
    phase,
    typedCandidate: candidate,
  });
  expect(wire.candidate).toEqual(candidate);
  expect(
    store.records.has(`verification-audit-format-${audit.candidate_hash}`),
  ).toBe(true);
  const legacy = memory();
  internal.mockResolvedValue(true);
  expect(
    await verificationContext(legacy, ledger(), audit, [], {
      phase,
      typedCandidate: candidate,
    }),
  ).toBe(audit);
});
it("refuses an indeterminate phase response rather than treating it as permission to upgrade", async () => {
  const { store, context, phase, internal } = await phaseFixture();
  internal.mockResolvedValue(undefined as any);
  await expect(
    verificationPhaseUnstarted(store, phase, context),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
  expect(store.records.size).toBe(0);
});

it("preserves all 43 historical whole/batch/audit wire hashes generated from the committed baseline", async () => {
  const { readFile } = await import("node:fs/promises");
  const golden = JSON.parse(
    await readFile(
      new URL("./typedVerificationLegacyHashes.json", import.meta.url),
      "utf8",
    ),
  );
  expect(golden.baseline_commit).toBe(
    "d5ddad344bde81d53bbd4b8f5b2d06c6d1eb4064",
  );
  const actual: Record<string, string> = {};
  const prompt = (context: any) =>
    modelPrompt("verify_grounding", context, [], [], "en", false, 2, 2);
  for (const task of verifiedTasks) {
    const candidate = typedVerificationFixtures[task].candidate,
      context = await contextFor(task, candidate);
    for (const version of [1, 2, ...(task === "analyze_chunk" ? [3] : [])]) {
      const store = memory();
      store.records.set(`verification-format-${context.candidate_hash}`, {
        value: { version },
      });
      const wire = await verificationContext(
        store,
        {
          preflight: async () => {
            throw Error("Historical format must not preflight");
          },
        } as any,
        context,
        [],
      );
      actual[`${task}:whole:${version}`] = await sha256(prompt(wire));
      expect(store.action).not.toHaveBeenCalledWith(
        "result_put",
        expect.anything(),
      );
    }
    const scope = {
      original_task: task,
      original_context: context.original_context,
      candidate_hash: context.candidate_hash,
      content_units: context.content_units.slice(0, 1),
      verification_scope: "content_batch",
    };
    for (const version of [3, 4, ...(task === "analyze_chunk" ? [5] : [])]) {
      const partition =
        version === 4
          ? { version: 4, policy: { version: 2, outputTokens: 40000 } }
          : { version: 3 };
      const pin =
        version === 5
          ? { version: 5, context_format: 3, partition }
          : partition;
      actual[`${task}:batch:${version}`] = await sha256(
        prompt(verificationBatchContext(scope, candidate, pin)),
      );
    }
    if (task === "review_proposal") {
      const audit = {
        original_task: task,
        original_context: {},
        candidate_hash: context.candidate_hash,
        content_units: context.content_units,
        verification_scope: "whole_audit_report",
        audit_validation_policy: 3,
      };
      const fixture = await phaseFixture();
      fixture.internal.mockResolvedValue(true);
      const wire = await verificationContext(
        fixture.store,
        ledger(),
        audit,
        [],
        { phase: fixture.phase, typedCandidate: candidate },
      );
      actual[`${task}:audit:legacy`] = await sha256(prompt(wire));
    }
  }
  expect(Object.keys(actual)).toHaveLength(43);
  expect(actual).toEqual(golden.cases);
});
