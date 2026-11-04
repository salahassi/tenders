import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../lib/appContext";
import { createConnectedExport } from "../lib/connectedExport";
import { exportProposal } from "../lib/export";
import { createSeedState } from "../test/fixtures/workspace";
import Proposals from "./Proposals";

vi.mock("../lib/connectedExport", async (original) => ({
  ...(await original<typeof import("../lib/connectedExport")>()),
  createConnectedExport: vi.fn(),
}));
vi.mock("../lib/export", async (original) => ({
  ...(await original<typeof import("../lib/export")>()),
  exportProposal: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function fixture() {
  const state = createSeedState();
  const first = {
    ...state.proposals[0],
    title: "First saved proposal",
    versionId: "first-version",
  };
  const second = {
    ...first,
    id: "second-proposal",
    title: "Selected saved proposal",
    versionId: "selected-version",
    status: "approved" as const,
  };
  state.proposals = [first, second];
  const context = {
    state,
    backend: { request: vi.fn(), auth: {} },
    mode: "CONNECTED_FREE",
    ready: true,
    saving: false,
    notify: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
    runCommand: vi.fn(),
  } as unknown as AppContextValue;
  render(
    <AppContext.Provider value={context}>
      <MemoryRouter>
        <Proposals />
      </MemoryRouter>
    </AppContext.Provider>,
  );
  return { context, first, second };
}

it("exports the clicked saved version as a server-authorized draft and reports success only after completion", async () => {
  let complete!: () => void;
  vi.mocked(createConnectedExport).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve([]);
      }),
  );
  const f = fixture();
  const first = screen.getByRole("button", {
    name: `Download ${f.first.title} as draft Word`,
  });
  const selected = screen.getByRole("button", {
    name: `Download ${f.second.title} as draft Word`,
  });
  await userEvent.click(selected);
  expect(createConnectedExport).toHaveBeenCalledExactlyOnceWith(
    f.context.backend,
    "selected-version",
    "draft",
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }),
  );
  expect(selected).toBeDisabled();
  expect(first).toBeDisabled();
  expect(selected).toHaveTextContent("Preparing…");
  expect(f.context.notify).not.toHaveBeenCalled();
  expect(exportProposal).not.toHaveBeenCalled();
  await act(async () => complete());
  expect(selected).toBeEnabled();
  expect(first).toBeEnabled();
  expect(f.context.notify).toHaveBeenCalledWith(
    expect.stringContaining("Draft Word downloaded"),
  );
});

it("shows a failed connected export without downloading a local substitute or claiming success", async () => {
  vi.mocked(createConnectedExport).mockRejectedValueOnce(
    new Error("The selected version changed. Refresh and try again."),
  );
  const f = fixture();
  const selected = screen.getByRole("button", {
    name: `Download ${f.second.title} as draft Word`,
  });
  await userEvent.click(selected);
  await waitFor(() => expect(selected).toBeEnabled());
  expect(f.context.notify).toHaveBeenCalledExactlyOnceWith(
    "The selected version changed. Refresh and try again.",
    "error",
  );
  expect(exportProposal).not.toHaveBeenCalled();
});

it.each(["backend", "version"])(
  "fails closed when the connected %s is unavailable",
  async (missing) => {
    const f = fixture();
    if (missing === "backend") f.context.backend = undefined;
    else f.second.versionId = "";
    // Context changes represent a disconnected or incomplete saved-state read.
    cleanup();
    render(
      <AppContext.Provider value={f.context}>
        <MemoryRouter>
          <Proposals />
        </MemoryRouter>
      </AppContext.Provider>,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: `Download ${f.second.title} as draft Word`,
      }),
    );
    expect(createConnectedExport).not.toHaveBeenCalled();
    expect(exportProposal).not.toHaveBeenCalled();
    expect(f.context.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("unavailable"),
      "error",
    );
    expect(
      screen.getByRole("button", {
        name: `Download ${f.second.title} as draft Word`,
      }),
    ).toBeEnabled();
  },
);
