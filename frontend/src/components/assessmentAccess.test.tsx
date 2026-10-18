import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import { emptyConnectedState } from "../lib/connectedRepository";
import OpportunityDetail from "../pages/OpportunityDetail";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(role: "Owner" | "Reviewer", plans: unknown[] = []) {
  const state = emptyConnectedState();
  state.settings.role = role;
  state.opportunities.push({
    id: "synthetic",
    revision: 4,
    title: "Synthetic discovery",
    reference: "S1",
    buyer: "Fixture buyer",
    description: "Public notice fixture",
    status: "new",
    documents: [],
    requirements: [],
    gaps: [],
    category: "",
    tags: [],
    deadline: "",
    score: null,
    coverage: 0,
    sourceId: "",
    value: null,
    saved: false,
    createdAt: "2026-10-17",
    acquisition: "not_requested",
    language: "en",
    sourceUrl: "",
  });
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    state,
    mode: "CONNECTED_FREE",
    backend: { list: vi.fn(async () => plans) },
    runCommand,
    notify: vi.fn(),
    saving: false,
  } as any);
  render(
    <MemoryRouter initialEntries={["/opportunities/synthetic"]}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  return runCommand;
}
it("lets the Owner assess a discovery before shortlisting or uploading an RFP", async () => {
  const command = setup("Owner");
  await userEvent.click(
    await screen.findByRole("button", { name: "Assess current evidence" }),
  );
  expect(command).toHaveBeenCalledWith("opportunity.assess", {
    id: "synthetic",
    expected_revision: 4,
  });
  expect(
    screen.getByRole("button", { name: "Generate complete proposal" }),
  ).toBeDisabled();
});
it("exposes saved assessment recovery without issuing a duplicate assessment", async () => {
  const command = setup("Owner", [
    {
      id: "plan",
      kind: "assessment",
      stage: "assessment",
      status: "blocked",
      revision: 7,
      error_code: "DATA_AUTHORIZATION_REQUIRED",
      created_at: "2026-10-17",
    },
  ]);
  expect(
    await screen.findByRole("button", { name: "Assess current evidence" }),
  ).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Resume saved work" }),
  );
  expect(command).toHaveBeenCalledWith(
    "generation.retry",
    expect.objectContaining({ id: "plan", expected_revision: 7 }),
  );
});
it("keeps assessment actions disabled for a Reviewer", async () => {
  const command = setup("Reviewer");
  expect(
    await screen.findByRole("button", { name: "Assess current evidence" }),
  ).toBeDisabled();
  expect(command).not.toHaveBeenCalled();
});
it("does not offer to resume an assessment superseded by changed evidence", async () => {
  setup("Owner", [
    {
      id: "old-plan",
      kind: "assessment",
      stage: "assessment",
      status: "canceled",
      revision: 3,
      error_code: "REASSESSMENT_SUPERSEDED",
      created_at: "2026-10-17",
    },
  ]);
  expect(
    await screen.findByRole("button", { name: "Assess current evidence" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Resume saved work" }),
  ).not.toBeInTheDocument();
});
