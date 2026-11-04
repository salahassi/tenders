import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import DocumentExtractionReview from "./DocumentExtractionReview";
import {
  BackendRequestError,
  type BackendClient,
  type DocumentExtractionCorrection,
  type DocumentExtractionReviewData,
} from "../lib/backendClient";

const documentId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const pdf = "%PDF-1.7\nSynthetic isolated UI source\n%%EOF";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function data(id = documentId): DocumentExtractionReviewData {
  return {
    document_id: id,
    document_revision: 7,
    original_hash: hash(pdf),
    extraction_hash: "e".repeat(64),
    original_name: "Synthetic.pdf",
    pdf_pages: 2,
    original_download_url: "https://private.example/source",
    original_download_expires_at: new Date(Date.now() + 300000).toISOString(),
    pages: [
      {
        page: 1,
        status: "needs_ocr",
        text: "",
        text_hash: hash(""),
        candidate_text: "Wrong recognition",
        candidate_text_hash: hash("Wrong recognition"),
        requires_review: true,
      },
      {
        page: 2,
        status: "blank",
        text: "",
        text_hash: hash(""),
        requires_review: true,
      },
    ],
    ocr: {
      document_id: id,
      document_revision: 7,
      status: "needs_review",
      successor_id: null,
      error_code: null,
      revision: 1,
      completed_pages: 2,
      total_pages: 2,
      review_pages: [1, 2],
    },
  };
}
function client(value = data()) {
  return {
    documentExtraction: vi.fn(
      async (_id: string, _signal?: AbortSignal) => value,
    ),
    correctDocumentExtraction: vi.fn(
      async (
        _input: DocumentExtractionCorrection,
        _key: string,
        _signal?: AbortSignal,
      ) => ({}),
    ),
    request: vi.fn(async (_path: string, _options?: unknown) => ({ data: {} })),
  };
}
const asClient = (value: ReturnType<typeof client>) =>
  value as unknown as BackendClient;
const confirmation = () =>
  screen.getByLabelText(
    "I compared the entire page with the original and confirmed this text.",
  );
const saveButton = () =>
  screen.getByRole("button", { name: /Save .* reviewed pages/ });
async function loaded() {
  await waitFor(() =>
    expect(screen.getByTitle("Original PDF page 1")).toBeInTheDocument(),
  );
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
    ),
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:synthetic-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requires viewing the verified original and explicit confirmation of the corrected page", async () => {
  const backend = client();
  render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await loaded();
  expect(saveButton()).toBeDisabled();
  expect(screen.getByLabelText("Full text of page 1")).toHaveValue(
    "Wrong recognition",
  );
  fireEvent.change(screen.getByLabelText("Full text of page 1"), {
    target: { value: "يجب على المورد تسليم 12 تقريرا خلال 30 يوما." },
  });
  fireEvent.click(confirmation());
  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(backend.correctDocumentExtraction).toHaveBeenCalledTimes(1),
  );
  expect(backend.correctDocumentExtraction.mock.calls[0][0]).toEqual({
    id: documentId,
    expected_revision: 7,
    expected_original_hash: hash(pdf),
    expected_extraction_hash: "e".repeat(64),
    review_confirmed: true,
    pages: [
      {
        page: 1,
        expected_page_text_hash: hash(""),
        text: "يجب على المورد تسليم 12 تقريرا خلال 30 يوما.",
        blank_confirmed: false,
      },
    ],
  });
  await screen.findByText(/Reviewed pages were saved/);
  expect(saveButton()).toBeDisabled();
});

it("requires blank-page confirmation and batches reviewed pages without losing earlier edits", async () => {
  const backend = client();
  render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await loaded();
  fireEvent.change(screen.getByLabelText("Full text of page 1"), {
    target: { value: "Complete corrected page." },
  });
  fireEvent.click(confirmation());
  fireEvent.change(screen.getByLabelText("Page to review"), {
    target: { value: "2" },
  });
  expect(confirmation()).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      "I checked the original: this page is genuinely blank.",
    ),
  );
  fireEvent.click(confirmation());
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(backend.correctDocumentExtraction).toHaveBeenCalledTimes(1),
  );
  expect(
    (backend.correctDocumentExtraction.mock.calls[0][0] as any).pages,
  ).toEqual([
    {
      page: 1,
      expected_page_text_hash: hash(""),
      text: "Complete corrected page.",
      blank_confirmed: false,
    },
    {
      page: 2,
      expected_page_text_hash: hash(""),
      text: "",
      blank_confirmed: true,
    },
  ]);
});

