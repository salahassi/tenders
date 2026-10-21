// @vitest-environment node
import { expect, it, vi } from "vitest";
import { wakeReadyQueue } from "../../supabase/functions/worker/queueWake";

const job = { id: "synthetic-job", lease_token: "synthetic-released-lease" };
function fixture(first: unknown, second: unknown = { dispatched: true }) {
  let clock = 1000;
  const internal = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const backend = {
    internal,
    invocationStartedAt: 0,
    invocationBudgetMs: 130000,
  };
  const timing = {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
  };
  return {
    backend,
    timing,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

it.each([{ dispatched: true }, { dispatched: false }, null])(
  "does not wait when the RPC gives no eligible cooldown: %j",
  async (result) => {
    const f = fixture(result);
    await wakeReadyQueue(f.backend, job, f.timing);
    expect(f.backend.internal).toHaveBeenCalledTimes(1);
    expect(f.timing.sleep).not.toHaveBeenCalled();
  },
);

it.each([0, -1, 10001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5000"])(
  "rejects an invalid cooldown without waiting: %s",
  async (retry_after_ms) => {
    const f = fixture({ dispatched: false, retry_after_ms });
    await wakeReadyQueue(f.backend, job, f.timing);
    expect(f.timing.sleep).not.toHaveBeenCalled();
    expect(f.backend.internal).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { dispatched: true },
  { dispatched: false },
  { dispatched: false, retry_after_ms: 9999 },
])(
  "retries once after a bounded wait and never loops on the second result: %j",
  async (second) => {
    const f = fixture({ dispatched: false, retry_after_ms: 5000 }, second);
    await wakeReadyQueue(f.backend, job, f.timing);
    expect(f.timing.sleep).toHaveBeenCalledExactlyOnceWith(5000);
    expect(f.backend.internal.mock.calls).toEqual([
      ["wake_backend_queue_status", { job_id: job.id, lease: job.lease_token }],
      ["wake_backend_queue_status", { job_id: job.id, lease: job.lease_token }],
    ]);
  },
);

it.each([120000, 125000, 131000])(
  "leaves cron to continue when invocation budget cannot cover cooldown and margin (%s elapsed)",
  async (elapsed) => {
    const f = fixture({ dispatched: false, retry_after_ms: 5000 });
    f.setClock(elapsed);
    await wakeReadyQueue(f.backend, job, f.timing);
    expect(f.timing.sleep).not.toHaveBeenCalled();
    expect(f.backend.internal).toHaveBeenCalledTimes(1);
  },
);

it("counts time spent in the first RPC against the same invocation budget", async () => {
  const f = fixture(null);
  f.backend.internal.mockReset().mockImplementationOnce(async () => {
    f.setClock(125000);
    return { dispatched: false, retry_after_ms: 5000 };
  });
  await wakeReadyQueue(f.backend, job, f.timing);
  expect(f.timing.sleep).not.toHaveBeenCalled();
  expect(f.backend.internal).toHaveBeenCalledTimes(1);
});

it("does not issue the retry if a delayed timer consumes the remaining budget", async () => {
  const f = fixture({ dispatched: false, retry_after_ms: 5000 });
  f.timing.sleep.mockImplementationOnce(async () => {
    f.setClock(126000);
  });
  await wakeReadyQueue(f.backend, job, f.timing);
  expect(f.timing.sleep).toHaveBeenCalledTimes(1);
  expect(f.backend.internal).toHaveBeenCalledTimes(1);
});

it("lets the handler's nonfatal completion boundary handle a failed second RPC", async () => {
  const f = fixture({ dispatched: false, retry_after_ms: 10000 });
  f.backend.internal
    .mockReset()
    .mockResolvedValueOnce({ dispatched: false, retry_after_ms: 10000 })
    .mockRejectedValueOnce(new Error("synthetic unavailable dispatcher"));
  await expect(wakeReadyQueue(f.backend, job, f.timing)).rejects.toThrow(
    "synthetic unavailable dispatcher",
  );
  expect(f.backend.internal).toHaveBeenCalledTimes(2);
  expect(f.timing.sleep).toHaveBeenCalledExactlyOnceWith(10000);
});
