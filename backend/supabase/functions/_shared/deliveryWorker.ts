import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";
import {
  buildDeliveryExport,
  deliveryRendererVersion,
  DOCX_MIME,
  type DeliveryVolume,
} from "./deliveryExport.ts";
import { verifyExportDocxAsync, type RenderModel } from "./export.ts";
import { renderDeliveryIsolated } from "./deliveryRenderIsolation.ts";

export async function deliveryBytes(
  blob: Blob | Uint8Array,
  model: RenderModel,
) {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length || bytes.length > 10485760)
    throw new AppError(
      422,
      "DELIVERY_ARTIFACT_INVALID",
      "The draft file is outside the supported size.",
    );
  await verifyExportDocxAsync(bytes, model);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  return { bytes, hash, size: bytes.length };
}

/** One leased job handles the immutable required volume set. Re-entry validates
 * stored bytes first, so upload-response loss never causes overwrite or a new
 * logical artifact. No part of this path calls a model or grants approval. */
export async function processDeliveryExport(
  backend: Backend,
  job: Record<string, any>,
  render: (model: RenderModel) => Promise<Uint8Array> = renderDeliveryIsolated,
) {
  const identity = { job_id: job.id, lease: job.lease_token };
  try {
    let context = await backend.internal("delivery_export_context", identity);
    if (context.renderer_version !== deliveryRendererVersion(context.snapshot))
      throw new AppError(
        409,
        "DELIVERY_RENDERER_UNSUPPORTED",
        "The saved renderer version is not supported.",
      );
    const expected = context.snapshot.payload.separate_volumes
      ? ["technical", "financial"]
      : ["combined"];
    if (
      !Array.isArray(context.artifacts) ||
      context.artifacts.length !== expected.length ||
      new Set(context.artifacts.map((artifact: any) => artifact.volume))
        .size !== expected.length ||
      context.artifacts.some(
        (artifact: any) => !expected.includes(artifact.volume),
      )
    )
      throw new AppError(
        422,
        "DELIVERY_ARTIFACT_INVALID",
        "The required draft volume set is incomplete.",
      );
    for (const artifact of context.artifacts) {
      const model = buildDeliveryExport(
        context.snapshot,
        artifact.volume as DeliveryVolume,
      );
      let blob = await backend.deliveryObject(artifact.storage_key);
      if (!blob) {
        if (artifact.status === "ready")
          throw new AppError(
            422,
            "DELIVERY_ARTIFACT_INVALID",
            "The verified draft file is missing.",
          );
        const rendered = await deliveryBytes(await render(model), model);
        // Recheck lease and current source/actor after CPU work and before storage side effects.
        context = await backend.internal("delivery_export_context", identity);
        const current = context.artifacts.find(
          (item: any) => item.id === artifact.id,
        );
        if (
          !current ||
          current.storage_key !== artifact.storage_key ||
          context.snapshot.id !== model.id
        )
          throw new AppError(
            409,
            "DELIVERY_ARTIFACT_INVALID",
            "The draft reservation changed.",
          );
        try {
          await backend.storeDeliveryObject(
            artifact.storage_key,
            rendered.bytes,
            DOCX_MIME,
          );
        } catch {
          // Existing-object conflicts and lost upload replies are safe only if
          // independently fetched bytes pass the exact current content checks.
          blob = await backend.deliveryObject(artifact.storage_key);
          if (!blob)
            throw new AppError(
              503,
              "DELIVERY_STORAGE_UNAVAILABLE",
              "The draft upload is not confirmed.",
            );
        }
        if (!blob) blob = await backend.deliveryObject(artifact.storage_key);
        if (!blob)
          throw new AppError(
            503,
            "DELIVERY_STORAGE_UNAVAILABLE",
            "The draft upload is not confirmed.",
          );
      }
      const actual = await deliveryBytes(blob, model);
      if (
        (artifact.content_hash && artifact.content_hash !== actual.hash) ||
        (artifact.expected_size &&
          Number(artifact.expected_size) !== actual.size)
      )
        throw new AppError(
          422,
          "DELIVERY_ARTIFACT_INVALID",
          "The saved draft bytes have changed.",
        );
      await backend.internal("complete_delivery_artifact", {
        ...identity,
        artifact_id: artifact.id,
        actual_hash: actual.hash,
        actual_size: actual.size,
      });
    }
    return await backend.internal("finish_delivery_export", identity);
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : "DELIVERY_RENDER_FAILED";
    await backend.internal("fail_delivery_export", {
      ...identity,
      error_code: code,
    });
    return { error_code: code };
  }
}
