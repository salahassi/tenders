const recoveryKey = "tenderdesk:password-recovery";
const tokensKey = "tenderdesk:recovery-tokens";
let recoveryTokens: { access_token: string; refresh_token: string } | null =
  null;

export type AuthCallback = {
  recovery: boolean;
  error: string | null;
  tokens: { access_token: string; refresh_token: string } | null;
  hasCode: boolean;
};

function hashParams(hash: string): URLSearchParams {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.includes("=")) return new URLSearchParams();
  return new URLSearchParams(raw.startsWith("/") ? raw.slice(1) : raw);
}

/** Read a Supabase email callback without letting the hash router discard it. */
export function parseAuthCallback(href: string): AuthCallback {
  const url = new URL(href);
  const hash = hashParams(url.hash);
  const type = url.searchParams.get("type") || hash.get("type");
  const access_token = hash.get("access_token");
  const refresh_token = hash.get("refresh_token");
  const error = (
    url.searchParams.get("error_description") ||
    hash.get("error_description") ||
    ""
  ).replace(/\+/g, " ");
  return {
    recovery:
      type === "recovery" || url.searchParams.get("auth") === "recovery",
    error: error || null,
    tokens:
      access_token && refresh_token ? { access_token, refresh_token } : null,
    hasCode: Boolean(url.searchParams.get("code")),
  };
}

export function captureAuthCallback(): AuthCallback {
  const parsed = parseAuthCallback(window.location.href);
  if (!parsed.recovery && !parsed.tokens && !parsed.error) return parsed;
  if (parsed.recovery) sessionStorage.setItem(recoveryKey, "1");
  if (parsed.tokens)
    sessionStorage.setItem(tokensKey, JSON.stringify(parsed.tokens));
  if (parsed.error) sessionStorage.setItem(`${recoveryKey}:error`, parsed.error);
  const url = new URL(window.location.href);
  if (parsed.recovery) url.hash = "#/reset-password";
  else if (parsed.tokens) url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return parsed;
}

export function markPasswordRecovery() {
  sessionStorage.setItem(recoveryKey, "1");
}

export function passwordRecoveryPending(): boolean {
  return sessionStorage.getItem(recoveryKey) === "1";
}

export function passwordRecoveryError(): string | null {
  return sessionStorage.getItem(`${recoveryKey}:error`);
}

export function takeRecoveryTokens(): {
  access_token: string;
  refresh_token: string;
} | null {
  if (recoveryTokens) return recoveryTokens;
  const raw = sessionStorage.getItem(tokensKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!parsed.access_token || !parsed.refresh_token) return null;
    recoveryTokens = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
    };
    return recoveryTokens;
  } catch {
    return null;
  }
}

export function clearPasswordRecovery() {
  recoveryTokens = null;
  sessionStorage.removeItem(recoveryKey);
  sessionStorage.removeItem(tokensKey);
  sessionStorage.removeItem(`${recoveryKey}:error`);
}
