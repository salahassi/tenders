import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ApprovalPanel from "./ApprovalPanel";
import type { Proposal } from "../types";
const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("../lib/store", () => ({ useApp: () => state.app }));
vi.mock("./CommercialReview", () => ({ default: () => null }));
vi.mock("./ProposalConsistencyReview", () => ({ default: () => null }));
afterEach(cleanup);
function fixture() {
  const hash = "a".repeat(64),
    runCommand = vi.fn(async () => ({}));
  const request = vi.fn(async (path: string) => ({
    data: path.endsWith("/consistency")
      ? { input: { requirements: [{ id: "r", applicability_binding: hash }] } }
      : path.endsWith("/readiness")
        ? { blockers: [] }
        : path.includes("/generation-plans/")
          ? {
              frozen_context: {
                proposal_consistency_version: 1,
                blocks: [],
                knowledge: [],
              },
            }
          : { id: "v", plan_id: "p", revision: 1 },
  }));
  state.app = {
    backend: {
      request,
      list: vi.fn(async (kind: string) =>
        kind === "requirements"
          ? [
              {
                id: "r",
                plan_id: "p",
                text: "Provide a workflow",
                mandatory: false,
                source_refs: [],
                source_semantics: {
                  version: 1,
                  review_status: "pending",
                  authority_status: "unconfirmed",
                  modality: "unknown",
                },
              },
            ]
          : kind === "proposal-sections"
            ? [
                {
                  id: "s",
                  section_key: "approach",
                  title: "Approach",
                  ordinal: 0,
                },
              ]
            : [],
      ),
    },
    runCommand,
    state: { settings: { role: "Owner" } },
    notify: vi.fn(),
    refresh: vi.fn(),
  };
  render(
    <ApprovalPanel
      proposal={{ id: "p", versionId: "v", opportunityId: "o" } as Proposal}
    />,
  );
  return { hash, request, runCommand };
}
it("shows pending meaning accurately and passes the exact reviewed applicability binding through existing Owner command", async () => {
  const f = fixture();
  await screen.findByText(/Obligation meaning\/authority needs review/);
  fireEvent.change(screen.getByLabelText("Response status"), {
    target: { value: "not_applicable_approved" },
  });
  fireEvent.change(screen.getByLabelText("Rationale"), {
    target: {
      value: "Owner reviewed current scope and explicitly declined this offer.",
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm this response" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith(
      "compliance.save",
      expect.objectContaining({
        expected_applicability_binding: f.hash,
        status: "not_applicable_approved",
      }),
    ),
  );
});
it("does not silently refresh and approve an exclusion after a late source/content change", async () => {
  const f = fixture();
  await screen.findByText(/Obligation meaning\/authority needs review/);
  f.runCommand.mockRejectedValueOnce(
    Object.assign(new Error("Changed source"), {
      code: "STALE_SOURCE_APPLICABILITY",
    }),
  );
  fireEvent.change(screen.getByLabelText("Response status"), {
    target: { value: "not_applicable_approved" },
  });
  fireEvent.change(screen.getByLabelText("Rationale"), {
    target: { value: "Owner reviewed this exact proposal and requirement." },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm this response" }),
  );
  await screen.findByText(/changed after you reviewed it/);
  expect(
    screen.getByRole("button", { name: "Confirm this response" }),
  ).toBeDisabled();
  expect(
    f.request.mock.calls.filter(([p]) => p.endsWith("/consistency")),
  ).toHaveLength(1);
});
