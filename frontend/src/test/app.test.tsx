import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { get, set } from "idb-keyval";
import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import App from "../App";
import { FixtureProvider as AppProvider, STORAGE_KEY } from "./FixtureProvider";
import { createSeedState } from "./fixtures/workspace";
import { clearLocalFiles, getLocalFile } from "../lib/knowledgeFiles";
import { getReviewSourceSignature } from "../lib/proposalReview";
import type { AppState } from "../types";

// These exercise the real browser-local provider and pages. A network call is
// treated as a failure, never replaced with a simulated successful backend.
const network = vi.fn(() =>
  Promise.reject(new Error("Demo attempted a network request.")),
);

function mount(route = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppProvider>
        <App />
      </AppProvider>
    </MemoryRouter>,
  );
}

async function stored() {
  return await get<AppState>(STORAGE_KEY);
}

// jsdom's File does not implement the Blob reading methods available in modern
// browsers. Keep the real parsing/extraction path and supply only those methods.
function textFile(name: string, content: string, type = "text/plain") {
  const file = new File([content], name, { type });
  Object.defineProperties(file, {
    text: { value: async () => content },
    arrayBuffer: {
      value: async () => new TextEncoder().encode(content).buffer,
    },
  });
  return file;
}

// Open enclosing disclosure panels in the same order a keyboard/mouse user
// would. Labels remain the selectors even if a section starts collapsed.
async function reveal(
  input: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
) {
  const details: HTMLDetailsElement[] = [];
  let parent = input.parentElement;
  while (parent) {
    if (parent.tagName === "DETAILS")
      details.unshift(parent as HTMLDetailsElement);
    parent = parent.parentElement;
  }
  for (const panel of details) {
    if (!panel.open) {
      const summary = Array.from(panel.children).find(
        (child) => child.tagName === "SUMMARY",
      );
      if (summary) await user.click(summary);
    }
  }
  return input;
}

function navigation() {
  return within(screen.getByRole("navigation", { name: "Main navigation" }));
}

beforeEach(async () => {
  sessionStorage.clear();
  await clearLocalFiles();
  network.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("crypto", webcrypto);
  const fixture = createSeedState();
  fixture.opportunities.forEach((o) => {
    o.assessment = {
      score: null,
      coverage: 0,
      routing: "needs_review",
      summary: "Synthetic assessed notice requiring review",
      stale: false,
      factors: {},
      missing: [],
      risks: [],
    };
  });
  await set(STORAGE_KEY, fixture);
});

