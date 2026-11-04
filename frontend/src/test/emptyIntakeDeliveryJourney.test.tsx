import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../lib/appContext";
import OpportunityDetail from "../pages/OpportunityDetail";
import { createSeedState } from "./fixtures/workspace";
import { downloadDeliveryPackage } from "../lib/deliveryDownload";

// Keep the real opportunity/upload, generation, prepare and saved-package UI.
// Unrelated provenance panels are outside this empty-intake journey.
vi.mock("../components/ProcurementHistory", () => ({ default: () => null }));
vi.mock("../components/AddendumOrder", () => ({ default: () => null }));
vi.mock("../lib/deliveryDownload", () => ({
  downloadDeliveryPackage: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function journey() {
  const state = createSeedState();
  const opportunity = {
    ...state.opportunities[0],
    description: "",
    documents: [],
    requirements: [],
    gaps: [],
    status: "shortlisted" as const,
    revision: 7,
  };
  state.opportunities = [opportunity];
  state.proposals = [];
  state.settings.role = "Owner";
  const saved = {
    snapshot: {
      id: "template",
      proposal_id: "proposal",
      delivery_revision: 1,
      ordinal: 1,
      language: "en",
      content_state: "template",
      input_state: "insufficient",
      assurance_state: "unreviewed",
      gap_count: 2,
    },
    status: "ready",
    artifacts: [
      {
        id: "file",
        volume: "combined",
        status: "ready",
        content_hash: "a".repeat(64),
        expected_size: 12,
        original_name: "template.docx",
        mime_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ],
  };
  const request = vi.fn(async (path: string) => {
    if (path === `/v1/opportunities/${opportunity.id}`)
      return { data: { revision: 7 } };
    if (path === "/v1/commands") return { data: [{ id: "template" }] };
    if (path === "/v1/delivery-snapshots/template/package")
      return { data: saved };
    throw new Error(`Unexpected test request ${path}`);
  });
  const update = vi.fn(async () => true);
  const runCommand = vi.fn();
  const context = {
    state,
    update,
    notify: vi.fn(),
    runCommand,
    saving: false,
    mode: "CONNECTED_FREE",
    backend: { request, list: vi.fn(async () => []) },
  } as unknown as AppContextValue;
  render(
    <AppContext.Provider value={context}>
      <MemoryRouter initialEntries={[`/opportunities/${opportunity.id}`]}>
        <Routes>
          <Route path="/opportunities/:id" element={<OpportunityDetail />} />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>,
  );
  return { opportunity, request, update, runCommand, saved };
}

it("keeps the independent template action available with zero documents while AI generation is disabled", async () => {
  const j = journey();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Generate proposal draft" }),
    ).toBeDisabled(),
  );
  const prepare = screen.getByRole("button", { name: "Save available draft" });
  expect(prepare).toBeEnabled();
  fireEvent.click(prepare);
  await screen.findByText(/Available scope information is insufficient/);
  expect(
    screen.getByText(
      /Missing inputs are highlighted yellow in the saved template/,
    ),
  ).toBeInTheDocument();
  expect(j.request).toHaveBeenCalledWith(
    "/v1/commands",
    expect.objectContaining({
      body: {
        commands: [
          {
            operation: "delivery.snapshot.prepare",
            input: { opportunity_id: j.opportunity.id, expected_revision: 7 },
          },
        ],
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download saved draft" }));
  await waitFor(() =>
    expect(downloadDeliveryPackage).toHaveBeenCalledWith(
      expect.anything(),
      j.saved,
      expect.any(AbortSignal),
    ),
  );
  expect(j.runCommand).not.toHaveBeenCalled();
  expect(j.update).not.toHaveBeenCalled();
});

it.each([
  {
    bytes: "",
    name: "empty.pdf",
    code: "EMPTY_FILE",
    message: "The file is empty.",
  },
  {
    bytes: "This is not a PDF file",
    name: "invalid.pdf",
    code: "INVALID_FILE",
    message: "The file signature does not match PDF.",
  },
])(
  "preserves the $code extraction result without creating a document and sends it through the independent template action",
  async ({ bytes, name, code, message }) => {
    const j = journey();
    const file = new File([bytes], name, { type: "application/pdf" });
    // jsdom File lacks arrayBuffer; use the real file bytes, not a parser mock.
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode(bytes).buffer,
    });
    fireEvent.change(screen.getByLabelText(/Upload reference files/), {
      target: { files: [file] },
    });
    await screen.findByText(`${name}: ${message}`);
    expect(j.update).not.toHaveBeenCalled();
    expect(j.runCommand).not.toHaveBeenCalled();
    const prepare = screen.getByRole("button", {
      name: "Save available draft",
    });
    expect(prepare).toBeEnabled();
    fireEvent.click(prepare);
    await screen.findByText(/Available scope information is insufficient/);
    expect(j.request).toHaveBeenCalledWith(
      "/v1/commands",
      expect.objectContaining({
        body: {
          commands: [
            {
              operation: "delivery.snapshot.prepare",
              input: {
                opportunity_id: j.opportunity.id,
                expected_revision: 7,
                intake_failure: code,
              },
            },
          ],
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeEnabled();
  },
);
