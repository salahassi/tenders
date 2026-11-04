import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";
import { DOCX_MIME } from "./deliveryExport.ts";
import { buildExportModel, type RenderModel } from "./export.ts";
import { deliveryBytes } from "./deliveryWorker.ts";
import { renderDeliveryIsolated } from "./deliveryRenderIsolation.ts";

/** Ordinary approved/draft exports use their original canonical export request.
 * A leased server job owns every volume; ready bytes are reused after a crash. */
export async function processOrdinaryExport(
  backend: Backend,
  job: Record<string, any>,
  render: (model: RenderModel) => Promise<Uint8Array> = renderDeliveryIsolated,
) {
  const identity = { job_id: job.id, lease: job.lease_token };
  try {
    let context = await backend.internal("export_render_context", identity);
    const expected = context.package.required_volumes;
    if (
      context.renderer_version !== "ordinary-2" ||
      !Array.isArray(expected) ||
      !Array.isArray(context.volumes) ||
      context.volumes.length !== expected.length ||
      new Set(context.volumes.map((slot: any) => slot.volume)).size !==
        expected.length ||
      context.volumes.some((slot: any) => !expected.includes(slot.volume))
    )
      throw new AppError(
        422,
        "EXPORT_PACKAGE_INVALID",
        "The required export volume set is incomplete.",
      );
    for (const slot of context.volumes) {
      const model = buildExportModel(slot.request, 2);
      let blob = await backend.deliveryObject(slot.storage_key);
      if (!blob) {
        if (slot.artifact)
          throw new AppError(
            422,
            "EXPORT_PACKAGE_BYTES_UNAVAILABLE",
            "The verified export file is unavailable.",
          );
        const rendered = await deliveryBytes(await render(model), model);
        context = await backend.internal("export_render_context", identity);
        const current = context.volumes.find(
          (item: any) => item.id === slot.id,
        );
        if (
          !current ||
          current.storage_key !== slot.storage_key ||
          current.export_id !== model.id
        )
          throw new AppError(
            409,
            "EXPORT_PACKAGE_INVALID",
            "The export reservation changed.",
          );
        try {
          await backend.storeDeliveryObject(
            slot.storage_key,
            rendered.bytes,
            DOCX_MIME,
          );
        } catch {
          blob = await backend.deliveryObject(slot.storage_key);
          if (!blob)
            throw new AppError(
              503,
              "DELIVERY_STORAGE_UNAVAILABLE",
              "The export upload is not confirmed.",
            );
        }
        if (!blob) blob = await backend.deliveryObject(slot.storage_key);
        if (!blob)
          throw new AppError(
            503,
            "DELIVERY_STORAGE_UNAVAILABLE",
            "The export upload is not confirmed.",
          );
      }
      const actual = await deliveryBytes(blob, model);
      if (
        slot.artifact &&
        (slot.artifact.content_hash !== actual.hash ||
          Number(slot.artifact.expected_size) !== actual.size)
      )
        throw new AppError(
          422,
          "ARTIFACT_MISMATCH",
          "The saved export bytes have changed.",
        );
      await backend.internal("complete_export_package_volume", {
        ...identity,
        slot_id: slot.id,
        actual_hash: actual.hash,
        actual_size: actual.size,
      });
    }
    return await backend.internal("finish_export_package", identity);
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : "DELIVERY_RENDER_FAILED";
    await backend.internal("fail_export_package", {
      ...identity,
      error_code: code,
    });
    return { error_code: code };
  }
}
