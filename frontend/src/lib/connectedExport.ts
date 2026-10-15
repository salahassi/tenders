import type { BackendClient } from "./backendClient";
import type { FontData, RenderModel } from "./renderDocx";
import { extractLocalDocument } from "./documents";
import { reviewOriginalEligibility } from "./contentEligibility";
type Row = Record<string, any>;
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let fontsPromise: Promise<FontData> | undefined;
async function fonts() {
  if (!fontsPromise)
    fontsPromise = Promise.all(
      (
        [
          "Amiri-Regular",
          "Amiri-Bold",
          "Carlito-Regular",
          "Carlito-Bold",
        ] as const
      ).map(async (name) => {
        const response = await fetch(
          `${import.meta.env.BASE_URL}fonts/${name}.ttf`,
        );
        if (!response.ok) throw Error("Bundled fonts could not be loaded.");
        return [name, new Uint8Array(await response.arrayBuffer())] as const;
      }),
    )
      .then((pairs) => Object.fromEntries(pairs) as FontData)
      .catch((e) => {
        fontsPromise = undefined;
        throw e;
      });
  return fontsPromise;
}
export async function packageDocx(model: RenderModel) {
  const data = await fonts();
  if (typeof Worker === "undefined")
    throw Error("This browser does not support background Word packaging.");
  const worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<Blob>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      done();
      reject(
        Error("Word packaging exceeded two minutes. Reduce the proposal size."),
      );
    }, 120000);
    worker.onmessage = ({ data }) => {
      done();
      data.error ? reject(Error(data.error)) : resolve(data.blob);
    };
    worker.onerror = () => {
      done();
      reject(Error("Background Word packaging failed."));
    };
    worker.postMessage({ model, fonts: data });
  });
}
export async function sha256(blob: Blob) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function command(
  client: BackendClient,
  operation: string,
  input: Row,
  key: string,
) {
  const { data } = await client.request<Row[]>("/v1/commands", {
    method: "POST",
    body: { commands: [{ operation, input }] },
    idempotencyKey: key,
  });
  return data[0];
}
export async function saveExportArtifact(
  client: BackendClient,
  request: Row,
  file: File,
  kind: "generated" | "reviewed",
) {
  if (file.size > 10485760) throw Error("The export exceeds 10 MiB.");
  const hash = await sha256(file),
    a = await command(
      client,
      "export.reserve",
      {
        export_id: request.id,
        kind,
        original_name: file.name,
        mime_type: file.type,
        size: file.size,
        hash,
        review_attested: kind === "reviewed",
      },
      `export:${request.id}:${kind}:${hash}`,
    );
  try {
    await client.uploadOriginal(
      { bucket: "tenderdesk-private", upload_path: a.storage_key },
      file,
    );
  } catch (e) {
    if (
      !e ||
      typeof e !== "object" ||
      !("statusCode" in e) ||
      String(e.statusCode) !== "409"
    )
      throw e;
  }
  return (
    await client.request<Row>(`/v1/export-artifacts/${a.id}/complete`, {
      method: "POST",
      body: {},
      idempotencyKey: `export-complete:${a.id}`,
    })
  ).data;
}
export async function downloadExport(client: BackendClient, artifact: Row) {
  const blob = await client.downloadArtifact(artifact.id);
  if ((await sha256(blob)) !== artifact.content_hash)
    throw Error("Downloaded file hash does not match its saved artifact.");
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = artifact.original_name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function createConnectedExport(
  client: BackendClient,
  versionId: string,
  mode: "draft" | "final",
) {
  const { data: version } = await client.request<Row>(
      `/v1/proposal-versions/${versionId}`,
    ),
    artifacts: Row[] = [];
  for (const volume of version.separate_volumes
    ? ["technical", "financial"]
    : ["combined"]) {
    const r = await command(
      client,
      "export.prepare",
      {
        proposal_version_id: versionId,
        expected_revision: version.revision,
        mode,
        volume,
      },
      crypto.randomUUID(),
    );
    const { data } = await client.request<{ request: Row; model: RenderModel }>(
      `/v1/exports/${r.id}/context`,
    );
    const blob = await packageDocx(data.model),
      file = new File(
        [blob],
        `proposal_v${version.ordinal}_${volume}_${mode}.docx`,
        { type: DOCX_MIME },
      );
    const artifact = await saveExportArtifact(
      client,
      data.request,
      file,
      "generated",
    );
    await downloadExport(client, artifact);
    artifacts.push(artifact);
  }
  return artifacts;
}
export async function saveReviewedExport(
  client: BackendClient,
  request: Row,
  file: File,
) {
  const doc = await extractLocalDocument(file);
  await reviewOriginalEligibility(doc, file);
  await command(
    client,
    "export.renew",
    { id: request.id, expected_revision: request.revision },
    crypto.randomUUID(),
  );
  return saveExportArtifact(client, request, file, "reviewed");
}
