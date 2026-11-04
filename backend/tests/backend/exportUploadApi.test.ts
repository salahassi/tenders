// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import { validateExportDocxEnvelope } from "../../supabase/functions/_shared/exportUpload.ts";
import { validateOriginal } from "../../supabase/functions/_shared/originals.ts";
import { buildExportModel } from "../../supabase/functions/_shared/export.ts";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend.ts";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx.ts";
const actor = "00000000-0000-4000-8000-000000000001",
  artifact = "00000000-0000-4000-8000-000000000002";
const mime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const request = {
  id: artifact,
  mode: "draft",
  volume: "combined",
  created_at: "2026-11-04T00:00:00Z",
  snapshot: {
    title: "Synthetic reviewed export",
    ordinal: 1,
    language: "en",
    template: {},
    sections: [],
    requirements: [],
    compliance: [],
    questions: [],
    export_renderer_version: "ordinary-2",
  },
};
const env: BackendEnvironment = {
  url: "https://synthetic.invalid",
  publishableKey: "synthetic-key",
  serviceKey: "synthetic-service",
  workerSecret: "synthetic-worker",
  allowedOrigins: ["https://synthetic-client.invalid"],
  models: modelEnvironments(() => undefined),
};
let native: Uint8Array;
beforeAll(async () => {
  const fonts = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
  native = new Uint8Array(
    await (await renderDocx(buildExportModel(request), fonts)).arrayBuffer(),
  );
});
async function complete(
  bytes: Uint8Array,
  name = "reviewed.docx",
  type = mime,
  context = request,
) {
  const backend = {
    authenticate: vi.fn(async () => ({ id: actor })),
    membership: vi.fn(async () => ({ workspace_id: actor, role: "Owner" })),
    userRpc: vi.fn(async () => ({
      request: context,
      artifact: {
        id: artifact,
        kind: "reviewed",
        original_name: name,
        mime_type: type,
        expected_size: bytes.length,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
        storage_key: "synthetic/reviewed",
      },
    })),
    object: vi.fn(async () => new Blob([new Uint8Array(bytes)])),
    internal: vi.fn(async () => ({ id: artifact, status: "ready" })),
  };
  const response = await createApiHandler(
    env,
    () => backend as unknown as Backend,
  )(
    new Request(
      `https://synthetic.invalid/functions/v1/api/v1/export-artifacts/${artifact}/complete`,
      {
        method: "POST",
        headers: {
          origin: env.allowedOrigins[0],
          authorization: "Bearer synthetic",
        },
      },
    ),
  );
  return { response, result: await response.json(), backend };
}
it("accepts a real canonical reviewed DOCX only after exact verification and final completion", async () => {
  const f = await complete(native);
  expect(f.response.status).toBe(200);
  expect(f.result.data.status).toBe("ready");
  expect(f.backend.internal).toHaveBeenCalledExactlyOnceWith(
    "complete_export_artifact",
    expect.objectContaining({
      actor_id: actor,
      verification_kind: "reviewed_docx",
      actual_size: native.length,
    }),
  );
});
it.each([
  ["reviewed.txt", mime],
  ["reviewed.docx", "application/pdf"],
  ["reviewed.xlsx", mime],
])(
  "rejects incorrect filename/MIME %s %s before acceptance",
  async (name, type) => {
    const f = await complete(native, name, type);
    expect(f.result.error.code).toBe("FILE_CONTENT_MISMATCH");
    expect(f.backend.internal).not.toHaveBeenCalled();
  },
);
it("rejects a wrong DOCX signature before acceptance", async () => {
  const f = await complete(new TextEncoder().encode("not a zip"));
  expect(f.result.error.code).toBe("FILE_CONTENT_MISMATCH");
  expect(f.backend.internal).not.toHaveBeenCalled();
});
it("does not confuse envelope admission with document acceptance", async () => {
  const truncated = Uint8Array.of(80, 75, 3, 4);
  expect(() =>
    validateExportDocxEnvelope("reviewed.DOCX", mime, truncated),
  ).not.toThrow();
  const f = await complete(truncated);
  expect(f.response.status).toBe(422);
  expect(f.result.error.code).toBe("INVALID_EXPORT_ARCHIVE");
  expect(f.backend.internal).not.toHaveBeenCalled();
});
it("rejects a valid foreign document against the actual canonical context", async () => {
  const foreign = structuredClone(request);
  foreign.snapshot.title = "Different authorized content";
  const f = await complete(native, "reviewed.docx", mime, foreign);
  expect(f.result.error.code).toBe("EXPORT_CONTENT_MISMATCH");
  expect(f.backend.internal).not.toHaveBeenCalled();
});
it("retains original-RFP 40MiB expanded archive policy", () => {
  const fixture = new Uint8Array(50);
  fixture.set([80, 75, 3, 4]);
  const view = new DataView(fixture.buffer);
  view.setUint32(4, 0x02014b50, true);
  view.setUint32(28, 40 * 1024 * 1024 + 1, true);
  expect(() => validateOriginal("original.docx", mime, fixture)).toThrow(
    expect.objectContaining({ code: "FILE_CONTENT_MISMATCH" }),
  );
});
it.each([0, 10485761])(
  "retains DOCX compressed upload size bounds: %s",
  (size) => {
    expect(() =>
      validateExportDocxEnvelope("reviewed.docx", mime, new Uint8Array(size)),
    ).toThrow(expect.objectContaining({ code: "FILE_SIZE_INVALID" }));
  },
);
it("preserves the reviewed PDF policy and verification kind", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const f = await complete(await pdf.save(), "reviewed.pdf", "application/pdf");
  expect(f.response.status).toBe(200);
  expect(f.backend.internal).toHaveBeenCalledWith(
    "complete_export_artifact",
    expect.objectContaining({ verification_kind: "owner_reviewed_pdf" }),
  );
});
it("preserves the reviewed PDF 200-page maximum", async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 201; i++) pdf.addPage();
  const f = await complete(await pdf.save(), "reviewed.pdf", "application/pdf");
  expect(f.result.error.code).toBe("EXPORT_PAGE_CAP_REACHED");
  expect(f.backend.internal).not.toHaveBeenCalled();
});
