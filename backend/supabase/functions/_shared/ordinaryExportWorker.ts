import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";
import { DOCX_MIME } from "./deliveryExport.ts";
import { buildExportModel, type RenderModel } from "./export.ts";
import { deliveryBytes, type VerifiedDeliveryBytes } from "./deliveryWorker.ts";
import { renderDeliveryIsolated } from "./deliveryRenderIsolation.ts";
import { DeliveryWorkBudget } from "./deliveryWorkBudget.ts";

/** Ordinary approved/draft exports use their original canonical export request.
 * A leased server job owns every volume; ready bytes are reused after a crash. */
export async function processOrdinaryExport(
  backend: Backend,
  job: Record<string, any>,
  render: (model: RenderModel, signal?: AbortSignal) => Promise<Uint8Array> = (
    model,
    signal,
  ) => renderDeliveryIsolated(model, undefined, 30_000, signal),
) {
  const identity = { job_id: job.id, lease: job.lease_token };
  const budget = new DeliveryWorkBudget();
  try {
    let contextStarted = performance.now();
    let context = await backend.internal("export_render_context", identity);
    budget.observe(
      { ...context, deadline_at: context.package?.deadline_at },
      contextStarted,
      "EXPORT_ISSUANCE_TIMEOUT",
    );
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
      let verified: VerifiedDeliveryBytes | undefined;
      let blob = await backend.deliveryObject(slot.storage_key);
      budget.check();
      if (!blob) {
        if (slot.artifact)
          throw new AppError(
            422,
            "EXPORT_PACKAGE_BYTES_UNAVAILABLE",
            "The verified export file is unavailable.",
          );
        budget.check();
        const rendered = await deliveryBytes(
          await render(model, budget.signal),
          model,
          budget.signal,
        );
        verified = rendered;
        budget.check();
        contextStarted = performance.now();
        context = await backend.internal("export_render_context", identity);
        budget.observe(
          { ...context, deadline_at: context.package?.deadline_at },
          contextStarted,
          "EXPORT_ISSUANCE_TIMEOUT",
        );
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
      const actual = await deliveryBytes(blob, model, budget.signal, verified);
      budget.check();
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
  } finally {
    budget.dispose();
  }
}
