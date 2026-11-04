// @vitest-environment node
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
import {
  buildDeliveryExport,
  DOCX_MIME,
} from "../../supabase/functions/_shared/deliveryExport.ts";
import { deliveryBytes } from "../../supabase/functions/_shared/deliveryWorker.ts";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx.ts";

const actor = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const suppliedActor = "00000000-0000-4000-8000-000000000003";
const snapshotId = "00000000-0000-4000-8000-000000000004";
const env: BackendEnvironment = {
  url: "https://example.supabase.co",
  publishableKey: "synthetic-public-key",
  serviceKey: "synthetic-service-key",
  workerSecret: "synthetic-worker-secret",
  allowedOrigins: ["https://app.example.test"],
  models: modelEnvironments(() => undefined),
};
const snapshot = {
  id: snapshotId,
  ordinal: 1,
  created_at: "2026-11-04T00:00:00Z",
  payload: {
    version: 1,
    title: "Synthetic operating manual proposal",
    language: "en",
    template: {},
    separate_volumes: false,
    input_state: "available",
    content_state: "source_draft",
    assurance_state: "unreviewed",
    substantive_complete: false,
    approval_state: "draft",
    notice: "Source information is retained; the response is not complete.",
    source_manifest: [],
    input_materials: {},
    sections: [
      {
        section_key: "scope",
        title: "Scope",
        volume: "technical",
        kind: "source_extract",
        source_ids: [],
        provenance: null,
        content_blocks: [
          {
            type: "paragraph",
            text: "Synthetic source requires an operating manual within thirty days.",
          },
          { type: "placeholder", gap_id: "scope.response" },
        ],
      },
    ],
    gaps: [
      {
        id: "scope.response",
        section_key: "scope",
        field_path: "response",
        reason: "RESPONSE_NOT_PREPARED",
        label: "Required: proposed approach and delivery schedule",
        required_for: "substantive_completion",
        source_ids: [],
      },
    ],
  },
};
let stored: Awaited<ReturnType<typeof deliveryBytes>>;
beforeAll(async () => {
  const fonts = Object.fromEntries(
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
  const model = buildDeliveryExport(snapshot, "combined");
  stored = await deliveryBytes(await renderDocx(model, fonts), model);
}, 30000);
function fixture() {
  const artifact = {
    id: artifactId,
    status: "ready",
    storage_key: "synthetic/immutable.docx",
    volume: "combined",
    content_hash: stored.hash,
    expected_size: stored.size,
    original_name: "synthetic-draft.docx",
    mime_type: DOCX_MIME,
  };
  const backend = {
    authenticate: vi.fn(async () => ({ id: actor })),
    membership: vi.fn(async () => ({
      workspace_id: snapshotId,
      role: "Owner",
    })),
    deliveryObject: vi.fn(async () => new Blob([new Uint8Array(stored.bytes)])),
    internal: vi.fn(
      async (
        name: string,
        _args: Record<string, unknown>,
      ): Promise<unknown> => {
        if (name === "delivery_artifact_context") return { snapshot, artifact };
        if (name === "authorize_delivery_artifact_download")
          return { authorized: true };
        throw new Error(`Unexpected internal operation: ${name}`);
      },
    ),
  };
  const handle = createApiHandler(env, () => backend as unknown as Backend);
  const request = () =>
    new Request(
      `https://edge.example.test/functions/v1/api/v1/delivery-artifacts/${artifactId}/download?actor_id=${suppliedActor}`,
      {
        headers: {
          origin: env.allowedOrigins[0],
          authorization: "Bearer synthetic-user-token",
          "x-actor-id": suppliedActor,
        },
      },
    );
  return { backend, handle, request, artifact };
}

describe("delivery download HTTP authorization and verified bytes", () => {
  it("uses the authenticated actor for both authorization checks despite a supplied actor", async () => {
    const f = fixture();
    const response = await f.handle(f.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(DOCX_MIME);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(stored.bytes);
    expect(f.backend.internal.mock.calls).toEqual([
      [
        "delivery_artifact_context",
        { artifact_id: artifactId, actor_id: actor },
      ],
      [
        "authorize_delivery_artifact_download",
        { artifact_id: artifactId, actor_id: actor, actual_hash: stored.hash },
      ],
    ]);
  });
  it.each(["membership", "source"])(
    "returns no document bytes when %s access is revoked during the storage read",
    async (kind) => {
      const f = fixture();
      let revoked = false;
      f.backend.deliveryObject.mockImplementation(async () => {
        revoked = true;
        return new Blob([new Uint8Array(stored.bytes)]);
      });
      f.backend.internal.mockImplementation(async (name) => {
        if (name === "delivery_artifact_context") {
          expect(revoked).toBe(false);
          return { snapshot, artifact: f.artifact };
        }
        expect(name).toBe("authorize_delivery_artifact_download");
        expect(revoked).toBe(true);
        throw new AppError(
          403,
          kind === "membership"
            ? "MEMBERSHIP_REQUIRED"
            : "SOURCE_ACCESS_REVOKED",
          "Access is no longer available.",
        );
      });
      const response = await f.handle(f.request());
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.has("content-disposition")).toBe(false);
      const body = await response.text();
      expect(JSON.parse(body).error.code).toBe(
        kind === "membership" ? "MEMBERSHIP_REQUIRED" : "SOURCE_ACCESS_REVOKED",
      );
      expect(body).not.toContain("Synthetic source requires");
      expect(f.backend.internal).toHaveBeenLastCalledWith(
        "authorize_delivery_artifact_download",
        {
          artifact_id: artifactId,
          actor_id: actor,
          actual_hash: stored.hash,
        },
      );
    },
  );
  it("rejects changed verified file metadata before granting download authorization", async () => {
    const f = fixture();
    f.artifact.content_hash = "0".repeat(64);
    const response = await f.handle(f.request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe(
      "DELIVERY_ARTIFACT_INVALID",
    );
    expect(f.backend.internal).toHaveBeenCalledTimes(1);
  });
  it("does not read storage or return file bytes while the artifact is unready", async () => {
    const f = fixture();
    f.artifact.status = "reserved";
    const response = await f.handle(f.request());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("DELIVERY_NOT_READY");
    expect(f.backend.deliveryObject).not.toHaveBeenCalled();
    expect(f.backend.internal).toHaveBeenCalledTimes(1);
  });
});

it("counts policy and volume-separation gaps in package metadata without returning source content", async () => {
  const f = fixture();
  const value = structuredClone(snapshot);
  value.payload.separate_volumes = true;
  value.payload.sections[0].content_blocks.unshift(
    {
      type: "paragraph",
      text: "Contact synthetic-contact@example.test for source clarification.",
    },
    { type: "paragraph", text: "The synthetic budget is USD 900." },
  );
  const metadata = {
    snapshot: { id: snapshotId, ordinal: 1, gap_count: 1 },
    status: "preparing",
    artifacts: [],
  };
  const userRpc = vi.fn(async (_token: string, operation: string) =>
    operation === "delivery_package" ? metadata : value,
  );
  Object.assign(f.backend, { userRpc });
  const response = await f.handle(
    new Request(
      `https://edge.example.test/functions/v1/api/v1/delivery-snapshots/${snapshotId}/package`,
      {
        headers: {
          origin: env.allowedOrigins[0],
          authorization: "Bearer synthetic-user-token",
        },
      },
    ),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.snapshot).toMatchObject({
    id: snapshotId,
    gap_count: 3,
    rendering_gap_count: 2,
  });
  expect(userRpc.mock.calls).toEqual([
    ["synthetic-user-token", "delivery_package", { snapshot_id: snapshotId }],
    ["synthetic-user-token", "delivery_context", { snapshot_id: snapshotId }],
  ]);
  expect(JSON.stringify(body)).not.toMatch(
    /synthetic-contact|USD 900|storage_key|source_extract|payload/,
  );
  expect(f.backend.deliveryObject).not.toHaveBeenCalled();
});