it("invalidates visual confirmation when the reviewed text changes", async () => {
  render(
    <DocumentExtractionReview
      client={asClient(client())}
      documentId={documentId}
      canEdit
    />,
  );
  await loaded();
  fireEvent.click(confirmation());
  expect(saveButton()).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Full text of page 1"), {
    target: { value: "Changed after review" },
  });
  expect(confirmation()).not.toBeChecked();
  expect(saveButton()).toBeDisabled();
});

it("refuses a mismatched original and does not let confidence or extracted text bypass preview verification", async () => {
  const backend = client({ ...data(), original_hash: "0".repeat(64) });
  render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("original PDF changed");
  expect(confirmation()).toBeDisabled();
  expect(saveButton()).toBeDisabled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(backend.correctDocumentExtraction).not.toHaveBeenCalled();
});

it("retains edits and reuses the same idempotency key after a lost save response", async () => {
  const backend = client();
  backend.correctDocumentExtraction.mockRejectedValueOnce(
    new Error("Connection interrupted"),
  );
  render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await loaded();
  fireEvent.click(confirmation());
  fireEvent.click(saveButton());
  await screen.findByText("Connection interrupted");
  expect(confirmation()).toBeChecked();
  fireEvent.click(saveButton());
  await screen.findByText(/Reviewed pages were saved/);
  expect(backend.correctDocumentExtraction.mock.calls[0][1]).toBe(
    backend.correctDocumentExtraction.mock.calls[1][1],
  );
  expect(backend.correctDocumentExtraction.mock.calls[0][0]).toEqual(
    backend.correctDocumentExtraction.mock.calls[1][0],
  );
});

it("retains a conflicting edit and requires re-review after modification", async () => {
  const backend = client();
  backend.correctDocumentExtraction.mockRejectedValueOnce(
    new BackendRequestError("REVISION_CONFLICT", "Conflict", 409),
  );
  render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await loaded();
  fireEvent.click(confirmation());
  fireEvent.click(saveButton());
  await screen.findByText(/Your edits are still here/);
  expect(screen.getByLabelText("Full text of page 1")).toHaveValue(
    "Wrong recognition",
  );
  fireEvent.change(screen.getByLabelText("Full text of page 1"), {
    target: { value: "Revised page" },
  });
  expect(saveButton()).toBeDisabled();
  fireEvent.click(confirmation());
  fireEvent.click(saveButton());
  await screen.findByText(/Reviewed pages were saved/);
  expect(backend.correctDocumentExtraction.mock.calls[0][1]).not.toBe(
    backend.correctDocumentExtraction.mock.calls[1][1],
  );
});

it("aborts a stale selection, ignores its late response and revokes the local preview on close", async () => {
  const backend = client();
  let finish!: (value: DocumentExtractionReviewData) => void;
  backend.documentExtraction.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  const oldSignal = backend.documentExtraction.mock
    .calls[0][1] as unknown as AbortSignal;
  backend.documentExtraction.mockResolvedValue(data(otherId));
  view.rerender(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={otherId}
      canEdit
    />,
  );
  await loaded();
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    finish({
      ...data(),
      pages: data().pages.map((p) => ({
        ...p,
        candidate_text: "STALE RESULT",
      })),
    }),
  );
  expect(screen.queryByDisplayValue("STALE RESULT")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-preview");
});

it("rejects wrong-document and oversized-original responses and keeps viewers read only", async () => {
  const backend = client(data(otherId));
  const view = render(
    <DocumentExtractionReview
      client={asClient(backend)}
      documentId={documentId}
      canEdit
    />,
  );
  await screen.findByRole("alert");
  expect(fetch).not.toHaveBeenCalled();
  view.unmount();
  const readonly = render(
    <DocumentExtractionReview
      client={asClient(client())}
      documentId={documentId}
      canEdit={false}
    />,
  );
  await loaded();
  expect(confirmation()).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /Save .* reviewed/ }),
  ).not.toBeInTheDocument();
  readonly.unmount();
  vi.mocked(fetch).mockResolvedValue(
    new Response(pdf, { headers: { "Content-Length": "10485761" } }),
  );
  render(
    <DocumentExtractionReview
      client={asClient(client())}
      documentId={documentId}
      canEdit
    />,
  );
  await screen.findByRole("alert");
  expect(saveButton()).toBeDisabled();
});
