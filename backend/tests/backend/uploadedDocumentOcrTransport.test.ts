// @vitest-environment node
import { expect, it, vi } from "vitest";
import { runNativeOcrWorker } from "../../scripts/backend/native-ocr-worker.ts";
import { processUploadedDocumentOcr } from "../../scripts/backend/uploaded-document-ocr-worker.ts";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway.ts";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
const id = "00000000-0000-4000-8000-000000000001",
  lease = "00000000-0000-4000-8000-000000000002";
const env: BackendEnvironment = {
  url: "https://db.example.test",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-service",
  workerSecret: "synthetic-worker",
  nativeWorkerSecret: "synthetic-native-secret-at-least-32-characters",
  allowedOrigins: ["https://app.example.test"],
  models: modelEnvironments(() => undefined),
};
it("fair native drain gives both continuously busy queues service and fits each whole attempt in the 9-minute budget", async () => {
  let time = 0;
  const order: string[] = [];
  const gateway = vi.fn();
  const uploaded = async () => {
    order.push("uploaded");
    time += 180000;
    return true;
  };
  const publicNotice = async () => {
    order.push("notice");
    time += 210000;
    return true;
  };
  expect(
    await runNativeOcrWorker(gateway, uploaded, publicNotice, () => time),
  ).toBe(2);
  expect(order).toEqual(["uploaded", "notice"]);
  expect(time).toBe(390000);
});
it("a failed or empty uploaded queue does not starve the public queue, and fast drains are bounded", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const notice = vi.fn(async () => true);
  const failed = vi.fn(async () => {
    throw Error("synthetic");
  });
  expect(await runNativeOcrWorker(vi.fn(), failed, notice, () => 0)).toBe(10);
  expect(notice).toHaveBeenCalledTimes(10);
  expect(failed).toHaveBeenCalledTimes(10);
  log.mockRestore();
  const empty = vi.fn(async () => false);
  expect(await runNativeOcrWorker(vi.fn(), empty, empty, () => 0)).toBe(0);
  expect(empty).toHaveBeenCalledTimes(2);
});
it("native page timeout returns a durable typed retry receipt without claiming invalid source", async () => {
  const gateway = vi.fn(async (action: string) =>
    action === "uploaded_ocr_claim"
      ? { request_id: id, lease, action: "page" }
      : action === "uploaded_ocr_input"
        ? { bytes: Buffer.from("%PDF-synthetic").toString("base64") }
        : null,
  );
  const read = vi.fn(async () => {
    throw Error("DOCUMENT_OCR_TIMEOUT");
  });
  expect(await processUploadedDocumentOcr(gateway, read)).toBe(true);
  expect(gateway).toHaveBeenLastCalledWith("uploaded_ocr_complete", {
    request_id: id,
    lease,
    result: null,
    error_code: "DOCUMENT_OCR_TIMEOUT",
  });
});
it("native publication tasks never call a recognizer or fetch source bytes again", async () => {
  const gateway = vi.fn(async (action: string) =>
    action === "uploaded_ocr_claim"
      ? { request_id: id, lease, action: "publish" }
      : null,
  );
  const read = vi.fn();
  expect(await processUploadedDocumentOcr(gateway, read)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(gateway).toHaveBeenLastCalledWith("uploaded_ocr_publish", {
    request_id: id,
    lease,
  });
});
function api() {
  const backend = {
    authenticate: vi.fn(async () => ({ id })),
    membership: vi.fn(async () => ({ workspace_id: id, role: "Owner" })),
    userRpc: vi.fn(async () => ({
      document_id: id,
      document_revision: 2,
      pages: [],
      ocr: { status: "needs_review" },
    })),
    one: vi.fn(async () => ({ id, storage_key: "synthetic/private.pdf" })),
    download: vi.fn(
      async () => "https://storage.example.test/synthetic-short-lived-token",
    ),
    command: vi.fn(async () => ({ id, revision: 3, ocr_status: "queued" })),
  };
  return {
    backend,
    handle: createApiHandler(env, () => backend as unknown as Backend),
  };
}
function request(body?: unknown, path = `/documents/${id}/extraction`) {
  return new Request(`https://edge.example.test/functions/v1/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer synthetic-user",
      origin: env.allowedOrigins[0],
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": "stable-correction",
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const correction = {
  id,
  expected_revision: 2,
  expected_original_hash: "a".repeat(64),
  expected_extraction_hash: "b".repeat(64),
  review_confirmed: true,
  pages: [
    {
      page: 1,
      expected_page_text_hash: "c".repeat(64),
      text: "Full corrected source paragraph.",
      blank_confirmed: false,
    },
  ],
};
it("actual API accepts reviewed full-page correction with pinned hashes and stable idempotency, without forging actor", async () => {
  const { handle, backend } = api();
  const response = await handle(request(correction));
  expect(response.status).toBe(202);
  expect(backend.command).toHaveBeenCalledWith(
    "synthetic-user",
    "document.extraction.correct",
    correction,
    "stable-correction",
  );
  const forged = await handle(request({ ...correction, actor_id: lease }));
  expect(forged.status).toBe(400);
  expect(backend.command).toHaveBeenCalledTimes(1);
});
it("actual extraction API rechecks authorization after short-lived URL issuance and exposes no storage key", async () => {
  const { handle, backend } = api();
  const response = await handle(request());
  expect(response.status).toBe(200);
  expect(backend.userRpc).toHaveBeenCalledTimes(2);
  const text = await response.text();
  expect(text).not.toContain("storage_key");
  expect(text).not.toContain("synthetic/private.pdf");
  backend.userRpc
    .mockReset()
    .mockResolvedValueOnce({
      document_id: id,
      document_revision: 2,
      pages: [],
      ocr: { status: "needs_review" },
    })
    .mockRejectedValueOnce(
      new AppError(403, "ROLE_FORBIDDEN", "Synthetic revocation"),
    );
  const revoked = await handle(request());
  expect(revoked.status).toBe(403);
  expect(await revoked.text()).not.toContain("synthetic-short-lived-token");
});
it("native uploaded OCR queue has the same dedicated secret boundary and cannot select a supplied storage key", async () => {
  const internal = vi.fn(async () => ({ request_id: id, lease }));
  const handler = createBrowserGateway(
    env,
    () => ({ internal }) as unknown as Backend,
  );
  const req = (secret: string, payload: unknown = {}) =>
    new Request("https://edge.example.test/functions/v1/source-browser", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-native-worker-secret": secret,
      },
      body: JSON.stringify({ action: "uploaded_ocr_claim", payload }),
    });
  expect((await handler(req("wrong"))).status).toBe(401);
  expect(internal).not.toHaveBeenCalled();
  expect((await handler(req(env.nativeWorkerSecret!))).status).toBe(200);
  expect(internal).toHaveBeenCalledWith("claim_uploaded_document_ocr");
  expect(
    (
      await handler(
        req(env.nativeWorkerSecret!, { storage_key: "other/private.pdf" }),
      )
    ).status,
  ).toBe(400);
  expect(internal).toHaveBeenCalledTimes(1);
});
