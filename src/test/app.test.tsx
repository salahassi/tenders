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
import App from "../App";
import { AppProvider, STORAGE_KEY } from "../lib/store";
import { createSeedState } from "../lib/seed";
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

function navigation() {
  return within(screen.getByRole("navigation", { name: "Main navigation" }));
}

beforeEach(async () => {
  sessionStorage.clear();
  network.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("crypto", webcrypto);
  await set(STORAGE_KEY, createSeedState());
});

afterEach(async () => {
  cleanup();
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("browser-local workspace journeys", () => {
  it("opens without credentials, preserves the demo disclosure, and navigates to setup", async () => {
    const user = userEvent.setup();
    mount();
    expect(
      await screen.findByRole(
        "heading",
        { name: "From opportunity to proposal." },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("You’re exploring the demo.")).toBeInTheDocument();
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
    expect(screen.getByText("You’re exploring the demo.")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /Setup details/ }));
    expect(
      await screen.findByText("Backend not configured"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No live tenders are collected, no model is called/),
    ).toBeInTheDocument();
  });

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
      await screen.findByRole("link", { name: "Open proposal" }),
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
    expect(
      await screen.findByRole("link", { name: title }),
    ).toBeInTheDocument();
  });

  it("persists the simulated Reviewer role and disables editing and source activation", async () => {
    const user = userEvent.setup();
    const first = mount("/settings");
    await user.click(await screen.findByRole("button", { name: "Reviewer" }));
    expect(
      screen.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();
    expect(screen.getByText(/This is not authentication/)).toBeInTheDocument();
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
      "Source enabled in your saved configuration. Live collection is not connected.",
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
    await user.click(
      screen.getByRole("link", { name: "View a review example" }),
    );
    expect(
      await screen.findByRole("region", { name: "Current proposal file" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: seed.proposals[0].title }),
    ).toBeInTheDocument();
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
      screen.getByRole("button", { name: "Download current Word" }),
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
      expect(review?.answers).toContainEqual({
        questionId: `gap:${question.id}`,
        answer: arabicAnswer,
      });
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
    const request = await screen.findByRole("textbox", {
      name: "Change request",
    });
    const instruction =
      "عدّل خطة التنفيذ إلى 12 أسبوعًا واشرح أثر ذلك على التكلفة.";
    await user.click(request);
    await user.paste(instruction);
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
        regeneration: {
          status: "awaiting_connection",
          baseVersion: proposal.version,
          instructions: instruction,
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
      await screen.findByRole("textbox", { name: "Change request" }),
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
    const request = await screen.findByRole("textbox", {
      name: "Change request",
    });
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
    for (const action of screen.getAllByRole("button", {
      name: "Request pricing change",
    })) {
      expect(action).toBeDisabled();
    }
    expect(
      screen.getByRole("button", { name: "Review pricing assumptions" }),
    ).toBeDisabled();
    await user.type(request, "This must not be saved");
    expect(request).toHaveValue("");
    expect((await stored())?.proposals).toEqual(seed.proposals);
  });
});
