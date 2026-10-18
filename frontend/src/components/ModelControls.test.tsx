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
                  provider: "zai_free",
                  model: "owner-chosen-zai-model",
                  project_ref: "synthetic-zai-account",
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
    screen.getByRole("heading", { name: "Gemini" }).parentElement!,
  );
  expect(panel.queryByLabelText("Quota expiry (UTC)")).not.toBeInTheDocument();
  expect(
    panel.queryByLabelText("quota remaining tokens"),
  ).not.toBeInTheDocument();
  expect(
    panel.getByLabelText("Enable matching backend credentials"),
  ).toBeEnabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider policies" }),
  );
  expect(f.runCommand).not.toHaveBeenCalled();
  await userEvent.click(
    panel.getByLabelText("Enable matching backend credentials"),
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
      quota_mode: "provider_managed",
      quota_ends_at: null,
      quota_remaining_tokens: null,
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
    screen.getByRole("heading", { name: "Gemini" }).parentElement!,
  );
  const toggle = panel.getByLabelText("Enable matching backend credentials");
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

it("queues a bounded connection check only after Gemini has been saved enabled", async () => {
  const f = setup("Owner", [
    {
      provider: "gemini_free",
      model: "gemini-3.8-flash",
      project_ref: "synthetic-project",
      enabled: true,
      revision: 1,
      quota_mode: "provider_managed",
      quota_ends_at: null,
      quota_remaining_tokens: null,
    },
  ]);
  await userEvent.click(
    await screen.findByRole("button", { name: "Check Gemini connection" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith("model.probe", {});
  expect(
    await screen.findByText(/Connection check queued/),
  ).toBeInTheDocument();
});

it("enables round robin without individual enabled policies and can queue its operational check", async () => {
  let routing: Record<string, unknown> | undefined;
  const runCommand = vi.fn(async (operation: string, input: any) => {
    if (operation === "model.routing") routing = { ...input, revision: 1 };
    return {};
  });
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: {
      request: vi.fn(async (path: string) => ({
        data:
          path === "/v1/model-routing"
            ? { records: routing ? [routing] : [] }
            : path === "/v1/model-environment"
              ? { providers: [] }
              : path === "/v1/eligibility"
                ? { items: [], authorizations: [] }
                : { records: [] },
      })),
    },
  } as any);
  render(<ModelControls />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Enable automatic routing" }),
  );
  expect(runCommand).toHaveBeenCalledWith("model.routing", {
    enabled: true,
    expected_revision: 0,
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Check model routing" }),
  );
  expect(runCommand).toHaveBeenCalledWith("model.probe", {});
  expect(
    await screen.findByRole("button", {
      name: "Disable automatic routing",
    }),
  ).toBeEnabled();
});

it("loads an Owner-selected z.ai model and saves free continuous policy without fabricated quota", async () => {
  const f = setup();
  await screen.findByDisplayValue("owner-chosen-zai-model");
  const panel = within(
    screen.getByRole("heading", { name: "z.ai (optional)" }).parentElement!,
  );
  expect(panel.queryByLabelText("Quota expiry (UTC)")).not.toBeInTheDocument();
  await userEvent.click(
    panel.getByLabelText("Enable matching backend credentials"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider policies" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith(
      "model.configure",
      expect.objectContaining({
        provider: "zai_free",
        model: "owner-chosen-zai-model",
        project_ref: "synthetic-zai-account",
        enabled: true,
        billing_verified: false,
        quota_mode: "provider_managed",
        quota_ends_at: null,
        quota_remaining_tokens: null,
      }),
    ),
  );
});

it("persists provider priority and rotation mode with no billing-confirmation UI", async () => {
  let routing: Record<string, unknown> = {
    enabled: true,
    revision: 7,
    strategy: "priority",
    provider_order: [
      "gemini_free",
      "qwen_free",
      "mistral_free",
      "groq_free",
      "zai_free",
    ],
  };
  const runCommand = vi.fn(async (_op: string, input: any) => {
    routing = { ...input, revision: 8 };
    return {};
  });
  const request = vi.fn(async (path: string) => ({
    data:
      path === "/v1/model-routing"
        ? { records: [routing] }
        : path === "/v1/model-environment"
          ? { providers: [] }
          : path === "/v1/eligibility"
            ? { items: [], authorizations: [] }
            : { records: [] },
  }));
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: { request },
  } as any);
  const view = render(<ModelControls />);
  await screen.findByRole("button", { name: "Save provider order" });
  expect(screen.queryByText(/Accounts confirmed free/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Move Gemini up" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Move z.ai (optional) up" }),
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Provider selection"),
    "round_robin",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider order" }),
  );
  await waitFor(() =>
    expect(runCommand).toHaveBeenCalledWith("model.routing", {
      enabled: true,
      expected_revision: 7,
      strategy: "round_robin",
      provider_order: [
        "gemini_free",
        "qwen_free",
        "mistral_free",
        "zai_free",
        "groq_free",
      ],
    }),
  );
  view.unmount();
  render(<ModelControls />);
  await screen.findByRole("button", { name: "Save provider order" });
  expect(screen.getByLabelText("Provider selection")).toHaveValue(
    "round_robin",
  );
  expect(
    within(screen.getByRole("list", { name: "Provider order" })).getAllByRole(
      "listitem",
    )[3],
  ).toHaveTextContent("z.ai");
});
