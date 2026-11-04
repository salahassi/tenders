// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { AppError } from "../../supabase/functions/_shared/http";

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
const request = (key = env.workerSecret) =>
  new Request("https://synthetic.test/worker", {
    method: "POST",
    headers: { "x-worker-secret": key },
  });
const cleanup = (id: string) => ({
  id,
  lease_token: `lease-${id}`,
  storage_key: `synthetic/${id}`,
});

function fixture(
  options: {
    fail?: string;
    firstClaimEmpty?: boolean;
    empty?: boolean;
    cleanup?: unknown;
    abandoned?: unknown;
    beforeMaintenance?: () => Promise<void>;
    type?: string;
  } = {},
) {
  const events: string[] = [];
  const job = {
    id: "synthetic-job",
    type: options.type || "advance_plan",
    lease_token: "synthetic-lease",
  };
  const internal = vi.fn(async (name: string, _args: any = {}) => {
    events.push(name);
    if (name === options.fail) throw Error("PRIVATE_DO_NOT_LOG");
    if (name === "maintenance_tick") await options.beforeMaintenance?.();
    if (name === "claim_storage_cleanup") return options.cleanup ?? [];
    if (name === "claim_abandoned_model_request") return options.abandoned;
    return null;
  });
  const claim = vi.fn(async () => {
    events.push("claim");
    if (options.fail === "claim") throw Error("PRIVATE_DO_NOT_LOG");
    if (
      options.empty ||
      (options.firstClaimEmpty && claim.mock.calls.length === 1)
    )
      return null;
    return job;
  });
  const removeObject = vi.fn(async (_key: string) => {
    events.push("removeObject");
    if (options.fail === "removeObject") throw Error("PRIVATE_DO_NOT_LOG");
  });
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error("Unexpected external request");
  });
  generation.mockImplementation(async () => events.push("business_committed"));
  const backend = {
    internal,
    claim,
    removeObject,
    invocationStartedAt: Date.now(),
    // Skip the independent local-drain loop; its real queue guards have their
    // own database regression suite. No model/email request is made here.
    invocationBudgetMs: 0,
  } as unknown as Backend;
  const handle = createWorkerHandler(
    env,
    async () => [],
    () => backend,
    fetcher,
  );
  return { events, job, internal, claim, removeObject, fetcher, handle };
}

