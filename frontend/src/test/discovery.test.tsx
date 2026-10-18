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
it("names the Company Knowledge file and note behind company citations", () => {
  const state = createSeedState();
  state.knowledge = [
    {
      id: "note",
      category: "company",
      title: "Synthetic experience note",
      content: "Synthetic verified note",
      evidence: "",
      verified: true,
    },
  ];
  state.knowledgeDocuments = [
    {
      id: "file",
      name: "Synthetic capability file.txt",
      size: 10,
      uploadedAt: "2026-01-01",
      text: "Synthetic verified file",
      status: "ready",
      classification: "synthetic",
      hash: "x",
      category: "company",
      enabled: true,
      verified: true,
    },
  ];
  const o: Opportunity = {
    ...state.opportunities[0],
    assessment: {
      score: 80,
      coverage: 100,
      routing: "recommended",
      summary: "Synthetic assessment",
      stale: false,
      missing: [],
      risks: [],
      companySources: [
        {
          id: "block",
          entity_kind: "document",
          entity_id: "file",
          content_hash: "x",
        },
        {
          id: "note",
          entity_kind: "knowledge",
          entity_id: "note",
          content_hash: "y",
        },
      ],
      factors: {
        capability: {
          rating: 4,
          reason: "Synthetic",
          notice_evidence: [],
          company_evidence: [
            { id: "block", quote: "Synthetic verified file" },
            { id: "note", quote: "Synthetic verified note" },
          ],
        },
      },
    },
  };
  const preview = getFitPreview(state, o);
  expect(preview.reasons[0].knowledgeTitle).toContain(
    "Synthetic capability file.txt",
  );
  expect(preview.reasons[0].knowledgeTitle).toContain(
    "Synthetic experience note",
  );
  expect(preview.reasons[0].knowledgeEvidence).toContain(
    "Synthetic verified note",
  );
});
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
      id: "closed",
      title: "Synthetic closed software",
      status: "new",
      assessment: assessed,
      discovery: { state: "assessed", inboxVisible: false, expired: true },
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
  await user.click(screen.getByRole("button", { name: /^Closed/ }));
  expect(
    screen.getByRole("link", { name: "Synthetic closed software" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Submission deadline passed")).toBeInTheDocument();
  expect(state).toEqual(before);
});

it("shows provider wait, actual attempt count and scheduled retry without inventing an assessment", () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    assessment: undefined,
    discovery: {
      state: "retry_wait",
      inboxVisible: false,
      error: "MODEL_ROUND_EXHAUSTED",
      attempts: 4,
      nextAttempt: "2026-10-18T12:30:00Z",
    },
  };
  const preview = getFitPreview(state, notice);
  expect(preview.level).toBe("Waiting for an available provider");
  expect(preview.summary).toContain("Attempts: 4");
  expect(preview.summary).toContain("15:30");
  expect(preview.summary).toContain("Riyadh");
  expect(inReviewInbox(notice)).toBe(false);
});
