import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError, databaseError } from "./http.ts";
import { MODEL_PROVIDER_IDS, type ModelProviderId } from "./modelProviders.ts";
import type { DocumentCoverage } from "./documentCoverage.ts";
import {
  isHeavyFileTable,
  FULL_LIST_PAGE_BYTES,
  FULL_LIST_PAGE_MS,
  jsonBytesUpperBound,
} from "./heavyFileProjection.ts";
import { postgrestBatchBody } from "./batchTransport.ts";
export type ModelEnvironmentSlot = {
  provider: string;
  model: string;
  projectRef: string;
  key: string;
};
export interface BackendEnvironment {
  url: string;
  /** Public HTTPS API origin when server requests use a private gateway. */
  publicApiUrl?: string;
  publishableKey: string;
  serviceKey: string;
  allowedOrigins: string[];
  workerSecret: string;
  nativeWorkerSecret?: string;
  browserOidcAudience?: string;
  collectionHosts?: string[];
  smtp?: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
    publicUrl: string;
  };
  models: Record<ModelProviderId, ModelEnvironmentSlot>;
  modelCredential?: (alias: string) => string;
}
const SECRET_PREFIX: Record<ModelProviderId, string> = {
  gemini_free: "APP_MODEL_GEMINI",
  qwen_free: "APP_MODEL_QWEN",
  groq_free: "APP_MODEL_GROQ",
  mistral_free: "APP_MODEL_MISTRAL",
  cloudflare_free: "APP_MODEL_CLOUDFLARE",
  zai_free: "APP_MODEL_ZAI",
  openai: "APP_MODEL_OPENAI",
  anthropic: "APP_MODEL_CLAUDE",
  openrouter: "APP_MODEL_OPENROUTER",
  qwencloud: "APP_MODEL_QWENCLOUD",
};
export function modelEnvironments(
  get: (name: string) => string | undefined,
): BackendEnvironment["models"] {
  const legacyProvider = get("APP_MODEL_PROVIDER") || "",
    legacyModel = get("APP_MODEL_NAME") || "",
    legacyProject = get("APP_MODEL_PROJECT") || "",
    legacyKey = get("APP_MODEL_KEY") || "";
  const slot = (provider: ModelProviderId) => {
    const prefix = SECRET_PREFIX[provider];
    return {
      provider,
      model:
        get(`${prefix}_NAME`) ||
        (legacyProvider === provider ? legacyModel : ""),
      projectRef:
        get(`${prefix}_PROJECT`) ||
        (legacyProvider === provider ? legacyProject : "") ||
        (provider === "openai" ||
        provider === "anthropic" ||
        provider === "openrouter"
          ? "default"
          : provider === "qwencloud"
            ? "ap-southeast-1"
            : ""),
      key:
        get(`${prefix}_KEY`) || (legacyProvider === provider ? legacyKey : ""),
    };
  };
  return Object.fromEntries(
    MODEL_PROVIDER_IDS.map((id) => [id, slot(id)]),
  ) as Record<ModelProviderId, ModelEnvironmentSlot>;
}
function platformKey(value: string | undefined): string {
  if (!value) return "";
  try {
    const keys: unknown = JSON.parse(value);
    if (
      keys &&
      typeof keys === "object" &&
      "default" in keys &&
      typeof keys.default === "string"
    )
      return keys.default;
  } catch {
    // Invalid secret-store configuration must never be included in diagnostics.
  }
  return "";
}
export function environment(
  get: (name: string) => string | undefined,
): BackendEnvironment {
  return {
    url: get("SUPABASE_URL") || "",
    publicApiUrl: get("APP_PUBLIC_API_URL") || undefined,
    publishableKey:
      get("APP_SUPABASE_PUBLISHABLE_KEY") ||
      platformKey(get("SUPABASE_PUBLISHABLE_KEYS")) ||
      get("SUPABASE_ANON_KEY") ||
      "",
    serviceKey:
      platformKey(get("SUPABASE_SECRET_KEYS")) ||
      get("SUPABASE_SERVICE_ROLE_KEY") ||
      "",
    allowedOrigins: (
      get("APP_ALLOWED_ORIGINS") || "https://salahassi.github.io"
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    workerSecret: get("APP_WORKER_SECRET") || "",
    nativeWorkerSecret: get("APP_NATIVE_WORKER_SECRET") || "",
    browserOidcAudience: get("APP_BROWSER_OIDC_AUDIENCE") || "",
    smtp: {
      host: get("APP_SMTP_HOST") || "",
      port: Number(get("APP_SMTP_PORT") || "465"),
      user: get("APP_SMTP_USER") || "",
      password: get("APP_SMTP_PASSWORD") || "",
      from: get("APP_SMTP_FROM") || "",
      publicUrl:
        get("APP_PUBLIC_URL") || "https://salahassi.github.io/tenders/",
    },
    models: modelEnvironments(get),
    modelCredential: (alias) =>
      /^APP_MODEL_[A-Z0-9_]{1,80}_KEY$/.test(alias) ? get(alias) || "" : "",
    collectionHosts: (get("APP_COLLECTION_HOSTS") || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  };
}
export class Backend {
  readonly invocationStartedAt = Date.now();
  resolveModelEnvironment(config: {
    provider: ModelProviderId;
    model: string;
    project_ref: string;
    credential_alias?: string;
    connection_id?: string;
  }) {
    const legacy = this.env.models[config.provider];
    if (!config.connection_id) return legacy;
    const key =
      config.credential_alias === `${SECRET_PREFIX[config.provider]}_KEY`
        ? legacy?.key
        : this.env.modelCredential?.(config.credential_alias || "") || "";
    return {
      provider: config.provider,
      model: config.model,
      projectRef: config.project_ref,
      key: key || "",
    };
  }
  private admin: SupabaseClient;
  constructor(
    private env: BackendEnvironment,
    readonly invocationBudgetMs = 110000,
  ) {
    if (!env.url || !env.publishableKey || !env.serviceKey)
      throw new AppError(
        503,
        "SETUP_REQUIRED",
        "Backend secrets are not configured.",
      );
    this.admin = createClient(env.url, env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  user(token: string) {
    return createClient(this.env.url, this.env.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  async authenticate(token: string) {
    const { data, error } = await this.admin.auth.getUser(token);
    if (error || !data.user)
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return data.user;
  }
  async checkInvitation(token: string) {
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const { data, error } = await this.admin.rpc("inspect_invitation", {
      invitation_hash: hash,
    });
    if (error) throw databaseError(error);
    if (!data)
      throw new AppError(
        422,
        "INVITATION_NOT_VALID",
        "This invitation is expired, revoked, or unavailable. Ask the Owner for a new link.",
      );
    return data;
  }
  async acceptInvitation(token: string, invitationToken: string) {
    const { data, error } = await this.user(token).rpc("accept_invitation", {
      invitation_token: invitationToken,
    });
    if (error) throw databaseError(error);
    return data;
  }
  async invitationCommand(
    token: string,
    operation: string,
    input: unknown,
    key: string,
  ) {
    const { data, error } = await this.user(token).rpc("invitation_command", {
      operation,
      input,
      idempotency_key: key,
    });
    if (error) throw databaseError(error);
    return data;
  }
  async membership(token: string) {
    const { data, error } = await this.user(token).rpc("current_membership");
    if (error) throw databaseError(error);
    if (!data?.length)
      throw new AppError(
        403,
        "ACCESS_PENDING",
        "Your identity has not been approved for this workspace.",
      );
    return data[0] as {
      workspace_id: string;
      role: "Owner" | "Editor" | "Reviewer";
    };
  }
  async list(
    token: string,
    table: string,
    filters: Record<string, string>,
    limit: number,
    cursor?: string,
    projection?: "job-summary",
  ) {
    // Each database read still materializes at most one heavy record. Small
    // full records share a byte/time-bounded HTTP page; a large record travels
    // alone. No field is shortened and no second large row is prefetched.
    const summary = projection === "job-summary" && table === "jobs";
    const heavy = !summary && isHeavyFileTable(table);
    const pageSize = heavy ? 1 : limit;
    const selection: string = summary
      ? "id,workspace_id,type,entity_id,status,attempts,error_code,next_attempt_at,created_at,updated_at,revision,model_round:checkpoint->model_routing->round_attempts,routing_mode:checkpoint->model_routing->mode"
      : table === "restore_sessions"
        ? "id,state,created_at,expires_at,committed_at"
        : table === "generation_plans"
          ? "id,workspace_id,opportunity_id,proposal_id,base_version_id,package_id,kind,stage,status,evidence_revision,input_hash,error_code,created_at,updated_at,revision"
          : table === "workspace_invitations"
            ? "id,workspace_id,email,role,status,expires_at,created_at,revision"
            : "*";
    const client = this.user(token);
    const read = async (after?: string) => {
      let q = client
        .from(table)
        .select(selection)
        .order(table === "model_activity" ? "sequence" : "id", {
          ascending: table !== "model_activity",
        })
        .limit(heavy ? pageSize : pageSize + 1);
      for (const [key, value] of Object.entries(filters)) q = q.eq(key, value);
      if (after)
        q =
          table === "model_activity"
            ? q.lt("sequence", after)
            : q.gt("id", after);
      const { data, error } = await q;
      if (error) throw databaseError(error);
      return (data || []) as unknown as Array<{
        id: string;
        [key: string]: unknown;
      }>;
    };
    if (heavy && table !== "jobs") {
      const records: Array<{ id: string; [key: string]: unknown }> = [];
      const deadline = performance.now() + FULL_LIST_PAGE_MS;
      let remaining = FULL_LIST_PAGE_BYTES,
        after = cursor;
      while (records.length < limit) {
        const [row] = await read(after);
        if (!row) return { records, next_cursor: null };
        const size = jsonBytesUpperBound(row, remaining);
        // Keep a large first row complete; otherwise defer the non-fitting row
        // to the next cursor page. At most 1 MiB plus that one row is retained.
        if (records.length && size > remaining) break;
        records.push(row);
        after = row.id;
        remaining -= size;
        if (remaining <= 0 || performance.now() >= deadline) break;
      }
      return { records, next_cursor: records.at(-1)?.id ?? null };
    }
    const rows = await read(cursor);
    return {
      records: rows.slice(0, pageSize),
      next_cursor: (heavy ? rows.length === pageSize : rows.length > pageSize)
        ? rows[pageSize - 1].id
        : null,
    };
  }
  async one(token: string, table: string, id: string) {
    const { data, error } = await this.user(token)
      .from(table)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw databaseError(error);
    if (!data)
      throw new AppError(
        404,
        "NOT_FOUND",
        "The record does not exist or is inaccessible.",
      );
    return data;
  }
  async command(token: string, operation: string, input: unknown, key: string) {
    const { data, error } = await this.user(token).rpc("app_command", {
      operation,
      input,
      idempotency_key: key,
    });
    if (error) throw databaseError(error);
    return data;
  }
  batchStream(
    token: string,
    commands: unknown[],
    key: string,
    signal: AbortSignal,
  ) {
    return postgrestBatchBody({
      url: this.env.url,
      publishableKey: this.env.publishableKey,
      token,
      commands,
      idempotencyKey: key,
      signal,
    });
  }
  async object(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { data, error } = await this.admin.storage
      .from("tenderdesk-private")
      .download(
        path,
        {},
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        },
      );
    signal?.throwIfAborted();
    if (error || !data)
      throw new AppError(
        422,
        "UPLOAD_NOT_FOUND",
        "The original has not been uploaded.",
      );
    return data;
  }
  /** A genuine404 is represented as absence, never as write settlement or
   * permission to upload again. Durable intent authorization is separate. */
  async deliveryObject(
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    const { data, error } = await this.admin.storage
      .from("tenderdesk-private")
      .download(
        path,
        {},
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        },
      );
    if (error) {
      const status = String(
        (error as { statusCode?: unknown }).statusCode || "",
      );
      if (status === "404") return null;
      throw new AppError(
        503,
        "DELIVERY_STORAGE_UNAVAILABLE",
        "Draft storage could not be read.",
      );
    }
    if (!data)
      throw new AppError(
        503,
        "DELIVERY_STORAGE_UNAVAILABLE",
        "Draft storage returned no bytes.",
      );
    return data;
  }
  async copyOriginalForOcr(source: string, destination: string) {
    const storage = createClient(this.env.url, this.env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(20000) }),
      },
    }).storage;
    const { error } = await storage
      .from("tenderdesk-private")
      .copy(source, destination);
    if (error)
      throw new AppError(
        503,
        "DOCUMENT_OCR_STORAGE_UNAVAILABLE",
        "The OCR original copy is not confirmed.",
      );
  }
  async storeDeliveryObject(
    path: string,
    bytes: Uint8Array,
    mime: string,
    signal?: AbortSignal,
  ) {
    const storage = createClient(this.env.url, this.env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
              : AbortSignal.timeout(20000),
          }),
      },
    }).storage;
    const { error } = await storage
      .from("tenderdesk-private")
      .upload(path, bytes, {
        contentType: mime,
        upsert: false,
      });
    if (error)
      throw new AppError(
        503,
        "DELIVERY_STORAGE_UNAVAILABLE",
        "Draft storage could not confirm the upload.",
      );
  }
  async accept(
    id: string,
    actor: string,
    hash: string,
    size: number,
    text: string,
    status: string,
    key: string,
    coverage?: DocumentCoverage,
  ) {
    const { data, error } = await this.admin.rpc(
      coverage
        ? "accept_uploaded_document_with_coverage"
        : "accept_uploaded_document",
      {
        document_id: id,
        actor_id: actor,
        actual_hash: hash,
        actual_size: size,
        extraction_text: text,
        extraction_status: status,
        command_key: key,
        ...(coverage ? { coverage } : {}),
      },
    );
    if (error) throw databaseError(error);
    return data;
  }
  async extraction(token: string, id: string) {
    const { data, error } = await this.user(token).rpc("upload_extraction", {
      document_id: id,
    });
    if (error) throw databaseError(error);
    return data as string;
  }
  async verifyPages(id: string, pages: number) {
    const { error } = await this.admin.rpc("verify_document_pages", {
      document_id: id,
      actual_pages: pages,
    });
    if (error) throw databaseError(error);
  }
  async download(path: string) {
    const { data, error } = await this.admin.storage
      .from("tenderdesk-private")
      .createSignedUrl(path, 300);
    if (error || !data)
      throw new AppError(
        503,
        "DOWNLOAD_UNAVAILABLE",
        "The original could not be opened.",
      );
    if (!this.env.publicApiUrl) return data.signedUrl;
    try {
      const external = new URL(this.env.publicApiUrl),
        internal = new URL(this.env.url),
        signed = new URL(data.signedUrl);
      if (
        !/^https:\/\/[^/?#]+\/?$/.test(this.env.publicApiUrl) ||
        external.protocol !== "https:" ||
        external.username ||
        external.password ||
        external.pathname !== "/" ||
        external.search ||
        external.hash ||
        internal.username ||
        internal.password ||
        internal.pathname !== "/" ||
        internal.search ||
        internal.hash ||
        signed.username ||
        signed.password ||
        signed.hash ||
        signed.origin !== internal.origin ||
        !signed.pathname.startsWith("/storage/v1/object/sign/") ||
        !signed.searchParams.get("token")
      )
        throw new Error("SIGNED_STORAGE_ORIGIN_INVALID");
      // Keep the exact escaped path and query, including the Storage signature.
      // Only the API origin changes; no privileged key enters the browser URL.
      return external.origin + signed.pathname + signed.search;
    } catch {
      throw new AppError(
        503,
        "DOWNLOAD_UNAVAILABLE",
        "The original could not be opened.",
      );
    }
  }
  async userRpc(token: string, name: string, args: Record<string, unknown>) {
    const { data, error } = await this.user(token).rpc(name, args);
    if (error) throw databaseError(error);
    return data;
  }
  async eligibility(token: string, opportunity: string | null) {
    const { data, error } = await this.user(token).rpc(
      "eligibility_candidates",
      { opportunity },
    );
    if (error) throw databaseError(error);
    return data;
  }
  async status(token: string) {
    const { data, error } = await this.user(token).rpc("workspace_status");
    if (error) throw databaseError(error);
    return data;
  }
  async operations(token: string) {
    const { data, error } = await this.user(token)
      .from("operations")
      .select(
        "last_heartbeat_at,last_source_success_at,scheduler_enabled,last_error_code",
      )
      .maybeSingle();
    if (error) throw databaseError(error);
    return data;
  }
  async removeObject(path: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { data, error } = await Promise.race([
        this.admin.storage.from("tenderdesk-private").remove([path]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  503,
                  "STORAGE_DELETE_FAILED",
                  "Private object cleanup timed out.",
                ),
              ),
            10000,
          );
        }),
      ]);
      if (error)
        throw new AppError(
          503,
          "STORAGE_DELETE_FAILED",
          "Private object cleanup failed.",
        );
      const deleted = Array.isArray(data)
        ? (data.find((value) => value.name === path) as
            Record<string, unknown> | undefined)
        : undefined;
      if (
        !deleted ||
        typeof deleted.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(deleted.id) ||
        typeof deleted.version !== "string" ||
        !deleted.version.length ||
        deleted.is_delete_marker === true
      )
        throw new AppError(
          503,
          "STORAGE_DELETE_RECEIPT_REQUIRED",
          "Storage did not confirm physical deletion of the exact object version. Its allowance remains reserved.",
        );
      return { object_id: deleted.id, object_version: deleted.version };
    } finally {
      clearTimeout(timer);
    }
  }
  async internal(name: string, args: Record<string, unknown> = {}) {
    const { data, error } = await this.admin.rpc(name, args);
    if (error) throw databaseError(error);
    return data;
  }
  async claim() {
    const { data, error } = await this.admin.rpc("claim_backend_job_v6");
    if (error) throw databaseError(error);
    return data;
  }
  async finish(
    id: string,
    lease: string,
    status: string,
    errorCode: string | null,
  ) {
    const { error } = await this.admin.rpc("finish_backend_job", {
      job_id: id,
      lease,
      result_status: status,
      result_error: errorCode,
    });
    if (error) throw databaseError(error);
  }
}
