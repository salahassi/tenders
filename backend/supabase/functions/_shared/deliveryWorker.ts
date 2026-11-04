import {
  assertStorageWriteMayStart,
  authorizeStorageWrite,
} from "./storageWrites.ts";
import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";
import {
  buildDeliveryExport,
  deliveryRendererVersion,
  DOCX_MIME,
  type DeliveryVolume,
} from "./deliveryExport.ts";
import { verifyOwnedExportDocxSnapshot, type RenderModel } from "./export.ts";
import { docxDigest } from "./deliveryVerifyProtocol.ts";
import { renderDeliveryIsolated } from "./deliveryRenderIsolation.ts";
import { DeliveryWorkBudget } from "./deliveryWorkBudget.ts";

export interface VerifiedDeliveryBytes {
  bytes: Uint8Array;
  hash: string;
  size: number;
}
const byteProofs = new WeakMap<
  VerifiedDeliveryBytes,
  { hash: string; size: number; modelHash: string }
>();
/** The private receipt binds exact bytes and the full current model. Caller-made
 * receipts and later model/receipt mutation cannot skip current verification. */
export async function deliveryBytes(
  blob: Blob | Uint8Array,
  model: RenderModel,
  signal?: AbortSignal,
  prior?: VerifiedDeliveryBytes,
): Promise<VerifiedDeliveryBytes> {
  signal?.throwIfAborted();
  // Snapshot model identity before any asynchronous Blob read. This outer
  // function returns directly, so its caller-owned model/Blob are not retained
  // in the verification suspension frame.
  const modelJson = JSON.stringify(model);
  const input =
    blob instanceof Uint8Array ? new Uint8Array(blob) : blob.arrayBuffer();
  return completeDeliveryByteSnapshot(input, modelJson, signal, prior);
}

async function completeDeliveryByteSnapshot(
  input: Uint8Array | Promise<ArrayBuffer>,
  modelJson: string,
  signal?: AbortSignal,
  prior?: VerifiedDeliveryBytes,
): Promise<VerifiedDeliveryBytes> {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(await input);
  if (!bytes.length || bytes.length > 10485760)
    throw new AppError(
      422,
      "DELIVERY_ARTIFACT_INVALID",
      "The draft file is outside the supported size.",
    );
  signal?.throwIfAborted();
  const hash = await docxDigest(bytes),
    modelHash = await docxDigest(new TextEncoder().encode(modelJson));
  signal?.throwIfAborted();
  const proof = prior && byteProofs.get(prior);
  if (
    !proof ||
    proof.hash !== hash ||
    proof.size !== bytes.length ||
    proof.modelHash !== modelHash
  ) {
    const verification = verifyOwnedExportDocxSnapshot(
      bytes,
      modelJson,
      signal,
    );
    modelJson = "";
    await verification;
  }
  signal?.throwIfAborted();
  const result = { bytes, hash, size: bytes.length };
  byteProofs.set(result, { hash, size: bytes.length, modelHash });
  return result;
}

/** One leased job handles the immutable required volume set. Re-entry validates
 * stored bytes first, so upload-response loss never causes overwrite or a new
 * logical artifact. No part of this path calls a model or grants approval. */
export async function processDeliveryExport(
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
    let context = await backend.internal("delivery_export_context", identity);
    budget.observe(context, contextStarted);
    if (job.checkpoint?.issuance_request_id) {
      const stateStarted = performance.now();
      const state = await backend.internal(
        "proposal_issuance_job_state",
        identity,
      );
      if (!state || state.id !== job.checkpoint.issuance_request_id)
        throw new AppError(
          409,
          "DELIVERY_ARTIFACT_INVALID",
          "The accepted issuance identity changed.",
        );
      if (state.outcome !== "active")
        throw new AppError(
          409,
          state.error_code || "PROPOSAL_ISSUANCE_CLOSED",
          "The accepted issuance request is closed.",
        );
      budget.observe(state, stateStarted, "PROPOSAL_ISSUANCE_TIMEOUT");
    }
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
      let verified: VerifiedDeliveryBytes | undefined;
      let blob = await backend.deliveryObject(
        artifact.storage_key,
        budget.signal,
      );
      budget.check();
      if (!blob) {
        if (artifact.status === "ready")
          throw new AppError(
            422,
            "DELIVERY_ARTIFACT_INVALID",
            "The verified draft file is missing.",
          );
        assertStorageWriteMayStart(artifact.write_state);
        budget.check();
        const rendered = await deliveryBytes(
          await render(model, budget.signal),
          model,
          budget.signal,
        );
        verified = rendered;
        budget.check();
        // Recheck lease and current source/actor after CPU work and before storage side effects.
        contextStarted = performance.now();
        context = await backend.internal("delivery_export_context", identity);
        budget.observe(context, contextStarted);
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
        await authorizeStorageWrite(
          backend,
          identity,
          artifact.storage_key,
          rendered,
        );
        budget.check();
        try {
          await backend.storeDeliveryObject(
            artifact.storage_key,
            rendered.bytes,
            DOCX_MIME,
            budget.signal,
          );
        } catch {
          // Existing-object conflicts and lost upload replies are safe only if
          // independently fetched bytes pass the exact current content checks.
          blob = await backend.deliveryObject(
            artifact.storage_key,
            budget.signal,
          );
          if (!blob)
            throw new AppError(
              503,
              "DELIVERY_STORAGE_UNAVAILABLE",
              "The draft upload is not confirmed.",
            );
        }
        if (!blob)
          blob = await backend.deliveryObject(
            artifact.storage_key,
            budget.signal,
          );
        if (!blob)
          throw new AppError(
            503,
            "DELIVERY_STORAGE_UNAVAILABLE",
            "The draft upload is not confirmed.",
          );
      }
      const actual = await deliveryBytes(blob, model, budget.signal, verified);
      budget.check();
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
    const cause = budget.signal.aborted ? budget.signal.reason : error;
    const code =
      cause instanceof AppError ? cause.code : "DELIVERY_RENDER_FAILED";
    await backend.internal("fail_delivery_export", {
      ...identity,
      error_code: code,
    });
    return { error_code: code };
  } finally {
    budget.dispose();
  }
}
