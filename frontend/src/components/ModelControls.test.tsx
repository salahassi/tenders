import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
            : path === "/v1/model-environment"
              ? { providers: [{ ...model, key_configured: true }] }
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

function setup(role = "Owner", saved: Record<string, unknown>[] = []) {
  const runCommand = vi.fn(async () => ({}));
  const request = vi.fn(async (path: string) => ({
    data:
      path === "/v1/model-settings"
        ? { records: saved }
        : path === "/v1/model-environment"
          ? {
              providers: [
                {
                  provider: "gemini_free",
                  model: "gemini-3.8-flash",
                  project_ref: "synthetic-project",
                  key_configured: true,
                },
                {
                  provider: "groq_free",
                  model: "synthetic-optional-model",
                  project_ref: "synthetic-optional-project",
                  key_configured: true,
                },
              ],
            }
          : path === "/v1/eligibility"
            ? { items: [], authorizations: [] }
            : { records: [] },
  }));
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: { request },
  } as any);
  render(<ModelControls />);
  return { runCommand, request };
}

it("prefills server model identity without inventing quota or activating optional providers", async () => {
  const f = setup();
  await screen.findByDisplayValue("gemini-3.8-flash");
  expect(screen.getByDisplayValue("synthetic-project")).toBeInTheDocument();
  const panel = within(
    screen.getByRole("heading", { name: "Gemini free tier" }).parentElement!,
  );
  expect(
    panel.getByLabelText(/I verified this project's free billing/),
  ).not.toBeChecked();
  expect(panel.getByLabelText("Free quota expiry (UTC)")).toHaveValue("");
  expect(panel.getByLabelText("quota remaining tokens")).toHaveValue(0);
  expect(
    panel.getByLabelText(
      "Enable matching backend credentials after verification",
    ),
  ).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider policies" }),
  );
  expect(f.runCommand).not.toHaveBeenCalled();
  await userEvent.type(
    panel.getByLabelText("Free quota expiry (UTC)"),
    "2099-01-01T00:00",
  );
  await userEvent.clear(panel.getByLabelText("quota remaining tokens"));
  await userEvent.type(panel.getByLabelText("quota remaining tokens"), "10000");
  await userEvent.click(
    panel.getByLabelText(/I verified this project's free billing/),
  );
  await userEvent.click(
    panel.getByLabelText(
      "Enable matching backend credentials after verification",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider policies" }),
  );
  await waitFor(() => expect(f.runCommand).toHaveBeenCalledTimes(1));
  expect(f.runCommand).toHaveBeenCalledWith(
    "model.configure",
    expect.objectContaining({
      provider: "gemini_free",
      model: "gemini-3.8-flash",
      project_ref: "synthetic-project",
      enabled: true,
    }),
  );
});

it("preserves an existing policy identity and permits disabling a mismatched policy", async () => {
  setup("Owner", [
    {
      provider: "gemini_free",
      model: "saved-model",
      project_ref: "saved-project",
      revision: 2,
      enabled: true,
    },
  ]);
  await screen.findByDisplayValue("saved-model");
  expect(screen.getByDisplayValue("saved-project")).toBeInTheDocument();
  expect(
    screen.getByText(/Model or project differs from the server configuration/),
  ).toBeInTheDocument();
  const panel = within(
    screen.getByRole("heading", { name: "Gemini free tier" }).parentElement!,
  );
  const toggle = panel.getByLabelText(
    "Enable matching backend credentials after verification",
  );
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
});

it("does not request Owner-only metadata for other roles", async () => {
  const f = setup("Reviewer");
  await screen.findByRole("button", { name: "Save provider policies" });
  expect(f.request).not.toHaveBeenCalledWith("/v1/model-environment");
  expect(
    screen.getByRole("button", { name: "Save provider policies" }),
  ).toBeDisabled();
});
