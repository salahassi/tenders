import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import SourceVerification from "./SourceVerification";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("sends the human-entered answer bound to the displayed live challenge", async () => {
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    backend: {
      request: vi.fn(async () => ({
        data: {
          id: "request",
          challenge_id: "challenge",
          image: "data:image/png;base64,AAAA",
          expires_at: "2026-10-22T18:00:00Z",
          url: "https://source.test",
        },
      })),
    },
    runCommand,
    notify: vi.fn(),
  } as any);
  render(<SourceVerification sourceId="source" revision={3} />);
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Verification code" }),
    "ABCDE",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and continue" }),
  );
  expect(runCommand).toHaveBeenCalledWith("source.verification.answer", {
    id: "request",
    challenge_id: "challenge",
    answer: "ABCDE",
  });
  expect(
    screen.getByRole("button", { name: "Waiting for verification result" }),
  ).toBeDisabled();
});
it("requests another collection when the previous challenge has expired", async () => {
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    backend: { request: vi.fn(async () => ({ data: null })) },
    runCommand,
    notify: vi.fn(),
  } as any);
  render(<SourceVerification sourceId="source" revision={3} needsRetry />);
  await userEvent.click(
    screen.getByRole("button", { name: "Request a new verification" }),
  );
  expect(runCommand).toHaveBeenCalledWith("source.collect", {
    id: "source",
    expected_revision: 3,
  });
});
