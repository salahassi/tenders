// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sha256 } from "../../supabase/functions/_shared/model";
import {
  assertVerifierRecheckCall,
  assertVerifierRecheckState,
  prepareVerifierRecheck,
  seedVerifierRecheck,
  verifierRecheckMarker,
} from "../../supabase/functions/_shared/modelVerifierRecheck";

async function fixture() {
  const candidate = {
    processed_block_ids: ["source"],
    summary: "Historical reference material.",
    requirements: [],
    questions: [],
    separate_volumes: false,
  };
  const marker = {
    version: 1 as const,
    parent_job_id: "10000000-0000-4000-8000-000000000001",
    parent_thread_id: "b".repeat(64),
    candidate_id: "10000000-0000-4000-8000-000000000002",
    candidate_hash: await sha256(JSON.stringify(candidate)),
    input_hash: "a".repeat(64),
  };
  const seed = {
    ...marker,
    verification_revision: 4,
    value: {
      result: candidate,
      producer: {
        provider: "qwencloud",
        model: "synthetic-model",
        project: "fixture",
        connectionId: "10000000-0000-4000-8000-000000000003",
        modelId: "10000000-0000-4000-8000-000000000004",
      },
    },
  };
  const records = new Map<string, any>();
  const action = vi.fn(async (name: string, args: any) => {
    if (name === "recheck_seed") return seed;
    if (name === "result_get") return records.get(args.key) ?? null;
    if (name === "result_put") {
      const saved = {
        id: crypto.randomUUID(),
        value: structuredClone(args.value),
      };
      records.set(args.key, saved);
      return saved;
    }
    throw new Error("Unexpected synthetic store action");
  });
  return {
    marker,
    seed,
    records,
    action,
    options: {
      store: { action },
      marker,
      inputHash: marker.input_hash,
      threadId: "c".repeat(64),
      context: { draft_input_version: 1 },
      evidence: [
        {
          id: "source",
          kind: "rfp" as const,
          verified: false,
          text: "Historical reference material.",
        },
      ],
      requiredIds: ["source"],
    },
  };
}

it.each([
  "parent_job_id",
  "parent_thread_id",
  "candidate_id",
  "candidate_hash",
  "input_hash",
  "verification_revision",
])(
  "rejects a server seed with mismatched %s before retaining any candidate",
  async (field) => {
    const s = await fixture();
    (s.seed as any)[field] = field === "verification_revision" ? 2 : "changed";
    await expect(seedVerifierRecheck(s.options)).rejects.toMatchObject({
      code: "MODEL_IDENTITY_CHANGED",
    });
    expect(s.action.mock.calls.some(([name]) => name === "result_put")).toBe(
      false,
    );
  },
);

it("recomputes the exact candidate hash and refuses a rejected-writer envelope", async () => {
  const s = await fixture();
  s.seed.value.result.summary = "Changed retained content.";
  await expect(seedVerifierRecheck(s.options)).rejects.toMatchObject({
    code: "MODEL_IDENTITY_CHANGED",
  });
  s.seed.value.result.summary = "Historical reference material.";
  Object.assign(s.seed.value, {
    local_validation: { code: "EVIDENCE_REFERENCE_INVALID" },
  });
  await expect(seedVerifierRecheck(s.options)).rejects.toMatchObject({
    code: "MODEL_IDENTITY_CHANGED",
  });
  expect(s.records.size).toBe(0);
});

it("revalidates the canonical source coverage and domain callback before writing the seed", async () => {
  const s = await fixture();
  await expect(
    seedVerifierRecheck({ ...s.options, requiredIds: ["another-source"] }),
  ).rejects.toMatchObject({ code: "MODEL_COVERAGE_INCOMPLETE" });
  await expect(
    seedVerifierRecheck({
      ...s.options,
      validate: () => {
        throw new Error("Synthetic domain rejection");
      },
    }),
  ).rejects.toThrow("Synthetic domain rejection");
  expect(s.records.size).toBe(0);
});

