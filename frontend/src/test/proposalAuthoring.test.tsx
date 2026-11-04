import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProposalAuthoring from "../components/ProposalAuthoring";
import type { BackendClient } from "../lib/backendClient";
afterEach(cleanup);
const id = "00000000-0000-4000-8000-000000000001";
function context() {
  return {
    session: {
      id,
      opportunity_id: id,
      proposal_id: id,
      revision: 1,
      responsible_actor_id: null,
    },
    revision: {
      id,
      body_hash: "a".repeat(64),
      body: {
        version: 1,
        requirements: [],
        sections: [],
        fulfillment: [],
        confirmed_shared_decisions: [],
        pending_inputs: [],
        reuse: [],
      },
    },
    snapshot: {
      payload: {
        source_manifest: [{ entity_id: id }],
        language: "en",
        input_state: "available",
      },
    },
    source_manifest: [{ entity_id: id }],
    context_hash: "b".repeat(64),
  };
}
function view(request: ReturnType<typeof vi.fn>, onPublished = vi.fn()) {
  return render(
    <MemoryRouter>
      <ProposalAuthoring
        client={{ request } as unknown as BackendClient}
        snapshotId={id}
        deliveryRevision={1}
        ar={false}
        onPublished={onPublished}
      />
    </MemoryRouter>,
  );
}
it("offers explicit responsibility and source review while requiring real reviewed obligations before completion", async () => {
  const initial = context();
  const request = vi.fn(async (path: string) => ({
    data: path.endsWith("/source-review")
      ? { source_evidence: { spans: [], reviews: [] } }
      : initial,
  }));
  view(request);
  await screen.findByText(/No responsible editor has accepted/);
  expect(
    screen.getByRole("button", {
      name: "Review saved responses against current sources",
    }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("My responsibility note"), {
    target: {
      value:
        "I will review the actual buyer response and coordinate missing inputs.",
    },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "I take responsibility for the response",
    }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      `/v1/proposal-authoring/${id}/claim`,
      expect.objectContaining({
        body: {
          expected_revision: 1,
          note: "I will review the actual buyer response and coordinate missing inputs.",
        },
      }),
    ),
  );
  expect(
    request.mock.calls.some(([path]) => String(path).includes("notification")),
  ).toBe(false);
});
it("preserves explicit pending input and publishes only a saved draft without inventing a substantive result", async () => {
  const initial = context(),
    published = vi.fn();
  const request = vi.fn(async (path: string, options?: any) => ({
    data: path.endsWith("/source-review")
      ? { source_evidence: { spans: [], reviews: [] } }
      : path.endsWith("/save")
        ? {
            ...initial,
            session: { ...initial.session, revision: 2 },
            revision: { ...initial.revision, body: options.body.body },
            published_snapshot: { id: "saved-authored-draft" },
          }
        : initial,
  }));
  view(request, published);
  await screen.findByLabelText(
    "Missing information to request from an authorized person",
  );
  fireEvent.change(
    screen.getByLabelText(
      "Missing information to request from an authorized person",
    ),
    {
      target: {
        value:
          "Confirm the acceptance witness and the required operating context.",
      },
    },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save as pending input" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save response draft" }));
  await waitFor(() =>
    expect(published).toHaveBeenCalledWith("saved-authored-draft"),
  );
  const saved = request.mock.calls.find(([path]) =>
    String(path).endsWith("/save"),
  )![1].body;
  expect(saved.body.pending_inputs[0]).toMatchObject({
    question:
      "Confirm the acceptance witness and the required operating context.",
    required_for: "substantive_completion",
  });
  expect(saved.body).not.toHaveProperty("substantive_complete");
  expect(
    screen.queryByText(
      "Substantive responses reviewed. Final approval remains required.",
    ),
  ).not.toBeInTheDocument();
});
it("offers a deliberate source successor after stale context and retains unreviewed response history", async () => {
  const next = context(),
    published = vi.fn();
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/open")) throw Error("authoring source changed");
    return {
      data: path.endsWith("/authoring-status")
        ? { session_id: id, revision: 4, delivery_revision: 6 }
        : path.endsWith("/refresh")
          ? { ...next, published_snapshot: { id: "current-source-draft" } }
          : { source_evidence: { spans: [], reviews: [] } },
    };
  });
  view(request, published);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Keep responses and refresh sources",
    }),
  );
  await waitFor(() =>
    expect(published).toHaveBeenCalledWith("current-source-draft"),
  );
  expect(request).toHaveBeenCalledWith(
    `/v1/proposal-authoring/${id}/refresh`,
    expect.objectContaining({
      body: { expected_revision: 4, expected_delivery_revision: 6 },
    }),
  );
  expect(
    screen.getByRole("button", {
      name: "Review saved responses against current sources",
    }),
  ).toBeDisabled();
});
