import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import ModelControls from "./ModelControls";

vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("saves an existing Gemini policy without requiring an unused Qwen profile", async () => {
  const runCommand = vi.fn(async () => ({}));
  const model = {
    provider: "gemini_free",
    model: "gemini-3.8-flash",
    project_ref: "synthetic-project",
    enabled: true,
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_ends_at: "2099-01-01T00:00:00Z",
    quota_remaining_tokens: 10000,
    calls_per_day: 10,
    input_per_day: 20000,
    output_per_day: 10000,
    failover_rank: 1,
    revision: 3,
  };
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: {
      request: vi.fn(async (path: string) => ({
        data:
          path === "/v1/model-settings"
            ? { records: [model] }
            : path === "/v1/eligibility"
              ? { items: [], authorizations: [] }
              : { records: [] },
      })),
    },
  } as any);
  render(<ModelControls />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Save provider policies" }),
  );
  await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
  expect(runCommand).toHaveBeenCalledWith(
    "model.configure",
    expect.objectContaining({
      provider: "gemini_free",
      model: "gemini-3.8-flash",
      expected_revision: 3,
      failover_rank: 1,
    }),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
