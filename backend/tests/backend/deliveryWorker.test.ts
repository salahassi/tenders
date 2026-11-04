import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { processDeliveryExport } from "../../supabase/functions/_shared/deliveryWorker.ts";
import {
  buildDeliveryExport,
  DOCX_MIME,
} from "../../supabase/functions/_shared/deliveryExport.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(separate = false) {
  const fontData = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
  const snapshot = {
    id: id(1),
    ordinal: 1,
    created_at: "2026-11-04T00:00:00Z",
    payload: {
      version: 1,
      title: "Operations proposal",
      language: "en",
      template: {},
      separate_volumes: separate,
      input_state: "available",
      content_state: "source_draft",
      assurance_state: "unreviewed",
      substantive_complete: false,
      approval_state: "draft",
      notice: "Response preparation is pending.",
      source_manifest: [],
      input_materials: {},
      sections: [
        {
          section_key: "response",
          title: "Response",
          volume: "technical",
          kind: "response",
          source_ids: [],
          provenance: null,
          content_blocks: [{ type: "placeholder", gap_id: "response" }],
        },
        {
          section_key: "price",
          title: "Price",
          volume: "financial",
          kind: "response",
          source_ids: [],
          provenance: null,
          content_blocks: [{ type: "placeholder", gap_id: "price" }],
        },
      ],
      gaps: ["response", "price"].map((key) => ({
        id: key,
        section_key: key,
        field_path: key,
        reason: "RESPONSE_NOT_PREPARED",
        label: `Required: ${key}`,
        required_for: "substantive_completion",
        source_ids: [],
      })),
    },
  };
  const artifacts = (separate ? ["technical", "financial"] : ["combined"]).map(
    (volume, index) => ({
      id: id(index + 2),
      snapshot_id: snapshot.id,
      volume,
      status: "pending",
      storage_key: `private/delivery/${id(index + 2)}`,
      write_state: "unstarted",
      content_hash: null as string | null,
      expected_size: null as number | null,
    }),
  );
  const context = {
    snapshot,
    artifacts,
    renderer_version: "1",
    server_now: new Date().toISOString(),
    lease_until: new Date(Date.now() + 600_000).toISOString(),
  };
  const objects = new Map<string, Blob>();
  const state = {
    loseUploadReply: false,
    failCompleteOnce: false,
    rejectContextAfterRender: false,
    contexts: 0,
    completed: false,
  };
  const backend: any = {
    internal: vi.fn(async (name: string, args: any) => {
      if (name === "delivery_export_context") {
        state.contexts++;
        if (state.rejectContextAfterRender && state.contexts > 1)
          throw new AppError(403, "ROLE_FORBIDDEN", "Revoked");
        return structuredClone(context);
      }
      if (name === "begin_render_storage_write") {
        const a = artifacts.find(
          (item) => item.storage_key === args.storage_key,
        )!;
        const send = a.write_state === "unstarted";
        if (send) a.write_state = "unknown";
        return { send, state: a.write_state };
      }
      if (name === "complete_delivery_artifact") {
        if (state.failCompleteOnce) {
          state.failCompleteOnce = false;
          throw new AppError(503, "DATABASE_TEMPORARY_FAILURE", "Retry");
        }
        Object.assign(
          artifacts.find((item) => item.id === args.artifact_id)!,
          {
            status: "ready",
            write_state: "observed",
            content_hash: args.actual_hash,
            expected_size: args.actual_size,
          },
        );
        return {};
      }
      if (name === "finish_delivery_export") {
        expect(artifacts.every((item) => item.status === "ready")).toBe(true);
        state.completed = true;
        return { processed: true };
      }
      if (name === "fail_delivery_export") return {};
      throw Error(`Unexpected RPC ${name}`);
    }),
    deliveryObject: vi.fn(async (path: string) => objects.get(path) || null),
    storeDeliveryObject: vi.fn(
      async (path: string, bytes: Uint8Array, mime: string) => {
        expect(mime).toBe(DOCX_MIME);
        expect(objects.has(path)).toBe(false);
        objects.set(path, new Blob([new Uint8Array(bytes)]));
        if (state.loseUploadReply) throw Error("reply lost");
      },
    ),
  };
  const render = vi.fn(
    async (model) =>
      new Uint8Array(await (await renderDocx(model, fontData)).arrayBuffer()),
  );
  const job = { id: id(9), lease_token: id(10) };
  return { backend, context, objects, state, render, job, artifacts };
}

