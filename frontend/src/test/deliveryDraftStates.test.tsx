import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import DeliveryDraft from "../components/DeliveryDraft";
import PrepareDeliveryDraft from "../components/PrepareDeliveryDraft";
import type { BackendClient } from "../lib/backendClient";
import {
  downloadDeliveryPackage,
  type DeliveryPackage,
} from "../lib/deliveryDownload";

vi.mock("../lib/deliveryDownload", () => ({
  downloadDeliveryPackage: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function saved(
  id: string,
  status: DeliveryPackage["status"] = "ready",
  ordinal = 1,
): DeliveryPackage {
  return {
    snapshot: {
      id,
      proposal_id: "proposal",
      delivery_revision: 17,
      ordinal,
      language: "en",
      content_state: "source_draft",
      input_state: "available",
      assurance_state: "unreviewed",
      gap_count: 3,
    },
    status,
    artifacts: [
      {
        id: `${id}-file`,
        volume: "combined",
        status: status === "ready" ? "ready" : "reserved",
        content_hash: "a".repeat(64),
        expected_size: 100,
        original_name: "draft.docx",
        mime_type: "application/docx",
      },
    ],
  };
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(downloadDeliveryPackage).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saved delivery states and stale async work", () => {
  it("keeps download disabled while preparing, polls, and describes a ready file as incomplete content", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: saved("one", "preparing") })
      .mockResolvedValue({ data: saved("one") });
    render(
      <DeliveryDraft
        client={{ request } as unknown as BackendClient}
        snapshotId="one"
      />,
    );
    await flush();
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Preparing the saved Word file/),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/The response is still incomplete/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Available scope information is insufficient/),
    ).not.toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/delivery-snapshots/one/package",
      "/v1/delivery-snapshots/one/package",
    ]);
  });
  it("retries a blocked package with its observed delivery revision and reloads it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: saved("one", "blocked") })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValue({ data: saved("one", "preparing") });
    render(
      <DeliveryDraft
        client={{ request } as unknown as BackendClient}
        snapshotId="one"
      />,
    );
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "does not mean the RFP is invalid",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry draft preparation" }),
    );
    await flush();
    expect(request.mock.calls[1]).toEqual([
      "/v1/commands",
      expect.objectContaining({
        method: "POST",
        idempotencyKey: expect.any(String),
        signal: expect.any(AbortSignal),
        body: {
          commands: [
            {
              operation: "delivery.snapshot.retry",
              input: { snapshot_id: "one", expected_delivery_revision: 17 },
            },
          ],
        },
      }),
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeDisabled();
  });
  it("ignores a late package response after switching snapshots", async () => {
    const old = deferred<{ data: DeliveryPackage }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ data: saved("two", "ready", 2) });
    const client = { request } as unknown as BackendClient;
    const view = render(<DeliveryDraft client={client} snapshotId="one" />);
    view.rerender(<DeliveryDraft client={client} snapshotId="two" />);
    await flush();
    await act(async () => {
      old.resolve({ data: saved("one", "blocked") });
    });
    expect(
      screen.getByText("Draft 2 · 3 unresolved inputs"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Draft 1 · 3 unresolved inputs"),
    ).not.toBeInTheDocument();
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("aborts an old download and never marks the new snapshot downloaded when the old promise completes", async () => {
    const pending = deferred<void>();
    vi.mocked(downloadDeliveryPackage).mockReturnValue(pending.promise);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: saved("one") })
      .mockResolvedValue({ data: saved("two", "ready", 2) });
    const client = { request } as unknown as BackendClient;
    const view = render(<DeliveryDraft client={client} snapshotId="one" />);
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Download saved draft" }),
    );
    const signal = vi.mocked(downloadDeliveryPackage).mock.calls[0][2]!;
    expect(signal.aborted).toBe(false);
    view.rerender(<DeliveryDraft client={client} snapshotId="two" />);
    await flush();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve();
    });
    expect(
      screen.queryByText(/Draft downloads started/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Draft 2 · 3 unresolved inputs"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeEnabled();
  });
  it("does not refresh the new snapshot when an old retry finishes after navigation", async () => {
    const pending = deferred<{ data: object }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: saved("one", "blocked") })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ data: saved("two", "ready", 2) });
    const client = { request } as unknown as BackendClient;
    const view = render(<DeliveryDraft client={client} snapshotId="one" />);
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry draft preparation" }),
    );
    const signal = request.mock.calls[1][1].signal as AbortSignal;
    view.rerender(<DeliveryDraft client={client} snapshotId="two" />);
    await flush();
    await act(async () => {
      pending.resolve({ data: {} });
    });
    expect(signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      screen.getByText("Draft 2 · 3 unresolved inputs"),
    ).toBeInTheDocument();
  });
  it("uses the insufficient-input notice only for a saved insufficient template", async () => {
    const template = saved("one");
    template.snapshot.input_state = "insufficient";
    template.snapshot.content_state = "template";
    render(
      <DeliveryDraft
        client={
          {
            request: vi.fn().mockResolvedValue({ data: template }),
          } as unknown as BackendClient
        }
        snapshotId="one"
      />,
    );
    await flush();
    expect(
      screen.getByText(/Available scope information is insufficient/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download saved draft" }),
    ).toBeEnabled();
  });
});

