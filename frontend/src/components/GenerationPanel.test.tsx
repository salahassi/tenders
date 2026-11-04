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
    backend: {
      list: vi.fn(async () => records),
      request: vi.fn(async (_path: string) => ({ data: null as any })),
    },
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
  "lets %s start a proposal draft directly without a separate permission review",
  async (role) => {
    const c = context();
    c.state.settings.role = role;
    render(
      <MemoryRouter>
        <GenerationPanel opportunity={opportunity()} embedded />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", {
      name: "Generate proposal draft",
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
it("keeps extraction checking optional and opens the exact unchecked file", async () => {
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
    await screen.findByRole("button", { name: "Generate proposal draft" }),
  ).toBeEnabled();
  expect(
    screen.getByText(/Checking the extracted text is optional/),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Check extracted text: RFP.pdf" }),
  );
  expect(review).toHaveBeenCalledWith(o.documents[0]);
});

it.each(["ready", "needs_ocr", "needs_processing", "error"])(
  "lets saved reference text with status %s start a draft without asserting RFP completeness",
  async (status) => {
    const c = context();
    const o = opportunity();
    o.documents = [
      {
        ...o.documents[0],
        name: "Unrelated meeting notes.txt",
        status,
        text:
          status === "ready"
            ? "Synthetic meeting notes without tender requirements."
            : "",
        extractionConfirmed: false,
      },
    ];
    render(
      <MemoryRouter>
        <GenerationPanel opportunity={o} />
      </MemoryRouter>,
    );
    const generate = await screen.findByRole("button", {
      name: "Generate proposal draft",
    });
    expect(generate).toBeEnabled();
    if (status !== "ready")
      expect(
        screen.getByText(
          /Files without readable text will be listed as unread/,
        ),
      ).toBeInTheDocument();
    await userEvent.click(generate);
    expect(c.runCommand).toHaveBeenCalledWith("proposal.generate", {
      id: o.id,
      expected_revision: 4,
    });
  },
);

it("waits for an active file upload to finish before freezing a draft request", async () => {
  const c = context();
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} inputBusy />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("button", { name: "Generate proposal draft" }),
  ).toBeDisabled();
  expect(screen.getByText(/Files are still being saved/)).toBeInTheDocument();
  expect(c.runCommand).not.toHaveBeenCalled();
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
    await vi.advanceTimersByTimeAsync(5000);
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

it.each(["active", "failed", "issued"])(
  "uses complete-package issuance %s instead of treating finished writing as delivery",
  async (outcome) => {
    const c = context([
      {
        id: "plan",
        kind: "proposal",
        stage: "completed",
        status: "completed",
        revision: 4,
        error_code: null,
        created_at: "2026-11-04T10:00:00Z",
        issuance_request_id: "request",
      },
    ]);
    c.backend.request.mockResolvedValue({
      data: {
        id: "request",
        plan_id: "plan",
        effective_outcome: outcome,
        effective_error_code:
          outcome === "failed" ? "PROPOSAL_ISSUANCE_TIMEOUT" : null,
      },
    });
    render(
      <MemoryRouter>
        <GenerationPanel opportunity={opportunity()} />
      </MemoryRouter>,
    );
    const text =
      outcome === "active"
        ? /Writing is complete. The full draft file package is still/
        : outcome === "failed"
          ? /reached its 10-minute limit/
          : /complete draft file package is ready to download/;
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Your proposal is ready. Open it to review and download.",
      ),
    ).not.toBeInTheDocument();
    if (outcome === "failed")
      expect(c.notify).toHaveBeenCalledWith(
        expect.stringMatching(/10-minute limit/),
        "error",
      );
  },
);
it("rejects stale request status and never claims completed writing is an issued package", async () => {
  const c = context([
    {
      id: "plan",
      kind: "proposal",
      stage: "completed",
      status: "completed",
      revision: 4,
      error_code: null,
      created_at: "2026-11-04T10:00:00Z",
      issuance_request_id: "current",
    },
  ]);
  c.backend.request.mockResolvedValue({
    data: { id: "older", plan_id: "plan", effective_outcome: "issued" },
  });
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "current request changed",
  );
  expect(
    screen.queryByText(/file package is ready to download/),
  ).not.toBeInTheDocument();
});
it("shows all agents unavailable immediately when admission rejects", async () => {
  const c = context();
  c.runCommand.mockRejectedValue(
    new BackendRequestError("AI_AGENTS_UNAVAILABLE", "Internal reason", 503),
  );
  render(
    <MemoryRouter>
      <GenerationPanel opportunity={opportunity()} />
    </MemoryRouter>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Generate proposal draft" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No AI agents are available",
  );
  expect(c.notify).toHaveBeenCalledWith(
    expect.stringMatching(/No AI agents are available/),
    "error",
  );
});