it("reuses the exact seed after an interrupted checkpoint and rejects changed producer provenance", async () => {
  const s = await fixture();
  const first = await seedVerifierRecheck(s.options);
  const second = await seedVerifierRecheck(s.options);
  expect(second).toEqual(first);
  expect(s.records.get("candidate-0").value).toEqual(s.seed.value);
  expect(
    s.action.mock.calls.filter(([name]) => name === "recheck_seed"),
  ).toHaveLength(2);
  expect(
    s.action.mock.calls.filter(([name]) => name === "result_put"),
  ).toHaveLength(2);
  s.records.get("candidate-0").value.producer.model = "different-model";
  await expect(seedVerifierRecheck(s.options)).rejects.toMatchObject({
    code: "MODEL_IDENTITY_CHANGED",
  });
});

it("does not permit a changed lineage marker or stale input to reuse a seeded candidate", async () => {
  const s = await fixture();
  await seedVerifierRecheck(s.options);
  s.records.get("verifier-recheck-provenance").value.parent_job_id =
    "10000000-0000-4000-8000-000000000099";
  await expect(seedVerifierRecheck(s.options)).rejects.toMatchObject({
    code: "MODEL_IDENTITY_CHANGED",
  });
  await expect(
    seedVerifierRecheck({ ...s.options, inputHash: "f".repeat(64) }),
  ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
});

it("allows only verifier/report-correction phases and never a writer cache, repair, batch or budget", async () => {
  const { marker } = await fixture();
  const h = marker.candidate_hash;
  for (const [task, key, unit] of [
    ["analyze_chunk", "candidate-0", "writer"],
    ["repair_result", "candidate-1", "writer-repair"],
    ["verify_grounding", `verification-${h}`, "writer"],
    ["verify_grounding", `verification-v3-${h}-content-0`, `v3-${h}-content-0`],
    ["verify_grounding", `verification-${"d".repeat(64)}`, `verifier-${h}`],
  ])
    expect(() => assertVerifierRecheckCall(marker, task, key, unit)).toThrow(
      "MODEL_IDENTITY_CHANGED",
    );
  expect(() =>
    assertVerifierRecheckCall(
      marker,
      "verify_grounding",
      `verification-${h}`,
      `verifier-${h}`,
    ),
  ).not.toThrow();
  expect(() =>
    assertVerifierRecheckCall(
      marker,
      "verify_grounding",
      `verification-repair-${h}`,
      `verifier-repair-${h}`,
    ),
  ).not.toThrow();
  for (const state of [
    { repairCount: 1 },
    { repairCount: 0, decision: "repair" },
    { repairCount: 0, candidateRef: "changed" },
    { candidateRef: "saved" },
  ])
    expect(() => assertVerifierRecheckState(state, "saved")).toThrow(
      "MODEL_IDENTITY_CHANGED",
    );
});

it("requires real verifier routing to executor two and fails closed on malformed checkpoint markers", async () => {
  const s = await fixture();
  const preflight = vi.fn(async () => ({
    providers: [] as any[],
    executor_version: 1,
  }));
  await expect(prepareVerifierRecheck({ preflight }, [])).rejects.toMatchObject(
    { code: "MODEL_IDENTITY_CHANGED" },
  );
  expect(preflight).toHaveBeenCalledWith([], "verify_grounding");
  preflight.mockResolvedValue({ providers: [], executor_version: 2 });
  await expect(prepareVerifierRecheck({ preflight }, [])).rejects.toMatchObject(
    { code: "MODEL_NOT_CONFIGURED" },
  );
  preflight.mockResolvedValue({
    providers: [{ enabled: false }],
    executor_version: 2,
  });
  await expect(prepareVerifierRecheck({ preflight }, [])).rejects.toMatchObject(
    { code: "MODEL_NOT_CONFIGURED" },
  );
  for (const marker of [
    null,
    {},
    { ...s.marker, version: 2 },
    { ...s.marker, extra: true },
  ])
    expect(() =>
      verifierRecheckMarker(
        {
          id: "10000000-0000-4000-8000-000000000005",
          checkpoint: { verifier_recheck: marker },
        },
        "analyze_chunk",
        false,
      ),
    ).toThrow("MODEL_IDENTITY_CHANGED");
  expect(() =>
    verifierRecheckMarker(
      {
        id: s.marker.parent_job_id,
        checkpoint: { verifier_recheck: s.marker },
      },
      "analyze_chunk",
      false,
    ),
  ).toThrow("MODEL_IDENTITY_CHANGED");
  expect(() =>
    verifierRecheckMarker(
      { id: "other", checkpoint: { verifier_recheck: s.marker } },
      "analyze_chunk",
      true,
    ),
  ).toThrow("MODEL_IDENTITY_CHANGED");
});
