import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import ModelCatalogControls from "./ModelCatalogControls";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(role = "Owner") {
  const capabilities = {
    revision: 1,
    output: "native_strict",
    background: true,
    streaming: false,
    reasoning: "none",
    reasoning_values: [],
    max_output_tokens: null,
  };
  const rows: Record<string, any[]> = {
    "model-connections": [
      {
        id: "connection-one",
        provider: "openai",
        label: "Fixture account",
        project_ref: "default",
        credential_alias: "APP_MODEL_OPENAI_KEY",
        enabled: true,
        revision: 1,
      },
    ],
    "model-configurations": [
      {
        id: "model-one",
        connection_id: "connection-one",
        label: "Primary",
        model: "owner-model-a",
        enabled: true,
        capabilities,
        revision: 1,
      },
      {
        id: "model-two",
        connection_id: "connection-one",
        label: "Alternative",
        model: "owner-model-b",
        enabled: true,
        capabilities,
        revision: 1,
      },
    ],
    "model-task-routes": [
      {
        id: "route",
        task: "default",
        model_ids: ["model-one", "model-two"],
        inherit_default: false,
        strategy: "priority",
        profile: null,
        revision: 3,
      },
    ],
    "model-execution-settings": [{ enabled: false, revision: 1 }],
  };
  const request = vi.fn(async (path: string) => ({
    data: path.includes("model-catalog-status")
      ? {
          connections: [{ id: "connection-one", key_configured: true }],
          tasks: [
            {
              task: "analyze_chunk",
              profile: {
                revision: 1,
                max_output_tokens: 16384,
                reasoning: "medium",
                require_native_strict: false,
              },
            },
          ],
        }
      : { records: rows[path.split("/").at(-1)!.split("?")[0]] },
  }));
  const runCommand = vi.fn(async (op: string, input: any) => {
    if (op === "model.task_route.save") {
      const next = { ...input, revision: input.expected_revision + 1 };
      rows["model-task-routes"] = [
        ...rows["model-task-routes"].filter((r) => r.task !== input.task),
        next,
      ];
      return next;
    }
    return { ...input, revision: 2 };
  });
  vi.mocked(useApp).mockReturnValue({
    backend: { request },
    runCommand,
    state: { settings: { role } },
    notify: vi.fn(),
    saving: false,
  } as any);
  render(<ModelCatalogControls legacy={<p>Existing routing controls</p>} />);
  return { request, runCommand };
}
it("keeps model names in configuration and only a credential alias in connection setup", async () => {
  const f = setup();
  await screen.findByText("owner-model-a");
  expect(screen.getByText("APP_MODEL_OPENAI_KEY")).toBeInTheDocument();
  expect(screen.getByText("Key present")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add model" }));
  await userEvent.type(screen.getByLabelText(/^Model name/), "owner-new-model");
  await userEvent.clear(screen.getByLabelText("Display label"));
  await userEvent.type(
    screen.getByLabelText("Display label"),
    "New selected model",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save model" }));
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith(
      "model.configuration.save",
      expect.objectContaining({
        connection_id: "connection-one",
        model: "owner-new-model",
        label: "New selected model",
        expected_revision: 0,
      }),
    ),
  );
  expect(JSON.stringify(f.runCommand.mock.calls)).not.toContain("api_key");
});
it("saves a per-task chain including two models on one provider, with inherited defaults and a task profile", async () => {
  const f = setup();
  await screen.findByText("owner-model-a");
  await userEvent.selectOptions(screen.getByLabelText("Task"), "analyze_chunk");
  await userEvent.selectOptions(
    screen.getByLabelText("Add a model to this task"),
    "model-two",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Add a model to this task"),
    "model-one",
  );
  await userEvent.click(screen.getByText("Output and reasoning for this task"));
  await userEvent.click(screen.getByLabelText("Customize task profile"));
  expect(screen.getByLabelText("Maximum output tokens")).toHaveValue(16384);
  await userEvent.click(
    screen.getByRole("button", { name: "Save task routing" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith(
      "model.task_route.save",
      expect.objectContaining({
        task: "analyze_chunk",
        model_ids: ["model-two", "model-one"],
        inherit_default: true,
        profile: {
          revision: 1,
          max_output_tokens: 16384,
          reasoning: "medium",
          require_native_strict: false,
        },
      }),
    ),
  );
  expect(screen.getByLabelText("Task")).toHaveValue("analyze_chunk");
});
it("retains the previous execution mode until explicitly enabled for new work", async () => {
  const f = setup();
  await screen.findByText("Existing provider routing active");
  expect(f.runCommand).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Enable task routing for new work" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith("model.execution.configure", {
      expected_revision: 1,
      enabled: true,
    }),
  );
});
it("gives non-Owners a read-only view without requesting credential status", async () => {
  const f = setup("Reviewer");
  await screen.findByText("owner-model-a");
  expect(screen.getByRole("button", { name: "Add model" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Save task routing" }),
  ).toBeDisabled();
  expect(f.request.mock.calls.some(([p]) => p.includes("catalog-status"))).toBe(
    false,
  );
});