it("recovers a committed upload after lost response without rendering or uploading twice", async () => {
  const f = await fixture();
  f.state.loseUploadReply = true;
  await expect(
    processDeliveryExport(f.backend, f.job, f.render),
  ).resolves.toEqual({ processed: true });
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.backend.storeDeliveryObject).toHaveBeenCalledTimes(1);
  expect(f.artifacts[0].status).toBe("ready");
});

it("reuses independently verified stored bytes after completion transaction failure and lease restart", async () => {
  const f = await fixture();
  f.state.failCompleteOnce = true;
  await expect(
    processDeliveryExport(f.backend, f.job, f.render),
  ).resolves.toEqual({ error_code: "DATABASE_TEMPORARY_FAILURE" });
  expect(f.state.completed).toBe(false);
  await processDeliveryExport(
    f.backend,
    { ...f.job, lease_token: id(11) },
    f.render,
  );
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.backend.storeDeliveryObject).toHaveBeenCalledTimes(1);
  expect(f.state.completed).toBe(true);
});

it("preserves the first volume and completes only after the second has recovered", async () => {
  const f = await fixture(true);
  const good = f.render.getMockImplementation()!;
  f.render
    .mockImplementationOnce(good)
    .mockRejectedValueOnce(Error("renderer unavailable"));
  await processDeliveryExport(f.backend, f.job, f.render);
  expect(f.artifacts.map((item) => item.status)).toEqual(["ready", "pending"]);
  expect(f.state.completed).toBe(false);
  await processDeliveryExport(
    f.backend,
    { ...f.job, lease_token: id(11) },
    f.render,
  );
  expect(f.render).toHaveBeenCalledTimes(3);
  expect(f.backend.storeDeliveryObject).toHaveBeenCalledTimes(2);
  expect(f.state.completed).toBe(true);
});

it("rechecks source/actor after rendering and before storage side effects", async () => {
  const f = await fixture();
  f.state.rejectContextAfterRender = true;
  await expect(
    processDeliveryExport(f.backend, f.job, f.render),
  ).resolves.toEqual({ error_code: "ROLE_FORBIDDEN" });
  expect(f.backend.storeDeliveryObject).not.toHaveBeenCalled();
  expect(f.state.completed).toBe(false);
});

it("never overwrites wrong existing bytes or publishes an incomplete volume set", async () => {
  const f = await fixture();
  const wrong = buildDeliveryExport(f.context.snapshot, "combined");
  wrong.blocks.push({ type: "paragraph", text: "Unapproved content" });
  f.objects.set(f.artifacts[0].storage_key, new Blob([await f.render(wrong)]));
  f.render.mockClear();
  await processDeliveryExport(f.backend, f.job, f.render);
  expect(f.state.completed).toBe(false);
  expect(f.render).not.toHaveBeenCalled();
  expect(f.backend.storeDeliveryObject).not.toHaveBeenCalled();
  const incomplete = await fixture(true);
  incomplete.artifacts.pop();
  await expect(
    processDeliveryExport(
      incomplete.backend,
      incomplete.job,
      incomplete.render,
    ),
  ).resolves.toEqual({ error_code: "DELIVERY_ARTIFACT_INVALID" });
  expect(incomplete.render).not.toHaveBeenCalled();
});

it("records an invalid immutable snapshot as terminal instead of a transient renderer failure", async () => {
  const f = await fixture();
  (f.context.snapshot.payload as any).substantive_complete = true;
  await expect(
    processDeliveryExport(f.backend, f.job, f.render),
  ).resolves.toEqual({ error_code: "DELIVERY_ARTIFACT_INVALID" });
  expect(f.backend.internal).toHaveBeenLastCalledWith("fail_delivery_export", {
    job_id: f.job.id,
    lease: f.job.lease_token,
    error_code: "DELIVERY_ARTIFACT_INVALID",
  });
  expect(f.render).not.toHaveBeenCalled();
  expect(f.backend.storeDeliveryObject).not.toHaveBeenCalled();
});
it("aborts CPU rendering at the current lease bound and writes no file", async () => {
  const f = await fixture();
  f.context.server_now = new Date().toISOString();
  f.context.lease_until = new Date(Date.now() + 30).toISOString();
  const render = vi.fn(
    async (_model, signal?: AbortSignal) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason);
        else
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
      }),
  );
  expect(await processDeliveryExport(f.backend, f.job, render)).toEqual({
    error_code: "STALE_LEASE",
  });
  expect(render).toHaveBeenCalledTimes(1);
  expect(f.backend.storeDeliveryObject).not.toHaveBeenCalled();
  expect(f.state.completed).toBe(false);
});
