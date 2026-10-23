import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../lib/appContext";
import { createSeedState } from "../test/fixtures/workspace";
import type { AppState, StateMutation } from "../types";
import Jobs from "./Jobs";

afterEach(cleanup);

function fixture() {
  const state = createSeedState();
  state.jobs = [
    {
      id: "00000000-0000-4000-8000-000000000031",
      type: "draft_section",
      target: "Synthetic section",
      status: "blocked",
      progress: 0,
      attempt: 14,
      modelRound: 2,
      message: "Review the saved result before retrying.",
      createdAt: "2026-10-21T10:00:00Z",
      updatedAt: "2026-10-21T12:15:00Z",
    },
  ];
  const update = vi.fn(async (_mutation: StateMutation) => true);
  const context = {
    state,
    update,
    notify: vi.fn(),
    mode: "CONNECTED_FREE",
    ready: true,
    saving: false,
  } as unknown as AppContextValue;
  return { state, context, update };
}

function view(context: AppContextValue) {
  return (
    <AppContext.Provider value={context}>
      <MemoryRouter initialEntries={["/jobs"]}>
        <Jobs />
      </MemoryRouter>
    </AppContext.Provider>
  );
}

it("filters OCR waits separately from retries and keeps cancellation available", async () => {
  const f = fixture();
  f.state.jobs = [
    {
      ...f.state.jobs[0],
      status: "retry_wait",
      errorCode: "NOTICE_OCR_PENDING",
      target: "Synthetic scanned notice",
    },
    {
      ...f.state.jobs[0],
      id: "other",
      status: "retry_wait",
      errorCode: "SOURCE_TIMEOUT",
      target: "Synthetic ordinary retry",
    },
  ];
  render(view(f.context));
  await userEvent
    .setup()
    .selectOptions(
      screen.getByRole("combobox", { name: "Filter jobs" }),
      "awaiting_ocr",
    );
  expect(screen.getByText("Awaiting OCR", { selector: ".badge" })).toHaveClass(
    "badge-purple",
  );
  expect(
    screen.queryByText("Synthetic ordinary retry"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Check retry" }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .selectOptions(
      screen.getByRole("combobox", { name: "Filter jobs" }),
      "retry_wait",
    );
  expect(
    screen.queryByText("Synthetic scanned notice"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Synthetic ordinary retry")).toBeInTheDocument();
});

it("labels worker executions, the current model round, and creation/update times separately", () => {
  const f = fixture();
  render(view(f.context));
  expect(
    screen.getByText("Worker attempts 14 · Current model round 2"),
  ).toBeInTheDocument();
  const created = screen.getByText("Created"),
    updated = screen.getByText("Updated");
  expect(created.querySelector("time")).toHaveAttribute(
    "datetime",
    f.state.jobs[0].createdAt,
  );
  expect(updated.querySelector("time")).toHaveAttribute(
    "datetime",
    f.state.jobs[0].updatedAt,
  );
  expect(created).toHaveTextContent("Riyadh");
  expect(updated).toHaveTextContent("Riyadh");
  expect(
    screen.getByText(/Worker attempts include background result checks/),
  ).toBeInTheDocument();
  expect(f.update).not.toHaveBeenCalled();
});

it("keeps zero worker attempts and missing optional history explicit", () => {
  const f = fixture();
  f.state.jobs[0] = {
    ...f.state.jobs[0],
    status: "queued",
    attempt: 0,
    modelRound: undefined,
    updatedAt: undefined,
  };
  render(view(f.context));
  expect(screen.getByText("Worker attempts 0")).toBeInTheDocument();
  expect(screen.queryByText(/Current model round/)).not.toBeInTheDocument();
  expect(screen.getByText("Updated Not recorded")).toBeInTheDocument();
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});

it("does not increment either counter or timestamp merely because a retry was requested", async () => {
  const f = fixture();
  let requested: AppState | undefined;
  f.update.mockImplementation(async (mutation) => {
    requested = mutation(f.state);
    return true;
  });
  const page = render(view(f.context));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check retry" }));
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(requested?.jobs[0]).toMatchObject({
    attempt: 14,
    modelRound: 2,
    createdAt: f.state.jobs[0].createdAt,
    updatedAt: f.state.jobs[0].updatedAt,
    message:
      "Retry requested. The backend checks the current processing requirements.",
  });
  page.rerender(view({ ...f.context, state: requested! }));
  expect(
    screen.getByText("Worker attempts 14 · Current model round 2"),
  ).toBeInTheDocument();
  const refreshed = {
    ...requested!,
    jobs: [
      { ...requested!.jobs[0], attempt: 15, updatedAt: "2026-10-21T12:30:00Z" },
    ],
  };
  page.rerender(view({ ...f.context, state: refreshed }));
  expect(
    screen.getByText("Worker attempts 15 · Current model round 2"),
  ).toBeInTheDocument();
  expect(screen.getByText("Updated").querySelector("time")).toHaveAttribute(
    "datetime",
    refreshed.jobs[0].updatedAt,
  );
});
