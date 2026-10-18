import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import ModelUsageReview from "./ModelUsageReview";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(role = "Owner") {
  const list = vi.fn(async () => [
    {
      id: "usage-fixture",
      provider: "openai",
      model: "owner-model",
      state: "unknown",
      revision: 3,
      reserved_input: 200,
      reserved_output: 50,
    },
  ]);
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: { list },
  } as any);
  render(<ModelUsageReview />);
  return { list, runCommand };
}
it("loads unresolved usage through paginated listing and preserves measured zero", async () => {
  const f = setup();
  await userEvent.click(
    await screen.findByRole("button", { name: "Reconcile usage" }),
  );
  expect(f.list).toHaveBeenCalledWith("provider-usage", { state: "unknown" });
  await userEvent.type(screen.getByLabelText("Measured input tokens"), "0");
  await userEvent.type(
    screen.getByLabelText("Measured total output, including thinking"),
    "0",
  );
  await userEvent.type(
    screen.getByLabelText("Provider record reference and explanation"),
    "Synthetic provider record confirms no billed usage.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record verified usage" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith(
      "usage.resolve",
      expect.objectContaining({
        id: "usage-fixture",
        expected_revision: 3,
        actual_input: 0,
        actual_output: 0,
        thinking_tokens: null,
      }),
    ),
  );
});
it("keeps usage reconciliation Owner-only", async () => {
  const f = setup("Reviewer");
  expect(
    await screen.findByRole("button", { name: "Reconcile usage" }),
  ).toBeDisabled();
  expect(f.runCommand).not.toHaveBeenCalled();
});
