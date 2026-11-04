// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  executeModel,
  type Ledger,
  type ModelPool,
  FreeModelProvider,
} from "../../supabase/functions/_shared/model";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const env = {
  provider: "openai",
  model: "synthetic-model",
  projectRef: "synthetic-project",
  key: "synthetic-placeholder",
};
const config = {
  provider: "openai" as const,
  model: env.model,
  project_ref: env.projectRef,
  enabled: true,
  automatic: true,
  quota_mode: "provider_managed" as const,
  free_only: false,
  billing_verified: false,
  free_quota_only: false,
  verified_at: "2026-11-04T00:00:00Z",
  quota_ends_at: null,
  capabilities: { ...defaultCapabilities("openai"), background: false },
};
const issuance = (deadline = Date.now() + 600000) => ({
  id: "synthetic-issuance",
  deadline_at: new Date(deadline).toISOString(),
  outcome: "active",
  error_code: null,
});
function ledger(pool: ModelPool): Ledger {
  return {
    preflight: vi.fn(async () => pool),
    reserve: vi.fn(async () => "synthetic-reservation"),
    settle: vi.fn(),
    attempt: vi.fn(),
    beginAttempt: vi.fn(),
  };
}
const run = (l: Ledger, fetcher: any, environments: any = { openai: env }) =>
  executeModel(
    "connection_probe",
    {},
    [],
    [],
    [],
    environments,
    l,
    "en",
    false,
    fetcher,
  );
it.each(["missing_credentials", "disabled", "cooldown", "empty"] as const)(
  "fails a new issuance immediately for %s without reservation or transport",
  async (reason) => {
    const c = {
      ...config,
      ...(reason === "disabled" ? { enabled: false } : {}),
      ...(reason === "cooldown"
        ? { retry_after: new Date(Date.now() + 60000).toISOString() }
        : {}),
    };
    const l = ledger({
      routing_mode: "round_robin",
      providers: reason === "empty" ? [] : [c],
      issuance_request: issuance(),
    });
    const fetcher = vi.fn();
    await expect(
      run(l, fetcher, reason === "missing_credentials" ? {} : undefined),
    ).rejects.toMatchObject({ code: "AI_AGENTS_UNAVAILABLE" });
    expect(l.reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(l.beginAttempt).not.toHaveBeenCalled();
  },
);
it("does not silently change historical unpinned failover semantics", async () => {
  const l = ledger({ routing_mode: "round_robin", providers: [] });
  await expect(run(l, vi.fn())).rejects.toMatchObject({
    code: "MODEL_ROUND_EXHAUSTED",
  });
});
it("rejects an elapsed accepted deadline before paid work starts", async () => {
  const l = ledger({
    routing_mode: "round_robin",
    providers: [config],
    issuance_request: issuance(Date.now() - 1),
  });
  const fetcher = vi.fn();
  await expect(run(l, fetcher)).rejects.toMatchObject({
    code: "PROPOSAL_ISSUANCE_TIMEOUT",
  });
  expect(l.reserve).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("aborts a stalled accepted POST at the remaining request-wide deadline and preserves unknown usage", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const l = ledger({
    routing_mode: "round_robin",
    providers: [config],
    issuance_request: issuance(Date.now() + 250),
  });
  const fetcher = vi.fn(
    (_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Synthetic timeout", "AbortError")),
        );
      }),
  );
  const result = run(l, fetcher);
  const rejection = expect(result).rejects.toMatchObject({
    code: "PROPOSAL_ISSUANCE_TIMEOUT",
  });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), {
    interval: 1,
  });
  await vi.advanceTimersByTimeAsync(250);
  await rejection;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(l.reserve).toHaveBeenCalledTimes(1);
  expect(l.settle).toHaveBeenCalledWith(
    "synthetic-reservation",
    { input: null, output: null, thinking: null },
    "PROPOSAL_ISSUANCE_TIMEOUT",
  );
});
it("bounds accepted remote GET polling by the same absolute deadline, even when ordinary poll timeout is20seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const fetcher = vi.fn(
    (_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Synthetic timeout", "AbortError")),
        );
      }),
  );
  const provider = new FreeModelProvider(
    env,
    fetcher,
    90000,
    false,
    config,
    1,
    0,
    false,
    Date.now() + 250,
  );
  const result = provider.pollBackground("synthetic-remote");
  const rejection = expect(result).rejects.toMatchObject({
    code: "PROPOSAL_ISSUANCE_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(250);
  await rejection;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].method).toBe("GET");
});

it("terminates immediately when every initially eligible provider rejects with403 quota exhaustion", async () => {
  const second = {
    ...config,
    provider: "qwencloud" as const,
    capabilities: { ...defaultCapabilities("qwencloud"), background: false },
  };
  const l = ledger({
    routing_mode: "round_robin",
    providers: [config, second],
    issuance_request: issuance(),
  });
  const fetcher = vi.fn(async () =>
    Response.json(
      {
        error: {
          code: "insufficient_quota",
          message: "Synthetic provider quota exhausted",
        },
      },
      { status: 403 },
    ),
  );
  await expect(
    run(l, fetcher, {
      openai: env,
      qwencloud: { ...env, provider: "qwencloud" },
    }),
  ).rejects.toMatchObject({ code: "AI_AGENTS_UNAVAILABLE" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(l.reserve).toHaveBeenCalledTimes(2);
  expect(l.settle).toHaveBeenCalledTimes(2);
});
it("continues GET-only reconciliation of an accepted request despite generation cooldown without reserving another call", async () => {
  const c = {
    ...config,
    model_config_id: "synthetic-model-config",
    connection_id: "synthetic-connection",
    capabilities: { ...defaultCapabilities("openai"), background: true },
    retry_after: new Date(Date.now() + 60000).toISOString(),
  };
  const l = ledger({
    routing_mode: "round_robin",
    providers: [c],
    pending_model_config_id: c.model_config_id,
    issuance_request: issuance(),
  });
  l.resume = vi.fn(async () => ({
    id: "synthetic-reserved",
    remote_request_id: "synthetic-accepted",
    remote_deadline: new Date(Date.now() + 60000).toISOString(),
    state: "reserved",
    input_hash: "a".repeat(64),
  }));
  l.checkpoint = vi.fn();
  l.defer = vi.fn();
  const fetcher = vi.fn(async () =>
    Response.json({ id: "synthetic-accepted", status: "in_progress" }),
  );
  await expect(run(l, fetcher)).rejects.toMatchObject({
    code: "MODEL_IN_PROGRESS",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((fetcher.mock.calls[0] as any)[1].method).toBe("GET");
  expect(l.reserve).not.toHaveBeenCalled();
  expect(l.settle).not.toHaveBeenCalled();
});
