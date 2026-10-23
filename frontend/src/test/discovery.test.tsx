import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { getFitPreview } from "../lib/fitPreview";
import { discoveryGroup, inReviewInbox } from "../lib/discovery";
import { createSeedState } from "./fixtures/workspace";
import { AppContext } from "../lib/appContext";
import Review from "../pages/Review";
import FitAssessment from "../components/FitAssessment";
import type { Opportunity } from "../types";
afterEach(cleanup);
it("places OCR waits in their own purple group and preserves final errors and human decisions", async () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    id: "scan",
    title: "Synthetic scanned notice",
    status: "new",
    assessment: undefined,
    discovery: {
      state: "awaiting_ocr",
      inboxVisible: false,
      error: "NOTICE_OCR_PENDING",
      attempts: 37,
      nextAttempt: "2026-10-23T10:00:00Z",
    },
  };
  state.opportunities = [notice];
  expect(discoveryGroup(notice)).toBe("ocr");
  expect(
    inReviewInbox({
      ...notice,
      discovery: { ...notice.discovery!, inboxVisible: true },
    }),
  ).toBe(false);
  expect(
    discoveryGroup({
      ...notice,
      discovery: {
        ...notice.discovery!,
        state: "blocked",
        error: "NOTICE_OCR_LOW_CONFIDENCE",
      },
    }),
  ).toBe("attention");
  expect(discoveryGroup({ ...notice, status: "declined" })).toBe("archived");
  expect(discoveryGroup({ ...notice, status: "shortlisted" })).toBe("selected");
  expect(
    discoveryGroup({
      ...notice,
      discovery: { ...notice.discovery!, expired: true },
    }),
  ).toBe("expired");
  expect(getFitPreview(state, notice).summary).not.toMatch(
    /Attempts:|Next attempt:/,
  );
  render(
    <MemoryRouter>
      <AppContext.Provider
        value={{ state, update: async () => true, notify: () => {} } as any}
      >
        <Review />
      </AppContext.Provider>
    </MemoryRouter>,
  );
  const tab = screen.getByRole("button", { name: /Awaiting OCR/ });
  expect(tab).toHaveTextContent("1");
  await userEvent.setup().click(tab);
  expect(screen.getByText("Awaiting OCR", { selector: ".badge" })).toHaveClass(
    "badge-purple",
  );
  expect(
    screen.getByRole("link", { name: notice.title }).closest("article"),
  ).toHaveClass("awaiting-ocr");
  expect(state.opportunities[0].status).toBe("new");
});
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

it("keeps scheduling waits and accepted model requests in progress without calling them failures", () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    status: "new",
    assessment: undefined,
    discovery: { state: "pending_schedule", inboxVisible: false },
  };
  expect(discoveryGroup(notice)).toBe("processing");
  expect(getFitPreview(state, notice)).toMatchObject({
    mode: "processing",
    level: "Awaiting scheduling",
  });
  notice.discovery = {
    state: "retry_wait",
    inboxVisible: false,
    error: "MODEL_IN_PROGRESS",
  };
  const preview = getFitPreview(state, notice);
  expect(discoveryGroup(notice)).toBe("processing");
  expect(preview.level).toBe("Assessing");
  expect(preview.summary).toContain("response is ready");
  expect(preview.summary).not.toContain("temporary failure");
  for (const [error, level] of [
    ["SOURCE_OCR_PENDING", "Awaiting OCR"],
    ["NOTICE_OCR_PENDING", "Awaiting OCR"],
    ["SOURCE_BROWSER_PENDING", "Reading original notice"],
    ["NOTICE_BROWSER_PENDING", "Reading original notice"],
  ]) {
    notice.discovery.error = error;
    expect(discoveryGroup(notice)).toBe(
      error.includes("OCR") ? "ocr" : "processing",
    );
    expect(getFitPreview(state, notice)).toMatchObject({
      mode: "processing",
      level,
    });
    expect(getFitPreview(state, notice).summary).toContain(
      "Assessment will continue",
    );
  }
});

it("makes completed unclear scope reviewable without admitting it as confirmed in-scope or an error", async () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    id: "unclear",
    title: "Synthetic mixed procurement",
    status: "new",
    assessment: {
      score: null,
      coverage: 30,
      routing: "needs_review",
      scope: "uncertain",
      summary: "The published notice does not identify the deliverables.",
      stale: false,
      factors: {},
      missing: ["Detailed deliverables"],
      risks: [],
    },
    discovery: { state: "assessed", inboxVisible: false },
  };
  state.opportunities = [notice];
  const before = structuredClone(state);
  expect(inReviewInbox(notice)).toBe(false);
  expect(discoveryGroup(notice)).toBe("scope");
  expect(getFitPreview(state, notice)).toMatchObject({
    mode: "recorded",
    level: "Scope needs review",
  });
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
    screen.getByRole("button", { name: /^Needs attention/ }),
  ).toHaveTextContent("0");
  expect(
    screen.getByRole("button", { name: /^Awaiting your decision/ }),
  ).toHaveTextContent("0");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /^Scope to review/ }));
  expect(screen.getByRole("link", { name: notice.title })).toBeInTheDocument();
  expect(screen.getByText("Scope needs review")).toBeInTheDocument();
  expect(
    screen.queryByText("Assessment needs attention"),
  ).not.toBeInTheDocument();
  expect(state).toEqual(before);

  notice.assessment!.stale = true;
  notice.discovery!.state = "not_started";
  expect(discoveryGroup(notice)).toBe("attention");
  expect(getFitPreview(state, notice).level).toBe("Reassessment required");
  notice.discovery!.state = "pending_schedule";
  expect(discoveryGroup(notice)).toBe("processing");
});

