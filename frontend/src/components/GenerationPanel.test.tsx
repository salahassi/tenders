import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import { getOpportunityStage } from "../lib/workflow";
import GenerationPanel from "./GenerationPanel";
import { BackendRequestError } from "../lib/backendClient";
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

it.each(["Owner", "Editor"])(
  "lets %s start an RFP-only proposal directly without a separate permission review",
  async (role) => {
    const c = context();
    c.state.settings.role = role;
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
  },
);
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

it("allows a final-stage stale proposal to request checked recovery and explains rejection", async () => {
  const c = context([
    {
      id: "plan",
      kind: "proposal",
      stage: "review",
      status: "blocked",
      error_code: "STALE_INPUT",
      revision: 4,
      created_at: "2026-10-23",
    },
  ]);
  c.runCommand.mockRejectedValueOnce(
    new BackendRequestError("STALE_INPUT", "stale input", 409),
  );
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Resume saved work" }),
  );
  expect(c.runCommand).toHaveBeenCalledWith(
    "generation.retry",
    expect.objectContaining({ id: "plan", expected_revision: 4 }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your completed work is retained",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "notice is the only changed input",
  );
});

it("does not offer stale recovery while model writing is unfinished", async () => {
  context([
    {
      id: "plan",
      kind: "proposal",
      stage: "drafting",
      status: "blocked",
      error_code: "STALE_INPUT",
      revision: 4,
      created_at: "2026-10-23",
    },
  ]);
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await screen.findByText("Proposal · Writing the proposal");
  expect(
    screen.queryByRole("button", { name: "Resume saved work" }),
  ).not.toBeInTheDocument();
});

it("explains a saved file-permission stop and offers recovery on the opportunity", async () => {
  const c = context([
    {
      id: "plan",
      kind: "proposal",
      stage: "analysis",
      status: "blocked",
      error_code: "DATA_AUTHORIZATION_REQUIRED",
      revision: 4,
      created_at: "2026-10-31",
    },
  ]);
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Select Resume saved work here",
  );
  expect(
    screen.getByText("Proposal · Reading tender requirements"),
  ).toBeVisible();
  expect(
    screen.queryByText(/review individual|authorize this text/i),
  ).not.toBeInTheDocument();
  expect(screen.getByText("DATA_AUTHORIZATION_REQUIRED")).not.toBeVisible();
  await userEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText("DATA_AUTHORIZATION_REQUIRED")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Resume saved work" }),
  );
  expect(c.runCommand).toHaveBeenCalledWith(
    "generation.retry",
    expect.objectContaining({ id: "plan", expected_revision: 4 }),
  );
  expect(c.notify).toHaveBeenCalledWith(
    expect.stringContaining("continue with your configured models"),
    "error",
  );
  expect(c.notify).not.toHaveBeenCalledWith(
    expect.stringContaining("work continues automatically"),
  );
});

it("announces a newly stopped request once while polling and announces a later recurrence", async () => {
  vi.useFakeTimers();
  const records = [
    {
      id: "plan",
      kind: "proposal",
      stage: "analysis",
      status: "running",
      error_code: null as string | null,
      revision: 1,
      created_at: "2026-10-31",
    },
  ];
  const c = context(records);
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(c.notify).not.toHaveBeenCalled();
  records[0] = {
    ...records[0],
    status: "blocked",
    error_code: "GENERATION_HANDLER_FAILED",
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "A processing error stopped this request",
  );
  expect(c.notify).toHaveBeenCalledTimes(1);
  expect(c.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("A processing error stopped this request"),
    "error",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(c.notify).toHaveBeenCalledTimes(1);
  records[0] = { ...records[0], status: "running", error_code: null };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  records[0] = {
    ...records[0],
    status: "blocked",
    error_code: "GENERATION_HANDLER_FAILED",
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(c.notify).toHaveBeenCalledTimes(2);
});

it.each([
  ["canceled", "This request was canceled. Saved results are retained."],
  ["completed", "Your proposal is ready. Open it to review and download."],
])(
  "shows the actual %s state instead of a retained earlier permission error",
  async (status, message) => {
    const c = context([
      {
        id: "plan",
        kind: "proposal",
        stage: status === "completed" ? "completed" : "analysis",
        status,
        error_code: "DATA_AUTHORIZATION_REQUIRED",
        revision: 5,
        created_at: "2026-10-31",
      },
    ]);
    render(
      <MemoryRouter>
        <GenerationPanel opportunity={opportunity()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.queryByText(/Select Resume saved work here/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(c.notify).not.toHaveBeenCalled();
  },
);
