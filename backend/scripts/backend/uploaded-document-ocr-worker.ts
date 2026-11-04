import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTesseractTsv } from "./public-notice-ocr-worker.ts";
import { actionsGateway, type NativeGateway } from "./native-worker-gateway.ts";

const run = promisify(execFile);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export interface UploadedPdfPageRequest {
  original_hash: string;
  total_pages: number;
  page: number;
  language: "ar" | "en" | "auto";
}
export interface UploadedOcrPage {
  page: number;
  text: string;
  confidence: number;
  image_hash: string;
  text_hash: string;
  engine: "tesseract";
  engine_version: string;
  languages: ["ara", "eng"];
  numeric_uncertainty: boolean;
  recognition_uncertainty: boolean;
}

/** An offline page attempt uses the existing admitted-original bounds (10 MiB,
 * 200 PDF pages), a <=2000px raster and one native thread. Confidence is a
 * recognition signal, never proof that a requirement/date/amount is correct. */
export async function readUploadedPdfPage(
  bytes: Buffer,
  request: UploadedPdfPageRequest,
): Promise<UploadedOcrPage> {
  if (
    bytes.length < 5 ||
    bytes.length > 10485760 ||
    bytes.subarray(0, 5).toString() !== "%PDF-" ||
    !/^[a-f0-9]{64}$/.test(request.original_hash) ||
    !Number.isInteger(request.total_pages) ||
    request.total_pages < 1 ||
    request.total_pages > 200 ||
    !Number.isInteger(request.page) ||
    request.page < 1 ||
    request.page > request.total_pages ||
    !["ar", "en", "auto"].includes(request.language)
  )
    throw Error("DOCUMENT_OCR_CAPACITY");
  if (hash(bytes) !== request.original_hash)
    throw Error("DOCUMENT_OCR_SOURCE_CHANGED");
  const deadline = Date.now() + 90000;
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "tenderdesk-uploaded-ocr-"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOSPC", "EDQUOT"].includes(String(error.code))
    )
      throw Error("DOCUMENT_OCR_CAPACITY");
    throw Error("DOCUMENT_OCR_FAILED");
  }
  const command = async (name: string, args: string[], cap: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("DOCUMENT_OCR_TIMEOUT");
    try {
      return await run(name, args, {
        timeout: Math.min(cap, remaining),
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        // Native PDF/OCR subprocesses do not inherit gateway or cloud secrets.
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          LANG: "C.UTF-8",
          OMP_THREAD_LIMIT: "1",
        },
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (("code" in error &&
          ["ENOSPC", "EDQUOT"].includes(String(error.code))) ||
          ("stderr" in error &&
            /No space left on device|Disk quota exceeded/i.test(
              String(error.stderr),
            )))
      )
        throw Error("DOCUMENT_OCR_CAPACITY");
      if (
        error &&
        typeof error === "object" &&
        "killed" in error &&
        error.killed
      )
        throw Error("DOCUMENT_OCR_TIMEOUT");
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      )
        throw Error("DOCUMENT_OCR_CAPACITY");
      throw Error("DOCUMENT_OCR_FAILED");
    }
  };
  try {
    const input = join(directory, "original.pdf");
    await writeFile(input, bytes, { mode: 0o600 });
    const info = await command("pdfinfo", [input], 10000);
    if (/^Encrypted:\s+yes/m.test(info.stdout))
      throw Error("DOCUMENT_OCR_RESTRICTED");
    if (
      Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]) !== request.total_pages
    )
      throw Error("DOCUMENT_OCR_SOURCE_CHANGED");
    const version = await command("tesseract", ["--version"], 5000);
    const engine_version = /^tesseract\s+([0-9]+(?:\.[0-9]+){1,3})/m.exec(
      version.stdout,
    )?.[1];
    if (!engine_version) throw Error("DOCUMENT_OCR_FAILED");
    const languages = await command("tesseract", ["--list-langs"], 5000);
    if (
      !/^ara\s*$/m.test(languages.stdout) ||
      !/^eng\s*$/m.test(languages.stdout)
    )
      throw Error("DOCUMENT_OCR_FAILED");
    const prefix = join(directory, "page");
    await command(
      "pdftoppm",
      [
        "-f",
        String(request.page),
        "-l",
        String(request.page),
        "-scale-to",
        "2000",
        "-png",
        "-singlefile",
        input,
        prefix,
      ],
      25000,
    );
    const image = await readFile(prefix + ".png");
    if (
      image.length < 24 ||
      image.length > 20 * 1024 * 1024 ||
      image.readUInt32BE(16) > 2000 ||
      image.readUInt32BE(20) > 2000
    )
      throw Error("DOCUMENT_OCR_CAPACITY");
    const result = await command(
      "tesseract",
      [
        prefix + ".png",
        "stdout",
        "-l",
        "ara+eng",
        "--psm",
        "3",
        "-c",
        "tessedit_create_tsv=1",
      ],
      30000,
    );
    const page = parseTesseractTsv(result.stdout, request.page);
    // Any low-confidence recognized numeric token requires source review; no
    // zero/default, digit substitution or date normalization is manufactured.
    const numeric_uncertainty = result.stdout
      .split(/\r?\n/)
      .slice(1)
      .some((line) => {
        const columns = line.split("\t");
        const text = columns.slice(11).join("\t");
        return (
          columns[0] === "5" &&
          /[0-9\u0660-\u0669\u06f0-\u06f9]/u.test(text) &&
          (!Number.isFinite(Number(columns[10])) || Number(columns[10]) < 85)
        );
      });
    // The frozen clean-Arabic acceptance failed at confidence 82 with no numeric
    // uncertainty. Preserve its candidate for page transcription; this engine
    // is not qualified to promote Arabic output to readable source evidence.
    const text = page.text.trim();
    return {
      page: request.page,
      text,
      confidence: page.confidence,
      image_hash: hash(image),
      text_hash: hash(text),
      engine: "tesseract",
      engine_version,
      languages: ["ara", "eng"],
      numeric_uncertainty,
      recognition_uncertainty:
        request.language === "ar" || /[\u0600-\u06ff]/u.test(text),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOSPC", "EDQUOT"].includes(String(error.code))
    )
      throw Error("DOCUMENT_OCR_CAPACITY");
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function processUploadedDocumentOcr(
  gateway: NativeGateway,
  read = readUploadedPdfPage,
) {
  const task = await gateway("uploaded_ocr_claim", {});
  if (!task) return false;
  const identity = { request_id: task.request_id, lease: task.lease };
  if (task.action === "publish") {
    await gateway("uploaded_ocr_publish", identity);
    return true;
  }
  let result: UploadedOcrPage | null = null;
  let error_code: string | null = null;
  try {
    const input = await gateway("uploaded_ocr_input", identity);
    if (typeof input.bytes !== "string" || input.bytes.length > 13981016)
      throw Error("DOCUMENT_OCR_CAPACITY");
    const bytes = Buffer.from(input.bytes, "base64");
    result = await read(bytes, task);
  } catch (failure) {
    const code = failure instanceof Error ? failure.message : "";
    error_code = [
      "DOCUMENT_OCR_TIMEOUT",
      "DOCUMENT_OCR_CAPACITY",
      "DOCUMENT_OCR_SOURCE_CHANGED",
      "DOCUMENT_OCR_RESTRICTED",
      "DOCUMENT_OCR_STORAGE_UNAVAILABLE",
    ].includes(code)
      ? code
      : "DOCUMENT_OCR_FAILED";
  }
  await gateway("uploaded_ocr_complete", { ...identity, result, error_code });
  // No source text, object key, customer filename or credential enters logs.
  console.log(
    JSON.stringify({
      kind: "uploaded_document_ocr",
      outcome:
        error_code ||
        (result!.text.length > 0 &&
        result!.confidence >= 70 &&
        !result!.numeric_uncertainty &&
        !result!.recognition_uncertainty
          ? "page_saved"
          : "review_required"),
    }),
  );
  return true;
}

export async function runUploadedDocumentOcrWorker(
  gateway: NativeGateway,
  now = Date.now,
) {
  const started = now();
  let processed = 0;
  while (processed < 10 && now() - started <= 9 * 60 * 1000 - 225000) {
    if (!(await processUploadedDocumentOcr(gateway))) break;
    processed++;
  }
  return processed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runUploadedDocumentOcrWorker(actionsGateway()).catch(() => {
    console.error("Uploaded OCR worker did not complete this attempt.");
    process.exitCode = 1;
  });
