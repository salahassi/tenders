// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";

const generation = vi.hoisted(() => vi.fn());
const notification = vi.hoisted(() => vi.fn());
vi.mock("../../supabase/functions/_shared/generation", () => ({
  processGeneration: generation,
}));
vi.mock("../../supabase/functions/_shared/notifications", async (original) => ({
  ...(await original<object>()),
  processNotificationEmail: notification,
}));
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-service",
  allowedOrigins: [],
  workerSecret: "synthetic-worker",
  models: modelEnvironments(() => undefined),
};
const request = (
  maintenance = false,
  secret = env.workerSecret,
  method = "POST",
) =>
  new Request(
    `https://synthetic.test/functions/v1/worker${maintenance ? "/maintenance" : ""}`,
    {
      method,
      headers: { "x-worker-secret": secret },
    },
  );

function fixture({
  empty = false,
  hint = 30000,
  holdMaintenance,
}: {
  empty?: boolean;
  hint?: unknown;
  holdMaintenance?: () => Promise<void>;
} = {}) {
  const jobs = [1, 2].map((n) => ({
    id: `synthetic-${n}`,
    type: "analyze_chunk",
    lease_token: `lease-${n}`,
  }));
  const claim = vi.fn(async () => (empty ? null : (jobs.shift() ?? null)));
  const internal = vi.fn(
    async (name: string, _args?: unknown): Promise<unknown> => {
      if (name === "verify_dispatcher_secret") return true;
      if (name === "maintenance_tick") await holdMaintenance?.();
      if (name === "claim_storage_cleanup") return [];
      if (name === "wake_backend_queue_status_v7")
        return {
          dispatched: false,
          retry_after_ms: hint,
          wait_kind: "accepted_remote_poll",
          job_revision: 7,
        };
      return null;
    },
  );
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error("UNEXPECTED_PROVIDER_CALL");
  });
  const factory = () =>
    ({
      claim,
      internal,
      invocationStartedAt: Date.now(),
      invocationBudgetMs: 130000,
    }) as unknown as Backend;
  const handle = createWorkerHandler(
    env,
    async () => [],
    factory,
    fetcher,
    undefined,
    { persistent: true },
  );
  return { handle, claim, internal, fetcher, factory };
}
beforeEach(() => {
  generation.mockReset().mockResolvedValue(undefined);
  notification.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("returns a future poll hint without sleeping or replaying the accepted job", async () => {
  const f = fixture();
  const result = await f.handle(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    data: { job_id: "synthetic-1", processed: true, claimed: true },
    queue_retry_after_ms: 30000,
  });
  expect(generation).toHaveBeenCalledTimes(1);
  expect(f.claim).toHaveBeenCalledTimes(1);
  expect(f.internal.mock.calls.map(([name]) => name)).toEqual([
    "claim_backend_local_job_v7",
    "wake_backend_queue_status_v7",
  ]);
  expect(notification).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
}, 1500);

it("preserves the original accepted request's poll hint after chaining local work", async () => {
  const f = fixture();
  const original = f.internal.getMockImplementation()!;
  let localClaimed = false;
  f.internal.mockImplementation(async (name, args) => {
    if (name === "claim_backend_local_job_v7" && !localClaimed) {
      localClaimed = true;
      return {
        id: "synthetic-local",
        type: "advance_plan",
        lease_token: "lease-local",
      };
    }
    if (name === "wake_backend_queue_status_v7") {
      expect(args).toEqual({ job_id: "synthetic-1", lease: "lease-1" });
    }
    return original(name, args);
  });
  const result = await f.handle(request());
  expect(await result.json()).toEqual({
    data: { job_id: "synthetic-1", processed: true, claimed: true },
    queue_retry_after_ms: 30000,
  });
  expect(generation.mock.calls.map(([, , job]) => job.id)).toEqual([
    "synthetic-1",
    "synthetic-local",
  ]);
  expect(
    f.internal.mock.calls.filter(
      ([name]) => name === "wake_backend_queue_status_v7",
    ),
  ).toHaveLength(1);
});

it("allows the next foreground job to complete while a separately awaited maintenance request is blocked", async () => {
  let entered!: () => void, release!: () => void;
  const atMaintenance = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    holdMaintenance: async () => {
      entered();
      await held;
    },
  });
  let maintenanceFinished = false;
  const maintenance = f.handle(request(true)).then((result) => {
    maintenanceFinished = true;
    return result;
  });
  await atMaintenance;
  expect(f.claim).not.toHaveBeenCalled();
  try {
    const first = await f.handle(request());
    const second = await f.handle(request());
    expect((await first.json()).data.job_id).toBe("synthetic-1");
    expect((await second.json()).data.job_id).toBe("synthetic-2");
    expect(generation).toHaveBeenCalledTimes(2);
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(maintenanceFinished).toBe(false);
  } finally {
    release();
  }
  expect(await (await maintenance).json()).toEqual({
    data: { maintenance: true },
  });
  expect(notification).toHaveBeenCalledTimes(1);
  expect(f.claim).toHaveBeenCalledTimes(2);
}, 1500);

