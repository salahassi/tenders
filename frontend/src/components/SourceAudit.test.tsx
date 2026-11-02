import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SourceAudit from "./SourceAudit";
import type { BackendClient } from "../lib/backendClient";

let backend: Pick<BackendClient, "request">;
vi.mock("../lib/store", () => ({ useApp: () => ({ backend }) }));
afterEach(cleanup);
const source = "00000000-0000-4000-8000-000000000099";
const other = "00000000-0000-4000-8000-000000000098";
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (n: number, target = source) => ({
  id: id(n),
  action: `Decision ${n}`,
  entity_id: target,
  actor_id: null,
  created_at: "2026-11-02T00:00:00Z",
});
const page = (
  records: ReturnType<typeof row>[],
  next: string | null = null,
) => ({
  data: { records, next_cursor: next },
  meta: { request_id: "fixture" },
});

describe("source decision history", () => {
  it("refreshes from the first page so later inserted events are discoverable", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([row(2)]))
      .mockResolvedValueOnce(page([row(1), row(2)]));
    backend = { request };
    render(<SourceAudit sourceId={source} />);
    await screen.findByText("Decision 2");
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh history" }),
    );
    expect(await screen.findByText("Decision 1")).toBeInTheDocument();
    expect(screen.getAllByText("Decision 2")).toHaveLength(1);
    expect(request.mock.calls[1][0]).toBe("/v1/audit-events?limit=500");
  });
  it("checks one page at a time and does not imply an empty loaded page is complete history", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 500 }, (_, i) => row(i + 1, other)),
          id(500),
        ),
      )
      .mockResolvedValueOnce(page([row(501)]));
    backend = { request };
    render(<SourceAudit sourceId={source} />);
    expect(
      await screen.findByText(
        /No decisions for this source in the loaded history/,
      ),
    ).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Load more workspace events" }),
    );
    expect(await screen.findByText("Decision 501")).toBeInTheDocument();
    expect(
      screen.getByText(/501 workspace events checked/),
    ).toBeInTheDocument();
    expect(request.mock.calls[1][0]).toBe(
      `/v1/audit-events?limit=500&cursor=${id(500)}`,
    );
    expect(
      screen.queryByRole("button", { name: "Load more workspace events" }),
    ).not.toBeInTheDocument();
  });
  it("keeps loaded decisions and retries the same failed continuation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([row(1)], id(1)))
      .mockRejectedValueOnce(new Error("History request unavailable"))
      .mockResolvedValueOnce(page([row(2)]));
    backend = { request };
    render(<SourceAudit sourceId={source} />);
    await screen.findByText("Decision 1");
    await userEvent.click(
      screen.getByRole("button", { name: "Load more workspace events" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "History request unavailable",
    );
    expect(screen.getByText("Decision 1")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry loading history" }),
    );
    expect(await screen.findByText("Decision 2")).toBeInTheDocument();
    expect(screen.getByText("Decision 1")).toBeInTheDocument();
    expect(request.mock.calls[1][0]).toBe(request.mock.calls[2][0]);
  });
  it("shows an initial authorization error in the panel and permits retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Session expired"))
      .mockResolvedValueOnce(page([]));
    backend = { request };
    render(
      <>
        <p>Workspace remains open</p>
        <SourceAudit sourceId={source} />
      </>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Session expired",
    );
    expect(screen.getByText("Workspace remains open")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry loading history" }),
    );
    expect(
      await screen.findByText("No decisions recorded for this source."),
    ).toBeInTheDocument();
    expect(request.mock.calls[1][0]).toBe("/v1/audit-events?limit=500");
  });
  it("ignores late responses from a replaced source and client even when transport ignores abort", async () => {
    let resolve!: (value: ReturnType<typeof page>) => void;
    const first = vi.fn(
      () =>
        new Promise<ReturnType<typeof page>>((done) => {
          resolve = done;
        }),
    );
    backend = { request: first as unknown as BackendClient["request"] };
    const view = render(<SourceAudit sourceId={source} />);
    await waitFor(() => expect(first).toHaveBeenCalledOnce());
    backend = { request: vi.fn().mockResolvedValue(page([row(2, other)])) };
    view.rerender(<SourceAudit sourceId={other} />);
    expect(await screen.findByText("Decision 2")).toBeInTheDocument();
    await act(async () => resolve(page([row(1, source)])));
    expect(screen.queryByText("Decision 1")).not.toBeInTheDocument();
    expect(screen.getByText("Decision 2")).toBeInTheDocument();
  });
  it.each(["empty", "duplicate", "backward"])(
    "rejects %s continuation pages without replacing loaded history",
    async (kind) => {
      const next =
        kind === "empty"
          ? page([], id(3))
          : kind === "duplicate"
            ? page([row(2)], id(2))
            : page([row(1)], id(1));
      const request = vi
        .fn()
        .mockResolvedValueOnce(page([row(2)], id(2)))
        .mockResolvedValueOnce(next);
      backend = { request };
      render(<SourceAudit sourceId={source} />);
      await screen.findByText("Decision 2");
      await userEvent.click(
        screen.getByRole("button", { name: "Load more workspace events" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "did not advance",
      );
      expect(screen.getAllByText("Decision 2")).toHaveLength(1);
      expect(screen.queryByText("Decision 1")).not.toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
