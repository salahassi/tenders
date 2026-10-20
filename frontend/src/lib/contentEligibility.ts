import type { DocumentRecord } from "../types";
export const unsafeBusinessContent = (text: string) =>
  /(?:(?:\bconfidential\b|سرية)\s*[:：—–-]|(?:^|[\r\n]|\\[nr]|["=:])\s*(?:confidential|سرية)\s*(?=$|[\r\n"]|\\[nr])|strictly private|سري للغاية|password\s*[:=]|api[_ -]?key\s*[:=]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|-----BEGIN .*PRIVATE KEY|\b(?:sk|sb_secret)_[a-z0-9]{12,}|\+\d[\d ()-]{7,}\d|\b\d{3}[- .]\d{3}[- .]\d{4}\b)/i.test(
    text,
  );
export type OriginalReview = { document: DocumentRecord; original: Blob };
let reviewer: ((request: OriginalReview) => Promise<boolean>) | undefined;
const approved = new Set<string>();
export function registerOriginalReviewer(
  handler: (request: OriginalReview) => Promise<boolean>,
) {
  reviewer = handler;
  return () => {
    if (reviewer === handler) reviewer = undefined;
    approved.clear();
  };
}
export async function reviewOriginalEligibility(
  document: DocumentRecord,
  original: Blob,
): Promise<true> {
  if (unsafeBusinessContent(document.name + "\n" + document.text))
    throw Error(
      "This file may contain confidential, personal or secret information. It has not been uploaded. Prepare a nonconfidential, nonpersonal replacement locally, including its metadata, and attach the replacement.",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await original.arrayBuffer(),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== document.hash)
    throw Error("The original changed after extraction. Attach it again.");
  if (approved.has(hash)) return true;
  if (!reviewer)
    throw Error(
      "Original-file review is unavailable. Reopen the upload screen before retrying.",
    );
  if (!(await reviewer({ document, original })))
    throw Error("Upload canceled before original bytes were sent.");
  approved.add(hash);
  return true;
}
