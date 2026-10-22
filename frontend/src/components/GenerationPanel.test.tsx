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
it("offers resume for the latest blocked plan and hides it on an older canceled plan", async () => {
  const c = context([
    {
      id: "latest",
      kind: "proposal",
      stage: "review",
      status: "blocked",
      error_code: "MODEL_CORRECTION_EXHAUSTED",
      revision: 2,
      created_at: "2026-10-22T10:00:00Z",
    },
    {
      id: "older",
      kind: "proposal",
      stage: "analysis",
      status: "canceled",
      error_code: "GENERATION_HANDLER_FAILED",
      revision: 3,
      created_at: "2026-10-21T10:00:00Z",
    },
  ]);
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} embedded />
    </MemoryRouter>,
  );
  const buttons = await screen.findAllByRole("button", {
    name: "Resume saved work",
  });
  expect(buttons).toHaveLength(1);
  await userEvent.click(buttons[0]);
  expect(c.runCommand).toHaveBeenCalledWith(
    "generation.retry",
    expect.objectContaining({ id: "latest", expected_revision: 2 }),
  );
});

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

it("does not start more progress requests while a slow completion refresh is outstanding", async () => {
  vi.useFakeTimers();
  const c = context([
    {
      id: "plan",
      kind: "proposal",
      stage: "completed",
      status: "completed",
      created_at: "2026-01-01",
    },
  ]);
  let finish!: () => void;
  c.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40000);
  });
  expect(c.refresh).toHaveBeenCalledTimes(1);
  expect(c.backend.list).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(c.backend.list).toHaveBeenCalledTimes(2);
  expect(c.refresh).toHaveBeenCalledTimes(1);
});

it("retries a failed completion refresh on the next poll without overlapping it", async () => {
  vi.useFakeTimers();
  const c = context([
    {
      id: "plan",
      kind: "proposal",
      stage: "completed",
      status: "completed",
      created_at: "2026-01-01",
    },
  ]);
  c.refresh.mockRejectedValueOnce(new Error("Temporary database failure"));
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Temporary database failure",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(c.refresh).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("ignores a previous opportunity's delayed completion after navigation", async () => {
  vi.useFakeTimers();
  const c = context();
  let finish!: (records: any[]) => void;
  c.backend.list.mockImplementationOnce(
    () =>
      new Promise<any[]>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(c.backend.list).toHaveBeenCalledTimes(1);
  view.rerender(
    <MemoryRouter>
      <GenerationPanel opportunity={{ ...opportunity(), id: "another" }} />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    finish([
      {
        id: "old-plan",
        kind: "proposal",
        stage: "completed",
        status: "completed",
        created_at: "2026-01-01",
      },
    ]);
  });
  expect(c.backend.list).toHaveBeenCalledTimes(2);
  expect(c.refresh).not.toHaveBeenCalled();
  expect(screen.queryByText("Loading progress…")).not.toBeInTheDocument();
});
