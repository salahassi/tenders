const pendingKey = "tenderdesk:pending-invitation";
export function pendingInvitation(): string {
  const token = window.location.hash.match(/^#\/invite\/([a-f0-9]{64})$/)?.[1];
  if (token) {
    sessionStorage.setItem(pendingKey, token);
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.href);
    return token;
  }
  const saved = sessionStorage.getItem(pendingKey) || "";
  return /^[a-f0-9]{64}$/.test(saved) ? saved : "";
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
