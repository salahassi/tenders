// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryWorkBudget } from "../../supabase/functions/_shared/deliveryWorkBudget";
const server = Date.parse("2040-01-01T00:00:00Z"),
  iso = (ms: number) => new Date(server + ms).toISOString();
function clock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
}
afterEach(() => vi.useRealTimers());
it("uses the server clock, consumes RPC waiting and never grants another600 seconds", () => {
  clock();
  const budget = new DeliveryWorkBudget(),
    start = performance.now();
  vi.advanceTimersByTime(200);
  budget.observe(
    { server_now: iso(0), lease_until: iso(60_000), deadline_at: iso(1000) },
    start,
    "PROPOSAL_ISSUANCE_TIMEOUT",
  );
  vi.advanceTimersByTime(799);
  expect(budget.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  expect(budget.signal.reason.code).toBe("PROPOSAL_ISSUANCE_TIMEOUT");
  budget.dispose();
});
it("a refreshed context may shorten but cannot extend the accepted lease/request budget", () => {
  clock();
  const budget = new DeliveryWorkBudget();
  budget.observe(
    { server_now: iso(0), lease_until: iso(5000), deadline_at: iso(1000) },
    performance.now(),
    "EXPORT_ISSUANCE_TIMEOUT",
  );
  vi.advanceTimersByTime(500);
  budget.observe(
    {
      server_now: iso(0),
      lease_until: iso(600_000),
      deadline_at: iso(600_000),
    },
    performance.now(),
    "EXPORT_ISSUANCE_TIMEOUT",
  );
  vi.advanceTimersByTime(500);
  expect(budget.signal.reason.code).toBe("EXPORT_ISSUANCE_TIMEOUT");
  budget.dispose();
});
it("honors the earlier lease and rejects absent or expired clock metadata", () => {
  clock();
  const budget = new DeliveryWorkBudget();
  budget.observe(
    { server_now: iso(0), lease_until: iso(10), deadline_at: iso(600_000) },
    performance.now(),
    "PROPOSAL_ISSUANCE_TIMEOUT",
  );
  vi.advanceTimersByTime(10);
  expect(budget.signal.reason.code).toBe("STALE_LEASE");
  budget.dispose();
  const invalid = new DeliveryWorkBudget();
  expect(() =>
    invalid.observe(
      { server_now: iso(0), lease_until: null },
      performance.now(),
    ),
  ).toThrow("lease clock");
  expect(() =>
    invalid.observe(
      { server_now: iso(0), lease_until: iso(-1) },
      performance.now(),
    ),
  ).toThrow("lease has ended");
  invalid.dispose();
});
it("disposes pending timers without a later false failure", () => {
  clock();
  const budget = new DeliveryWorkBudget();
  budget.observe(
    { server_now: iso(0), lease_until: iso(5000) },
    performance.now(),
  );
  budget.dispose();
  vi.advanceTimersByTime(6000);
  expect(budget.signal.aborted).toBe(false);
});
