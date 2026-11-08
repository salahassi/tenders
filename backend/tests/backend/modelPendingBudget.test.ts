import { afterEach, expect, it, vi } from "vitest";
import {
  executeModel,
  ModelDeferred,
  ModelError,
  type Ledger,
} from "../../supabase/functions/_shared/model";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";

afterEach(() => vi.restoreAllMocks());
const config = {
  provider: "openai" as const,
  model: "synthetic-model",
  project_ref: "synthetic-project",
  enabled: true,
  free_only: false,
  billing_verified: true,
  free_quota_only: false,
  quota_mode: "provider_managed" as const,
  verified_at: "2026-01-01T00:00:00Z",
  quota_ends_at: null,
  capabilities: defaultCapabilities("openai"),
};
const environment = {
  provider: "openai",
  model: config.model,
  projectRef: config.project_ref,
  key: "fixture-key",
};
function fixture(late: boolean, resume: NonNullable<Ledger["resume"]>) {
  const ledger: Ledger = {
    invocationStartedAt: Date.now() - (late ? 25000 : 0),
    invocationBudgetMs: 110000,
    preflight: vi.fn(async () => ({
      routing_mode: "round_robin" as const,
      providers: [config],
    })),
    reserve: vi.fn(),
    settle: vi.fn(),
    resume: vi.fn(resume),
    checkpoint: vi.fn(),
    defer: vi.fn(),
    beginAttempt: vi.fn(async () => "41"),
    endAttempt: vi.fn(),
    attempt: vi.fn(),
    loadRound: vi.fn(async (input_hash) => ({
      input_hash,
      remaining: [config],
      output_error: null,
      retry_windows: [],
    })),
    saveRound: vi.fn(),
  };
  const fetcher = vi.fn(async (_url: any, init: any) => {
    expect(init.method).toBe("GET");
    return Response.json({
      id: "accepted-id",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"status":"ready"}' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
  const run = () =>
    executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      { openai: environment },
      ledger,
      "en",
      false,
      fetcher,
    );
  return { ledger, fetcher, run };
}
const pending = () => ({
  id: "usage",
  remote_request_id: "accepted-id",
  remote_deadline: new Date(Date.now() + 60000).toISOString(),
});

it("polls an exact accepted phase after the fresh generation time budget is exhausted", async () => {
  const x = fixture(true, async () => pending());
  await expect(x.run()).resolves.toEqual({ status: "ready" });
  expect(x.fetcher).toHaveBeenCalledTimes(1);
  expect(x.ledger.resume).toHaveBeenCalledTimes(1);
  expect(x.ledger.reserve).not.toHaveBeenCalled();
  expect(x.ledger.settle).toHaveBeenCalledTimes(1);
  expect(x.ledger.saveRound).not.toHaveBeenCalledWith(expect.anything(), true);
});

it("still yields an unaccepted fresh phase without an attempt or provider call", async () => {
  const x = fixture(true, async () => null);
  await expect(x.run()).rejects.toBeInstanceOf(ModelDeferred);
  expect(x.ledger.resume).toHaveBeenCalledTimes(1);
  expect(x.ledger.beginAttempt).not.toHaveBeenCalled();
  expect(x.fetcher).not.toHaveBeenCalled();
  expect(x.ledger.reserve).not.toHaveBeenCalled();
  expect(x.ledger.settle).not.toHaveBeenCalled();
  expect(x.ledger.saveRound).toHaveBeenCalledWith(
    expect.objectContaining({
      remaining: [expect.objectContaining({ model: config.model })],
    }),
    true,
  );
  expect(x.ledger.saveRound).not.toHaveBeenCalledWith(null, false);
});

it.each([
  ["identity", () => new ModelError("MODEL_IDENTITY_CHANGED")],
  ["authorization", () => new ModelError("DATA_AUTHORIZATION_REQUIRED")],
  ["database transport", () => new Error("fixture transport failure")],
] as const)(
  "keeps %s resume failure bookkeeping identical before and after the fresh-send threshold",
  async (_name, failure) => {
    const outcomes: any[] = [];
    for (const late of [false, true]) {
      const x = fixture(late, async () => {
        throw failure();
      });
      let code: unknown;
      try {
        await x.run();
      } catch (error) {
        code = (error as ModelError).code;
      }
      expect(code).toBeDefined();
      expect(x.ledger.resume).toHaveBeenCalledTimes(1);
      expect(x.ledger.beginAttempt).toHaveBeenCalledTimes(1);
      expect(x.fetcher).not.toHaveBeenCalled();
      expect(x.ledger.reserve).not.toHaveBeenCalled();
      expect(x.ledger.settle).not.toHaveBeenCalled();
      outcomes.push({
        code,
        finished: vi.mocked(x.ledger.endAttempt!).mock.calls,
        attempts: vi.mocked(x.ledger.attempt!).mock.calls,
        rounds: vi.mocked(x.ledger.saveRound!).mock.calls,
      });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  },
);
