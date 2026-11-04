import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import OperationsPanel from "./OperationsPanel";

vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(uncertainty?: Record<string, number>, blocked: unknown[] = []) {
  const status = {
    server_time: "2026-11-04T12:00:00Z",
    last_heartbeat_at: "2026-11-04T12:00:00Z",
    last_source_success_at: null,
    last_maintenance_at: null,
    scheduler_enabled: true,
    reserved_storage_bytes: "10485760",
    cleanup_bytes: "10485760",
    extracted_bytes: "0",
    database_bytes: "0",
    queued_jobs: 0,
    blocked_jobs: 0,
    cleanup_pending: 1,
    cleanup_blocked: blocked.length,
    calls_today: 0,
    input_tokens_today: "0",
    output_tokens_today: "0",
    unknown_usage: 0,
    usage_day: "2026-11-04",
    model_enabled: true,
    ...(uncertainty ? { storage_write_uncertainty: uncertainty } : {}),
  };
  const backend = {
    request: vi.fn(async () => ({ data: status })),
    list: vi.fn(async (table: string) =>
      table === "storage-cleanup" ? blocked : [],
    ),
  };
  vi.mocked(useApp).mockReturnValue({
    backend,
    state: { settings: { role: "Owner" } },
  } as any);
  render(
    <MemoryRouter>
      <OperationsPanel />
    </MemoryRouter>,
  );
  return backend;
}

it("explains retained bytes without claiming historical file usage", async () => {
  setup({
    unsettled_keys: 1,
    held_bytes: 10485760,
    quiescence_required_keys: 0,
    historical_inventory_keys: 3,
  });
  expect(await screen.findByText(/1 uploads await confirmation/)).toBeVisible();
  expect(screen.getByText(/10.0 MiB of the reserved total/)).toBeVisible();
  expect(
    screen.getByText(/3 older file records need a storage audit/),
  ).toHaveTextContent("Their current physical usage has not been established.");
  expect(screen.queryByRole("button", { name: "Retry cleanup" })).toBeNull();
});

it("keeps older status responses usable without inventing uncertainty", async () => {
  setup();
  expect(
    await screen.findByText(/Background processing is responding/),
  ).toBeVisible();
  expect(screen.queryByLabelText("File storage verification")).toBeNull();
  expect(screen.queryByText(/uploads await confirmation/)).toBeNull();
});

it("offers retry only for cleanup that does not require administrator reconciliation", async () => {
  const backend = setup(
    {
      unsettled_keys: 0,
      held_bytes: 10485760,
      quiescence_required_keys: 1,
      historical_inventory_keys: 0,
    },
    [
      {
        id: "synthetic-unresolved",
        status: "blocked",
        error_code: "STORAGE_QUIESCENCE_REQUIRED",
        estimated_size: 10485760,
      },
      {
        id: "synthetic-retryable",
        status: "blocked",
        error_code: "STORAGE_DELETE_FAILED",
        estimated_size: 1024,
      },
    ],
  );
  const retry = await screen.findByRole("button", { name: "Retry cleanup" });
  expect(screen.getAllByRole("button", { name: "Retry cleanup" })).toHaveLength(
    1,
  );
  expect(
    screen.getByText(/Administrator storage checks required/),
  ).toBeVisible();
  await userEvent.click(retry);
  expect(backend.request).toHaveBeenCalledWith(
    "/v1/storage-cleanup/synthetic-retryable/retry",
    { method: "POST", body: {} },
  );
  expect(
    backend.request.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("synthetic-unresolved"),
    ),
  ).toBe(false);
});
