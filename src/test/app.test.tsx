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

beforeEach(async () => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
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
        { name: "Good work starts with the right opportunity." },
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
      await screen.findByRole("heading", {
        name: "Find your next opportunity.",
      }),
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

  it("combines search and human-decision filters without hiding an unranked opportunity", async () => {
    const seed = createSeedState();
    const unranked = seed.opportunities.find((item) => item.id === "opp-7")!;
    unranked.score = null;
    await set(STORAGE_KEY, seed);
    const user = userEvent.setup();
    mount("/opportunities");
    const search = await screen.findByRole("textbox", {
      name: "Search opportunities",
    });
    await user.type(search, "DEMO-0007");
    expect(
      screen.getByRole("link", { name: unranked.title }),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      2,
    );
    await user.click(screen.getByRole("button", { name: /^Shortlisted/ }));
    expect(
      screen.queryByRole("link", { name: unranked.title }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /^All opportunities/ }),
    );
    expect(
      screen.getByRole("link", { name: unranked.title }),
    ).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "DEMO-0010");
    await user.click(screen.getByRole("button", { name: /^Declined/ }));
    expect(
      screen.getByRole("link", {
        name: "Construction of a new electrical substation",
      }),
    ).toBeInTheDocument();
  });

  it("opens every remaining workspace destination through visible navigation", async () => {
    const user = userEvent.setup();
    mount("/dashboard");
    await screen.findByRole(
      "heading",
      { name: "Good work starts with the right opportunity." },
      { timeout: 5000 },
    );
    const destinations = [
      ["Review queue", "A little attention goes a long way."],
      ["Proposals", "Your proposal workspace"],
      ["Company knowledge", "Knowledge base"],
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

  it("validates a manual entry and restores its Arabic text and unresolved deadline after remount", async () => {
    const user = userEvent.setup();
    const first = mount("/opportunities");
    await user.click(
      await screen.findByRole("button", { name: "Add opportunity" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add an opportunity" });
    const title = "منصة خدمات رقمية — synthetic QA opportunity";
    await user.click(
      within(dialog).getByRole("textbox", { name: "Opportunity title" }),
    );
    await user.paste(title);
    await user.click(
      within(dialog).getByRole("button", { name: "Add opportunity" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Provide a title and either a reference number or source URL.",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reference number" }),
      "QA-MANUAL-001",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Buyer" }),
      "Synthetic QA buyer",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add opportunity" }),
    );
    expect(
      await screen.findByRole("link", { name: title }),
    ).toBeInTheDocument();
    await waitFor(async () => {
      const created = (await stored())?.opportunities.find(
        (item) => item.reference === "QA-MANUAL-001",
      );
      expect(created).toMatchObject({
        title,
        score: null,
        coverage: 0,
        deadline: "",
        status: "new",
        acquisition: "not_requested",
      });
      expect(created?.gaps.some((gap) => gap.required && !gap.answer)).toBe(
        true,
      );
    });
    first.unmount();
    mount("/opportunities");
    await user.type(
      await screen.findByRole("textbox", { name: "Search opportunities" }),
      "QA-MANUAL-001",
    );
    expect(screen.getByRole("link", { name: title })).toBeInTheDocument();
  });

  it("persists the simulated Reviewer role and disables editing and source approval", async () => {
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
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
  });

  it("records local source approval and reports a blocked test without contacting the source", async () => {
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
    await user.click(within(row).getByRole("button", { name: "Approve" }));
    expect(
      within(row).getByText("approved", { exact: true }),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Test" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connected backend is not configured. No network request was made.",
    );
    await waitFor(async () => {
      const state = await stored();
      expect(
        state?.sources.find((source) => source.id === "src-3"),
      ).toMatchObject({ status: "approved", lastRun: null, nextRun: null });
      expect(state?.jobs[0]).toMatchObject({
        status: "blocked",
        progress: 0,
        target: "Procurement directory candidate",
      });
      expect(state?.jobs[0].message).toContain("No network request was made.");
    });
  });

  it("records acquisition approval without creating a proposal before a readable RFP is supplied", async () => {
    const user = userEvent.setup();
    mount("/opportunities/opp-2");
    await user.click(
      await screen.findByRole("button", { name: "Acquisition" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Request acquisition" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve acquisition" }),
    );
    expect(screen.getByText("Approved", { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add and review a readable RFP before creating a draft.",
    );
    expect(
      screen.getByRole("heading", { name: "RFP document package" }),
    ).toBeInTheDocument();
    await waitFor(async () => {
      const state = await stored();
      expect(
        state?.opportunities.find((item) => item.id === "opp-2")?.acquisition,
      ).toBe("approved");
      expect(state?.proposals).toHaveLength(3);
      expect(state?.jobs).toHaveLength(3);
      expect(
        state?.audit.some((item) => item.action.includes("no payment made")),
      ).toBe(true);
    });
  });

  it("requires Owner attestation and invalidates exact-version approval when a section is edited", async () => {
    const user = userEvent.setup();
    mount("/proposals/prop-2");
    await user.click(
      await screen.findByRole("button", { name: /^Review & export/ }),
    );
    expect(
      screen.getByRole("button", { name: "Approved technical DOCX" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Approve version 1" }));
    const dialog = screen.getByRole("dialog", { name: "Approve version 1" });
    expect(
      within(dialog).getByRole("button", {
        name: "Approve this exact version",
      }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /I reviewed the RFP coverage/,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Approve this exact version",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Approved technical DOCX" }),
    ).toBeEnabled();
    await waitFor(async () =>
      expect(
        (await stored())?.proposals.find((item) => item.id === "prop-2"),
      ).toMatchObject({ status: "approved", version: 1, approvalVersion: 1 }),
    );
    await user.click(screen.getByRole("button", { name: /^Write proposal/ }));
    const content = screen.getByRole("textbox", { name: "Section content" });
    await user.click(content);
    await user.keyboard("{Control>}{End}{/Control}");
    await user.paste(" Clarified implementation acceptance criteria.");
    await user.click(screen.getByRole("button", { name: "Save section" }));
    await user.click(screen.getByRole("button", { name: /^Review & export/ }));
    expect(
      screen.getByRole("button", { name: "Approved technical DOCX" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Approve version 2" }),
    ).toBeEnabled();
    await waitFor(async () =>
      expect(
        (await stored())?.proposals.find((item) => item.id === "prop-2"),
      ).toMatchObject({ status: "draft", version: 2, approvalVersion: null }),
    );
  });
});