it("does not run housekeeping or re-claim work when the foreground queue is empty", async () => {
  const f = fixture({ empty: true });
  expect(await (await f.handle(request())).json()).toEqual({
    data: { claimed: false },
  });
  expect(f.claim).toHaveBeenCalledTimes(1);
  expect(f.internal).not.toHaveBeenCalled();
  expect(generation).not.toHaveBeenCalled();
});

it("joins an unfinished maintenance run and starts another only after it settles", async () => {
  let entered!: () => void, release!: () => void;
  const atMaintenance = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    holdMaintenance: async () => {
      entered();
      await held;
    },
  });
  // Use the synchronous mock RPC authentication result so one microtask is a
  // deterministic barrier after the retried request has joined the held run.
  const handle = createWorkerHandler(
    { ...env, workerSecret: "" },
    async () => [],
    f.factory,
    f.fetcher,
    undefined,
    { persistent: true },
  );
  const first = handle(request(true));
  await atMaintenance;
  let retryFinished = false;
  const retry = handle(request(true)).then((result) => {
    retryFinished = true;
    return result;
  });
  await Promise.resolve();
  const maintenanceCalls = () =>
    f.internal.mock.calls.filter(([name]) => name === "maintenance_tick");
  try {
    expect(maintenanceCalls()).toHaveLength(1);
    expect(retryFinished).toBe(false);
    expect(f.claim).not.toHaveBeenCalled();
  } finally {
    release();
  }
  const results = await Promise.all([first, retry]);
  for (const result of results)
    expect(await result.json()).toEqual({ data: { maintenance: true } });
  expect(notification).toHaveBeenCalledTimes(1);
  expect((await handle(request(true))).status).toBe(200);
  expect(maintenanceCalls()).toHaveLength(2);
  expect(notification).toHaveBeenCalledTimes(2);
  expect(f.claim).not.toHaveBeenCalled();
});

it("reports failed maintenance without claiming or retrying business work", async () => {
  const f = fixture({
    holdMaintenance: async () => {
      throw new Error("PRIVATE_MAINTENANCE_FAILURE");
    },
  });
  const result = await f.handle(request(true));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    data: { maintenance: true },
    maintenance_pending: ["maintenance_tick"],
  });
  expect(f.claim).not.toHaveBeenCalled();
  expect(generation).not.toHaveBeenCalled();
  expect(f.internal.mock.calls.map(([name]) => name)).toContain(
    "claim_storage_cleanup",
  );
});

it.each([0, 60001, "30000", null, Number.NaN])(
  "omits invalid scheduler hints (%s)",
  async (hint) => {
    const f = fixture({ hint });
    expect(await (await f.handle(request())).json()).not.toHaveProperty(
      "queue_retry_after_ms",
    );
  },
);

it.each([false, true])(
  "authenticates both persistent routes before any operation (maintenance=%s)",
  async (maintenance) => {
    const f = fixture();
    expect((await f.handle(request(maintenance, "wrong"))).status).toBe(401);
    expect(
      (await f.handle(request(maintenance, env.workerSecret, "GET"))).status,
    ).toBe(405);
    expect(f.internal).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
  },
);

it("keeps the maintenance route disabled in the default edge handler", async () => {
  const f = fixture();
  const edge = createWorkerHandler(env, async () => [], f.factory, f.fetcher);
  expect((await edge(request(true))).status).toBe(404);
  expect(f.internal).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
});

it("rejects detached background processing in persistent mode", () => {
  const f = fixture();
  expect(() =>
    createWorkerHandler(
      env,
      async () => [],
      f.factory,
      f.fetcher,
      () => {},
      { persistent: true },
    ),
  ).toThrow("PERSISTENT_WORKER_REQUIRES_AWAITED_PROCESSING");
});
