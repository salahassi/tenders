import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deployment } from "./deployment";

export interface DocumentExtractionReviewData {
  document_id: string;
  document_revision: number;
  original_hash: string;
  extraction_hash: string;
  original_name: string;
  pdf_pages: number;
  original_download_url: string;
  original_download_expires_at: string;
  pages: {
    page: number;
    status: "readable" | "blank" | "needs_ocr" | "extraction_failed";
    text: string;
    text_hash: string;
    candidate_text?: string;
    candidate_text_hash?: string;
    requires_review: boolean;
    reviewed_by?: string;
    reviewed_at?: string;
  }[];
  ocr: {
    document_id: string;
    document_revision: number;
    status:
      | "queued"
      | "running"
      | "retry_wait"
      | "blocked"
      | "needs_review"
      | "published"
      | null;
    successor_id: string | null;
    error_code: string | null;
    revision: number | null;
    completed_pages: number;
    total_pages: number;
    review_pages: number[];
  };
}
export interface DocumentExtractionCorrection {
  id: string;
  expected_revision: number;
  expected_original_hash: string;
  expected_extraction_hash: string;
  pages: {
    page: number;
    expected_page_text_hash: string;
    text: string;
    blank_confirmed: boolean;
  }[];
  review_confirmed: true;
}

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
    const localDev =
      import.meta.env.DEV &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localDev) ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      throw new Error("Supply the application's HTTPS API base URL.");
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
  async documentExtraction(
    id: string,
    signal?: AbortSignal,
  ): Promise<DocumentExtractionReviewData> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid document ID.");
    return (
      await this.request<DocumentExtractionReviewData>(
        `/v1/documents/${id}/extraction`,
        { signal },
      )
    ).data;
  }
  async correctDocumentExtraction(
    input: DocumentExtractionCorrection,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return (
      await this.request<Record<string, unknown>>(
        `/v1/documents/${input.id}/extraction`,
        { method: "POST", body: input, idempotencyKey, signal },
      )
    ).data;
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
  async list<T>(
    resource: string,
    filters: Record<string, string> = {},
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({
        ...filters,
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const { data } = await this.request<{
        records: T[];
        next_cursor: string | null;
      }>(`/v1/${resource}?${query}`);
      if (
        !Array.isArray(data.records) ||
        (data.next_cursor !== null && typeof data.next_cursor !== "string")
      )
        throw new Error("Invalid list response.");
      rows.push(...data.records);
      cursor = data.next_cursor;
      if (cursor && (seen.has(cursor) || rows.length >= 10000))
        throw new Error("The list exceeded its supported boundary.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  async downloadArtifact(id: string): Promise<Blob> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid artifact.");
    return this.downloadBytes(`/v1/export-artifacts/${id}/download`);
  }
  async downloadDeliveryArtifact(
    id: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid artifact.");
    return this.downloadBytes(`/v1/delivery-artifacts/${id}/download`, signal);
  }
  async downloadBytes(path: string, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    if (
      !/^\/v1\/(?:(?:export-artifacts|delivery-artifacts)\/[0-9a-f-]{36}\/download|recovery\/files\/(?:documents|export_artifacts|proposal_delivery_artifacts)\/[0-9a-f-]{36})$/.test(
        path,
      )
    )
      throw Error("Invalid file path.");
    const {
      data: { session },
      error,
    } = await this.auth.auth.getSession();
    signal?.throwIfAborted();
    if (error) throw error;
    if (!session)
      throw new BackendRequestError(
        "UNAUTHENTICATED",
        "Sign in to download.",
        401,
      );
    const response = await fetch(`${this.projectUrl}/functions/v1/api${path}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      signal,
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      const value = await response.json();
      throw new BackendRequestError(
        value.error?.code || "DOWNLOAD_FAILED",
        value.error?.message || "Download failed.",
        response.status,
      );
    }
    const blob = await response.blob();
    signal?.throwIfAborted();
    return blob;
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

// This app always uses authenticated server persistence. Query parameters cannot enable local data.
export function configuredBackend(): BackendClient {
  const url = deployment.projectUrl,
    key = deployment.publishableKey;
  if (!url || !key)
    throw new BackendRequestError(
      "SETUP_REQUIRED",
      "The application API URL and publishable key need to be configured.",
      503,
    );
  return new BackendClient(url, key);
}
