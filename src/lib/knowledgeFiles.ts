import { del, get, keys, set } from "idb-keyval";
import type { KnowledgeDocument } from "../types";

const FILE_PREFIX = "tenderdesk:file:";

/** Originals live separately from serializable workspace metadata and text. */
export async function saveLocalFile(
  documentId: string,
  file: Blob,
): Promise<void> {
  await set(`${FILE_PREFIX}${documentId}`, file);
}

export async function getLocalFile(
  documentId: string,
): Promise<Blob | undefined> {
  return get<Blob>(`${FILE_PREFIX}${documentId}`);
}

export async function removeLocalFile(documentId: string): Promise<void> {
  await del(`${FILE_PREFIX}${documentId}`);
}

export async function clearLocalFiles(): Promise<void> {
  const stored = await keys();
  await Promise.all(
    stored
      .filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith(FILE_PREFIX),
      )
      .map((key) => del(key)),
  );
}

export async function downloadLocalFile(
  documentId: string,
  filename: string,
): Promise<void> {
  const blob = await getLocalFile(documentId);
  if (!blob) {
    throw new Error(
      "The original file is not available in this browser. Upload it again to restore the download.",
    );
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A future agent adapter can retrieve these traceable inputs without UI access.
 * Files that need OCR, failed extraction, or were excluded are never treated as
 * readable context. No external model or upload is performed by this helper. */
export function getEnabledKnowledgeContext(documents: KnowledgeDocument[]) {
  return documents
    .filter(
      (item) => item.enabled && item.status === "ready" && item.text.trim(),
    )
    .map(({ id, name, category, text, hash, classification }) => ({
      id,
      name,
      category,
      text,
      hash,
      classification,
    }));
}
