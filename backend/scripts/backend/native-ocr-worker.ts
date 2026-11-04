import { pathToFileURL } from "node:url";
import { actionsGateway, type NativeGateway } from "./native-worker-gateway.ts";
import { processNoticeOcrRequest } from "./public-notice-ocr-worker.ts";
import { processUploadedDocumentOcr } from "./uploaded-document-ocr-worker.ts";

/** The existing native OCR CronJob serves both durable queues fairly. Each
 * family gets one bounded attempt per round; an empty/failing family does not
 * consume the other family's opportunity, and no unbounded drain is started. */
export async function runNativeOcrWorker(
  gateway: NativeGateway,
  uploaded = processUploadedDocumentOcr,
  notice = processNoticeOcrRequest,
  now = Date.now,
) {
  const deadline = now() + 9 * 60 * 1000;
  let processed = 0;
  for (let round = 0; round < 10 && now() < deadline; round++) {
    let found = false;
    for (const [read, maximumAttemptMs] of [
      [uploaded, 225000],
      [notice, 240000],
    ] as const) {
      // Include gateway timeouts and worst-case OIDC renewal for every call,
      // as well as the native per-attempt deadline.
      // Never start a task whose whole bounded attempt cannot fit this run.
      if (deadline - now() < maximumAttemptMs) continue;
      try {
        if (await read(gateway)) {
          processed++;
          found = true;
        }
      } catch {
        console.error("A native OCR queue attempt remains pending.");
      }
    }
    if (!found) break;
  }
  return processed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runNativeOcrWorker(actionsGateway()).catch(() => {
    console.error("Native OCR worker did not complete.");
    process.exitCode = 1;
  });