afterEach(async () => {
  cleanup();
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("UI journeys with a test-only workspace", () => {
  it("navigates through workspace pages without offering demo entry points", async () => {
    const user = userEvent.setup();
    mount();
    expect(
      await screen.findByRole(
        "heading",
        { name: "From opportunity to proposal." },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("You’re exploring the demo."),
    ).not.toBeInTheDocument();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).getByRole("link", { name: "Opportunities" }),
    );
    expect(
      await screen.findByRole(
        "heading",
        { name: "Opportunities" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("You’re exploring the demo."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /Setup details/ }));
    expect(
      await screen.findByRole("heading", { name: "Current service status" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/File workflows, automated collection, AI analysis/),
    ).toBeInTheDocument();
  }, 15000);

  it("shows only accepted opportunities and keeps unranked items searchable", async () => {
    const seed = createSeedState();
    const accepted = seed.opportunities.find((item) => item.id === "opp-2")!;
    accepted.score = null;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount("/opportunities");
    const search = await screen.findByRole("textbox", {
      name: "Search opportunities",
    });
    await user.type(search, accepted.reference);
    expect(
      screen.getByRole("link", { name: accepted.title }),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      2,
    );
    expect(
      screen.queryByText(/Fit score|Evidence coverage/),
    ).not.toBeInTheDocument();
    await user.clear(search);
    for (const status of ["new", "deferred", "declined"]) {
      const excluded = seed.opportunities.find(
        (item) => item.status === status,
      )!;
      expect(
        screen.queryByRole("link", { name: excluded.title }),
      ).not.toBeInTheDocument();
    }
  });

  it("reviews discovered items once and moves accepted items into Opportunities", async () => {
    const seed = createSeedState();
    const candidate = seed.opportunities.find((item) => item.id === "opp-4")!;
    const deferred = seed.opportunities.find((item) => item.id === "opp-7")!;
    const user = userEvent.setup();
    mount("/review");
    await screen.findByRole("heading", { level: 1, name: "Review inbox" });
    expect(
      screen.getByRole("link", { name: deferred.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: seed.opportunities[0].title }),
    ).not.toBeInTheDocument();
    const card = screen
      .getByRole("link", { name: candidate.title })
      .closest("article")!;
    await user.click(
      within(card).getByRole("button", { name: "Add to opportunities" }),
    );
    expect(
      screen.queryByRole("link", { name: candidate.title }),
    ).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(
        (await stored())?.opportunities.find((item) => item.id === candidate.id)
          ?.status,
      ).toBe("shortlisted");
    });
    await user.click(navigation().getByRole("link", { name: "Opportunities" }));
    expect(
      await screen.findByRole("link", { name: candidate.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: deferred.title }),
    ).not.toBeInTheDocument();
  });

  it("archives discoveries reversibly without adding them to Opportunities", async () => {
    const seed = createSeedState();
    const candidate = seed.opportunities.find((item) => item.id === "opp-4")!;
    const user = userEvent.setup();
    mount("/review");
    const link = await screen.findByRole("link", { name: candidate.title });
    await user.click(
      within(link.closest("article")!).getByRole("button", { name: "Archive" }),
    );
    expect(
      screen.queryByRole("link", { name: candidate.title }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Archived/ }));
    const archived = screen.getByRole("link", { name: candidate.title });
    await user.click(
      within(archived.closest("article")!).getByRole("button", {
        name: "Return to inbox",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: /^Awaiting your decision/ }),
    );
    expect(
      screen.getByRole("link", { name: candidate.title }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(
        (await stored())?.opportunities.find((item) => item.id === candidate.id)
          ?.status,
      ).toBe("new"),
    );
  });

  it("records external submission while keeping the same linked proposal available", async () => {
    const seed = createSeedState();
    const opportunity = seed.opportunities.find((item) => item.id === "opp-1")!;
    const proposal = seed.proposals.find(
      (item) => item.opportunityId === opportunity.id,
    )!;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount(`/opportunities/${opportunity.id}`);
    await user.click(
      await screen.findByRole("button", {
        name: "Mark as submitted externally",
      }),
    );
    await waitFor(async () => {
      const state = await stored();
      expect(
        state?.opportunities.find((item) => item.id === opportunity.id)?.status,
      ).toBe("submitted");
      expect(state?.proposals).toEqual(seed.proposals);
    });
    expect(
      screen.queryByRole("combobox", { name: /^Opportunity status/ }),
    ).not.toBeInTheDocument();
    await user.click(navigation().getByRole("link", { name: "Opportunities" }));
    expect(
      await screen.findByRole("link", { name: opportunity.title }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Has proposal/ }));
    expect(
      screen.getByRole("link", { name: opportunity.title }),
    ).toBeInTheDocument();
    await user.click(navigation().getByRole("link", { name: "Proposals" }));
    await screen.findByRole("heading", { level: 1, name: "Proposal files" });
    expect(
      await screen.findByRole("link", { name: `Open ${proposal.title}` }),
    ).toHaveAttribute("href", `/proposals/${proposal.id}`);
    await user.click(
      screen.getByRole("link", {
        name: `View opportunity: ${opportunity.title}`,
      }),
    );
    await user.click(
      await screen.findByRole("link", { name: new RegExp(proposal.title) }),
    );
    expect(
      await screen.findByRole("region", { name: "Current proposal file" }),
    ).toBeInTheDocument();
    expect((await stored())?.proposals).toEqual(seed.proposals);
  });

  it("opens every remaining workspace destination through visible navigation", async () => {
    const user = userEvent.setup();
    mount("/dashboard");
    await screen.findByRole(
      "heading",
      { name: "From opportunity to proposal." },
      { timeout: 5000 },
    );
    const destinations = [
      ["Review inbox", "Review inbox"],
      ["Proposals", "Proposal files"],
      ["Company knowledge", "Company knowledge"],
    ];
    for (const [link, heading] of destinations) {
      await user.click(
        within(
          screen.getByRole("navigation", { name: "Main navigation" }),
        ).getByRole("link", { name: new RegExp(`^${link}`) }),
      );
      expect(
        await screen.findByRole("heading", { level: 1, name: heading }),
      ).toBeInTheDocument();
    }
    await user.click(screen.getByRole("link", { name: "Activity & jobs" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Activity & jobs" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /^Notifications, / }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Notifications" }),
    ).toBeInTheDocument();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).getByRole("link", { name: "Sources" }),
    );
    await user.click(
      await screen.findByRole("link", {
        name: "Public-sector opportunity fixtures",
      }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Public-sector opportunity fixtures",
      }),
    ).toBeInTheDocument();
  });

  it("adds a title-only opportunity and restores its Arabic text with no invented deadline", async () => {
    const user = userEvent.setup();
    const first = mount("/opportunities");
    await user.click(
      await screen.findByRole("button", { name: "Add opportunity" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add an opportunity" });
    const title = "منصة خدمات رقمية — synthetic QA opportunity";
    const titleInput = within(dialog).getByRole("textbox", {
      name: "Opportunity title",
    });
    expect(titleInput).toBeRequired();
    expect(titleInput).toBeInvalid();
    await user.click(titleInput);
    await user.paste(title);
    await user.click(
      within(dialog).getByRole("button", { name: "Add opportunity" }),
    );
    expect(
      await screen.findByRole("link", { name: title }),
    ).toBeInTheDocument();
    await waitFor(async () => {
      const created = (await stored())?.opportunities.find(
        (item) => item.title === title,
      );
      expect(created).toMatchObject({
        title,
        score: null,
        deadline: "",
        status: "shortlisted",
        requirements: [],
        gaps: [],
      });
    });
    first.unmount();
    mount("/opportunities");
    const search = await screen.findByRole("textbox", {
      name: "Search opportunities",
    });
    await user.click(search);
    await user.paste(title);
    expect(screen.getByRole("link", { name: title })).toBeInTheDocument();
  });

  it("imports source discoveries into the review inbox before the active opportunity list", async () => {
    const user = userEvent.setup();
    mount("/opportunities");
    await user.click(await screen.findByRole("button", { name: "Import CSV" }));
    const dialog = screen.getByRole("dialog", { name: "Import opportunities" });
    const title = "Synthetic QA CSV opportunity";
    await user.upload(
      within(dialog).getByLabelText("CSV file (up to 1 MiB)"),
      textFile(
        "opportunities.csv",
        `title,external_id,description\n${title},QA-CSV-001,Synthetic public fixture for test review`,
        "text/csv",
      ),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: "Import valid rows" }),
    );
    await waitFor(async () => {
      expect(
        (await stored())?.opportunities.find(
          (item) => item.reference === "QA-CSV-001",
        ),
      ).toMatchObject({ title, status: "new", deadline: "" });
    });
    expect(screen.queryByRole("link", { name: title })).not.toBeInTheDocument();
    await user.click(navigation().getByRole("link", { name: /^Review inbox/ }));
    expect(screen.queryByRole("link", { name: title })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Needs attention/ }));
    expect(
      await screen.findByRole("link", { name: title }),
    ).toBeInTheDocument();
  });

  it("disables editing and source activation for a Reviewer fixture", async () => {
    const user = userEvent.setup();
    const reviewer = createSeedState();
    reviewer.settings.role = "Reviewer";
    await set(STORAGE_KEY, reviewer);
    const first = mount("/settings");
    await screen.findByRole("heading", { name: "Workspace settings" });
    expect(
      screen.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Reviewer" }),
    ).not.toBeInTheDocument();
    await waitFor(async () =>
      expect((await stored())?.settings.role).toBe("Reviewer"),
    );
    first.unmount();
    mount("/opportunities");
    expect(
      await screen.findByRole("button", { name: "Add opportunity" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import CSV" })).toBeDisabled();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).getByRole("link", { name: "Sources" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sources" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable" }),
    ).not.toBeInTheDocument();
  });

  it("enables a source configuration without claiming a collection run or contacting the source", async () => {
    const seed = createSeedState();
    seed.sources.find((source) => source.id === "src-3")!.url =
      "https://example.org/unconnected-procurement-feed";
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount("/sources");
    const candidateLink = await screen.findByRole("link", {
      name: "Procurement directory candidate",
    });
    const row = candidateLink.closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Enable" }));
    expect(
      within(row).getByText("Enabled", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Source enabled. Check Jobs for collection results or access blockers.",
    );
    await waitFor(async () => {
      const state = await stored();
      expect(
        state?.sources.find((source) => source.id === "src-3"),
      ).toMatchObject({ status: "approved", lastRun: null, nextRun: null });
      expect(state?.jobs).toEqual(seed.jobs);
    });
  });

  it("loads a legacy workspace and persists uploaded company references across remounts", async () => {
    const legacy = createSeedState() as Partial<AppState>;
    delete legacy.knowledgeDocuments;
    await set(STORAGE_KEY, legacy);
    const user = userEvent.setup();
    const first = mount("/knowledge");
    await screen.findByRole("heading", { level: 1, name: "Company knowledge" });
    expect(
      screen.getByText("Start with your company files"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Saved data could not be loaded/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Upload files" }));
    const dialog = screen.getByRole("dialog", { name: "Upload company files" });
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "File category" }),
      "team",
    );
    await user.upload(
      within(dialog).getByLabelText("Company reference files"),
      textFile(
        "synthetic-team.txt",
        "Synthetic team fixture: a technical architect, integration engineer, and implementation lead are included for demonstration only.",
      ),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 file" }),
    );
    await screen.findByRole("heading", { name: "synthetic-team.txt" });
    await waitFor(async () => {
      const document = (await stored())?.knowledgeDocuments[0];
      expect(document).toMatchObject({
        name: "synthetic-team.txt",
        category: "team",
        enabled: true,
        status: "ready",
      });
      expect(document?.text).toContain("Synthetic team fixture");
    });
    await user.click(
      screen.getByRole("checkbox", { name: "Include as reference" }),
    );
    await waitFor(async () =>
      expect((await stored())?.knowledgeDocuments[0].enabled).toBe(false),
    );
    first.unmount();
    mount("/knowledge");
    await screen.findByRole("heading", { name: "synthetic-team.txt" });
    expect(
      screen.getByRole("checkbox", { name: "Excluded from proposals" }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "View text" }));
    expect(
      within(
        screen.getByRole("dialog", { name: "synthetic-team.txt" }),
      ).getByText(/Synthetic team fixture/),
    ).toBeInTheDocument();
  });

  it("requires an RFP and never substitutes a manual or sample proposal for disconnected generation", async () => {
    const seed = createSeedState();
    const opportunity = seed.opportunities.find((item) => item.id === "opp-2")!;
    opportunity.deadline = "";
    opportunity.documents = [];
    opportunity.requirements = [];
    opportunity.gaps = [];
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount("/opportunities/opp-2");
    const input = await screen.findByLabelText(/^Upload RFP files/);
    expect(
      screen.getByRole("button", { name: "Generate proposal" }),
    ).toBeDisabled();
    expect(
      screen.queryByText("Write the proposal manually"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "File content" }),
    ).not.toBeInTheDocument();
    expect((await stored())?.proposals).toHaveLength(seed.proposals.length);
    expect(
      screen.queryByRole("button", { name: "Acquisition" }),
    ).not.toBeInTheDocument();
    await user.upload(
      input,
      textFile(
        "synthetic-rfp.txt",
        "Synthetic RFP: provide an accessible bilingual portal with secure administrator access and a documented handover.",
      ),
    );
    await waitFor(async () => {
      const current = (await stored())?.opportunities.find(
        (item) => item.id === "opp-2",
      );
      expect(current?.documents[0]).toMatchObject({
        name: "synthetic-rfp.txt",
        status: "ready",
        classification: "unspecified",
      });
    });
    await user.click(screen.getByRole("button", { name: "Generate proposal" }));
    const aiDialog = screen.getByRole("dialog", {
      name: "Proposal generation is not connected",
    });
    expect(
      within(aiDialog).getByText(/No proposal has been created by this action/),
    ).toBeInTheDocument();
    expect((await stored())?.proposals).toHaveLength(seed.proposals.length);
    await user.click(
      within(aiDialog).getByRole("button", { name: "Close dialog" }),
    );
    expect(
      screen.queryByRole("link", { name: "View a review example" }),
    ).not.toBeInTheDocument();
    const current = await stored();
    expect(current?.proposals).toEqual(seed.proposals);
    expect(
      current?.proposals.some((proposal) => proposal.opportunityId === "opp-2"),
    ).toBe(false);
    expect(
      current?.opportunities.find((item) => item.id === "opp-2")?.status,
    ).toBe("shortlisted");
  });

  it("does not create a draft while any supplied RFP needs readable text", async () => {
    const seed = createSeedState();
    const opportunity = seed.opportunities.find((item) => item.id === "opp-2")!;
    opportunity.documents = [
      {
        id: "ready-file",
        name: "readable.txt",
        size: 50,
        uploadedAt: new Date().toISOString(),
        text: "A readable synthetic RFP body with enough detail.",
        status: "ready",
        classification: "synthetic",
        hash: "ready-hash",
      },
      {
        id: "scan-file",
        name: "scanned.pdf",
        size: 50,
        uploadedAt: new Date().toISOString(),
        text: "",
        status: "needs_ocr",
        classification: "synthetic",
        hash: "scan-hash",
      },
    ];
    await set(STORAGE_KEY, seed);
    mount("/opportunities/opp-2");
    expect(
      await screen.findByRole("button", { name: "Generate proposal" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Start writing from this RFP" }),
    ).not.toBeInTheDocument();
    expect((await stored())?.proposals).toHaveLength(seed.proposals.length);
    expect(
      screen.queryByRole("textbox", { name: "Section content" }),
    ).not.toBeInTheDocument();
  });

  it("persists Arabic review answers without changing the current proposal content or approval", async () => {
    const seed = createSeedState();
    const proposal = seed.proposals.find((item) => item.id === "prop-2")!;
    const opportunity = seed.opportunities.find(
      (item) => item.id === proposal.opportunityId,
    )!;
    const question = opportunity.gaps[0];
    proposal.status = "approved";
    proposal.approvalVersion = proposal.version;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    const first = mount(`/proposals/${proposal.id}`);
    const questionHeading = await screen.findByRole("heading", {
      name: question.question,
    });
    const answer = within(questionHeading.closest("article")!).getByRole(
      "textbox",
      { name: /^Your answer/ },
    );
    const arabicAnswer =
      "ستتوفر واجهات الربط الثلاث وبيئة الاختبار قبل بدء التنفيذ.";
    await user.click(answer);
    await user.paste(arabicAnswer);
    await user.click(
      screen.getByRole("button", { name: "Save review inputs" }),
    );
    expect(
      screen.getByText("Review inputs have not been applied to the file."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download complete draft Word" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("textbox", { name: "Section content" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add section" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /pricing/i }),
    ).not.toBeInTheDocument();
    await waitFor(async () => {
      const updated = (await stored())?.proposals.find(
        (item) => item.id === proposal.id,
      );
      const { review, ...currentFile } = updated!;
      expect(currentFile).toEqual(proposal);
      expect(review?.answers).toContainEqual(
        expect.objectContaining({
          questionId: `gap:${question.id}`,
          answer: arabicAnswer,
        }),
      );
      expect(review?.regeneration).toBeUndefined();
    });
    first.unmount();
    mount(`/proposals/${proposal.id}`);
    const restoredQuestion = await screen.findByRole("heading", {
      name: question.question,
    });
    expect(
      within(restoredQuestion.closest("article")!).getByRole("textbox", {
        name: /^Your answer/,
      }),
    ).toHaveValue(arabicAnswer);
  });

  it("saves a regeneration request as pending without applying inputs or creating a new version", async () => {
    const seed = createSeedState();
    const proposal = seed.proposals.find((item) => item.id === "prop-2")!;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount(`/proposals/${proposal.id}`);
    const request = await reveal(
      await screen.findByLabelText("Additional comments", {
        exact: true,
        selector: "textarea",
      }),
      user,
    );
    const instruction =
      "عدّل خطة التنفيذ إلى 12 أسبوعًا واشرح أثر ذلك على التكلفة.";
    await user.click(request);
    await user.paste(instruction);
    const attachment = new NodeFile(
      [
        "Synthetic delivery schedule: the complete planned delivery duration is twelve weeks, including acceptance.",
      ],
      "delivery-schedule.txt",
      { type: "text/plain" },
    ) as unknown as File;
    await user.upload(
      screen.getByLabelText("Attach files to Additional comments", {
        exact: true,
      }),
      attachment,
    );
    await screen.findByText(attachment.name, { exact: true });
    await user.click(
      screen.getByRole("button", { name: "Regenerate proposal" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Regeneration is awaiting the AI connection",
    });
    expect(
      within(dialog).getByText(
        /No AI request has been sent and no new file or version has been created/,
      ),
    ).toBeInTheDocument();
    await waitFor(async () => {
      const state = await stored();
      const updated = state?.proposals.find((item) => item.id === proposal.id);
      const { review, ...currentFile } = updated!;
      expect(currentFile).toEqual(proposal);
      expect(state?.proposals).toHaveLength(seed.proposals.length);
      expect(review).toMatchObject({
        baseVersion: proposal.version,
        instructions: instruction,
        attachments: [expect.objectContaining({ name: attachment.name })],
        regeneration: {
          status: "awaiting_connection",
          baseVersion: proposal.version,
          instructions: instruction,
          attachments: [expect.objectContaining({ name: attachment.name })],
        },
      });
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Back to review" }),
    );
    expect(
      screen.getByText("Review inputs have not been applied to the file."),
    ).toBeInTheDocument();
  });

  it("saves independent section comments and text or file answers together, then snapshots them in one regeneration", async () => {
    const seed = createSeedState();
    const proposal = seed.proposals.find((item) => item.id === "prop-2")!;
    const opportunity = seed.opportunities.find(
      (item) => item.id === proposal.opportunityId,
    )!;
    proposal.status = "approved";
    proposal.approvalVersion = proposal.version;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    const first = mount(`/proposals/${proposal.id}`);
    await screen.findByRole("region", { name: "Current proposal file" });

    const scope = proposal.sections.find((section) => section.id === "scope")!;
    const terms = proposal.sections.find(
      (section) => section.id === "commercial-assumptions",
    )!;
    const scopeLabel = `Comments on ${scope.title}`;
    const termsLabel = `Comments on ${terms.title}`;
    const scopeComment =
      "عدّل نطاق العمل ليشمل واجهة التكامل الموجودة في المرفق.";
    const termsComment =
      "اجعل صلاحية العرض ستين يومًا، مع إبقاء الدفعات كما هي.";
    const scopeInput = await reveal(
      screen.getByLabelText(scopeLabel, { exact: true, selector: "textarea" }),
      user,
    );
    await user.click(scopeInput);
    await user.paste(scopeComment);
    const scopeFile = new NodeFile(
      [
        "Synthetic attachment: add one approved integration interface to the documented delivery scope.",
      ],
      "scope-change.txt",
      { type: "text/plain" },
    ) as unknown as File;
    await user.upload(
      screen.getByLabelText(`Attach files to ${scopeLabel}`, { exact: true }),
      scopeFile,
    );
    await screen.findByText(scopeFile.name, { exact: true });
    const termsInput = await reveal(
      screen.getByLabelText(termsLabel, { exact: true, selector: "textarea" }),
      user,
    );
    await user.click(termsInput);
    await user.paste(termsComment);

    const questionOne = within(
      screen
        .getByRole("heading", { name: opportunity.gaps[0].question })
        .closest("article")!,
    );
    const questionTwo = within(
      screen
        .getByRole("heading", { name: opportunity.gaps[1].question })
        .closest("article")!,
    );
    const questionFile = new NodeFile(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
      "integration-answer.png",
      { type: "image/png" },
    ) as unknown as File;
    await user.upload(
      questionOne.getByLabelText("Attach files to Your answer", {
        exact: true,
      }),
      questionFile,
    );
    await questionOne.findByText(questionFile.name, { exact: true });
    expect(
      questionOne.getByRole("textbox", { name: "Your answer" }),
    ).toHaveValue("");

    const answer = "اعتمد جدول الدفعات المرفق مع صلاحية ستين يومًا.";
    await user.click(questionTwo.getByRole("textbox", { name: "Your answer" }));
    await user.paste(answer);
    const termsFile = new NodeFile(
      [
        "Synthetic commercial fixture: 30 percent kickoff, 40 percent accepted delivery, 30 percent handover.",
      ],
      "payment-milestones.txt",
      { type: "text/plain" },
    ) as unknown as File;
    await user.upload(
      questionTwo.getByLabelText("Attach files to Your answer", {
        exact: true,
      }),
      termsFile,
    );
    await questionTwo.findByText(termsFile.name, { exact: true });

    await user.click(
      screen.getByRole("button", { name: "Save review inputs" }),
    );
    await waitFor(async () => {
      const updated = (await stored())!.proposals.find(
        (item) => item.id === proposal.id,
      )!;
      const { review, ...currentFile } = updated;
      expect(currentFile).toEqual(proposal);
      expect(review?.sectionChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sectionId: scope.id,
            sectionTitle: scope.title,
            comment: scopeComment,
            attachments: [
              expect.objectContaining({
                name: scopeFile.name,
                status: "ready",
              }),
            ],
          }),
          expect.objectContaining({
            sectionId: terms.id,
            sectionTitle: terms.title,
            comment: termsComment,
          }),
        ]),
      );
      expect(review?.answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            questionId: `gap:${opportunity.gaps[0].id}`,
            answer: "",
            attachments: [
              expect.objectContaining({
                name: questionFile.name,
                status: "needs_processing",
              }),
            ],
          }),
          expect.objectContaining({
            questionId: `gap:${opportunity.gaps[1].id}`,
            answer,
            attachments: [
              expect.objectContaining({
                name: termsFile.name,
                status: "ready",
              }),
            ],
          }),
        ]),
      );
      expect(review?.regeneration).toBeUndefined();
    });
    const savedReview = (await stored())!.proposals.find(
      (item) => item.id === proposal.id,
    )!.review!;
    const attachedDocuments = [
      ...(savedReview.sectionChanges || []).flatMap(
        (change) => change.attachments || [],
      ),
      ...savedReview.answers.flatMap((item) => item.attachments || []),
    ];
    expect(attachedDocuments).toHaveLength(3);
    for (const document of attachedDocuments) {
      const original = await getLocalFile(document.id);
      expect(original?.size).toBe(document.size);
      const uploaded = [scopeFile, questionFile, termsFile].find(
        (file) => file.name === document.name,
      )!;
      expect(new Uint8Array(await original!.arrayBuffer())).toEqual(
        new Uint8Array(await uploaded.arrayBuffer()),
      );
      if (document.status === "ready")
        expect(await original?.text()).toBe(document.text);
      else expect(document.text).toBe("");
    }

    first.unmount();
    sessionStorage.clear();
    const second = mount(`/proposals/${proposal.id}`);
    await screen.findByRole("region", { name: "Current proposal file" });
    const restoredScope = await reveal(
      screen.getByLabelText(scopeLabel, { exact: true, selector: "textarea" }),
      user,
    );
    expect(restoredScope).toHaveValue(scopeComment);
    expect(
      screen.getByLabelText(termsLabel, { exact: true, selector: "textarea" }),
    ).toHaveValue(termsComment);
    expect(
      screen.getByText(scopeFile.name, { exact: true }),
    ).toBeInTheDocument();
    const restoredQuestion = within(
      screen
        .getByRole("heading", { name: opportunity.gaps[1].question })
        .closest("article")!,
    );
    expect(
      restoredQuestion.getByRole("textbox", {
        name: "Your answer",
      }),
    ).toHaveValue(answer);
    expect(
      restoredQuestion.getByText(termsFile.name, { exact: true }),
    ).toBeInTheDocument();

    const revisedScope = `${scopeComment} وحدّث خطة التسليم وفق ذلك.`;
    await user.clear(restoredScope);
    await user.click(restoredScope);
    await user.paste(revisedScope);
    const revisedAnswer = `${answer} لا تغيّر نسب الدفعات.`;
    const restoredAnswer = restoredQuestion.getByRole("textbox", {
      name: "Your answer",
    });
    await user.clear(restoredAnswer);
    await user.click(restoredAnswer);
    await user.paste(revisedAnswer);
    await user.click(
      screen.getByRole("button", { name: "Regenerate proposal" }),
    );
    await screen.findByRole("dialog", {
      name: "Regeneration is awaiting the AI connection",
    });
    await waitFor(async () => {
      const updated = (await stored())!.proposals.find(
        (item) => item.id === proposal.id,
      )!;
      const { review, ...currentFile } = updated;
      expect(currentFile).toEqual(proposal);
      expect(
        review?.sectionChanges?.find((item) => item.sectionId === scope.id)
          ?.comment,
      ).toBe(revisedScope);
      expect(
        review?.sectionChanges?.find((item) => item.sectionId === terms.id)
          ?.comment,
      ).toBe(termsComment);
      expect(
        review?.answers.find(
          (item) => item.questionId === `gap:${opportunity.gaps[1].id}`,
        )?.answer,
      ).toBe(revisedAnswer);
      expect(review?.regeneration).toMatchObject({
        status: "awaiting_connection",
        answers: review!.answers,
        sectionChanges: review!.sectionChanges,
        baseVersion: proposal.version,
      });
    });
    const requestedReview = (await stored())!.proposals.find(
      (item) => item.id === proposal.id,
    )!.review!;
    await user.click(screen.getByRole("button", { name: "Back to review" }));
    const nextRound = "ملاحظة لاحقة لم تدخل في طلب إعادة التوليد المحفوظ.";
    await user.clear(restoredScope);
    await user.click(restoredScope);
    await user.paste(nextRound);
    expect(
      (await stored())!.proposals.find((item) => item.id === proposal.id)!
        .review,
    ).toEqual(requestedReview);
    second.unmount();
    mount(`/proposals/${proposal.id}`);
    await screen.findByRole("region", { name: "Current proposal file" });
    expect(
      screen.getByLabelText(scopeLabel, { exact: true, selector: "textarea" }),
    ).toHaveValue(nextRound);
    expect(
      (await stored())!.proposals.find((item) => item.id === proposal.id)!
        .review,
    ).toEqual(requestedReview);
  }, 15000);

  it("retains legacy general instructions and earlier manual edits without assigning them to an arbitrary section", async () => {
    const seed = createSeedState();
    const proposal = seed.proposals.find((item) => item.id === "prop-2")!;
    const opportunity = seed.opportunities.find(
      (item) => item.id === proposal.opportunityId,
    )!;
    const oldInstruction =
      "Legacy general instruction: preserve the existing acceptance criteria.";
    proposal.review = {
      baseVersion: proposal.version,
      sourceSignature: getReviewSourceSignature(seed, proposal, opportunity),
      instructions: oldInstruction,
      answers: [],
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(
      `proposal-section-${proposal.id}-scope`,
      JSON.stringify({
        title: "Scope and approach",
        body: "Earlier unsaved scope edit in Arabic: أضف بند التكامل.",
      }),
    );
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount(`/proposals/${proposal.id}`);
    const general = await screen.findByLabelText("Additional comments", {
      exact: true,
      selector: "textarea",
    });
    expect(general).toHaveValue(oldInstruction);
    const recovered = screen.getByLabelText("Recovered previous edits");
    await reveal(recovered, user);
    expect((recovered as HTMLTextAreaElement).value).toContain(
      "أضف بند التكامل",
    );
    expect(recovered).toHaveAttribute("readonly");
    for (const section of proposal.sections) {
      expect(
        screen.getByLabelText(`Comments on ${section.title}`, {
          exact: true,
          selector: "textarea",
        }),
      ).toHaveValue("");
    }
    expect((await stored())!.proposals).toEqual(seed.proposals);
  });

  it("requires review of a recovered session draft before using it for regeneration", async () => {
    const seed = createSeedState();
    const proposal = seed.proposals.find((item) => item.id === "prop-2")!;
    await set(STORAGE_KEY, seed);
    const instruction =
      "ملاحظة محفوظة سابقًا تحتاج مراجعة مقابل الكراسة الحالية.";
    sessionStorage.setItem(
      `proposal-review-${proposal.id}`,
      JSON.stringify({
        answers: {},
        instructions: instruction,
        baseVersion: proposal.version - 1,
        sourceSignature: "previous-rfp-context",
      }),
    );
    const user = userEvent.setup();
    mount(`/proposals/${proposal.id}`);
    expect(
      await screen.findByRole("textbox", { name: "Additional comments" }),
    ).toHaveValue(instruction);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Regenerate proposal" }),
    ).toBeDisabled();
    expect((await stored())?.proposals).toEqual(seed.proposals);
    await user.click(
      screen.getByRole("button", { name: "Save review inputs" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Regenerate proposal" }),
      ).toBeEnabled(),
    );
    const updated = (await stored())?.proposals.find(
      (item) => item.id === proposal.id,
    );
    const { review, ...currentFile } = updated!;
    expect(currentFile).toEqual(proposal);
    expect(review).toMatchObject({
      baseVersion: proposal.version,
      instructions: instruction,
    });
    expect(review?.sourceSignature).not.toBe("previous-rfp-context");
    expect(review?.regeneration).toBeUndefined();
  });

  it("keeps proposal review inputs and regeneration read-only for the Reviewer role", async () => {
    const seed = createSeedState();
    seed.settings.role = "Reviewer";
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount("/proposals/prop-1");
    const request = await reveal(
      await screen.findByLabelText("Additional comments", {
        exact: true,
        selector: "textarea",
      }),
      user,
    );
    expect(request).toHaveAttribute("readonly");
    for (const answer of screen.getAllByRole("textbox", {
      name: /^Your answer/,
    })) {
      expect(answer).toHaveAttribute("readonly");
    }
    expect(
      screen.getByRole("button", { name: "Save review inputs" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Regenerate proposal" }),
    ).toBeDisabled();
    for (const section of seed.proposals[0].sections) {
      const comment = screen.getByLabelText(`Comments on ${section.title}`, {
        exact: true,
        selector: "textarea",
      });
      await reveal(comment, user);
      expect(comment).toHaveAttribute("readonly");
      await user.type(comment, "This section must not change");
      expect(comment).toHaveValue("");
    }
    const uploads =
      document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(uploads).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Request pricing change" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Provide pricing information" }),
    ).not.toBeInTheDocument();
    await user.type(request, "This must not be saved");
    expect(request).toHaveValue("");
    expect((await stored())?.proposals).toEqual(seed.proposals);
  });
});
