import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../lib/appContext";
import PendingProposal from "../components/PendingProposal";
import { createSeedState } from "./fixtures/workspace";
vi.mock("../components/GenerationPanel", () => ({
  default: () => <div>Generation remains separate</div>,
}));
vi.mock("../components/DeliveryDraft", () => ({
  default: ({ snapshotId }: { snapshotId: string }) => (
    <p>Saved pointer: {snapshotId}</p>
  ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes accepted delivery successors without a page reload and stops polling once a full version appears", async () => {
  vi.useFakeTimers();
  const state = createSeedState();
  const opportunity = state.opportunities[0];
  const record = {
    id: "proposal",
    opportunity_id: opportunity.id,
    active_version_id: null as string | null,
    active_delivery_snapshot_id: "early-snapshot",
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { ...record } })
    .mockResolvedValueOnce({
      data: { ...record, active_delivery_snapshot_id: "accepted-successor" },
    })
    .mockResolvedValue({
      data: { ...record, active_version_id: "saved-version" },
    });
  const refresh = vi.fn(async () => {});
  const context = {
    state,
    backend: { request },
    refresh,
  } as unknown as AppContextValue;
  render(
    <AppContext.Provider value={context}>
      <MemoryRouter>
        <PendingProposal id="proposal" />
      </MemoryRouter>
    </AppContext.Provider>,
  );
  await act(async () => {});
  expect(screen.getByText("Saved pointer: early-snapshot")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    screen.getByText("Saved pointer: accepted-successor"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Saved pointer: early-snapshot"),
  ).not.toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Proposal data is not loaded")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(request).toHaveBeenCalledTimes(3);
});

it("cancels a pending proposal poll on unmount", async () => {
  vi.useFakeTimers();
  const state = createSeedState();
  const request = vi
    .fn()
    .mockResolvedValue({
      data: {
        id: "proposal",
        opportunity_id: state.opportunities[0].id,
        active_version_id: null,
      },
    });
  const context = {
    state,
    backend: { request },
    refresh: vi.fn(),
  } as unknown as AppContextValue;
  const view = render(
    <AppContext.Provider value={context}>
      <MemoryRouter>
        <PendingProposal id="proposal" />
      </MemoryRouter>
    </AppContext.Provider>,
  );
  await act(async () => {});
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(request).toHaveBeenCalledTimes(1);
});
