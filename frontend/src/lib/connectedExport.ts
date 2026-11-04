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
export interface DurableExportPackage {
  id: string;
  revision: number;
  status: "preparing" | "ready" | "blocked";
  mode: "draft" | "final";
  proposal_version_id: string;
  accepted_at: string;
  deadline_at: string;
  server_now: string;
  artifacts: {
    id: string | null;
    volume: string;
    status: string;
    content_hash: string | null;
    expected_size: number | null;
    original_name: string;
    mime_type: string;
  }[];
  job: {
    status: string;
    error_code: string | null;
    next_attempt_at: string | null;
  };
}
export type ExportWaitOptions = {
  signal?: AbortSignal;
  onProgress?: (value: DurableExportPackage) => void;
};
export class ExportPackageBlockedError extends Error {
  constructor(public saved: DurableExportPackage) {
    super(
      saved.job.error_code?.includes("STORAGE")
        ? "There is not enough storage to prepare the complete export. Free storage, then explicitly retry."
        : "Export preparation stopped. Review the current proposal and any unresolved issue, then explicitly retry.",
    );
  }
}
const requestSignal = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
function packageIdentity(
  saved: DurableExportPackage,
  version: string,
  mode: "draft" | "final",
) {
  if (
    !saved ||
    !/^[0-9a-f-]{36}$/.test(saved.id) ||
    saved.proposal_version_id !== version ||
    saved.mode !== mode ||
    !Number.isSafeInteger(saved.revision) ||
    !["preparing", "ready", "blocked"].includes(saved.status) ||
    !Array.isArray(saved.artifacts) ||
    saved.artifacts.length > 2
  )
    throw Error("The saved export package does not match this request.");
  if (
    !Number.isFinite(Date.parse(saved.server_now)) ||
    !Number.isFinite(Date.parse(saved.accepted_at)) ||
    Date.parse(saved.deadline_at) - Date.parse(saved.accepted_at) !== 600000
  )
    throw Error(
      "The saved export deadline is unavailable. Refresh and try again.",
    );
}
function waitForPoll(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(
        signal?.reason || new DOMException("Stopped waiting", "AbortError"),
      );
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
async function completeConnectedExport(
  client: BackendClient,
  first: DurableExportPackage,
  options: ExportWaitOptions,
  expectedVolumes = first.artifacts.map((a) => a.volume).sort(),
) {
  let saved = first;
  const clock = [first.accepted_at, first.deadline_at].join("/");
  for (let polls = 0; ; polls++) {
    options.signal?.throwIfAborted();
    packageIdentity(saved, first.proposal_version_id, first.mode);
    if (
      saved.id !== first.id ||
      [saved.accepted_at, saved.deadline_at].join("/") !== clock
    )
      throw Error(
        "The export authorization changed. Reopen the saved export before continuing.",
      );
    options.onProgress?.(saved);
    if (saved.status === "blocked") throw new ExportPackageBlockedError(saved);
    if (saved.status === "ready") break;
    const remaining =
      Date.parse(saved.deadline_at) - Date.parse(saved.server_now);
    if (remaining <= 0 || polls >= 405)
      throw Error(
        "The export observation deadline has elapsed. Select Download again to check the saved result and available recovery action.",
      );
    await waitForPoll(Math.min(1500, remaining), options.signal);
    saved = (
      await client.request<DurableExportPackage>(
        `/v1/export-packages/${saved.id}`,
        { signal: requestSignal(options.signal) },
      )
    ).data;
  }
  const volumes = saved.artifacts.map((a) => a.volume).sort();
  if (
    JSON.stringify(volumes) !== JSON.stringify(expectedVolumes) ||
    saved.job.status !== "succeeded" ||
    !['["combined"]', '["financial","technical"]'].includes(
      JSON.stringify(volumes),
    ) ||
    saved.artifacts.some(
      (a) =>
        !a.id ||
        a.status !== "ready" ||
        !/^[a-f0-9]{64}$/.test(a.content_hash || "") ||
        !Number.isSafeInteger(Number(a.expected_size)) ||
        Number(a.expected_size) <= 0 ||
        Number(a.expected_size) > 10485760,
    )
  )
    throw Error("The complete saved export package is not ready.");
  // Verify all stored volumes before a single browser download is triggered.
  const files = await Promise.all(
    saved.artifacts.map(async (artifact) => {
      const blob = await client.downloadArtifact(
        artifact.id!,
        requestSignal(options.signal),
      );
      options.signal?.throwIfAborted();
      if (
        blob.size !== Number(artifact.expected_size) ||
        (await sha256(blob)) !== artifact.content_hash
      )
        throw Error(
          "Downloaded file bytes differ from the verified saved export.",
        );
      return { blob, name: artifact.original_name };
    }),
  );
  const current = (
    await client.request<DurableExportPackage>(
      `/v1/export-packages/${saved.id}`,
      { signal: requestSignal(options.signal) },
    )
  ).data;
  packageIdentity(current, first.proposal_version_id, first.mode);
  if (
    [current.accepted_at, current.deadline_at].join("/") !== clock ||
    current.id !== saved.id ||
    current.status !== "ready" ||
    current.job.status !== "succeeded" ||
    JSON.stringify(current.artifacts) !== JSON.stringify(saved.artifacts)
  )
    throw Error(
      "The export package changed during download. Refresh before continuing.",
    );
  options.signal?.throwIfAborted();
  for (const file of files) {
    const url = URL.createObjectURL(file.blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  return saved.artifacts;
}
/** The server owns rendering and persistence. Re-entry with a fresh UI key
 * discovers the same current package and keeps its original deadline. */
export async function createConnectedExport(
  client: BackendClient,
  versionId: string,
  mode: "draft" | "final",
  options: ExportWaitOptions = {},
) {
  options.signal?.throwIfAborted();
  const version = (
    await client.request<Row>(`/v1/proposal-versions/${versionId}`, {
      signal: requestSignal(options.signal),
    })
  ).data;
  const prepared = (
    await client.request<DurableExportPackage[]>("/v1/commands", {
      method: "POST",
      body: {
        commands: [
          {
            operation: "export.package.prepare",
            input: {
              proposal_version_id: versionId,
              expected_revision: version.revision,
              mode,
            },
          },
        ],
      },
      idempotencyKey: crypto.randomUUID(),
      signal: requestSignal(options.signal),
    })
  ).data[0];
  packageIdentity(prepared, versionId, mode);
  return completeConnectedExport(
    client,
    prepared,
    options,
    version.separate_volumes ? ["financial", "technical"] : ["combined"],
  );
}
/** Only this explicit user action authorizes a fresh preparation deadline. */
export async function retryConnectedExport(
  client: BackendClient,
  previous: DurableExportPackage,
  options: ExportWaitOptions = {},
) {
  options.signal?.throwIfAborted();
  const prepared = (
    await client.request<DurableExportPackage[]>("/v1/commands", {
      method: "POST",
      body: {
        commands: [
          {
            operation: "export.package.retry",
            input: { id: previous.id, expected_revision: previous.revision },
          },
        ],
      },
      idempotencyKey: crypto.randomUUID(),
      signal: requestSignal(options.signal),
    })
  ).data[0];
  packageIdentity(prepared, previous.proposal_version_id, previous.mode);
  return completeConnectedExport(client, prepared, options);
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
