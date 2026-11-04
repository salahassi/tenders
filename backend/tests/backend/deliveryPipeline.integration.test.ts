// @vitest-environment node
import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createApiHandler } from "../../supabase/functions/api/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { AppError, databaseError } from "../../supabase/functions/_shared/http";
import {
  buildDeliveryExport,
  DOCX_MIME,
} from "../../supabase/functions/_shared/deliveryExport";
import {
  deliveryBytes,
  processDeliveryExport,
} from "../../supabase/functions/_shared/deliveryWorker";
import {
  type RenderModel,
  verifyExportDocx,
} from "../../supabase/functions/_shared/export";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";

// Migrated SQL, real commands/leases, worker, renderer, DOCX validation and API
// handlers run together. Auth-token validation and object transport are local
// test adapters; this does not establish hosted Auth/Storage or visual acceptance.
let f: Awaited<ReturnType<typeof workflowFixture>>;
let fonts: FontData;
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public-key",
  serviceKey: "synthetic-service-key",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic-worker-secret",
  models: modelEnvironments(() => undefined),
};
beforeAll(async () => {
  f = await workflowFixture();
  fonts = Object.fromEntries(
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
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw Error("Invalid test SQL identifier");
  return `"${value}"`;
};
async function sql(
  role: "authenticated" | "service_role",
  actor: string,
  query: string,
  args: unknown[] = [],
) {
  await f.db.exec("savepoint delivery_transport");
  try {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      actor,
    ]);
    await f.db.exec(`set local role ${role}`);
    return (await f.db.query<Record<string, any>>(query, args)).rows;
  } catch (error) {
    await f.db.exec("rollback to savepoint delivery_transport");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role; release savepoint delivery_transport");
  }
}
function actorFor(token: string) {
  if (token !== "synthetic-owner")
    throw new AppError(401, "UNAUTHENTICATED", "Invalid synthetic session.");
  return f.owner;
}
async function rpc(
  name: string,
  args: Record<string, unknown> = {},
  token?: string,
) {
  const entries = Object.entries(args);
  const named = entries
    .map(([key], index) => `${identifier(key)} => $${index + 1}`)
    .join(",");
  const rows = await sql(
    token ? "authenticated" : "service_role",
    token ? actorFor(token) : "",
    `select public.${identifier(name)}(${named}) data`,
    entries.map(([, value]) =>
      value && typeof value === "object" ? JSON.stringify(value) : value,
    ),
  );
  return rows[0]?.data;
}
function transport() {
  const objects = new Map<string, Blob>();
  const state = { revokeOnRead: false };
  const backend = {
    authenticate: async (token: string) => ({ id: actorFor(token) }),
    membership: async (token: string) => {
      const [membership] = await sql(
        "authenticated",
        actorFor(token),
        "select * from public.current_membership()",
      );
      if (!membership)
        throw new AppError(403, "ACCESS_PENDING", "Membership is unavailable.");
      return membership;
    },
    batch: (token: string, commands: unknown[], key: string) =>
      rpc("app_batch", { commands, idempotency_key: key }, token),
    userRpc: (token: string, name: string, args: Record<string, unknown>) =>
      rpc(name, args, token),
    internal: vi.fn((name: string, args: Record<string, unknown> = {}) =>
      rpc(name, args),
    ),
    deliveryObject: vi.fn(async (key: string) => {
      const blob = objects.get(key) || null;
      if (state.revokeOnRead && blob) {
        state.revokeOnRead = false;
        await f.db.query(
          "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
          [f.w, f.owner],
        );
      }
      return blob;
    }),
    storeDeliveryObject: vi.fn(
      async (key: string, bytes: Uint8Array, mime: string) => {
        expect(mime).toBe(DOCX_MIME);
        if (objects.has(key))
          throw new Error("An immutable object must never be overwritten.");
        objects.set(key, new Blob([new Uint8Array(bytes)]));
      },
    ),
  };
  const handle = createApiHandler(env, () => backend as unknown as Backend);
  const request = (path: string, body?: unknown) =>
    handle(
      new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: env.allowedOrigins[0],
          authorization: "Bearer synthetic-owner",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": crypto.randomUUID(),
              }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { backend, objects, state, request };
}
async function twoVolumeOpportunity() {
  await f.db.query(
    "insert into public.templates(workspace_id,title,language,volume_mode,required_sections,fixed_blocks,content_hash,approved,approved_by,approved_at,created_by) values($1,'Synthetic two-volume template','en','separate',$2::jsonb,'[]',repeat('a',64),true,$3,now(),$3)",
    [
      f.w,
      JSON.stringify([
        {
          key: "approach",
          title: "Proposed approach",
          purpose: "Explain implementation",
          volume: "technical",
          applicable: true,
          rationale: "",
        },
        {
          key: "commercial",
          title: "Commercial response",
          purpose: "Confirm commercial inputs",
          volume: "financial",
          applicable: true,
          rationale: "",
        },
      ]),
      f.owner,
    ],
  );
  const source = await f.command("source.create", {
    name: "Synthetic delivery pipeline",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic operating manual proposal",
    reference: "SYNTHETIC-PIPELINE",
    description:
      "Deliver an operating manual with two approval stages within thirty days.",
    language: "en",
    decision: "shortlisted",
  });
}

