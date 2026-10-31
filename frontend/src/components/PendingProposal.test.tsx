import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../lib/appContext";
import { BackendRequestError } from "../lib/backendClient";
import ProposalEditor from "../pages/ProposalEditor";
import { createSeedState } from "../test/fixtures/workspace";
import PendingProposal from "./PendingProposal";

vi.mock("./ApprovalPanel", () => ({ default: () => null }));
vi.mock("./ExportPanel", () => ({ default: () => null }));
vi.mock("./ReviewHistory", () => ({ default: () => null }));
vi.mock("./PricingReview", () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});
const id = "00000000-0000-4000-8000-000000000075";
function fixture() {
  const state = createSeedState();
  const saved = { ...state.proposals[0], id, versionId: "saved-version" };
  const opportunity = state.opportunities.find(
    (item) => item.id === saved.opportunityId,
  )!;
  opportunity.status = "in_progress";
  state.proposals = [];
  const record = {
    id,
    opportunity_id: opportunity.id,
    active_version_id: null as string | null,
  };
  const plans = [
    {
      id: "plan",
      kind: "proposal",
      stage: "drafting",
      status: "blocked",
      revision: 5,
      error_code: "MODEL_CORRECTION_EXHAUSTED",
      created_at: "2026-01-01",
    },
  ];
  const request = vi.fn(async () => ({ data: record, meta: {} }));
  const list = vi.fn(async () => plans);
  const context = {
    state,
    backend: { request, list },
    mode: "CONNECTED_FREE",
    ready: true,
    saving: false,
    runCommand: vi.fn(async () => ({})),
    refresh: vi.fn(async () => {}),
    notify: vi.fn(),
    update: vi.fn(),
  } as unknown as AppContextValue;
  return { context, record, request, list, saved, opportunity, plans };
}
function view(value: AppContextValue) {
  return (
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/proposals/${id}`]}>
        <Routes>
          <Route path="/proposals/:id" element={<ProposalEditor />} />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

it("loads the authorized pending record and shows real progress without a fabricated version or automatic command", async () => {
  const f = fixture();
  let resolve!: (value: { data: typeof f.record; meta: {} }) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const page = render(view(f.context));
  expect(screen.getByRole("status")).toHaveTextContent("Loading proposal");
  expect(screen.queryByText("Proposal not found")).not.toBeInTheDocument();
  await act(async () => resolve({ data: f.record, meta: {} }));
  expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
    "Proposal preparation",
  );
  expect(
    await screen.findByText("Proposal · Writing the proposal"),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "did not pass the required checks",
  );
  expect(
    screen.getByRole("button", { name: "Resume saved work" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("link", { name: "Open opportunity" }),
  ).toHaveAttribute("href", `/opportunities/${f.opportunity.id}`);
  expect(
    screen.queryByRole("button", { name: "Download complete draft Word" }),
  ).not.toBeInTheDocument();
  page.rerender(view({ ...f.context, state: { ...f.context.state } }));
  await act(async () => {});
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledWith(`/v1/proposals/${id}`, {
    signal: expect.any(AbortSignal),
  });
  expect(f.context.runCommand).not.toHaveBeenCalled();
  expect(f.context.state.proposals).toEqual([]);
});

it.each([403, 404])(
  "keeps a real HTTP %s unavailable without inferring a pending proposal",
  async (status) => {
    const f = fixture();
    f.request.mockRejectedValueOnce(
      new BackendRequestError("NOT_FOUND", "Unavailable", status),
    );
    render(view(f.context));
    expect(await screen.findByText("Proposal not found")).toBeInTheDocument();
    expect(screen.queryByText("Proposal preparation")).not.toBeInTheDocument();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.context.runCommand).not.toHaveBeenCalled();
  },
);

it("shows a request failure distinctly and retries only the authorized read", async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(
    new BackendRequestError("UNAVAILABLE", "Connection unavailable", 503),
  );
  render(view(f.context));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection unavailable",
  );
  expect(screen.queryByText("Proposal not found")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
    "Proposal preparation",
  );
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.context.runCommand).not.toHaveBeenCalled();
});

it("refreshes a newly available version and transitions to its actual saved document", async () => {
  const f = fixture();
  f.record.active_version_id = f.saved.versionId;
  function Harness() {
    const [state, setState] = useState(f.context.state);
    const refresh = async () =>
      setState((current) => ({ ...current, proposals: [f.saved] }));
    return view({ ...f.context, state, refresh });
  }
  render(<Harness />);
  expect(
    await screen.findByRole("button", { name: "Download complete draft Word" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Proposal preparation", level: 1 }),
  ).not.toBeInTheDocument();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.context.runCommand).not.toHaveBeenCalled();
});

it("uses normal generation completion refresh to leave the pending page", async () => {
  const f = fixture();
  f.plans[0].status = "completed";
  f.plans[0].stage = "completed";
  function Harness() {
    const [state, setState] = useState(f.context.state);
    const refresh = async () =>
      setState((current) => ({ ...current, proposals: [f.saved] }));
    return view({ ...f.context, state, refresh });
  }
  render(<Harness />);
  expect(
    await screen.findByRole("button", { name: "Download complete draft Word" }),
  ).toBeInTheDocument();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.context.runCommand).not.toHaveBeenCalled();
});

it("discards a stale response after the proposal identifier changes", async () => {
  const f = fixture();
  let finishFirst!: (value: { data: typeof f.record; meta: {} }) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishFirst = done;
      }),
  );
  f.request.mockRejectedValueOnce(
    new BackendRequestError("NOT_FOUND", "Unavailable", 404),
  );
  const pending = (proposalId: string) => (
    <AppContext.Provider value={f.context}>
      <MemoryRouter>
        <PendingProposal id={proposalId} />
      </MemoryRouter>
    </AppContext.Provider>
  );
  const page = render(pending(id));
  page.rerender(pending("00000000-0000-4000-8000-000000000076"));
  await waitFor(() =>
    expect(screen.getByText("Proposal not found")).toBeInTheDocument(),
  );
  await act(async () => finishFirst({ data: f.record, meta: {} }));
  expect(screen.getByText("Proposal not found")).toBeInTheDocument();
  expect(f.list).not.toHaveBeenCalled();
});

it("identifies a recovered historical draft while keeping draft download available", async () => {
  const f = fixture();
  f.context.state.proposals = [
    { ...f.saved, recoveredFromEarlierNotice: true },
  ];
  render(view(f.context));
  expect(
    await screen.findByText(
      /Recovered draft: this version retains the earlier notice/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Download complete draft Word" }),
  ).toBeEnabled();
  expect(f.context.runCommand).not.toHaveBeenCalled();
});
