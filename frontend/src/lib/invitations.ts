const pendingKey = "tenderdesk:pending-invitation";
export const invitationChangedEvent = "tenderdesk:invitation-changed";

export function notifyInvitationCaptured() {
  window.dispatchEvent(new Event(invitationChangedEvent));
}

/** Read a 64-char invite token from HashRouter path or legacy hash links. */
export function readPendingInvitation(pathname = ""): string {
  const fromPath = pathname.match(/^\/invite\/([a-f0-9]{64})$/)?.[1];
  if (fromPath) {
    sessionStorage.setItem(pendingKey, fromPath);
    notifyInvitationCaptured();
    return fromPath;
  }
  const fromHash = window.location.hash.match(/^#\/invite\/([a-f0-9]{64})$/)?.[1];
  if (fromHash) {
    sessionStorage.setItem(pendingKey, fromHash);
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.href);
    return fromHash;
  }
  const saved = sessionStorage.getItem(pendingKey) || "";
  return /^[a-f0-9]{64}$/.test(saved) ? saved : "";
}

/** @deprecated Use readPendingInvitation with router pathname. */
export function pendingInvitation(): string {
  return readPendingInvitation();
}

export function clearPendingInvitation() {
  sessionStorage.removeItem(pendingKey);
}

export async function newInvitationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const token_hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return { token, token_hash };
}
