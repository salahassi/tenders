import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import { getOpportunityStage } from "../lib/workflow";
import GenerationPanel from "./GenerationPanel";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const opportunity = () =>
  ({
    id: "opportunity",
    revision: 4,
    status: "shortlisted",
    documents: [
      {
        id: "document",
        name: "RFP.pdf",
        status: "ready",
        extractionConfirmed: true,
      },
    ],
  }) as any;
function context(records: any[] = []) {
  const value = {
    backend: { list: vi.fn(async () => records) },
    state: {
      settings: { role: "Owner" },
      proposals: [],
      knowledge: [],
      knowledgeDocuments: [],
    },
    runCommand: vi.fn(async () => ({})),
    notify: vi.fn(),
    refresh: vi.fn(async () => {}),
    saving: false,
  };
  vi.mocked(useApp).mockReturnValue(value as any);
  return value;
}
it("starts an RFP-only proposal without company knowledge or a custom template", async () => {
  const c = context();
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} embedded />
    </MemoryRouter>,
  );
  const button = await screen.findByRole("button", {
    name: "Generate complete proposal",
  });
  expect(button).toBeEnabled();
  expect(
    screen.getByText(/No custom template or company knowledge is required/),
  ).toBeInTheDocument();
  await userEvent.click(button);
  expect(c.runCommand).toHaveBeenCalledWith("proposal.generate", {
    id: "opportunity",
    expected_revision: 4,
  });
});
it("explains extraction review and opens the exact pending file instead of reporting ready", async () => {
  context();
  const o = opportunity();
  o.documents[0].extractionConfirmed = false;
  const review = vi.fn();
  expect(getOpportunityStage(o, [])).toBe("rfp_needs_review");
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={o} onReviewFile={review} />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("button", { name: "Generate complete proposal" }),
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Review RFP.pdf" }));
  expect(review).toHaveBeenCalledWith(o.documents[0]);
});
it("refreshes the workspace when generation finishes so the download becomes available without reloading", async () => {
  vi.useFakeTimers();
  const records = [
    {
      id: "plan",
      kind: "proposal",
      stage: "analysis",
      status: "running",
      created_at: "2026-01-01",
    },
  ];
  const c = context(records);
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(c.refresh).not.toHaveBeenCalled();
  records[0] = { ...records[0], stage: "completed", status: "completed" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(c.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(c.refresh).toHaveBeenCalledTimes(1);
});
