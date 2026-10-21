import type { Backend } from "../_shared/backend.ts";

type WakeBackend = Pick<
  Backend,
  "internal" | "invocationStartedAt" | "invocationBudgetMs"
>;
const POST_WAKE_MARGIN_MS = 5000;

// The job lease has already been released. Never drain work in this invocation,
// loop on a cooldown, or change eligibility; a second RPC rechecks every guard.
export async function wakeReadyQueue(
  backend: WakeBackend,
  job: { id: string; lease_token: string },
  timing = {
    now: () => Date.now(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
) {
  const args = { job_id: job.id, lease: job.lease_token };
  const result = await backend.internal("wake_backend_queue_status", args);
  const delay = result?.retry_after_ms;
  const remotePoll = result?.wait_kind === "accepted_remote_poll";
  const revision = result?.job_revision;
  const remaining = () =>
    backend.invocationBudgetMs - (timing.now() - backend.invocationStartedAt);
  if (
    result?.dispatched !== false ||
    !Number.isInteger(delay) ||
    delay < 1 ||
    delay > (remotePoll ? 60000 : 10000) ||
    (remotePoll && (!Number.isSafeInteger(revision) || revision < 1)) ||
    !(remaining() > delay + POST_WAKE_MARGIN_MS)
  )
    return;
  await timing.sleep(delay);
  // A suspended invocation may resume later than requested. Let cron recover
  // if the remaining budget no longer leaves time for the second RPC.
  if (remaining() <= POST_WAKE_MARGIN_MS) return;
  await backend.internal(
    remotePoll ? "wake_backend_queue_revision" : "wake_backend_queue_status",
    remotePoll ? { ...args, expected_revision: revision } : args,
  );
}
