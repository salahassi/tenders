import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProposalConsistencyReview from "./ProposalConsistencyReview";
import type { BackendClient } from "../lib/backendClient";
afterEach(cleanup);
const context = (version: string) => ({
  version_id: version,
  version_revision: 1,
  binding_hash: "a".repeat(64),
  input: {
    requirements: [
      {
        id: "r",
        text: "Provide a workflow",
        source_refs: [{ id: "s", quote: "Provide a workflow" }],
        source_semantics: {
          review_status: "confirmed",
          authority_status: "confirmed",
          conditions: [],
          exceptions: [],
          consequences: [],
        },
      },
    ],
    sections: [
      {
        key: "approach",
        title: "Approach",
        requirement_ids: ["r"],
        content_blocks: [
          {
            type: "paragraph",
            text: "Configure workflow. Deliver manual. Buyer signs acceptance.",
          },
        ],
      },
    ],
    input_complete: true,
  },
  shared_decisions: [],
  report: { substantive_complete: false, coverage: [], diagnostics: [] },
});
it("requires explicit scoped review and sends real response fields without a trusted pass flag", async () => {
  const request = vi.fn(async (_path: string, options?: any) => ({
    data:
      options?.method === "POST"
        ? {
            version_revision: 2,
            report: {
              substantive_complete: false,
              coverage: [],
              diagnostics: [],
            },
          }
        : context("v1"),
  }));
  render(
    <ProposalConsistencyReview
      client={{ request } as unknown as BackendClient}
      versionId="v1"
      onSaved={vi.fn(async () => {})}
    />,
  );
  await screen.findByText("Provide a workflow", { selector: "summary" });
  const submit = screen.getByRole("button", {
    name: "Check and save my scoped review",
  });
  expect(submit).toBeDisabled();
  fireEvent.change(
    screen.getByLabelText("Section containing the primary response"),
    { target: { value: "approach" } },
  );
  fireEvent.change(
    screen.getByLabelText("Implementation method from the response"),
    { target: { value: "Configure workflow" } },
  );
  fireEvent.change(screen.getByLabelText("Deliverable from the response"), {
    target: { value: "Deliver manual" },
  });
  fireEvent.change(
    screen.getByLabelText("Acceptance evidence from the response"),
    { target: { value: "Buyer signs acceptance" } },
  );
  fireEvent.click(screen.getByLabelText(/I reviewed this response/));
  fireEvent.change(
    screen.getByLabelText(
      "What you checked and why the response is sufficient",
    ),
    {
      target: {
        value:
          "I checked the buyer obligation, proposed method and acceptance evidence.",
      },
    },
  );
  fireEvent.click(submit);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const payload = (request.mock.calls[1][1] as any).body;
  expect(payload.reviewed_requirement_ids).toEqual(["r"]);
  expect(payload.fulfillment[0].method).toBe("Configure workflow");
  expect(payload).not.toHaveProperty("report");
  expect(payload).not.toHaveProperty("actor_id");
});
it("discards a late old-version load and clears scoped attestations on version change", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const request = vi.fn((path: string) =>
    path.includes("/old/")
      ? pending
      : Promise.resolve({ data: context("new") }),
  );
  const client = { request } as unknown as BackendClient;
  const view = render(
    <ProposalConsistencyReview
      client={client}
      versionId="old"
      onSaved={vi.fn()}
    />,
  );
  view.rerender(
    <ProposalConsistencyReview
      client={client}
      versionId="new"
      onSaved={vi.fn()}
    />,
  );
  await screen.findByText("Provide a workflow", { selector: "summary" });
  await act(async () =>
    resolve({
      data: {
        ...context("old"),
        input: {
          ...context("old").input,
          requirements: [
            {
              id: "old",
              text: "Old response",
              source_refs: [],
              source_semantics: {},
            },
          ],
        },
      },
    }),
  );
  expect(screen.queryByText("Old response")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/I reviewed this response/)).not.toBeChecked();
});
