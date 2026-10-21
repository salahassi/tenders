// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  executeModel,
  FreeModelProvider,
  ModelCandidateRepair,
  type Ledger,
} from "../../supabase/functions/_shared/model";

afterEach(() => vi.restoreAllMocks());
const env = {
  provider: "qwen_free",
  model: "fixture-a",
  projectRef: "fixture-project",
  key: "fixture-key",
};
const config = {
  provider: "qwen_free" as const,
  model: "fixture-a",
  project_ref: env.projectRef,
  enabled: true,
  free_only: true,
  billing_verified: true,
  free_quota_only: true,
  verified_at: new Date().toISOString(),
  quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
};
const evidence = [
  {
    id: "block-1",
    kind: "rfp" as const,
    verified: false,
    text: "Provide approval workflow.",
  },
];
const valid = {
  processed_block_ids: ["block-1"],
  requirements: [],
  questions: [],
  separate_volumes: false,
  summary: "Buyer requires an approval workflow.",
};

it.each([
  [1, true, true],
  [0, true, false],
  [1, false, false],
] as const)(
  "only the explicit V1 graph handoff stops unchanged-prompt writer failover (revision %s, graph %s)",
  async (semanticRevision, graph, stop) => {
    const events: string[] = [];
    const generate = vi
      .spyOn(FreeModelProvider.prototype, "generate")
      .mockImplementationOnce(async () => ({
        text: JSON.stringify({ ...valid, processed_block_ids: [] }),
        usage: { input: 12, output: 8, thinking: 0 },
        complete: true,
      }))
      .mockImplementationOnce(async () => ({
        text: JSON.stringify(valid),
        usage: { input: 12, output: 8, thinking: 0 },
        complete: true,
      }));
    const retained: unknown[] = [];
    const saveRound = vi.fn();
    const ledger: Ledger = {
      preflight: async () => ({
        routing_mode: "round_robin",
        providers: [config, { ...config, model: "fixture-b" }],
      }),
      environment: (target) => ({ ...env, model: target.model }),
      reserve: async () => "fixture-usage",
      settle: async () => {
        events.push("settled");
      },
      candidateReceived: async () => {
        events.push("counted");
      },
      beginAttempt: async () => "1",
      loadRound: async (inputHash) => ({
        input_hash: inputHash,
        remaining: [config, { ...config, model: "fixture-b" }],
        output_error: null,
        retry_windows: [],
      }),
      saveRound,
      endAttempt: async (_id, code) => {
        events.push(code);
      },
      invalidCandidate: async (candidate, code, diagnostics) => {
        retained.push({ candidate, code, diagnostics });
        events.push("retained");
        return "repair";
      },
    };
    const operation = executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env },
      ledger,
      "en",
      false,
      fetch,
      1,
      {
        independentGrounding: true,
        semanticRevision,
        repairContentValidation: graph,
      },
    );
    if (stop)
      await expect(operation).rejects.toBeInstanceOf(ModelCandidateRepair);
    else await expect(operation).resolves.toEqual(valid);
    expect(generate).toHaveBeenCalledTimes(stop ? 1 : 2);
    if (stop) expect(saveRound).not.toHaveBeenCalled();
    expect(events.slice(0, 4)).toEqual([
      "settled",
      "counted",
      "retained",
      "MODEL_COVERAGE_INCOMPLETE",
    ]);
    expect(retained).toEqual([
      {
        candidate: { ...valid, processed_block_ids: [] },
        code: "MODEL_COVERAGE_INCOMPLETE",
        diagnostics: [
          {
            code: "MODEL_COVERAGE_INCOMPLETE",
            reason: "required_ids_mismatch",
            paths: ["$.processed_block_ids"],
            requirement_ids: ["block-1"],
          },
        ],
      },
    ]);
  },
);

it.each(["malformed", "schema", "policy"])(
  "does not send %s output into the content-repair handoff",
  async (kind) => {
    const invalidCandidate = vi.fn(async () => "repair" as const);
    vi.spyOn(FreeModelProvider.prototype, "generate").mockResolvedValue({
      text:
        kind === "malformed"
          ? "{"
          : JSON.stringify(
              kind === "schema"
                ? { incomplete: true }
                : { ...valid, summary: "person@example.test" },
            ),
      usage: { input: 12, output: 8, thinking: 0 },
      complete: true,
    });
    const ledger: Ledger = {
      preflight: async () => ({ providers: [config] }),
      reserve: async () => "fixture-usage",
      settle: async () => {},
      invalidCandidate,
    };
    await expect(
      executeModel(
        "analyze_chunk",
        {},
        evidence,
        ["block-1"],
        [],
        { qwen_free: env },
        ledger,
        "en",
        false,
        fetch,
        1,
        {
          independentGrounding: true,
          semanticRevision: 1,
          repairContentValidation: true,
        },
      ),
    ).rejects.toThrow();
    expect(invalidCandidate).not.toHaveBeenCalled();
  },
);
