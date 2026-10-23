// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  fetchOcrDocument,
  parseTesseractTsv,
  processNoticeOcrRequest,
  publicImageDimensions,
  readPublicDocumentOcr,
  validateOcrRequest,
  runNoticeOcrWorker,
} from "../../scripts/backend/public-notice-ocr-worker";

const bytes = Buffer.from("%PDF-synthetic bounded public evidence");
const request = {
  id: "synthetic-request",
  url: "https://public.example.test/notice.pdf",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  mime: "application/pdf",
  pages: [1, 2],
  total_pages: 2,
  approved_hosts: ["public.example.test"],
  workspace_id: "synthetic-workspace",
  lease_token: "synthetic-lease",
};
it("runs OCR claims and completions independently, without browser actions", async () => {
  const gateway = vi.fn(async (action: string) =>
    action === "ocr_claim" &&
    gateway.mock.calls.filter(([name]) => name === "ocr_claim").length === 1
      ? request
      : null,
  );
  const read = vi.fn(async () => ({
    sha256: request.sha256,
    engine: "tesseract",
    languages: ["ara", "eng"],
    pages: [
      {
        page: 1,
        text: "Synthetic readable public notice text.",
        confidence: 90,
      },
    ],
  }));
  expect(
    await runNoticeOcrWorker(gateway, (g) => processNoticeOcrRequest(g, read)),
  ).toBe(1);
  expect(gateway.mock.calls.map(([action]) => action)).toEqual([
    "ocr_claim",
    "ocr_complete",
    "ocr_claim",
  ]);
  expect(read).toHaveBeenCalledWith(request);
});
it("bounds an OCR run by request count and its own elapsed time", async () => {
  const gateway = vi.fn();
  const process = vi.fn(async () => true);
  expect(await runNoticeOcrWorker(gateway, process, () => 0)).toBe(10);
  let elapsed = 0;
  const slow = vi.fn(async () => {
    elapsed += 3 * 60 * 1000;
    return true;
  });
  expect(await runNoticeOcrWorker(gateway, slow, () => elapsed)).toBe(3);
});
it("accepts only the exact public bytes and checks every redirect destination before fetching", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
  const lookup = vi.fn(async () => ["8.8.8.8"]);
  expect(await fetchOcrDocument(request, fetcher, lookup)).toEqual(bytes);
  expect(lookup).toHaveBeenCalledWith("public.example.test");
  const changed = vi.fn<typeof fetch>(
    async () => new Response("changed evidence"),
  );
  await expect(fetchOcrDocument(request, changed, lookup)).rejects.toThrow(
    "SOURCE_CONTENT_CHANGED",
  );
  const redirect = vi.fn<typeof fetch>(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://internal.example.test/secrets" },
      }),
  );
  await expect(fetchOcrDocument(request, redirect, lookup)).rejects.toThrow(
    "UNSAFE_DESTINATION",
  );
  expect(redirect).toHaveBeenCalledTimes(1);
  await expect(
    fetchOcrDocument(request, fetcher, async () => ["127.0.0.1"]),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds content length and streamed bytes even without an honest response length", async () => {
  const large = vi.fn<typeof fetch>(
    async () =>
      new Response("small", {
        headers: { "content-length": String(6 * 1024 * 1024) },
      }),
  );
  await expect(
    fetchOcrDocument(request, large, async () => ["8.8.8.8"]),
  ).rejects.toThrow("SOURCE_TOO_LARGE");
  const stream = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1)),
  );
  await expect(
    fetchOcrDocument(request, stream, async () => ["8.8.8.8"]),
  ).rejects.toThrow("SOURCE_TOO_LARGE");
});

it("validates page and media limits before native parsing and independently rechecks the hash", async () => {
  for (const invalid of [
    { ...request, pages: [0] },
    { ...request, pages: [1, 1] },
    { ...request, pages: [3] },
    { ...request, total_pages: 101 },
    {
      ...request,
      pages: Array.from({ length: 11 }, (_, i) => i + 1),
      total_pages: 11,
    },
    { ...request, mime: "text/html" },
    { ...request, mime: "image/png" },
  ])
    expect(() => validateOcrRequest(invalid)).toThrow("NOTICE_OCR_FAILED");
  await expect(
    readPublicDocumentOcr(request, async () => Buffer.from("changed")),
  ).rejects.toThrow("SOURCE_CONTENT_CHANGED");
  const html = Buffer.from("<html>challenge is not a PDF</html>");
  await expect(
    readPublicDocumentOcr(
      { ...request, sha256: createHash("sha256").update(html).digest("hex") },
      async () => html,
    ),
  ).rejects.toThrow("NOTICE_OCR_FAILED");
});

it("retains OCR lines and measured confidence while ignoring invalid layout and confidence rows", () => {
  const header =
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const tsv = [
    header,
    "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t",
    "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tSynthetic",
    "5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t70\tnotice",
    "5\t1\t1\t1\t2\t1\t0\t0\t10\t10\t80\tعطاء",
    "5\t1\t1\t1\t2\t2\t0\t0\t10\t10\t999\tinvalid",
  ].join("\n");
  const page = parseTesseractTsv(tsv, 2);
  expect(page).toEqual({
    page: 2,
    text: "Synthetic notice\nعطاء",
    confidence: 82,
  });
  expect(parseTesseractTsv(header, 1)).toEqual({
    page: 1,
    text: "",
    confidence: 0,
  });
});

it("reads image dimensions before OCR so compressed image bombs can be rejected", () => {
  const png = Buffer.alloc(24);
  png.write("PNG", 1);
  png.writeUInt32BE(2000, 16);
  png.writeUInt32BE(3000, 20);
  expect(publicImageDimensions(png)).toEqual([2000, 3000]);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("VP8X", 12);
  webp.writeUIntLE(1499, 24, 3);
  webp.writeUIntLE(2499, 27, 3);
  expect(publicImageDimensions(webp)).toEqual([1500, 2500]);
  expect(() =>
    publicImageDimensions(Buffer.from("unrecognized image")),
  ).toThrow("NOTICE_OCR_FAILED");
});

it("completes the exact claimed lease with public OCR provenance and records safe failures", async () => {
  const gateway = vi.fn(async (action: string) =>
    action === "ocr_claim" ? request : null,
  );
  const result = {
    sha256: request.sha256,
    pages: [
      {
        page: 1,
        text: "Synthetic public notice text with enough useful detail",
        confidence: 88,
      },
      { page: 2, text: "", confidence: 0 },
    ],
    engine: "tesseract",
    languages: ["ara", "eng"],
  };
  expect(await processNoticeOcrRequest(gateway, async () => result)).toBe(true);
  expect(gateway).toHaveBeenLastCalledWith("ocr_complete", {
    request_id: request.id,
    lease: request.lease_token,
    result,
    error_code: null,
  });
  await processNoticeOcrRequest(gateway, async () => {
    throw Error("private runtime diagnostic");
  });
  expect(gateway).toHaveBeenLastCalledWith("ocr_complete", {
    request_id: request.id,
    lease: request.lease_token,
    result: null,
    error_code: "NOTICE_OCR_FAILED",
  });
  expect(await processNoticeOcrRequest(async () => null)).toBe(false);
});
