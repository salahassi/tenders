import { verifyBoundedDocxAsync } from "./boundedDocx.ts";
import { blockedContent } from "./contentPolicy.ts";
import { AppError } from "./http.ts";
import {
  DOCX_CONTENT_ERRORS,
  docxDigest,
  readVerificationFrame,
} from "./deliveryVerifyProtocol.ts";
const runtime = (
  globalThis as unknown as {
    Deno: {
      stdin: { readable: ReadableStream<Uint8Array> };
      stdout: { write(bytes: Uint8Array): Promise<number> };
      exit(code: number): never;
    };
  }
).Deno;
async function respond(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  while (offset < bytes.length)
    offset += await runtime.stdout.write(bytes.subarray(offset));
}
try {
  const { model, bytes } = await readVerificationFrame(runtime.stdin.readable);
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(model),
  );
  await verifyBoundedDocxAsync(bytes, parsed, blockedContent);
  await respond({
    version: 1,
    verified: true,
    model_hash: await docxDigest(model),
    document_hash: await docxDigest(bytes),
    size: bytes.length,
  });
} catch (error) {
  if (
    error instanceof AppError &&
    ((error.status === 422 && DOCX_CONTENT_ERRORS.has(error.code)) ||
      (error.status === 413 && error.code === "FILE_SIZE_INVALID"))
  )
    await respond({ version: 1, code: error.code, status: error.status });
  runtime.exit(1);
}