beforeEach(() => {
  generation.mockReset();
  notification.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("commits eligible business work before healthy housekeeping and preserves its response", async () => {
  const f = fixture();
  const response = await f.handle(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { job_id: f.job.id, processed: true },
  });
  expect(f.events.indexOf("business_committed")).toBeLessThan(
    f.events.indexOf("maintenance_tick"),
  );
  expect(f.claim).toHaveBeenCalledTimes(1);
  expect(notification).toHaveBeenCalledTimes(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each([
  ["maintenance_tick", "maintenance_tick"],
  ["schedule_assessment_refresh", "assessment_scheduling"],
  ["automation_notification_tick", "notification_delivery"],
  ["claim_abandoned_model_request", "usage_reconciliation"],
  ["claim_storage_cleanup", "storage_cleanup"],
] as const)(
  "reports failed %s without losing eligible business work or leaking the exception",
  async (fail, operation) => {
    const f = fixture({ fail });
    const response = await f.handle(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: { job_id: f.job.id, processed: true },
      maintenance_pending: [operation],
    });
    expect(generation).toHaveBeenCalledTimes(1);
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.internal).toHaveBeenCalledWith("claim_storage_cleanup");
    expect(console.warn).toHaveBeenCalledWith(
      "worker_maintenance_pending",
      operation,
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "PRIVATE_DO_NOT_LOG",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

it("isolates a notification delivery failure separately from scheduling", async () => {
  notification.mockRejectedValue(Error("PRIVATE_DO_NOT_LOG"));
  const f = fixture();
  expect(await (await f.handle(request())).json()).toMatchObject({
    data: { processed: true },
    maintenance_pending: ["notification_delivery"],
  });
  expect(f.internal).toHaveBeenCalledWith("claim_abandoned_model_request");
  expect(f.internal).toHaveBeenCalledWith("claim_storage_cleanup");
});

it("does not wait for stalled housekeeping before committing already eligible work", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({ beforeMaintenance: () => waiting });
  const result = f.handle(request());
  await vi.waitFor(() =>
    expect(f.internal).toHaveBeenCalledWith("maintenance_tick"),
  );
  expect(generation).toHaveBeenCalledTimes(1);
  expect(f.events.indexOf("business_committed")).toBeLessThan(
    f.events.indexOf("maintenance_tick"),
  );
  release();
  expect((await result).status).toBe(200);
});

it("reclaims once after maintenance makes work eligible without another maintenance pass", async () => {
  const f = fixture({ firstClaimEmpty: true });
  expect(await (await f.handle(request())).json()).toEqual({
    data: { job_id: f.job.id, processed: true },
  });
  expect(f.claim).toHaveBeenCalledTimes(2);
  expect(
    f.internal.mock.calls.filter(([name]) => name === "maintenance_tick"),
  ).toHaveLength(1);
  expect(generation).toHaveBeenCalledTimes(1);
});

it("reports no claimed work and an outstanding maintenance failure without invented processing", async () => {
  const f = fixture({ empty: true, fail: "maintenance_tick" });
  expect(await (await f.handle(request())).json()).toEqual({
    data: { claimed: false },
    maintenance_pending: ["maintenance_tick"],
  });
  expect(f.claim).toHaveBeenCalledTimes(2);
  expect(generation).not.toHaveBeenCalled();
});

it.each([{}, [null], [{ id: "bad", storage_key: "synthetic/missing-lease" }]])(
  "rejects malformed cleanup receipts without issuing a deletion (%j)",
  async (batch) => {
    const f = fixture({ cleanup: batch });
    expect(await (await f.handle(request())).json()).toMatchObject({
      data: { processed: true },
      maintenance_pending: ["storage_cleanup"],
    });
    expect(f.removeObject).not.toHaveBeenCalled();
    expect(
      f.internal.mock.calls.some(
        ([name]) => name === "complete_storage_cleanup",
      ),
    ).toBe(false);
  },
);

it("retains failed cleanup rather than freeing capacity, and continues its batch", async () => {
  const first = cleanup("first"),
    second = cleanup("second");
  const f = fixture({ cleanup: [first, second] });
  f.removeObject.mockRejectedValueOnce(Error("PRIVATE_DO_NOT_LOG"));
  expect(await (await f.handle(request())).json()).toMatchObject({
    maintenance_pending: ["storage_cleanup"],
  });
  expect(f.internal).toHaveBeenCalledWith("complete_storage_cleanup", {
    cleanup_id: first.id,
    lease: first.lease_token,
    succeeded: false,
  });
  expect(f.internal).toHaveBeenCalledWith("complete_storage_cleanup", {
    cleanup_id: second.id,
    lease: second.lease_token,
    succeeded: true,
  });
  expect(f.removeObject).toHaveBeenCalledTimes(2);
});

it("isolates cleanup completion failure without pretending it was committed or abandoning other leased items", async () => {
  const first = cleanup("first"),
    second = cleanup("second");
  const f = fixture({
    cleanup: [first, second],
    fail: "complete_storage_cleanup",
  });
  expect(await (await f.handle(request())).json()).toMatchObject({
    data: { processed: true },
    maintenance_pending: ["storage_cleanup"],
  });
  expect(f.removeObject).toHaveBeenCalledTimes(2);
  expect(
    f.internal.mock.calls.filter(
      ([name]) => name === "complete_storage_cleanup",
    ),
  ).toHaveLength(2);
  expect(console.warn).toHaveBeenCalledWith(
    "worker_maintenance_pending",
    "storage_cleanup",
  );
});

it("retains an unreconcilable accepted receipt without sending new content or settling unknown usage", async () => {
  const f = fixture({
    abandoned: {
      id: "synthetic-usage",
      provider: "openai",
      model: "synthetic-model",
      project_ref: "synthetic-project",
      remote_request_id: "synthetic-accepted",
    },
  });
  expect(await (await f.handle(request())).json()).toMatchObject({
    data: { processed: true },
    maintenance_pending: ["usage_reconciliation"],
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(
    f.internal.mock.calls.some(([name]) => name === "settle_model_call"),
  ).toBe(false);
});

it("does not let maintenance isolation bypass dispatcher authentication", async () => {
  const f = fixture();
  expect((await f.handle(request("wrong-secret"))).status).toBe(401);
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.internal).not.toHaveBeenCalled();
  expect(generation).not.toHaveBeenCalled();
});

it("keeps a failed critical business claim fatal instead of reporting maintenance-only success", async () => {
  const f = fixture({ fail: "claim" });
  const response = await f.handle(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "DISPATCH_FAILED" });
  expect(f.internal).not.toHaveBeenCalled();
  expect(generation).not.toHaveBeenCalled();
});

it.each(["STALE_LEASE", "DATA_AUTHORIZATION_REQUIRED", "STALE_INPUT"])(
  "keeps critical business %s failures fatal and never emits processed success",
  async (code) => {
    const f = fixture();
    generation.mockRejectedValueOnce(
      new AppError(409, code, "PRIVATE_DO_NOT_LOG"),
    );
    const response = await f.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DISPATCH_FAILED" });
    expect(f.internal).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

it("preserves source authorization failure and never fetches or completes that source", async () => {
  const f = fixture({ type: "source_collect" });
  const base = f.internal.getMockImplementation()!;
  f.internal.mockImplementation(async (name, args) => {
    if (name === "collection_context")
      throw new AppError(403, "ROLE_FORBIDDEN", "PRIVATE_DO_NOT_LOG");
    return base(name, args);
  });
  expect(await (await f.handle(request())).json()).toEqual({
    data: { job_id: f.job.id, error_code: "ROLE_FORBIDDEN" },
  });
  expect(f.internal).toHaveBeenCalledWith("fail_collection", {
    job_id: f.job.id,
    lease: f.job.lease_token,
    error_code: "ROLE_FORBIDDEN",
    retry_after: null,
  });
  expect(
    f.internal.mock.calls.some(([name]) => name === "complete_collection"),
  ).toBe(false);
  expect(generation).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
