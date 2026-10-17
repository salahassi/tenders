import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError, databaseError } from "./http.ts";
import { MODEL_PROVIDER_IDS, type ModelProviderId } from "./modelProviders.ts";
export type ModelEnvironmentSlot = {
  provider: string;
  model: string;
  projectRef: string;
  key: string;
};
export interface BackendEnvironment {
  url: string;
  publishableKey: string;
  serviceKey: string;
  allowedOrigins: string[];
  workerSecret: string;
  collectionHosts?: string[];
  models: Record<ModelProviderId, ModelEnvironmentSlot>;
}
const SECRET_PREFIX: Record<ModelProviderId, string> = {
  gemini_free: "APP_MODEL_GEMINI",
  qwen_free: "APP_MODEL_QWEN",
  groq_free: "APP_MODEL_GROQ",
  mistral_free: "APP_MODEL_MISTRAL",
  cloudflare_free: "APP_MODEL_CLOUDFLARE",
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
        (legacyProvider === provider ? legacyProject : ""),
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
    models: modelEnvironments(get),
    collectionHosts: (get("APP_COLLECTION_HOSTS") || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  };
}
export class Backend {
  private admin: SupabaseClient;
  constructor(private env: BackendEnvironment) {
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
  ) {
    const selection: string =
      table === "restore_sessions"
        ? "id,state,created_at,expires_at,committed_at"
        : table === "generation_plans"
          ? "id,workspace_id,opportunity_id,proposal_id,base_version_id,package_id,kind,stage,status,evidence_revision,input_hash,error_code,created_at,updated_at,revision"
          : table === "workspace_invitations"
            ? "id,workspace_id,email,role,status,expires_at,created_at,revision"
            : "*";
    let q = this.user(token)
      .from(table)
      .select(selection)
      .order("id", { ascending: true })
      .limit(limit + 1);
    for (const [key, value] of Object.entries(filters)) q = q.eq(key, value);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw databaseError(error);
    const rows = (data || []) as unknown as Array<{
      id: string;
      [key: string]: unknown;
    }>;
    return {
      records: rows.slice(0, limit),
      next_cursor: rows.length > limit ? rows[limit - 1].id : null,
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
  async batch(token: string, commands: unknown[], key: string) {
    const { data, error } = await this.user(token).rpc("app_batch", {
      commands,
      idempotency_key: key,
    });
    if (error) throw databaseError(error);
    return data;
  }
  async object(path: string) {
    const { data, error } = await this.admin.storage
      .from("tenderdesk-private")
      .download(path);
    if (error || !data)
      throw new AppError(
        422,
        "UPLOAD_NOT_FOUND",
        "The original has not been uploaded.",
      );
    return data;
  }
  async accept(
    id: string,
    actor: string,
    hash: string,
    size: number,
    text: string,
    status: string,
    key: string,
  ) {
    const { data, error } = await this.admin.rpc("accept_uploaded_document", {
      document_id: id,
      actor_id: actor,
      actual_hash: hash,
      actual_size: size,
      extraction_text: text,
      extraction_status: status,
      command_key: key,
    });
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
    return data.signedUrl;
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
      const { error } = await Promise.race([
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
    const { data, error } = await this.admin.rpc("claim_backend_job");
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
