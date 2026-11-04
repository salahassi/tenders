import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";

/** Missing bytes cannot reopen an already consumed one-time PUT permission. */
export function assertStorageWriteMayStart(state: unknown) {
  if (typeof state === "string" && state !== "unstarted")
    throw new AppError(
      503,
      "DELIVERY_STORAGE_UNAVAILABLE",
      "A previous upload is not yet settled. Its storage allowance remains reserved.",
    );
}

export async function authorizeStorageWrite(
  backend: Backend,
  identity: { job_id: string; lease: string },
  key: string,
  bytes: { hash: string; size: number },
) {
  const result = await backend.internal("begin_render_storage_write", {
    ...identity,
    storage_key: key,
    expected_hash: bytes.hash,
    expected_size: bytes.size,
  });
  if (result?.send !== true)
    throw new AppError(
      503,
      "DELIVERY_STORAGE_UNAVAILABLE",
      "The upload permission was already consumed. A missing object does not authorize another write.",
    );
}

/** Return true only after a known single PUT has settled, or an explicit
 * quiescence reconciliation has retired the key. Bare404 never settles a PUT. */
export async function prepareStorageCleanup(
  backend: Backend,
  item: { id: string; lease_token: string; storage_key: string },
): Promise<"delete" | "complete" | "deferred"> {
  const identity = { cleanup_id: item.id, lease: item.lease_token };
  let context = await backend.internal("storage_cleanup_context", identity);
  if (!context || context.storage_key !== item.storage_key)
    throw new AppError(
      409,
      "STORAGE_WRITE_PROVENANCE_REQUIRED",
      "The cleanup write provenance is unavailable.",
    );
  if (context.can_delete === true)
    return context.delete_required === true ? "delete" : "complete";
  if (context.write_state === "unknown") {
    try {
      const blob = await backend.deliveryObject(item.storage_key);
      if (
        blob &&
        blob.size >= 1 &&
        blob.size <= 10485760 &&
        blob.size === Number(context.expected_size)
      ) {
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          ),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
        if (hash === context.expected_hash) {
          context = await backend.internal("observe_cleanup_storage_write", {
            ...identity,
            actual_hash: hash,
            actual_size: blob.size,
          });
          if (context?.can_delete === true) return "delete";
        }
      }
    } catch {
      // Read failure, mismatch or absent bytes preserves uncertain accounting.
      // The canonical defer call below rechecks the current cleanup lease.
    }
  }
  await backend.internal("defer_storage_cleanup", identity);
  return "deferred";
}
