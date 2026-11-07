import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import JobDetails from "./JobDetails";
const { request, backend } = vi.hoisted(() => {
  const request = vi.fn();
  return { request, backend: { request } };
});
vi.mock("../lib/store", () => ({ useApp: () => ({ backend }) }));
vi.mock("../lib/deployment", () => ({ deployment: {} }));
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { request.mockReset(); });

it("does not read a full job until opened; failures wait for an explicit retry", async () => {
  request
    .mockRejectedValueOnce(new Error("Request unavailable"))
    .mockResolvedValueOnce({
      data: {
        id,
        checkpoint: {
          model_routing: {
            checks: [{ provider: "qwencloud", code: "PROVIDER_QUOTA_WAIT" }],
          },
        },
      },
    });
  const { rerender } = render(<JobDetails id={id} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show task details" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Request unavailable",
  );
  rerender(<JobDetails id={id} />);
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry details" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("QwenCloud"),
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][0]).toBe(`/v1/jobs/${id}`);
});

it("aborts an open detail read on unmount and ignores the late response", async () => {
  let resolve!: (value: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { unmount } = render(<JobDetails id={id} />);
  fireEvent.click(screen.getByRole("button", { name: "Show task details" }));
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  resolve({ data: { id, checkpoint: {} } });
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
});
