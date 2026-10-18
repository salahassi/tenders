import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { getFitPreview } from "../lib/fitPreview";
import { inReviewInbox } from "../lib/discovery";
import { createSeedState } from "./fixtures/workspace";
import { AppContext } from "../lib/appContext";
import Review from "../pages/Review";
import type { Opportunity } from "../types";
afterEach(cleanup);
it("never presents a blocked or unscheduled assessment as running", () => {
  const state = createSeedState();
  const o = state.opportunities[0];
  for (const [status, label] of [
    ["blocked", "Assessment blocked"],
    ["failed", "Assessment failed"],
    ["pending_schedule", "Awaiting scheduling"],
    ["queued", "Assessment queued"],
    ["running", "Assessing"],
    ["quota_wait", "Waiting for model quota"],
  ] as const) {
    const notice = {
      ...o,
      status: "new" as const,
      discovery: { state: status, inboxVisible: false },
    };
    expect(inReviewInbox(notice)).toBe(false);
    expect(getFitPreview(state, notice).level).toBe(label);
  }
});
it("separates eligible, excluded, active and blocked notices without changing decisions", async () => {
  const state = createSeedState();
  const base = state.opportunities[0];
  const assessed: Opportunity["assessment"] = {
    score: null,
    coverage: 0,
    routing: "needs_review",
    summary: "Synthetic reviewed notice",
    stale: false,
    factors: {},
    missing: [],
    risks: [],
  };
  state.opportunities = [
    {
      ...base,
      id: "eligible",
      title: "Synthetic software",
      status: "new",
      assessment: assessed,
      discovery: { state: "assessed", inboxVisible: true },
    },
    {
      ...base,
      id: "hardware",
      title: "Synthetic hardware",
      status: "new",
      assessment: { ...assessed, routing: "excluded" },
      discovery: { state: "assessed", inboxVisible: false },
    },
    {
      ...base,
      id: "queued",
      title: "Synthetic queued notice",
      status: "new",
      discovery: { state: "queued", inboxVisible: false },
    },
    {
      ...base,
      id: "blocked",
      title: "Synthetic blocked notice",
      status: "new",
      discovery: {
        state: "blocked",
        inboxVisible: false,
        error: "DATA_AUTHORIZATION_REQUIRED",
      },
    },
  ];
  const before = structuredClone(state);
  render(
    <MemoryRouter>
      <AppContext.Provider
        value={{ state, update: async () => true, notify: () => {} } as any}
      >
        <Review />
      </AppContext.Provider>
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("link", { name: "Synthetic software" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Synthetic hardware" }),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Outside scope/ }));
  expect(
    screen.getByRole("link", { name: "Synthetic hardware" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Assessing/ }));
  expect(screen.getByText("Assessment queued")).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Synthetic blocked notice" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Needs attention/ }));
  expect(screen.getByText("Assessment blocked")).toBeInTheDocument();
  expect(screen.queryByText("Not assessed")).not.toBeInTheDocument();
  expect(state).toEqual(before);
});
