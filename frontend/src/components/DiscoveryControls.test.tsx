import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect, vi } from "vitest";
import { useApp } from "../lib/store";
import DiscoveryControls from "./DiscoveryControls";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("persists continuing company evidence permission with selected destinations", async () => {
  let policy = {
    scope: "combined",
    include_keywords: ["Synthetic services"],
    exclude_keywords: [],
    auto_public_notices: true,
    auto_company_knowledge: false,
    providers: ["gemini_free", "groq_free", "zai_free"],
  };
  const runCommand = vi.fn(async (_op: string, input: any) => {
    policy = input;
    return {};
  });
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: {
      request: vi.fn(async () => ({
        data: { workspace: { revision: 7, discovery_policy: policy } },
      })),
    },
  } as any);
  const page = render(<DiscoveryControls />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Automatically assess public collector notices"),
    ).toBeChecked(),
  );
  await userEvent.click(
    screen.getByLabelText("Include Company Knowledge in model processing"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save assessment & sharing settings" }),
  );
  await waitFor(() =>
    expect(runCommand).toHaveBeenCalledWith("discovery.configure", {
      expected_revision: 7,
      scope: "combined",
      include_keywords: ["Synthetic services"],
      exclude_keywords: [],
      auto_public_notices: true,
      auto_company_knowledge: true,
      providers: ["gemini_free", "groq_free", "zai_free"],
    }),
  );
  page.unmount();
  render(<DiscoveryControls />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Include Company Knowledge in model processing"),
    ).toBeChecked(),
  );
});

function setupScope(role = "Owner") {
  let policy: any = {
    scope: "company_knowledge",
    include_keywords: [],
    exclude_keywords: [],
    auto_public_notices: true,
    auto_company_knowledge: true,
    providers: ["groq_free"],
  };
  let revision = 1;
  const notify = vi.fn();
  const runCommand = vi.fn(async (_op: string, input: any) => {
    policy = input;
    revision++;
    return {};
  });
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role } },
    saving: false,
    notify,
    runCommand,
    backend: {
      request: vi.fn(async () => ({
        data: { workspace: { revision, discovery_policy: policy } },
      })),
    },
  } as any);
  return { runCommand, notify };
}
it("saves and reloads combined scope with normalized Arabic and English terms", async () => {
  const { runCommand, notify } = setupScope();
  const page = render(<DiscoveryControls />);
  const source = screen.getByLabelText("Company service scope");
  await waitFor(() => expect(source).toBeEnabled());
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Company Knowledge",
    "Keywords",
    "Company Knowledge + keywords",
  ]);
  await userEvent.selectOptions(source, "combined");
  await userEvent.type(
    screen.getByLabelText("Interest keywords"),
    "تصميم  الحدائق، Garden design\ngarden design",
  );
  await userEvent.type(
    screen.getByLabelText("Exclusion keywords"),
    "صيانة المباني",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save assessment & sharing settings" }),
  );
  await waitFor(() =>
    expect(runCommand).toHaveBeenCalledWith("discovery.configure", {
      expected_revision: 1,
      scope: "combined",
      include_keywords: ["تصميم الحدائق", "Garden design"],
      exclude_keywords: ["صيانة المباني"],
      auto_public_notices: true,
      auto_company_knowledge: true,
      providers: ["groq_free"],
    }),
  );
  expect(notify).toHaveBeenCalledWith(
    "Service scope saved. Existing notices will be reassessed.",
  );
  page.unmount();
  render(<DiscoveryControls />);
  await waitFor(() =>
    expect(screen.getByLabelText("Company service scope")).toHaveValue(
      "combined",
    ),
  );
  expect(screen.getByLabelText("Interest keywords")).toHaveValue(
    "تصميم الحدائق\nGarden design",
  );
  expect(screen.getByLabelText("Exclusion keywords")).toHaveValue(
    "صيانة المباني",
  );
});
it("validates empty and contradictory keywords and preserves a draft when a save fails", async () => {
  const { runCommand } = setupScope();
  render(<DiscoveryControls />);
  const source = screen.getByLabelText("Company service scope");
  const save = screen.getByRole("button", {
    name: "Save assessment & sharing settings",
  });
  await waitFor(() => expect(source).toBeEnabled());
  await userEvent.selectOptions(source, "keywords");
  expect(save).toBeDisabled();
  await userEvent.type(
    screen.getByLabelText("Interest keywords"),
    "Garden design",
  );
  await userEvent.type(
    screen.getByLabelText("Exclusion keywords"),
    "garden design",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("cannot be both");
  expect(save).toBeDisabled();
  await userEvent.clear(screen.getByLabelText("Exclusion keywords"));
  runCommand.mockRejectedValueOnce(new Error("REVISION_CONFLICT"));
  await userEvent.click(save);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("REVISION_CONFLICT"),
  );
  expect(screen.getByLabelText("Interest keywords")).toHaveValue(
    "Garden design",
  );
  await userEvent.selectOptions(source, "company_knowledge");
  expect(screen.queryByLabelText("Interest keywords")).not.toBeInTheDocument();
  await userEvent.selectOptions(source, "keywords");
  expect(screen.getByLabelText("Interest keywords")).toHaveValue(
    "Garden design",
  );
});
it("allows Editors to inspect the scope without changing it", async () => {
  setupScope("Editor");
  render(<DiscoveryControls />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Automatically assess public collector notices"),
    ).toBeChecked(),
  );
  expect(screen.getByLabelText("Company service scope")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Save assessment & sharing settings" }),
  ).toBeDisabled();
});
