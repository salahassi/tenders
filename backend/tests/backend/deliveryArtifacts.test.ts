// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { readFile } from "node:fs/promises";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function row(sql: string, args: unknown[] = []) {
  return (await f.db.query<any>(sql, args)).rows[0];
}
async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_failure");
  try {
    return await run();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected_failure");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected_failure;reset role");
  }
}
async function userRpc(name: string, args: unknown[] = [], actor = f.owner) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    actor,
  ]);
  return attempt(async () => {
    await f.db.exec("set role authenticated");
    return f.rpc(name, args);
  });
}
async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic artifact source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic artifact proposal",
    reference: "SYNTHETIC",
    description: "Synthetic scope: deliver a documented approval workflow.",
    language: "en",
    decision: "shortlisted",
  });
  const snapshot = await f.command("delivery.snapshot.prepare", {
    opportunity_id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  return { opportunity, snapshot };
}
async function clone(s: any, separate = false) {
  return row(
    `insert into public.proposal_delivery_snapshots(workspace_id,opportunity_id,proposal_id,base_version_id,ordinal,content_hash,source_manifest,payload,created_by)
 select workspace_id,opportunity_id,proposal_id,base_version_id,(select max(ordinal)+1 from public.proposal_delivery_snapshots where proposal_id=$1),encode(sha256(convert_to(p::text,'UTF8')),'hex'),source_manifest,p,created_by from public.proposal_delivery_snapshots cross join lateral(select payload||jsonb_build_object('title',$3::text,'separate_volumes',$4::boolean) p) x where id=$2 returning *`,
    [s.proposal_id, s.id, crypto.randomUUID(), separate],
  );
}
async function job(s: any) {
  return row(
    "select * from public.jobs where type='render_delivery' and entity_id=$1 order by coalesce((checkpoint->>'delivery_attempt')::int,1) desc",
    [s.id],
  );
}
async function artifacts(s: any) {
  return (
    await f.db.query<any>(
      "select * from public.proposal_delivery_artifacts where snapshot_id=$1 order by volume",
      [s.id],
    )
  ).rows;
}
async function bytes() {
  return Number(
    (await row("select app_private.storage_reserved_bytes($1) n", [f.w])).n,
  );
}
async function claim(s: any) {
  const j = await f.rpc("claim_backend_job_v5");
  expect(j?.entity_id).toBe(s.id);
  return j;
}
async function context(j: any) {
  return f.rpc("delivery_export_context", [j.id, j.lease_token]);
}
async function complete(j: any, a: any, hash = "a".repeat(64), size = 321) {
  return f.rpc("complete_delivery_artifact", [
    j.id,
    j.lease_token,
    a.id,
    hash,
    size,
  ]);
}
async function ready(s: any) {
  const j = await claim(s),
    c = await context(j);
  for (const a of c.artifacts) await complete(j, a);
  await f.rpc("finish_delivery_export", [j.id, j.lease_token]);
  return { j, c };
}

it("creates stable local jobs/artifacts without model usage, upfront reservation or approval", async () => {
  const { snapshot: s } = await setup(),
    j = await job(s),
    a = await artifacts(s);
  expect(j).toMatchObject({
    type: "render_delivery",
    status: "queued",
    input_hash: s.content_hash,
    attempts: 0,
    checkpoint: {
      model_executor: 3,
      delivery_renderer_version: "1",
      delivery_retry_policy: 1,
    },
  });
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    volume: "combined",
    status: "pending",
    reserved_bytes: 0,
    expected_size: null,
    content_hash: null,
  });
  expect(await bytes()).toBe(0);
  expect(
    await row("select count(*)::int n from public.provider_usage"),
  ).toEqual({ n: 0 });
  expect(
    await row(
      "select active_version_id,state from public.proposals where id=$1",
      [s.proposal_id],
    ),
  ).toEqual({ active_version_id: null, state: "draft" });
  const metadata = await userRpc("delivery_package", [s.id]);
  expect(metadata).toMatchObject({
    status: "preparing",
    snapshot: { id: s.id, gap_count: s.payload.gaps.length },
    job: { status: "queued" },
  });
  expect(JSON.stringify(metadata)).not.toMatch(
    /storage_key|source_manifest|content_blocks/,
  );
});
it("keeps old workers out while v3 local work bypasses occupied model slots, not exclusive leases", async () => {
  const { snapshot: s } = await setup();
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1,null,gen_random_uuid(),'synthetic-busy','openai','synthetic-model',repeat('a',64),current_date,1,100,100,'reserved',$2)`,
    [f.w, f.owner],
  );
  const j = await f.rpc("claim_backend_local_job_v5");
  expect(j.entity_id).toBe(s.id);
  expect(await f.rpc("claim_backend_job_v5")).toBeNull();
  expect((await row("select state from public.provider_usage")).state).toBe(
    "reserved",
  );
});
it("reserves the full immutable volume set once and requires every verified artifact for completion", async () => {
  const initial = await setup(),
    s = await clone(initial.snapshot, true),
    j = await claim(s),
    c = await context(j);
  expect(c.renderer_version).toBe("1");
  expect(c.artifacts.map((a: any) => a.volume)).toEqual([
    "financial",
    "technical",
  ]);
  expect(await bytes()).toBe(2 * 10485760);
  expect((await context(j)).artifacts).toEqual(c.artifacts);
  expect(await bytes()).toBe(2 * 10485760);
  await complete(j, c.artifacts[0]);
  expect(await bytes()).toBe(10485760 + 321);
  await expect(
    attempt(() => f.rpc("finish_delivery_export", [j.id, j.lease_token])),
  ).rejects.toThrow("DELIVERY_EXPORT_INCOMPLETE");
  expect((await userRpc("delivery_package", [s.id])).status).toBe("preparing");
  await expect(
    attempt(() =>
      f.rpc("delivery_artifact_context", [c.artifacts[0].id, f.owner]),
    ),
  ).rejects.toThrow("DELIVERY_EXPORT_INCOMPLETE");
  await complete(j, c.artifacts[1], "b".repeat(64), 654);
  await f.rpc("finish_delivery_export", [j.id, j.lease_token]);
  expect(await bytes()).toBe(975);
  expect((await userRpc("delivery_package", [s.id])).status).toBe("ready");
  expect(
    (
      await row(
        "select payload->>'approval_state' state from public.proposal_delivery_snapshots where id=$1",
        [s.id],
      )
    ).state,
  ).toBe("draft");
});
it("refuses completion before storage reservation", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s),
    [a] = await artifacts(s);
  await expect(attempt(() => complete(j, a))).rejects.toThrow(
    "DELIVERY_STORAGE_NOT_RESERVED",
  );
  expect((await artifacts(s))[0].status).toBe("pending");
});
it.each([
  ["not-a-hash", 100],
  ["a".repeat(64), 0],
  ["a".repeat(64), 10485761],
])("rejects malformed/oversized receipts (%s,%s)", async (hash, size) => {
  const { snapshot: s } = await setup(),
    j = await claim(s),
    c = await context(j);
  await expect(
    attempt(() => complete(j, c.artifacts[0], String(hash), Number(size))),
  ).rejects.toThrow("DELIVERY_ARTIFACT_INVALID");
  expect((await artifacts(s))[0].status).toBe("pending");
  expect(await bytes()).toBe(10485760);
});
it("replays exact completion and rejects changed ready bytes", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s),
    c = await context(j);
  const first = await complete(j, c.artifacts[0]);
  expect(await complete(j, c.artifacts[0])).toEqual(first);
  await expect(
    attempt(() => complete(j, c.artifacts[0], "b".repeat(64))),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    (
      await row(
        "select count(*)::int n from public.audit_events where action='delivery.artifact.ready'",
      )
    ).n,
  ).toBe(1);
  await expect(
    attempt(() =>
      f.db.query(
        "update public.proposal_delivery_artifacts set content_hash=repeat('b',64) where id=$1",
        [first.id],
      ),
    ),
  ).rejects.toThrow("DELIVERY_ARTIFACT_IMMUTABLE");
});
it("storage exhaustion preserves the snapshot and never partially reserves two volumes", async () => {
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/capacity',250000000,'Synthetic capacity fixture')",
    [f.w],
  );
  const initial = await setup(),
    s = await clone(initial.snapshot, true),
    j = await claim(s);
  await expect(attempt(() => context(j))).rejects.toThrow(
    "STORAGE_CAP_REACHED",
  );
  expect((await artifacts(s)).map((a) => a.reserved_bytes)).toEqual([0, 0]);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_delivery_snapshots where id=$1",
        [s.id],
      )
    ).n,
  ).toBe(1);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "STORAGE_CAP_REACHED",
  ]);
  expect((await job(s)).status).toBe("retry_wait");
  expect((await userRpc("delivery_package", [s.id])).job.error_code).toBe(
    "STORAGE_CAP_REACHED",
  );
});
it("coalesces burst snapshots only before attempts, leases or possible uploads", async () => {
  const { snapshot: first } = await setup();
  let last = first;
  for (let i = 0; i < 30; i++) last = await clone(last);
  expect(
    await row(
      "select count(*)::int n from public.jobs where type='render_delivery' and status='queued'",
    ),
  ).toEqual({ n: 1 });
  expect(
    await row(
      "select count(*)::int n from public.jobs where type='render_delivery' and status='canceled' and error_code='DELIVERY_SUPERSEDED'",
    ),
  ).toEqual({ n: 30 });
  expect(await bytes()).toBe(0);
  expect((await userRpc("delivery_package", [first.id])).status).toBe(
    "blocked",
  );
  const j = await claim(last),
    c = await context(j),
    later = await clone(last);
  expect((await job(last)).status).toBe("running");
  expect((await artifacts(last))[0].reserved_bytes).toBe(10485760);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "DELIVERY_STORAGE_UNAVAILABLE",
  ]);
  await clone(later);
  expect((await job(last)).status).toBe("retry_wait");
  expect((await artifacts(last))[0].storage_key).toBe(
    c.artifacts[0].storage_key,
  );
});
it("retains ready files when later snapshots arrive", async () => {
  const { snapshot: s } = await setup();
  await ready(s);
  const old = await artifacts(s);
  await clone(s);
  expect(await artifacts(s)).toEqual(old);
  expect((await job(s)).status).toBe("succeeded");
  expect((await userRpc("delivery_package", [s.id])).status).toBe("ready");
});
it("recovers expired renderer leases without losing reserved/ambiguous bytes", async () => {
  const { snapshot: s } = await setup(),
    first = await claim(s),
    c = await context(first);
  await f.db.query(
    "update public.jobs set lease_until=now()-interval '1 second' where id=$1",
    [first.id],
  );
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  const next = await claim(s);
  expect(next.lease_token).not.toBe(first.lease_token);
  expect((await context(next)).artifacts).toEqual(c.artifacts);
  await expect(attempt(() => complete(first, c.artifacts[0]))).rejects.toThrow(
    "STALE_LEASE",
  );
  await complete(next, c.artifacts[0]);
});
it.each(["DELIVERY_STORAGE_UNAVAILABLE", "DELIVERY_RENDER_FAILED"])(
  "retries %s with stable IDs/backoff and no AI",
  async (code) => {
    const { snapshot: s } = await setup(),
      j = await claim(s),
      c = await context(j);
    await f.rpc("fail_delivery_export", [j.id, j.lease_token, code]);
    const waiting = await job(s);
    expect(waiting.status).toBe("retry_wait");
    expect(waiting.failure_count).toBe(1);
    expect(waiting.lease_token).toBeNull();
    expect(await f.rpc("claim_backend_job_v5")).toBeNull();
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [j.id],
    );
    const next = await claim(s);
    expect((await context(next)).artifacts).toEqual(c.artifacts);
    expect(
      (await row("select count(*)::int n from public.provider_usage")).n,
    ).toBe(0);
  },
);
it.each([
  "DELIVERY_ARTIFACT_INVALID",
  "DELIVERY_GAP_INVALID",
  "DELIVERY_RENDERER_UNSUPPORTED",
  "EXPORT_PLACEHOLDER_MISMATCH",
  "BUYER_VOLUME_RULE",
  "TECHNICAL_VOLUME_CONTAINS_PRICE",
])("blocks content/version %s without relabeling valid input", async (code) => {
  const { snapshot: s } = await setup(),
    j = await claim(s);
  await context(j);
  await f.rpc("fail_delivery_export", [j.id, j.lease_token, code]);
  const metadata = await userRpc("delivery_package", [s.id]);
  expect(metadata.status).toBe("blocked");
  expect(metadata.job.error_code).toBe(code);
  expect(metadata.snapshot.input_state).toBe("available");
  expect(await job(s)).toMatchObject({
    status: "blocked",
    error_code: code,
    lease_token: null,
    lease_until: null,
  });
  expect((await artifacts(s))[0]).toMatchObject({
    status: "pending",
    content_hash: null,
    expected_size: null,
    reserved_bytes: 10485760,
  });
  expect(await f.rpc("claim_backend_job_v5")).toBeNull();
});
it("rejects arbitrary diagnostics and foreign artifact IDs", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s),
    c = await context(j);
  await expect(
    attempt(() =>
      f.rpc("fail_delivery_export", [
        j.id,
        j.lease_token,
        "PRIVATE_DIAGNOSTIC_TEXT",
      ]),
    ),
  ).rejects.toThrow("INVALID_INPUT");
  await expect(
    attempt(() => complete(j, { id: crypto.randomUUID() })),
  ).rejects.toThrow("NOT_FOUND");
  expect((await artifacts(s))[0]).toMatchObject({
    id: c.artifacts[0].id,
    status: "pending",
    reserved_bytes: 10485760,
    expected_size: null,
    content_hash: null,
  });
});
it.each(["source", "membership"])(
  "rechecks %s before ready commit but allows recording its failure",
  async (mode) => {
    const { snapshot: s, opportunity: o } = await setup(),
      j = await claim(s),
      c = await context(j);
    if (mode === "source")
      await f.db.query(
        "update public.opportunities set description='Changed synthetic scope',revision=revision+1 where id=$1",
        [o.id],
      );
    else
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    const code = mode === "source" ? "STALE_INPUT" : "ROLE_FORBIDDEN";
    await expect(attempt(() => complete(j, c.artifacts[0]))).rejects.toThrow(
      code,
    );
    await f.rpc("fail_delivery_export", [j.id, j.lease_token, code]);
    expect((await job(s)).status).toBe("blocked");
    expect((await artifacts(s))[0].status).toBe("pending");
    expect(await bytes()).toBe(10485760);
  },
);
it("rechecks current user/source and stored-byte hash at download", async () => {
  const { snapshot: s, opportunity: o } = await setup();
  await ready(s);
  const [a] = await artifacts(s);
  expect(
    (await f.rpc("delivery_artifact_context", [a.id, f.owner])).artifact
      .storage_key,
  ).toBe(a.storage_key);
  await expect(
    attempt(() =>
      f.rpc("authorize_delivery_artifact_download", [
        a.id,
        f.owner,
        "b".repeat(64),
      ]),
    ),
  ).rejects.toThrow("EXPORT_HASH_MISMATCH");
  expect(
    await f.rpc("authorize_delivery_artifact_download", [
      a.id,
      f.owner,
      a.content_hash,
    ]),
  ).not.toHaveProperty("storage_key");
  await f.db.query(
    "update public.opportunities set description='Changed synthetic scope',revision=revision+1 where id=$1",
    [o.id],
  );
  await expect(
    attempt(() =>
      f.rpc("authorize_delivery_artifact_download", [
        a.id,
        f.owner,
        a.content_hash,
      ]),
    ),
  ).rejects.toThrow("STALE_INPUT");
});
it("exposes metadata only to members and denies browser worker/context authority", async () => {
  const { snapshot: s } = await setup(),
    j = await job(s),
    [a] = await artifacts(s);
  await expect(
    userRpc("delivery_package", [s.id], crypto.randomUUID()),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  await expect(
    userRpc("delivery_artifact_context", [a.id, f.owner]),
  ).rejects.toThrow("permission denied");
  await expect(
    userRpc("complete_delivery_artifact", [
      j.id,
      crypto.randomUUID(),
      a.id,
      "a".repeat(64),
      123,
    ]),
  ).rejects.toThrow("permission denied");
  await expect(
    attempt(async () => {
      await f.db.exec("set role authenticated");
      return f.db.query(
        "select storage_key from public.proposal_delivery_artifacts",
      );
    }),
  ).rejects.toThrow("permission denied");
  await expect(
    attempt(async () => {
      await f.db.exec("set role anon");
      return f.rpc("delivery_package", [s.id]);
    }),
  ).rejects.toThrow("permission denied");
});
it("backs up ready bytes and protects active artifacts from cleanup", async () => {
  const { snapshot: s } = await setup();
  await ready(s);
  const [a] = await artifacts(s),
    manifest = await userRpc("workspace_backup_manifest");
  expect(
    manifest.rows.some(
      (r: any) => r.key === `proposal_delivery_artifacts/${a.id}`,
    ),
  ).toBe(true);
  expect(manifest.files).toContainEqual(
    expect.objectContaining({
      key: `proposal_delivery_artifacts/${a.id}`,
      hash: a.content_hash,
      size: a.expected_size,
    }),
  );
  expect(
    (
      await userRpc("recovery_file_context", [
        "proposal_delivery_artifacts",
        a.id,
      ])
    ).storage_key,
  ).toBe(a.storage_key);
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,$2,321,'Synthetic accidental cleanup')",
    [f.w, a.storage_key],
  );
  expect(await f.rpc("claim_storage_cleanup")).toEqual([]);
  expect(
    (
      await row(
        "select error_code from public.storage_cleanup_queue where storage_key=$1",
        [a.storage_key],
      )
    ).error_code,
  ).toBe("ACTIVE_REFERENCE_FOUND");
});
it("purges artifacts/render jobs while retaining ambiguous-byte capacity until confirmed deletion", async () => {
  const { snapshot: s, opportunity: o } = await setup(),
    j = await claim(s),
    c = await context(j);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "DELIVERY_STORAGE_UNAVAILABLE",
  ]);
  await userRpc("archive_opportunity", [
    o.id,
    o.revision,
    true,
    "Synthetic archive for artifact purge",
  ]);
  expect((await job(s)).status).toBe("canceled");
  const preview = await userRpc("preview_opportunity_purge", [o.id]);
  expect(preview.counts.proposal_delivery_artifacts).toBe(1);
  expect(preview.counts.jobs).toBe(1);
  expect(preview.files).toHaveLength(1);
  await userRpc("purge_opportunity", [
    o.id,
    preview.preview_hash,
    o.title,
    "Synthetic confirmed artifact purge",
    true,
  ]);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_delivery_artifacts",
      )
    ).n,
  ).toBe(0);
  expect(await bytes()).toBe(10485760);
  const [queued] = await f.rpc("claim_storage_cleanup");
  expect(queued.storage_key).toBe(c.artifacts[0].storage_key);
  await f.rpc("complete_storage_cleanup", [
    queued.id,
    queued.lease_token,
    false,
  ]);
  expect(await bytes()).toBe(10485760);
  const [retry] = await f.rpc("claim_storage_cleanup");
  await f.rpc("complete_storage_cleanup", [retry.id, retry.lease_token, true]);
  expect(await bytes()).toBe(0);
});
it.each([
  "lease_until",
  "lease_token",
  "model_executor",
  "delivery_renderer_version",
  "delivery_retry_policy",
])("fails closed with missing %s", async (field) => {
  const { snapshot: s } = await setup(),
    j = await claim(s);
  if (field.startsWith("lease"))
    await f.db.query(`update public.jobs set ${field}=null where id=$1`, [
      j.id,
    ]);
  else
    await f.db.query(
      "update public.jobs set checkpoint=checkpoint-$2 where id=$1",
      [j.id, field],
    );
  await expect(attempt(() => context(j))).rejects.toThrow(
    field.startsWith("lease") ? "STALE_LEASE" : "DELIVERY_ARTIFACT_INVALID",
  );
  expect(await bytes()).toBe(0);
  if (!field.startsWith("lease")) {
    await f.rpc("fail_delivery_export", [
      j.id,
      j.lease_token,
      "DELIVERY_ARTIFACT_INVALID",
    ]);
    expect((await job(s)).status).toBe("blocked");
  }
});
it("retains aged terminal render provenance without rolling back routine maintenance", async () => {
  const { snapshot: s } = await setup();
  await ready(s);
  await clone(s);
  await f.db.query(
    "update public.jobs set updated_at=now()-interval '100 days' where type='render_delivery'",
  );
  const result = await f.rpc("maintenance_tick");
  expect(result.due).toBe(true);
  expect((await job(s)).status).toBe("succeeded");
});
it("bounds transient attempts and explicitly retries under current authority with the same uncertain bytes", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s),
    c = await context(j);
  await f.db.query("update public.jobs set failure_count=5 where id=$1", [
    j.id,
  ]);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "DELIVERY_RENDER_TIMEOUT",
  ]);
  expect((await job(s)).status).toBe("blocked");
  const revision = (
    await row("select delivery_revision from public.proposals where id=$1", [
      s.proposal_id,
    ])
  ).delivery_revision;
  const input = { snapshot_id: s.id, expected_delivery_revision: revision },
    key = crypto.randomUUID();
  const result = await f.command("delivery.snapshot.retry", input, key);
  expect(result.id).toBe(s.id);
  expect(await job(s)).toMatchObject({
    status: "queued",
    created_by: f.owner,
    checkpoint: { delivery_attempt: 2 },
  });
  expect((await artifacts(s))[0]).toMatchObject({
    storage_key: c.artifacts[0].storage_key,
    reserved_bytes: 10485760,
    status: "pending",
  });
  await f.command("delivery.snapshot.retry", input, key);
  expect(
    (
      await row(
        "select count(*)::int n from public.jobs where type='render_delivery'",
      )
    ).n,
  ).toBe(2);
  await expect(
    f.command("delivery.snapshot.retry", {
      ...input,
      expected_delivery_revision: revision + 1,
    }),
  ).rejects.toThrow("DELIVERY_RETRY_NOT_ALLOWED");
  const next = await claim(s);
  await context(next);
  await complete(next, c.artifacts[0]);
  await f.rpc("finish_delivery_export", [next.id, next.lease_token]);
  expect(await userRpc("delivery_package", [s.id])).toMatchObject({
    status: "ready",
    snapshot: { proposal_id: s.proposal_id, delivery_revision: revision + 1 },
  });
});
it("wakes new local artifacts with full model slots only through the current worker and preserves wake revision guards", async () => {
  const { snapshot: s } = await setup();
  await f.db.exec(
    `create table app_private.test_delivery_dispatches(id int);create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$begin insert into app_private.test_delivery_dispatches values(1);end$$;`,
  );
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled) values(true,'https://synthetic.supabase.co','synthetic',true)",
  );
  const done = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,'analyze_chunk',gen_random_uuid(),'synthetic','succeeded',$2) returning *",
    [f.w, f.owner],
  );
  await f.db.query(
    "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1,null,gen_random_uuid(),'synthetic-busy','openai','synthetic-model',repeat('a',64),current_date,1,100,100,'reserved',$2)",
    [f.w, f.owner],
  );
  const lease = crypto.randomUUID();
  expect(await f.rpc("wake_backend_queue_status", [done.id, lease])).toEqual({
    dispatched: false,
  });
  expect(
    await f.rpc("wake_backend_queue_revision_v5", [
      done.id,
      lease,
      done.revision + 1,
    ]),
  ).toEqual({ dispatched: false });
  expect(await f.rpc("wake_backend_queue_status_v5", [done.id, lease])).toEqual(
    { dispatched: true },
  );
  expect(await f.rpc("wake_backend_queue_status_v5", [done.id, lease])).toEqual(
    { dispatched: false },
  );
  expect((await f.rpc("claim_backend_local_job_v5")).entity_id).toBe(s.id);
});
it.each([false, true])(
  "restores %s partial volume package and resumes only through current explicit authority",
  async (partial) => {
    const { snapshot: initial } = await setup(),
      s = await clone(initial, true),
      j = await claim(s),
      c = await context(j);
    await complete(j, c.artifacts[0]);
    if (!partial) {
      await complete(j, c.artifacts[1]);
      await f.rpc("finish_delivery_export", [j.id, j.lease_token]);
    }
    const manifest = await userRpc("workspace_backup_manifest"),
      all: any[] = [];
    for (let i = 0; i < manifest.rows.length; i += 15)
      all.push(
        ...(await userRpc("workspace_backup_rows", [
          JSON.stringify(manifest.rows.slice(i, i + 15).map((r: any) => r.key)),
        ])),
      );
    const target = await workflowFixture(
      "00000000-0000-4000-8000-000000000088",
    );
    async function targetRpc(name: string, args: unknown[] = []) {
      await target.db.query(
        "select set_config('request.jwt.claim.sub',$1,false)",
        [target.owner],
      );
      await target.db.exec("set role authenticated");
      try {
        return await target.rpc(name, args);
      } finally {
        await target.db.exec("reset role");
      }
    }
    try {
      await target.db.exec("begin");
      const session = await targetRpc("begin_workspace_restore", [
        JSON.stringify(manifest),
        true,
      ]);
      for (let i = 0; i < all.length; i += 10)
        await targetRpc("stage_restore_rows", [
          session.id,
          JSON.stringify(all.slice(i, i + 10)),
        ]);
      for (const file of session.files)
        await target.rpc("complete_restore_file", [
          file.id,
          target.owner,
          file.content_hash,
          file.expected_size,
        ]);
      await targetRpc("commit_workspace_restore", [session.id]);
      let pack = await targetRpc("delivery_package", [s.id]);
      expect(pack.status).toBe(partial ? "blocked" : "ready");
      const restored = (
        await target.db.query<any>(
          "select * from public.proposal_delivery_artifacts where snapshot_id=$1 order by volume",
          [s.id],
        )
      ).rows;
      expect(restored[0]).toMatchObject({
        status: "ready",
        content_hash: "a".repeat(64),
        expected_size: 321,
      });
      expect(restored[0].storage_key).not.toBe(c.artifacts[0].storage_key);
      if (partial) {
        expect(restored[1]).toMatchObject({
          status: "expired",
          reserved_bytes: 0,
        });
        const retryInput = {
          snapshot_id: s.id,
          expected_delivery_revision: pack.snapshot.delivery_revision,
        };
        await target.command("delivery.snapshot.retry", retryInput);
        const next = await target.rpc("claim_backend_job_v5");
        expect(next.created_by).toBe(target.owner);
        expect(next.id).not.toBe(j.id);
        const nextContext = await target.rpc("delivery_export_context", [
          next.id,
          next.lease_token,
        ]);
        expect(nextContext.artifacts[0]).toMatchObject({
          status: "ready",
          storage_key: restored[0].storage_key,
          content_hash: restored[0].content_hash,
        });
        expect(nextContext.artifacts[1]).toMatchObject({
          status: "pending",
          reserved_bytes: 10485760,
        });
        expect(nextContext.artifacts[1].storage_key).not.toBe(
          c.artifacts[1].storage_key,
        );
        expect(nextContext.artifacts[1].storage_key).not.toBe(
          restored[1].storage_key,
        );
        await target.rpc("complete_delivery_artifact", [
          next.id,
          next.lease_token,
          nextContext.artifacts[1].id,
          "b".repeat(64),
          456,
        ]);
        await target.rpc("finish_delivery_export", [next.id, next.lease_token]);
        pack = await targetRpc("delivery_package", [s.id]);
        expect(pack.status).toBe("ready");
      }
      const authorized = await target.rpc(
        "authorize_delivery_artifact_download",
        [restored[0].id, target.owner, restored[0].content_hash],
      );
      expect(authorized.id).toBe(restored[0].id);
      expect(
        (
          await target.db.query<any>(
            "select count(*)::int n from public.provider_usage",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await target.db.exec("rollback");
      await target.db.close();
    }
  },
  30000,
);
it("bounds six crash recoveries and retains uncertain storage for explicit retry", async () => {
  const { snapshot: s } = await setup();
  let j = await claim(s);
  const c = await context(j);
  for (let crash = 1; crash <= 6; crash++) {
    await f.db.query(
      "update public.jobs set lease_until=now()-interval '1 second' where id=$1",
      [j.id],
    );
    const next = await f.rpc("claim_backend_job_v5");
    if (crash < 6) {
      expect(next.id).toBe(j.id);
      expect(next.failure_count).toBe(crash);
      j = next;
    } else {
      expect(next).toBeNull();
      expect(await job(s)).toMatchObject({
        status: "blocked",
        failure_count: 6,
        error_code: "DELIVERY_WORKER_RESTARTED",
        lease_token: null,
      });
    }
  }
  expect((await artifacts(s))[0]).toMatchObject({
    storage_key: c.artifacts[0].storage_key,
    reserved_bytes: 10485760,
    status: "pending",
  });
});
it("rejects null failure diagnostics and explicit retry under a live or ambiguous lease", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s);
  await expect(
    attempt(() => f.rpc("fail_delivery_export", [j.id, j.lease_token, null])),
  ).rejects.toThrow("INVALID_INPUT");
  const input = {
    snapshot_id: s.id,
    expected_delivery_revision: (await userRpc("delivery_package", [s.id]))
      .snapshot.delivery_revision,
  };
  await expect(f.command("delivery.snapshot.retry", input)).rejects.toThrow(
    "DELIVERY_RETRY_NOT_ALLOWED",
  );
  await f.db.query("update public.jobs set status='blocked' where id=$1", [
    j.id,
  ]);
  await expect(f.command("delivery.snapshot.retry", input)).rejects.toThrow(
    "DELIVERY_RETRY_NOT_ALLOWED",
  );
  expect(
    (
      await row(
        "select count(*)::int n from public.jobs where type='render_delivery'",
      )
    ).n,
  ).toBe(1);
});
it("rechecks source and actor before idempotent retry replay", async () => {
  const { snapshot: s, opportunity: o } = await setup(),
    j = await claim(s);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "DELIVERY_ARTIFACT_INVALID",
  ]);
  const input = {
      snapshot_id: s.id,
      expected_delivery_revision: (await userRpc("delivery_package", [s.id]))
        .snapshot.delivery_revision,
    },
    key = crypto.randomUUID();
  await f.command("delivery.snapshot.retry", input, key);
  await f.db.query(
    "update public.opportunities set description='Changed synthetic input',revision=revision+1 where id=$1",
    [o.id],
  );
  await expect(
    f.command("delivery.snapshot.retry", input, key),
  ).rejects.toThrow("STALE_INPUT");
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    f.command("delivery.snapshot.retry", input, key),
  ).rejects.toThrow("ROLE_FORBIDDEN");
});
it("rejects retry from read-only membership or stale delivery revision", async () => {
  const { snapshot: s } = await setup(),
    j = await claim(s);
  await f.rpc("fail_delivery_export", [
    j.id,
    j.lease_token,
    "DELIVERY_RENDERER_UNSUPPORTED",
  ]);
  const revision = (await userRpc("delivery_package", [s.id])).snapshot
    .delivery_revision;
  await expect(
    f.command("delivery.snapshot.retry", {
      snapshot_id: s.id,
      expected_delivery_revision: revision + 1,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await f.db.query(
    "update public.memberships set role='Reviewer' where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    f.command("delivery.snapshot.retry", {
      snapshot_id: s.id,
      expected_delivery_revision: revision,
    }),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  expect((await job(s)).status).toBe("blocked");
});
it.each([false, true])(
  "explicitly initializes a pre-queue snapshot across the actual migration boundary (separate: %s)",
  async (separate) => {
    const legacy = await workflowFixture(
      "00000000-0000-4000-8000-000000000088",
      "20261104121116_proposal_delivery_snapshots.sql",
    );
    try {
      await legacy.db.exec("begin");
      const source = await legacy.command("source.create", {
        name: "Synthetic pre-queue source",
        kind: "manual",
      });
      const opportunity = await legacy.command("opportunity.create", {
        source_id: source.id,
        title: "Synthetic pre-queue proposal",
        reference: "SYNTHETIC",
        description: "Deliver a documented two-stage approval process.",
        language: "en",
        decision: "shortlisted",
      });
      let snapshot = await legacy.command("delivery.snapshot.prepare", {
        opportunity_id: opportunity.id,
        expected_revision: opportunity.revision,
      });
      if (separate) {
        snapshot = (
          await legacy.db.query<any>(
            `insert into public.proposal_delivery_snapshots(workspace_id,opportunity_id,proposal_id,base_version_id,ordinal,content_hash,source_manifest,payload,created_by)
        select workspace_id,opportunity_id,proposal_id,base_version_id,ordinal+1,encode(sha256(convert_to(p::text,'UTF8')),'hex'),source_manifest,p,created_by
        from public.proposal_delivery_snapshots cross join lateral(select payload||'{"separate_volumes":true}'::jsonb p) x where id=$1 returning *`,
            [snapshot.id],
          )
        ).rows[0];
      }
      expect(
        (
          await legacy.db.query<any>(
            "select count(*)::int n from public.jobs where type='render_delivery'",
          )
        ).rows[0].n,
      ).toBe(0);
      await legacy.db.exec(
        await readFile(
          new URL(
            "../../supabase/migrations/20261104122333_durable_delivery_artifacts.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const pack = await legacy.rpc("delivery_package", [snapshot.id]);
      expect(pack).toMatchObject({
        status: "blocked",
        artifacts: [],
        job: {
          id: null,
          status: "not_queued",
          error_code: "DELIVERY_NOT_QUEUED",
          next_attempt_at: null,
        },
      });
      expect(
        (
          await legacy.db.query<any>(
            "select count(*)::int n from public.jobs where type='render_delivery'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await legacy.db.query<any>(
            "select count(*)::int n from public.proposal_delivery_artifacts",
          )
        ).rows[0].n,
      ).toBe(0);
      const input = {
          snapshot_id: snapshot.id,
          expected_delivery_revision: pack.snapshot.delivery_revision,
        },
        key = crypto.randomUUID();
      expect(
        (await legacy.command("delivery.snapshot.retry", input, key)).id,
      ).toBe(snapshot.id);
      await legacy.command("delivery.snapshot.retry", input, key);
      await expect(
        legacy.command("delivery.snapshot.retry", input),
      ).rejects.toThrow("REVISION_CONFLICT");
      const jobs = (
        await legacy.db.query<any>(
          "select * from public.jobs where type='render_delivery'",
        )
      ).rows;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        entity_id: snapshot.id,
        created_by: legacy.owner,
        status: "queued",
        checkpoint: { model_executor: 3, delivery_attempt: 1 },
      });
      const files = (
        await legacy.db.query<any>(
          "select * from public.proposal_delivery_artifacts order by volume",
        )
      ).rows;
      expect(files.map((a) => a.volume)).toEqual(
        separate ? ["financial", "technical"] : ["combined"],
      );
      expect(
        files.every(
          (a) =>
            a.status === "pending" &&
            a.reserved_bytes === 0 &&
            a.created_by === legacy.owner,
        ),
      ).toBe(true);
      expect(
        (
          await legacy.db.query<any>(
            "select count(*)::int n from public.audit_events where action='delivery.render.initialized' and details->>'previous_job_id' is null",
          )
        ).rows[0].n,
      ).toBe(1);
      const preserved = (
        await legacy.db.query<any>(
          "select payload,content_hash from public.proposal_delivery_snapshots where id=$1",
          [snapshot.id],
        )
      ).rows[0];
      expect(preserved).toEqual({
        payload: snapshot.payload,
        content_hash: snapshot.content_hash,
      });
      const claimed = await legacy.rpc("claim_backend_job_v3");
      const context = await legacy.rpc("delivery_export_context", [
        claimed.id,
        claimed.lease_token,
      ]);
      expect(context.artifacts).toHaveLength(separate ? 2 : 1);
      expect(
        (
          await legacy.db.query<any>(
            "select count(*)::int n from public.provider_usage",
          )
        ).rows[0].n,
      ).toBe(0);
      await legacy.db.exec("rollback");
    } finally {
      await legacy.db.close();
    }
  },
  30000,
);
it.each(["none", "partial"])(
  "rejects %s artifact sets when a renderer job already exists",
  async (mode) => {
    const initial = await setup(),
      s = await clone(initial.snapshot, true);
    await f.db.query(
      "delete from public.proposal_delivery_artifacts where snapshot_id=$1 and ($2='none' or volume='financial')",
      [s.id, mode],
    );
    await expect(userRpc("delivery_package", [s.id])).rejects.toThrow(
      "DELIVERY_ARTIFACT_INVALID",
    );
    const revision = (
      await row("select delivery_revision from public.proposals where id=$1", [
        s.proposal_id,
      ])
    ).delivery_revision;
    await expect(
      f.command("delivery.snapshot.retry", {
        snapshot_id: s.id,
        expected_delivery_revision: revision,
      }),
    ).rejects.toThrow("DELIVERY_ARTIFACT_INVALID");
    expect(
      (
        await row(
          "select count(*)::int n from public.jobs where type='render_delivery' and entity_id=$1",
          [s.id],
        )
      ).n,
    ).toBe(1);
  },
);
