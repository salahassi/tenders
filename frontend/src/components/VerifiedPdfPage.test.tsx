import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VerifiedPdfPage from "./VerifiedPdfPage";
const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  render: vi.fn(),
  destroy: vi.fn(async () => {}),
  cancel: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: mocks.getDocument,
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/synthetic-worker.mjs",
}));
const bytes = new ArrayBuffer(4);
beforeEach(() => {
  mocks.render.mockReturnValue({
    promise: Promise.resolve(),
    cancel: mocks.cancel,
  });
  mocks.getDocument.mockReturnValue({
    destroy: mocks.destroy,
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: mocks.render,
      }),
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("permits review only after the actual render promise and destroys its worker on close", async () => {
  let finish!: () => void;
  mocks.render.mockReturnValue({
    promise: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel: mocks.cancel,
  });
  const onReady = vi.fn();
  const view = render(
    <VerifiedPdfPage
      bytes={bytes}
      page={1}
      title="Original page"
      language="en"
      onReady={onReady}
    />,
  );
  await waitFor(() => expect(mocks.render).toHaveBeenCalled());
  expect(onReady).toHaveBeenLastCalledWith(null);
  expect(screen.getByTitle("Original page")).not.toBeVisible();
  await act(async () => finish());
  expect(onReady).toHaveBeenLastCalledWith(1);
  expect(screen.getByTitle("Original page")).toBeVisible();
  view.unmount();
  expect(mocks.destroy).toHaveBeenCalled();
});
it("does not confirm a failed original page render", async () => {
  mocks.render.mockReturnValue({
    promise: Promise.reject(new Error("Cannot decode image")),
    cancel: mocks.cancel,
  });
  const onReady = vi.fn();
  render(
    <VerifiedPdfPage
      bytes={bytes}
      page={1}
      title="Original page"
      language="ar"
      onReady={onReady}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("تعذر عرض الصفحة");
  expect(onReady).not.toHaveBeenCalledWith(1);
  expect(screen.getByTitle("Original page")).not.toBeVisible();
});
it("ignores an old page finishing after the selected page changed", async () => {
  let finish!: () => void;
  mocks.render.mockReturnValueOnce({
    promise: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel: mocks.cancel,
  });
  const onReady = vi.fn();
  const view = render(
    <VerifiedPdfPage
      bytes={bytes}
      page={1}
      title="Original page1"
      language="en"
      onReady={onReady}
    />,
  );
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  view.rerender(
    <VerifiedPdfPage
      bytes={bytes}
      page={2}
      title="Original page2"
      language="en"
      onReady={onReady}
    />,
  );
  await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(2));
  await act(async () => finish());
  expect(onReady).not.toHaveBeenCalledWith(1);
  expect(onReady).toHaveBeenLastCalledWith(2);
});
it("bounds a stalled render and does not confirm it after timeout", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  mocks.render.mockReturnValue({
    promise: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel: mocks.cancel,
  });
  const onReady = vi.fn();
  render(
    <VerifiedPdfPage
      bytes={bytes}
      page={1}
      title="Original page"
      language="en"
      onReady={onReady}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.render).toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(mocks.destroy).toHaveBeenCalled();
  await act(async () => finish());
  expect(onReady).not.toHaveBeenCalledWith(1);
});
