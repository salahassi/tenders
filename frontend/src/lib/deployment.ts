/** Public connection settings, loaded before the application bundle. */
export interface PublicDeploymentConfig {
  apiUrl?: string;
  publishableKey?: string;
  appOrigin?: string;
}

declare global {
  interface Window {
    __TENDERDESK_CONFIG__?: PublicDeploymentConfig;
  }
}

const configured = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const runtime = window.__TENDERDESK_CONFIG__;
const runtimeConfigured =
  runtime &&
  ["apiUrl", "publishableKey", "appOrigin"].some((key) =>
    Object.prototype.hasOwnProperty.call(runtime, key),
  );
const build = runtimeConfigured ? undefined : import.meta.env;
const pageOrigin =
  window.location.origin +
  window.location.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "");

// Only an anonymous/publishable key belongs here. Authentication, membership and
// RLS still determine access. Missing configuration never contacts the old host.
export const deployment = {
  projectUrl: (
    configured(runtime?.apiUrl) ||
    configured(build?.VITE_SUPABASE_URL) ||
    window.location.origin
  ).replace(/\/$/, ""),
  publishableKey:
    configured(runtime?.publishableKey) ||
    configured(build?.VITE_SUPABASE_PUBLISHABLE_KEY),
  /** Canonical hosted app URL for invitation and recovery email links. */
  appOrigin: (
    configured(runtime?.appOrigin) ||
    configured(build?.VITE_APP_ORIGIN) ||
    pageOrigin
  ).replace(/\/$/, ""),
} as const;
