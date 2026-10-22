import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { publicAddress } from "../../supabase/functions/_shared/collector.ts";

const run = promisify(execFile);
const MAX_BYTES = 5 * 1024 * 1024;
type OcrRequest = {
  id: string;
  url: string;
  sha256: string;
  mime: string;
  pages: number[];
  total_pages: number;
  approved_hosts: string[];
  workspace_id: string;
  lease_token: string;
};
type OcrPage = { page: number; text: string; confidence: number };
type Gateway = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<any>;

/** Connect only to the resolved public IPv4, retaining hostname TLS verification. */
export async function pinnedPublicGet(
  url: URL,
  address: string,
  signal: AbortSignal,
) {
  let agent: HttpsAgent | undefined;
  const proxyValue = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    if (!["http:", "https:"].includes(proxy.protocol))
      throw Error("NOTICE_OCR_FAILED");
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connect = (
        proxy.protocol === "https:" ? httpsRequest : httpRequest
      )({
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${address}:443`,
        headers: {
          Host: `${url.hostname}:443`,
          ...(proxy.username || proxy.password
            ? {
                "Proxy-Authorization":
                  "Basic " +
                  Buffer.from(
                    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
                  ).toString("base64"),
              }
            : {}),
        },
        signal,
      });
      connect.once("connect", (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(Error("NOTICE_OCR_FAILED"));
          return;
        }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      connect.once("error", reject);
      connect.end();
    });
    agent = new HttpsAgent({ keepAlive: false });
    agent.createConnection = () =>
      tlsConnect({
        socket,
        servername: url.hostname,
        rejectUnauthorized: true,
      });
  }
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent: agent || false,
        signal,
        family: 4,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
        headers: { "User-Agent": "TenderDesk public notice OCR reader" },
      },
      (incoming) => {
        incoming.once("close", () => agent?.destroy());
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: incoming.statusCode || 502,
            headers,
          }),
        );
      },
    );
    request.once("error", (error) => {
      agent?.destroy();
      reject(error);
    });
    request.end();
  });
}

export async function fetchOcrDocument(
  request: Pick<OcrRequest, "url" | "sha256" | "approved_hosts">,
  fetcher?: typeof fetch,
  lookup: (host: string) => Promise<string[]> = resolve4,
  deadline = Date.now() + 45000,
) {
  const remaining = Math.min(45000, deadline - Date.now());
  if (remaining <= 0) throw Error("SOURCE_TIMEOUT");
  const signal = AbortSignal.timeout(remaining);
  const abort = new Promise<never>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(Error("SOURCE_TIMEOUT")), {
      once: true,
    }),
  );
  let target = request.url;
  for (let hop = 0; hop <= 3; hop++) {
    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !request.approved_hosts.includes(url.hostname)
    )
      throw Error("UNSAFE_DESTINATION");
    const addresses = await Promise.race([lookup(url.hostname), abort]);
    if (
      !addresses.length ||
      addresses.some((address) => !publicAddress(address))
    )
      throw Error("UNSAFE_DESTINATION");
    const response = await Promise.race([
      fetcher
        ? fetcher(url.href, {
            redirect: "manual",
            headers: { "User-Agent": "TenderDesk public notice OCR reader" },
            signal,
          })
        : pinnedPublicGet(url, addresses[0], signal),
      abort,
    ]);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 3) throw Error("UNSAFE_DESTINATION");
      target = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw Error("NOTICE_OCR_FAILED");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw Error("SOURCE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("NOTICE_OCR_FAILED");
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), abort]);
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw Error("SOURCE_TOO_LARGE");
      }
      parts.push(value);
    }
    const bytes = Buffer.concat(parts);
    if (createHash("sha256").update(bytes).digest("hex") !== request.sha256)
      throw Error("SOURCE_CONTENT_CHANGED");
    return bytes;
  }
  throw Error("UNSAFE_DESTINATION");
}

export function parseTesseractTsv(tsv: string, page: number): OcrPage {
  const lines = new Map<string, string[]>();
  let weightedConfidence = 0;
  let characters = 0;
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const confidence = Number(columns[10]);
    const word = columns.slice(11).join("\t").trim();
    if (
      !word ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    )
      continue;
    const key = columns.slice(1, 5).join(":");
    const words = lines.get(key) || [];
    words.push(word);
    lines.set(key, words);
    weightedConfidence += confidence * word.length;
    characters += word.length;
  }
  const text = [...lines.values()].map((words) => words.join(" ")).join("\n");
  if (text.length > 20000) throw Error("SOURCE_TOO_LARGE");
  return {
    page,
    text,
    confidence: characters ? Math.round(weightedConfidence / characters) : 0,
  };
}

export function validateOcrRequest(request: OcrRequest) {
  if (
    !/^[a-f0-9]{64}$/.test(request.sha256) ||
    !Number.isInteger(request.total_pages) ||
    request.total_pages < 1 ||
    request.total_pages > 100 ||
    !Array.isArray(request.pages) ||
    request.pages.length < 1 ||
    request.pages.length > 10 ||
    new Set(request.pages).size !== request.pages.length ||
    request.pages.some(
      (page) =>
        !Number.isInteger(page) || page < 1 || page > request.total_pages,
    ) ||
    !["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(
      request.mime,
    ) ||
    (request.mime !== "application/pdf" &&
      (request.total_pages !== 1 || request.pages[0] !== 1))
  )
    throw Error("NOTICE_OCR_FAILED");
}

export function publicImageDimensions(bytes: Buffer): [number, number] {
  if (bytes.length >= 24 && bytes.subarray(1, 4).toString() === "PNG")
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString() === "RIFF") {
    const format = bytes.subarray(12, 16).toString();
    if (format === "VP8X")
      return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    if (format === "VP8 ")
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (format === "VP8L" && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      if (length < 2) break;
      offset += length + 2;
    }
  }
  throw Error("NOTICE_OCR_FAILED");
}

/** Native OCR runs only on a bounded, hash-verified public attachment. */
export async function readPublicDocumentOcr(
  request: OcrRequest,
  download = fetchOcrDocument,
) {
  validateOcrRequest(request);
  const deadline = Date.now() + 150000;
  const bytes = await download(request, undefined, undefined, deadline);
  if (bytes.length > MAX_BYTES) throw Error("SOURCE_TOO_LARGE");
  if (createHash("sha256").update(bytes).digest("hex") !== request.sha256)
    throw Error("SOURCE_CONTENT_CHANGED");
  const isPdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const isPng = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isWebp =
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP";
  if (
    (request.mime === "application/pdf" && !isPdf) ||
    (request.mime === "image/png" && !isPng) ||
    (request.mime === "image/jpeg" && !isJpeg) ||
    (request.mime === "image/webp" && !isWebp)
  )
    throw Error("NOTICE_OCR_FAILED");
  if (!isPdf) {
    const [width, height] = publicImageDimensions(bytes);
    if (
      width < 1 ||
      height < 1 ||
      width > 10000 ||
      height > 10000 ||
      width * height > 40000000
    )
      throw Error("SOURCE_TOO_LARGE");
  }
  const directory = await mkdtemp(join(tmpdir(), "tenderdesk-public-ocr-"));
  const command = async (name: string, args: string[], cap = 30000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("SOURCE_TIMEOUT");
    return await run(name, args, {
      timeout: Math.min(cap, remaining),
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
  };
  try {
    const input = join(directory, isPdf ? "document.pdf" : "document.image");
    await writeFile(input, bytes);
    if (isPdf) {
      const { stdout } = await command("pdfinfo", [input], 10000);
      if (Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]) !== request.total_pages)
        throw Error("SOURCE_CONTENT_CHANGED");
      if (/^Encrypted:\s+yes/m.test(stdout))
        throw Error("SOURCE_DOCUMENT_RESTRICTED");
    }
    const pages: OcrPage[] = [];
    for (const page of request.pages) {
      let image = input;
      if (isPdf) {
        const prefix = join(directory, "page-" + page);
        await command(
          "pdftoppm",
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-scale-to",
            "2000",
            "-png",
            "-singlefile",
            input,
            prefix,
          ],
          25000,
        );
        image = prefix + ".png";
      }
      const { stdout } = await command("tesseract", [
        image,
        "stdout",
        "-l",
        "ara+eng",
        "--psm",
        "3",
        "-c",
        "tessedit_create_tsv=1",
      ]);
      pages.push(parseTesseractTsv(stdout, page));
      if (pages.reduce((total, item) => total + item.text.length, 0) > 60000)
        throw Error("SOURCE_TOO_LARGE");
    }
    if (!pages.some((page) => page.text.length >= 30 && page.confidence >= 50))
      throw Error("NOTICE_OCR_LOW_CONFIDENCE");
    return {
      sha256: request.sha256,
      pages,
      engine: "tesseract",
      languages: ["ara", "eng"],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function processNoticeOcrRequest(
  gateway: Gateway,
  read = readPublicDocumentOcr,
) {
  const request: OcrRequest | null = await gateway("ocr_claim", {});
  if (!request) return false;
  let result: Awaited<ReturnType<typeof readPublicDocumentOcr>> | null = null;
  let error_code: string | null = null;
  try {
    result = await read(request);
  } catch (error) {
    const name = error instanceof Error ? error.message : "";
    error_code = [
      "NOTICE_OCR_LOW_CONFIDENCE",
      "SOURCE_TOO_LARGE",
      "UNSAFE_DESTINATION",
      "SOURCE_CONTENT_CHANGED",
      "SOURCE_DOCUMENT_RESTRICTED",
      "SOURCE_TIMEOUT",
    ].includes(name)
      ? name
      : error instanceof Error &&
          (error.name === "TimeoutError" ||
            ("killed" in error && error.killed === true))
        ? "SOURCE_TIMEOUT"
        : "NOTICE_OCR_FAILED";
  }
  await gateway("ocr_complete", {
    request_id: request.id,
    lease: request.lease_token,
    result,
    error_code,
  });
  console.log(
    JSON.stringify({
      host: new URL(request.url).hostname,
      outcome: error_code || "ocr_ready",
    }),
  );
  return true;
}