describe("independent draft preparation navigation", () => {
  it("passes the observed opportunity revision and reported extraction failure without declaring the RFP invalid", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { revision: 9 } })
      .mockResolvedValueOnce({ data: [{ id: "draft-one" }] })
      .mockResolvedValue({ data: saved("draft-one") });
    render(
      <PrepareDeliveryDraft
        client={{ request } as unknown as BackendClient}
        opportunityId="opportunity-one"
        intakeFailure="EXTRACTION_FAILED"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save available draft" }),
    );
    await flush();
    expect(request.mock.calls[1][1].body.commands).toEqual([
      {
        operation: "delivery.snapshot.prepare",
        input: {
          opportunity_id: "opportunity-one",
          expected_revision: 9,
          intake_failure: "EXTRACTION_FAILED",
        },
      },
    ]);
    expect(
      screen.getByText(/The response is still incomplete/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Available scope information is insufficient/),
    ).not.toBeInTheDocument();
  });
  it("does not send an old opportunity command when its revision arrives after navigation", async () => {
    const old = deferred<{ data: { revision: number } }>();
    const request = vi.fn().mockReturnValueOnce(old.promise);
    const client = { request } as unknown as BackendClient;
    const view = render(
      <PrepareDeliveryDraft client={client} opportunityId="one" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save available draft" }),
    );
    view.rerender(<PrepareDeliveryDraft client={client} opportunityId="two" />);
    await act(async () => {
      old.resolve({ data: { revision: 9 } });
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save available draft" }),
    ).toBeEnabled();
  });
  it("ignores an old save response and clears a saved draft when the opportunity changes", async () => {
    const old = deferred<{ data: Array<{ id: string }> }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { revision: 9 } })
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ data: { revision: 10 } })
      .mockResolvedValueOnce({ data: [{ id: "draft-two" }] })
      .mockResolvedValue({ data: saved("draft-two", "ready", 2) });
    const client = { request } as unknown as BackendClient;
    const view = render(
      <PrepareDeliveryDraft client={client} opportunityId="one" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save available draft" }),
    );
    await flush();
    view.rerender(<PrepareDeliveryDraft client={client} opportunityId="two" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Save available draft" }),
    );
    await flush();
    await act(async () => {
      old.resolve({ data: [{ id: "draft-one" }] });
    });
    expect(
      screen.getByText("Draft 2 · 3 unresolved inputs"),
    ).toBeInTheDocument();
    expect(
      request.mock.calls.some(
        ([path]) => path === "/v1/delivery-snapshots/draft-one/package",
      ),
    ).toBe(false);
    view.rerender(
      <PrepareDeliveryDraft client={client} opportunityId="three" />,
    );
    expect(
      screen.queryByRole("heading", { name: "Saved proposal draft" }),
    ).not.toBeInTheDocument();
  });
});
