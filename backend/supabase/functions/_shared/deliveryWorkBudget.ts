import { AppError } from "./http.ts";

type ClockContext = {
  server_now: unknown;
  lease_until: unknown;
  deadline_at?: unknown;
};
/** A runtime CPU budget derived from the DB's current clock and existing lease /
 * request. RPC time is charged conservatively. Refreshes may only shorten it. */
export class DeliveryWorkBudget {
  private readonly controller = new AbortController();
  private bound = Infinity;
  private reason: AppError | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  get signal() {
    return this.controller.signal;
  }
  observe(
    context: ClockContext,
    rpcStarted: number,
    deadlineCode?: "PROPOSAL_ISSUANCE_TIMEOUT" | "EXPORT_ISSUANCE_TIMEOUT",
  ) {
    const received = performance.now();
    const parse = (value: unknown) =>
      typeof value === "string" ? Date.parse(value) : NaN;
    const server = parse(context.server_now),
      lease = parse(context.lease_until);
    if (
      !Number.isFinite(server) ||
      !Number.isFinite(lease) ||
      !Number.isFinite(rpcStarted) ||
      rpcStarted > received
    )
      throw new AppError(
        422,
        "DELIVERY_ARTIFACT_INVALID",
        "The current render lease clock is unavailable.",
      );
    let remaining = lease - server,
      code = "STALE_LEASE";
    if (deadlineCode) {
      const deadline = parse(context.deadline_at);
      if (!Number.isFinite(deadline))
        throw new AppError(
          422,
          "DELIVERY_ARTIFACT_INVALID",
          "The current issuance clock is unavailable.",
        );
      if (deadline - server <= remaining) {
        remaining = deadline - server;
        code = deadlineCode;
      }
    }
    remaining -= received - rpcStarted;
    const target = received + Math.max(0, remaining);
    if (target < this.bound) {
      this.bound = target;
      if (this.timer !== undefined) clearTimeout(this.timer);
      const reason = new AppError(
        409,
        code,
        code === "STALE_LEASE"
          ? "The current render lease has ended."
          : "The accepted issuance deadline has elapsed.",
      );
      this.reason = reason;
      if (remaining <= 0) this.controller.abort(reason);
      else
        this.timer = setTimeout(() => this.controller.abort(reason), remaining);
    }
    this.check();
  }
  check() {
    if (!this.signal.aborted && performance.now() >= this.bound)
      this.controller.abort(this.reason);
    this.signal.throwIfAborted();
  }
  dispose() {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
