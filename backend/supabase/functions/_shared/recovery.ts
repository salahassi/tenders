import { z } from "zod";
import { AppError, readJson } from "./http.ts";
import { validateOriginal } from "./originals.ts";
import { uuid } from "./contracts.ts";
import type { Backend } from "./backend.ts";
const key = z.string().regex(/^[a-z_]+\/[0-9a-f-]{36}$/),
  row = z
    .object({
      key,
      data: z.string().max(9437184),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();
export async function recoveryRoute(
  request: Request,
  path: string,
  backend: Backend,
  token: string,
  userId: string,
  role: string,
  headers: Headers,
  respond: (data: unknown, status?: number) => Response,
): Promise<Response | null> {
  if (!path.startsWith("/v1/recovery/")) return null;
  if (role !== "Owner")
    throw new AppError(
      403,
      "ROLE_FORBIDDEN",
      "Only the Owner can back up or restore workspace data.",
    );
  const rpc = (name: string, args: Record<string, unknown> = {}) =>
    backend.userRpc(token, name, args);
  if (path === "/v1/recovery/manifest" && request.method === "GET")
    return respond(await rpc("workspace_backup_manifest"));
  if (path === "/v1/recovery/rows" && request.method === "POST") {
    const input = z
      .object({ keys: z.array(key).min(1).max(30) })
      .strict()
      .parse(await readJson(request, 8192));
    return respond(
      await rpc("workspace_backup_rows", { row_keys: input.keys }),
    );
  }
  if (path === "/v1/recovery/restore" && request.method === "POST") {
    const input = z
      .object({
        manifest: z.record(z.string(), z.unknown()),
        eligibility_attested: z.literal(true),
      })
      .strict()
      .parse(await readJson(request, 20971520));
    return respond(
      await rpc("begin_workspace_restore", {
        backup_manifest: input.manifest,
        eligibility_attested: true,
      }),
      201,
    );
  }
  const restore = path.match(
    /^\/v1\/recovery\/restore\/([^/]+)\/(rows|commit|cancel)$/,
  );
  if (restore && request.method === "POST") {
    const id = uuid.parse(restore[1]);
    if (restore[2] === "rows") {
      const input = z
        .object({ items: z.array(row).min(1).max(30) })
        .strict()
        .parse(await readJson(request, 23068672));
      return respond(
        await rpc("stage_restore_rows", { restore_id: id, items: input.items }),
      );
    }
    return respond(
      await rpc(
        restore[2] === "commit"
          ? "commit_workspace_restore"
          : "cancel_workspace_restore",
        { restore_id: id },
      ),
    );
  }
  const file = path.match(
      /^\/v1\/recovery\/files\/(documents|export_artifacts)\/([^/]+)$/,
    ),
    complete = path.match(/^\/v1\/recovery\/restore-files\/([^/]+)\/complete$/);
  if (
    (file && request.method === "GET") ||
    (complete && request.method === "POST")
  ) {
    const id = uuid.parse((file || complete)![file ? 2 : 1]),
      context = complete
        ? await rpc("restore_file_context", { file_id: id })
        : await rpc("recovery_file_context", {
            file_kind: file![1],
            file_id: id,
          });
    const blob = await backend.object(context.storage_key),
      size = Number(context.size ?? context.expected_size),
      expectedHash = context.hash ?? context.content_hash;
    if (blob.size !== size || blob.size > 10485760)
      throw new AppError(
        422,
        "BACKUP_FILE_HASH_MISMATCH",
        "The stored file differs from the backup manifest.",
      );
    const bytes = new Uint8Array(await blob.arrayBuffer()),
      hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    if (hash !== expectedHash)
      throw new AppError(
        422,
        "BACKUP_FILE_HASH_MISMATCH",
        "The stored file differs from the backup manifest.",
      );
    if (complete) {
      validateOriginal(context.original_name, context.mime_type, bytes);
      return respond(
        await backend.internal("complete_restore_file", {
          file_id: id,
          actor_id: userId,
          actual_hash: hash,
          actual_size: bytes.length,
        }),
      );
    }
    const latest = await rpc("recovery_file_context", {
      file_kind: file![1],
      file_id: id,
    });
    if (latest.hash !== hash || latest.storage_key !== context.storage_key)
      throw new AppError(
        409,
        "BACKUP_SOURCE_CHANGED",
        "The original changed during backup.",
      );
    const out = new Headers(headers);
    out.set("content-type", context.mime);
    out.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(context.name)}`,
    );
    out.set("content-length", String(bytes.length));
    return new Response(bytes, { headers: out });
  }
  throw new AppError(404, "NOT_FOUND", "Recovery action not found.");
}
