import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deployment } from "./deployment";

export class BackendRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details: unknown = null,
  ) {
    super(message);
  }
}
export class BackendClient {
  readonly auth: SupabaseClient;
  constructor(
    readonly projectUrl: string,
    private readonly publishableKey: string,
  ) {
    const url = new URL(projectUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      throw new Error("Supply the Supabase project's HTTPS base URL.");
    if (!publishableKey)
      throw new Error("The Supabase publishable key is required.");
    this.auth = createClient(projectUrl, publishableKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        detectSessionInUrl: true,
        autoRefreshToken: true,
      },
    });
  }
  async checkInvitation(
    token: string,
  ): Promise<{ email: string; role: string; expires_at: string }> {
    const response = await fetch(
      `${this.projectUrl}/functions/v1/api/v1/invitations/check`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    const payload = await response.json();
    if (!response.ok)
      throw new BackendRequestError(
        payload.error?.code || "INVITATION_NOT_VALID",
        payload.error?.message || "This invitation is unavailable.",
        response.status,
      );
    return payload.data;
  }
  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ data: T; meta: { request_id: string; revision?: number } }> {
    if (!/^\/v1\/[a-z0-9/_-]+(?:\?[a-z0-9_=&-]*)?$/i.test(path))
      throw new Error("Use an application API path.");
    const {
      data: { session },
      error,
    } = await this.auth.auth.getSession();
    if (error) throw error;
    if (!session?.access_token)
      throw new BackendRequestError(
        "UNAUTHENTICATED",
        "Sign in to continue.",
        401,
      );
    const response = await fetch(`${this.projectUrl}/functions/v1/api${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BackendRequestError(
        "INVALID_RESPONSE",
        "The backend did not return a valid response.",
        response.status,
      );
    }
    if (!response.ok)
      throw new BackendRequestError(
        payload.error?.code || "REQUEST_FAILED",
        payload.error?.message || "The request could not be completed.",
        response.status,
        payload.error?.details,
      );
    return payload;
  }
  async uploadOriginal(
    reservation: { upload_path: string; bucket: string },
    file: File,
  ) {
    const { error } = await this.auth.storage
      .from(reservation.bucket)
      .upload(reservation.upload_path, file, {
        upsert: false,
        contentType: file.type || undefined,
      });
    if (error) throw error;
  }
}

// Configuration alone never migrates demo records or grants a browser role.
export function configuredBackend(): BackendClient | null {
  const mode =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("mode")
      : null;
  if (mode === "demo") return null;
  const configuredMode =
    import.meta.env.VITE_APP_MODE ||
    (import.meta.env.PROD ? "CONNECTED_FREE" : "DEMO");
  if (configuredMode !== "CONNECTED_FREE" && mode !== "connected") return null;
  const url = import.meta.env.VITE_SUPABASE_URL || deployment.projectUrl,
    key =
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      deployment.publishableKey;
  if (!url || !key)
    throw new BackendRequestError(
      "SETUP_REQUIRED",
      "Connected mode needs the Supabase URL and publishable key.",
      503,
    );
  return new BackendClient(url, key);
}
