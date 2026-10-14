import { Backend, type BackendEnvironment } from "../_shared/backend.ts";
import {
  commandSchemas,
  completeUploadSchema,
  uuid,
  type CommandName,
} from "../_shared/contracts.ts";
import { AppError, corsHeaders, readJson } from "../_shared/http.ts";
import { validateOriginal } from "../_shared/originals.ts";

const readTables: Record<string, string> = {
  sources: "sources",
  opportunities: "opportunities",
  knowledge: "knowledge_items",
  jobs: "jobs",
  notifications: "notifications",
  "audit-events": "audit_events",
  proposals: "proposals",
};
const routeCommands: Array<{
  method: string;
  pattern: RegExp;
  command: CommandName;
  idField?: string;
}> = [
  { method: "POST", pattern: /^\/v1\/sources$/, command: "source.create" },
  {
    method: "POST",
    pattern: /^\/v1\/sources\/([^/]+)\/actions$/,
    command: "source.action",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/opportunities$/,
    command: "opportunity.create",
  },
  {
    method: "POST",
    pattern: /^\/v1\/opportunities\/([^/]+)\/decision$/,
    command: "opportunity.decision",
    idField: "id",
  },
  { method: "POST", pattern: /^\/v1\/knowledge$/, command: "knowledge.save" },
  {
    method: "PATCH",
    pattern: /^\/v1\/knowledge\/([^/]+)$/,
    command: "knowledge.save",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/knowledge\/([^/]+)\/verify$/,
    command: "knowledge.verify",
    idField: "id",
  },
  {
    method: "PUT",
    pattern: /^\/v1\/proposals\/([^/]+)\/review-inputs$/,
    command: "review.save",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals\/([^/]+)\/regenerate$/,
    command: "proposal.regenerate",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/documents\/prepare-upload$/,
    command: "document.prepare",
  },
  {
    method: "PATCH",
    pattern: /^\/v1\/notifications\/([^/]+)$/,
    command: "notification.read",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/memberships\/actions$/,
    command: "membership.set",
  },
];