it("binds prepare, SQL claims, real two-volume rendering, retry and current-authority downloads without overwriting retained bytes", async () => {
  const t = transport();
  const opportunity = await twoVolumeOpportunity();
  const prepared = await t.request("commands", {
    commands: [
      {
        operation: "delivery.snapshot.prepare",
        input: {
          opportunity_id: opportunity.id,
          expected_revision: opportunity.revision,
        },
      },
    ],
  });
  expect(prepared.status).toBe(200);
  const snapshot = (await prepared.json()).data[0];
  expect(snapshot.payload).toMatchObject({
    separate_volumes: true,
    input_state: "available",
    content_state: "source_draft",
    substantive_complete: false,
    approval_state: "draft",
  });
  const firstJob = await rpc("claim_backend_job_v3");
  expect(firstJob).toMatchObject({
    type: "render_delivery",
    entity_id: snapshot.id,
    status: "running",
  });
  const firstContext = await rpc("delivery_export_context", {
    job_id: firstJob.id,
    lease: firstJob.lease_token,
  });
  expect(firstContext.artifacts.map((item: any) => item.volume)).toEqual([
    "financial",
    "technical",
  ]);
  const [firstArtifact, secondArtifact] = firstContext.artifacts;
  let rejectSecond = true;
  const render = vi.fn(async (model: RenderModel) => {
    if (model.volume === secondArtifact.volume && rejectSecond) {
      rejectSecond = false;
      throw Error("Synthetic second-volume renderer interruption.");
    }
    return new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
  });
  await expect(
    processDeliveryExport(t.backend as unknown as Backend, firstJob, render),
  ).resolves.toEqual({ error_code: "DELIVERY_RENDER_FAILED" });
  const partial = (
    await (await t.request(`delivery-snapshots/${snapshot.id}/package`)).json()
  ).data;
  expect(partial.status).toBe("preparing");
  expect(partial.job).toMatchObject({
    id: firstJob.id,
    status: "retry_wait",
    error_code: "DELIVERY_RENDER_FAILED",
  });
  expect(partial.artifacts.map((item: any) => item.status)).toEqual([
    "ready",
    "pending",
  ]);
  expect(t.objects.size).toBe(1);
  const firstBlob = t.objects.get(firstArtifact.storage_key)!;
  const retained = await deliveryBytes(
    firstBlob,
    buildDeliveryExport(snapshot, firstArtifact.volume),
  );
  expect(partial.artifacts[0]).toMatchObject({
    id: firstArtifact.id,
    content_hash: retained.hash,
    expected_size: retained.size,
  });

  // Even the verified first file cannot be downloaded as a complete package.
  const readsBeforeIncompleteDownload =
    t.backend.deliveryObject.mock.calls.length;
  const incompleteDownload = await t.request(
    `delivery-artifacts/${firstArtifact.id}/download`,
  );
  expect(incompleteDownload.status).toBe(422);
  expect((await incompleteDownload.json()).error.code).toBe(
    "DELIVERY_EXPORT_INCOMPLETE",
  );
  expect(t.backend.deliveryObject).toHaveBeenCalledTimes(
    readsBeforeIncompleteDownload,
  );

  // Advance only the fixture's due time; retry still uses the canonical SQL
  // claim and a fresh lease, preserving the same logical job and object keys.
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [firstJob.id],
  );
  const retryJob = await rpc("claim_backend_job_v3");
  expect(retryJob).toMatchObject({
    id: firstJob.id,
    entity_id: snapshot.id,
    status: "running",
  });
  expect(retryJob.lease_token).not.toBe(firstJob.lease_token);
  const completed = await processDeliveryExport(
    t.backend as unknown as Backend,
    retryJob,
    render,
  );
  expect(completed).toMatchObject({
    id: firstJob.id,
    status: "succeeded",
    lease_token: null,
    lease_until: null,
  });
  expect(render.mock.calls.map(([model]) => model.volume)).toEqual([
    "financial",
    "technical",
    "technical",
  ]);
  expect(t.backend.storeDeliveryObject.mock.calls.map(([key]) => key)).toEqual([
    firstArtifact.storage_key,
    secondArtifact.storage_key,
  ]);
  expect(t.objects.get(firstArtifact.storage_key)).toBe(firstBlob);
  const packageResponse = await t.request(
    `delivery-snapshots/${snapshot.id}/package`,
  );
  expect(packageResponse.status).toBe(200);
  const complete = (await packageResponse.json()).data;
  expect(complete.status).toBe("ready");
  expect(complete.artifacts).toHaveLength(2);
  expect(complete.artifacts.every((item: any) => item.status === "ready")).toBe(
    true,
  );
  expect(complete.artifacts[0]).toMatchObject({
    id: firstArtifact.id,
    content_hash: retained.hash,
    expected_size: retained.size,
  });
  expect(JSON.stringify(complete)).not.toMatch(
    /storage_key|source_manifest|content_blocks/,
  );
  for (const artifact of complete.artifacts) {
    const response = await t.request(
      `delivery-artifacts/${artifact.id}/download`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(DOCX_MIME);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const model = buildDeliveryExport(snapshot, artifact.volume);
    expect(verifyExportDocx(bytes, model)).toBe(true);
    expect(await deliveryBytes(bytes, model)).toMatchObject({
      hash: artifact.content_hash,
      size: artifact.expected_size,
    });
  }

  // Auth and first SQL authorization succeed, then membership changes while
  // object transport is in flight. The second real SQL check must deny bytes.
  t.state.revokeOnRead = true;
  const beforeRevocationCalls = t.backend.internal.mock.calls.length;
  const revoked = await t.request(
    `delivery-artifacts/${firstArtifact.id}/download`,
  );
  expect(revoked.status).toBe(403);
  expect(revoked.headers.get("content-type")).toContain("application/json");
  expect(revoked.headers.has("content-disposition")).toBe(false);
  expect((await revoked.json()).error.code).toBe("ROLE_FORBIDDEN");
  expect(t.backend.internal.mock.calls.slice(beforeRevocationCalls)).toEqual([
    [
      "delivery_artifact_context",
      { artifact_id: firstArtifact.id, actor_id: f.owner },
    ],
    [
      "authorize_delivery_artifact_download",
      {
        artifact_id: firstArtifact.id,
        actor_id: f.owner,
        actual_hash: retained.hash,
      },
    ],
  ]);
  expect(t.objects.get(firstArtifact.storage_key)).toBe(firstBlob);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.generation_plans",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select active_version_id,state from public.proposals where id=$1",
        [snapshot.proposal_id],
      )
    ).rows[0],
  ).toEqual({ active_version_id: null, state: "draft" });
}, 30000);
