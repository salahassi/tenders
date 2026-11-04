import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConnectedExport } from "../lib/useConnectedExport";
import ConnectedExportStatus from "../components/ConnectedExportStatus";
import {
  createConnectedExport,
  retryConnectedExport,
  ExportPackageBlockedError,
} from "../lib/connectedExport";
vi.mock("../lib/connectedExport", async () => ({
  ...(await vi.importActual("../lib/connectedExport")),
  createConnectedExport: vi.fn(),
  retryConnectedExport: vi.fn(),
}));
const client = {} as any,
  completed = vi.fn();
function Harness() {
  const flow = useConnectedExport(client, completed);
  return (
    <>
      <button onClick={() => void flow.start("version", "draft")}>
        Download
      </button>
      <ConnectedExportStatus flow={flow} />
    </>
  );
}
afterEach(() => vi.resetAllMocks());
it("unmount aborts observation and suppresses late download notification while server request remains independent", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(createConnectedExport).mockImplementation(
    async (_c, _v, _m, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal;
        signal?.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      }),
  );
  const view = render(<Harness />);
  fireEvent.click(screen.getByText("Download"));
  expect(
    await screen.findByText(/being prepared and verified on the server/),
  ).toBeInTheDocument();
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {});
  expect(completed).not.toHaveBeenCalled();
  expect(retryConnectedExport).not.toHaveBeenCalled();
});
it("a blocked package offers an explicit retry; rendering the status cannot start a fresh deadline", async () => {
  const saved = {
    id: "package",
    revision: 4,
    proposal_version_id: "version",
    mode: "draft",
    status: "blocked",
    job: { error_code: "TIMEOUT" },
  } as any;
  vi.mocked(createConnectedExport).mockRejectedValue(
    new ExportPackageBlockedError(saved),
  );
  vi.mocked(retryConnectedExport).mockResolvedValue([]);
  render(<Harness />);
  fireEvent.click(screen.getByText("Download"));
  const retry = await screen.findByRole("button", {
    name: "Retry export preparation",
  });
  expect(retryConnectedExport).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await act(async () => {});
  expect(retryConnectedExport).toHaveBeenCalledWith(
    client,
    saved,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(completed).toHaveBeenCalledOnce();
});