export function createApiHandler(
  env: BackendEnvironment,
  factory = () => new Backend(env),
) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    const respond = (
      data: unknown,
      status = 200,
      meta: Record<string, unknown> = {},
    ) =>
      new Response(
        JSON.stringify({ data, meta: { request_id: requestId, ...meta } }),
        { status, headers },
      );
    try {
      headers = corsHeaders(request, env.allowedOrigins);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const url = new URL(request.url),
        path = url.pathname.replace(/^\/(?:functions\/v1\/)?api(?=\/)/, "");
      if (path === "/v1/health" && request.method === "GET")
        return respond({ status: "available" });
      const token = request.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token)
        throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
      const backend = factory();
      const user = await backend.authenticate(token);
      const membership = await backend.membership(token);
      if (path === "/v1/bootstrap" && request.method === "GET")
        return respond({
          mode: "CONNECTED_FREE",
          membership,
          operations: await backend.operations(token),
          model: { enabled: false, blocker: "MODEL_NOT_CONFIGURED" },
        });
      const read = path.match(/^\/v1\/([a-z-]+)(?:\/([^/]+))?$/);
      if (request.method === "GET" && read && readTables[read[1]]) {
        if (read[2]) {
          const id = uuid.parse(read[2]);
          const record = await backend.one(token, readTables[read[1]], id);
          return respond(record, 200, { revision: record.revision });
        }
        const limit = Number(url.searchParams.get("limit") || 25);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(
            400,
            "INVALID_PAGINATION",
            "Limit must be between 1 and 100.",
          );
        const cursor = url.searchParams.get("cursor") || undefined;
        if (cursor) uuid.parse(cursor);
        const filters: Record<string, string> = {};
        const decision = url.searchParams.get("decision");
        if (decision && read[1] === "opportunities") {
          if (
            !["undecided", "shortlisted", "deferred", "declined"].includes(
              decision,
            )
          )
            throw new AppError(
              400,
              "INVALID_FILTER",
              "Unknown opportunity decision.",
            );
          filters.decision = decision;
        }
        return respond(
          await backend.list(
            token,
            readTables[read[1]],
            filters,
            limit,
            cursor,
          ),
        );
      }
      const downloads = path.match(/^\/v1\/documents\/([^/]+)\/download$/);
      if (request.method === "GET" && downloads) {
        const document = await backend.one(
          token,
          "documents",
          uuid.parse(downloads[1]),
        );
        if (["pending", "expired"].includes(document.status))
          throw new AppError(
            422,
            "DOCUMENT_NOT_READY",
            "The original is not available yet.",
          );
        return respond({
          url: await backend.download(document.storage_key),
          expires_in: 300,
        });
      }
      const complete = path.match(
        /^\/v1\/documents\/([^/]+)\/complete-upload$/,
      );
      const key = request.headers.get("idempotency-key");
      if (!key || key.length > 200)
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Supply an Idempotency-Key of at most 200 characters.",
        );
      if (request.method === "POST" && complete) {
        if (membership.role === "Reviewer")
          throw new AppError(
            403,
            "ROLE_FORBIDDEN",
            "Your role cannot upload files.",
          );
        const id = uuid.parse(complete[1]),
          input = completeUploadSchema.parse(await readJson(request));
        const document = await backend.one(token, "documents", id);
        if (document.created_by !== user.id)
          throw new AppError(
            403,
            "ROLE_FORBIDDEN",
            "Only the uploader can accept this original.",
          );
        const original = await backend.object(document.storage_key);
        if (original.size !== Number(document.expected_size))
          throw new AppError(
            422,
            "UPLOAD_MISMATCH",
            "The uploaded size does not match the reservation.",
          );
        const bytes = new Uint8Array(await original.arrayBuffer());
        validateOriginal(document.original_name, document.mime_type, bytes);
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        const data = await backend.accept(
          id,
          user.id,
          hash,
          bytes.length,
          input.extracted_text,
          input.status,
          key,
        );
        return respond(data, 200, { revision: data.revision });
      }
      for (const route of routeCommands) {
        const match = path.match(route.pattern);
        if (!match || request.method !== route.method) continue;
        const raw = await readJson(request);
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new AppError(400, "INVALID_INPUT", "Supply a JSON object.");
        if (route.idField && route.idField in raw)
          throw new AppError(
            400,
            "INVALID_INPUT",
            "The record ID belongs in the route only.",
          );
        const input = commandSchemas[route.command].parse({
          ...raw,
          ...(route.idField ? { [route.idField]: uuid.parse(match[1]) } : {}),
        });
        const data = await backend.command(token, route.command, input, key);
        if (route.command === "document.prepare")
          return respond(
            {
              ...data,
              bucket: "tenderdesk-private",
              upload_path: data.storage_key,
              upload_expires_at: new Date(
                new Date(data.created_at).getTime() + 15 * 60 * 1000,
              ).toISOString(),
              upload_method: "authenticated_storage",
            },
            201,
            { revision: data.revision },
          );
        return respond(
          data,
          route.command === "proposal.regenerate"
            ? 202
            : request.method === "POST" && !route.idField
              ? 201
              : 200,
          { revision: data.revision },
        );
      }
      throw new AppError(
        503,
        "CAPABILITY_NOT_ACTIVE",
        "This workflow has not been activated. Existing records are preserved.",
      );
    } catch (error) {
      const invalid = error && typeof error === "object" && "issues" in error;
      const e =
        error instanceof AppError
          ? error
          : invalid
            ? new AppError(400, "INVALID_INPUT", "Check the request fields.")
            : new AppError(
                503,
                "SERVICE_UNAVAILABLE",
                "The request could not be completed.",
                null,
                true,
              );
      return new Response(
        JSON.stringify({
          error: {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            details: e.details,
          },
          request_id: requestId,
        }),
        { status: e.status, headers },
      );
    }
  };
}
