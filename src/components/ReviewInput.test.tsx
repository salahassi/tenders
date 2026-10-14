import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReviewInput from "./ReviewInput";
import type { DocumentRecord } from "../types";
import { attachReviewFile } from "../lib/reviewAttachments";
import { downloadLocalFile, getLocalFile } from "../lib/knowledgeFiles";

vi.mock("../lib/reviewAttachments", () => ({
  MAX_REVIEW_ATTACHMENTS: 10,
  REVIEW_ATTACHMENT_ACCEPT:
    ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.xlsx,.pptx",
  attachReviewFile: vi.fn(),
}));
vi.mock("../lib/knowledgeFiles", () => ({
  getLocalFile: vi.fn(),
  downloadLocalFile: vi.fn(),
}));

const record = (name: string, id = name): DocumentRecord => ({
  id,
  name,
  size: 40,
  text: "Recorded file content",
  status: "ready",
  classification: "unspecified",
  uploadedAt: "2026-10-14T10:00:00Z",
  hash: "hash",
});

function Harness({
  onBusyChange = vi.fn(),
  initial = [],
}: {
  onBusyChange?: (busy: boolean) => void;
  initial?: DocumentRecord[];
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState(initial);
  return (
    <ReviewInput
      id="review-answer"
      label="Your answer"
      value={value}
      onChange={setValue}
      attachments={files}
      onAttachmentsChange={setFiles}
      onBusyChange={onBusyChange}
    />
  );
}

describe("text or file review inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLocalFile).mockResolvedValue(new Blob(["original"]));
    vi.mocked(downloadLocalFile).mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("accepts a file-only answer and preserves text entered during extraction", async () => {
    let finish!: (value: DocumentRecord) => void;
    vi.mocked(attachReviewFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const busy = vi.fn();
    render(<Harness onBusyChange={busy} />);
    await userEvent.upload(
      screen.getByLabelText("Attach files to Your answer"),
      new File(["content"], "فريق.txt", { type: "text/plain" }),
    );
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue(
      "",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your answer" }),
      "يرجى اعتماد الفريق المرفق",
    );
    await act(async () => finish(record("فريق.txt")));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue(
      "يرجى اعتماد الفريق المرفق",
    );
    expect(screen.getByText("فريق.txt")).toBeVisible();
    expect(busy).toHaveBeenLastCalledWith(false);
    await userEvent.clear(screen.getByRole("textbox", { name: "Your answer" }));
    expect(screen.getByText("فريق.txt")).toBeVisible();
  });

  it("preserves successful files and typed text when another file fails", async () => {
    vi.mocked(attachReviewFile).mockResolvedValueOnce(record("valid.txt"));
    vi.mocked(attachReviewFile).mockRejectedValueOnce(
      new Error("The file exceeds 10 MiB."),
    );
    render(<Harness />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your answer" }),
      "Existing response",
    );
    await userEvent.upload(
      screen.getByLabelText("Attach files to Your answer"),
      [
        new File(["yes"], "valid.txt", { type: "text/plain" }),
        new File(["no"], "large.pdf", { type: "application/pdf" }),
      ],
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "large.pdf: The file exceeds 10 MiB.",
    );
    expect(screen.getByText("valid.txt")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue(
      "Existing response",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove valid.txt" }),
    );
    expect(screen.queryByText("valid.txt")).not.toBeInTheDocument();
  });

  it("keeps existing attachments downloadable in read-only mode and reports missing originals", async () => {
    vi.mocked(getLocalFile).mockResolvedValueOnce(undefined);
    vi.mocked(downloadLocalFile).mockRejectedValueOnce(
      new Error("The original file is not available in this browser."),
    );
    render(
      <ReviewInput
        id="read"
        label="Section comments"
        value="Saved comments"
        onChange={vi.fn()}
        attachments={[record("plan.pdf")]}
        onAttachmentsChange={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(
      screen.queryByLabelText("Attach files to Section comments"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove plan.pdf" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Original unavailable in this browser/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Download plan.pdf" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The original file is not available in this browser.",
    );
  });

  it("rejects excess attachments before starting extraction", async () => {
    render(
      <Harness
        initial={Array.from({ length: 9 }, (_, index) =>
          record(`file-${index}.txt`),
        )}
      />,
    );
    await userEvent.upload(
      screen.getByLabelText("Attach files to Your answer"),
      [
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File(["two"], "two.txt", { type: "text/plain" }),
      ],
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose 1 or fewer additional files.",
    );
    expect(attachReviewFile).not.toHaveBeenCalled();
    await waitFor(() => expect(getLocalFile).toHaveBeenCalledTimes(9));
  });
});
