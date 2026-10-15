import type { BackendClient } from "./backendClient";
import type { BackupBundle, BackupManifest, BackupRow } from "./backupFormat";
import { backupHash, backupManifestSchema } from "./backupFormat";
type Progress = (message: string) => void;
async function worker<T>(data: unknown): Promise<T> {
  if (typeof Worker === "undefined")
    throw Error("This browser cannot run background backup verification.");
  const worker = new Worker(new URL("./backup.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const stop = () => {
        clearTimeout(timer);
        worker.terminate();
      },
      timer = setTimeout(() => {
        stop();
        reject(
          Error(
            "Backup processing exceeded five minutes. Retry on a desktop browser.",
          ),
        );
      }, 300000);
    worker.onmessage = ({ data }) => {
      stop();
      data.error ? reject(Error(data.error)) : resolve(data.result);
    };
    worker.onerror = () => {
      stop();
      reject(Error("Background backup processing failed."));
    };
    worker.postMessage(data);
  });
}
export const previewBackup = (file: File) =>
  worker<BackupBundle>({ action: "unpack", file });
export async function downloadWorkspaceBackup(
  client: BackendClient,
  progress: Progress,
) {
  const manifest = backupManifestSchema.parse(
      (await client.request<BackupManifest>("/v1/recovery/manifest")).data,
    ),
    rows: BackupRow[] = [],
    files: Record<string, Uint8Array> = {};
  let batch: string[] = [],
    size = 0;
  async function flush() {
    if (!batch.length) return;
    rows.push(
      ...(
        await client.request<BackupRow[]>("/v1/recovery/rows", {
          method: "POST",
          body: { keys: batch },
        })
      ).data,
    );
    batch = [];
    size = 0;
    progress(`Read ${rows.length} of ${manifest.rows.length} records.`);
  }
  for (const row of manifest.rows) {
    if (batch.length >= 30 || size + row.size > 10485760) await flush();
    batch.push(row.key);
    size += row.size;
  }
  await flush();
  for (const [index, file] of manifest.files.entries()) {
    progress(
      `Reading and checking original ${index + 1} of ${manifest.files.length}.`,
    );
    const blob = await client.downloadBytes(`/v1/recovery/files/${file.key}`),
      bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== file.size || (await backupHash(bytes)) !== file.hash)
      throw Error(
        "An original changed during backup. Retry from a stable workspace.",
      );
    files[file.key] = bytes;
  }
  const latest = (await client.request<BackupManifest>("/v1/recovery/manifest"))
    .data;
  if (latest.root_hash !== manifest.root_hash)
    throw Error(
      "The workspace changed during backup. Retry when edits and jobs have stopped.",
    );
  progress("Verifying and packaging all records and originals locally.");
  return worker<Blob>({ action: "pack", bundle: { manifest, rows, files } });
}
export async function restoreWorkspaceBackup(
  client: BackendClient,
  bundle: BackupBundle,
  progress: Progress,
  onSession: (id: string) => void,
) {
  const session = (
    await client.request<any>("/v1/recovery/restore", {
      method: "POST",
      body: { manifest: bundle.manifest, eligibility_attested: true },
    })
  ).data;
  onSession(session.id);
  let batch: BackupRow[] = [],
    size = 0,
    done = 0;
  async function flush() {
    if (!batch.length) return;
    await client.request(`/v1/recovery/restore/${session.id}/rows`, {
      method: "POST",
      body: { items: batch },
    });
    done += batch.length;
    batch = [];
    size = 0;
    progress(
      `Validated ${done} of ${bundle.rows.length} records on the server.`,
    );
  }
  for (const row of bundle.rows) {
    const bytes = new TextEncoder().encode(row.data).length;
    if (batch.length >= 30 || size + bytes > 10485760) await flush();
    batch.push(row);
    size += bytes;
  }
  await flush();
  for (const [index, reservation] of session.files.entries()) {
    progress(`Restoring original ${index + 1} of ${session.files.length}.`);
    if (reservation.status === "ready") continue;
    const file = new File(
      [bundle.files[reservation.row_key] as Uint8Array<ArrayBuffer>],
      reservation.original_name,
      { type: reservation.mime_type },
    );
    try {
      await client.uploadOriginal(
        { bucket: "tenderdesk-private", upload_path: reservation.storage_key },
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
    await client.request(
      `/v1/recovery/restore-files/${reservation.id}/complete`,
      { method: "POST", body: {} },
    );
  }
  progress("Verifying references and committing the complete workspace.");
  return (
    await client.request(`/v1/recovery/restore/${session.id}/commit`, {
      method: "POST",
      body: {},
    })
  ).data;
}