it("shows the saved scope explanation without inventing a missing RFP or reusing a stale cause", () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    assessment: {
      score: null,
      coverage: 0,
      routing: "needs_review",
      scope: "uncertain",
      scopeReason: "Synthetic company profile does not describe its services.",
      summary: "Synthetic assessment summary",
      stale: false,
      factors: {},
      missing: ["Company service description"],
      risks: [],
    },
    noticeEvidence: {
      status: "read",
      fetchedAt: "2026-10-23T12:00:00Z",
      attachments: [],
    },
    discovery: { state: "assessed", inboxVisible: false },
  };
  const renderAssessment = () => (
    <MemoryRouter>
      <FitAssessment state={state} opportunity={notice} compact />
    </MemoryRouter>
  );
  const page = render(renderAssessment());
  expect(screen.getByText(notice.assessment!.scopeReason!)).toBeInTheDocument();
  expect(
    screen.getByText("Original notice details retrieved."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      "Service scope needs confirmation from the full notice or RFP.",
    ),
  ).not.toBeInTheDocument();

  notice.assessment!.scopeReason = undefined;
  page.rerender(renderAssessment());
  const fallback =
    "Review the recorded evidence and open questions to resolve service scope.";
  expect(screen.getByText(fallback)).toBeInTheDocument();

  notice.assessment!.stale = true;
  notice.discovery!.state = "pending_schedule";
  page.rerender(renderAssessment());
  expect(screen.queryByText(fallback)).not.toBeInTheDocument();
  expect(screen.getByText("Awaiting scheduling")).toBeInTheDocument();
});

it.each([
  ["SOURCE_NOTICE_REDIRECTED", "without readable tender details"],
  ["MANUAL_SOURCE_REQUIRED", "access or verification"],
  ["DATA_POLICY_BLOCKED", "data policy prevented"],
  ["DATA_AUTHORIZATION_REQUIRED", "Processing permission is missing"],
  ["MODEL_CORRECTION_EXHAUSTED", "did not pass validation"],
  ["NOTICE_OCR_LOW_CONFIDENCE", "could not be read reliably"],
  ["NOTICE_OCR_FAILED", "Text extraction"],
])(
  "explains the actual %s blocker without claiming an assessment completed",
  (error, explanation) => {
    const state = createSeedState();
    const notice: Opportunity = {
      ...state.opportunities[0],
      status: "new",
      assessment: undefined,
      discovery: { state: "blocked", inboxVisible: false, error },
    };
    expect(discoveryGroup(notice)).toBe("attention");
    expect(getFitPreview(state, notice).summary).toContain(explanation);
    expect(getFitPreview(state, notice).mode).toBe("unassessed");
  },
);

it("keeps closed, archived and selected unclear notices out of the scope review queue", () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    status: "new",
    assessment: {
      score: null,
      coverage: 0,
      routing: "needs_review",
      scope: "uncertain",
      summary: "Unknown scope",
      stale: false,
      factors: {},
      missing: [],
      risks: [],
    },
    discovery: { state: "assessed", inboxVisible: false, expired: true },
  };
  expect(discoveryGroup(notice)).toBe("expired");
  notice.status = "declined";
  expect(discoveryGroup(notice)).toBe("archived");
  notice.status = "shortlisted";
  expect(discoveryGroup(notice)).toBe("selected");
});

it("identifies successfully read scan text while retaining partial and unread coverage", () => {
  const state = createSeedState();
  const notice: Opportunity = {
    ...state.opportunities[0],
    noticeEvidence: {
      status: "partial",
      fetchedAt: "2026-10-22T12:00:00Z",
      attachments: [
        {
          url: "https://example.test/native.pdf",
          status: "read",
          includedPages: 2,
          totalPages: 2,
        },
        {
          url: "https://example.test/scan.pdf",
          status: "partial",
          includedPages: 1,
          totalPages: 3,
          extraction: "ocr",
          ocrReadPages: [1],
        },
        {
          url: "https://example.test/unread.pdf",
          status: "needs_ocr",
          includedPages: 0,
          totalPages: 1,
          extraction: "ocr",
          ocrReadPages: [],
        },
      ],
    },
  };
  render(
    <MemoryRouter>
      <FitAssessment state={state} opportunity={notice} compact />
    </MemoryRouter>,
  );
  expect(screen.getAllByText(/Text read from scan/)).toHaveLength(1);
  expect(
    screen.getByText(/1 of 3 pages available to assessment; partial evidence/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Requires OCR/)).toBeInTheDocument();
});
