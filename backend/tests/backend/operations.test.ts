// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function userRpc(name: string, args: unknown[] = []) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  await f.db.exec("set role authenticated;savepoint op_attempt");
  try {
    return await f.rpc(name, args);
  } catch (e) {
    await f.db.exec("rollback to savepoint op_attempt");
    throw e;
  } finally {
    await f.db.exec("release savepoint op_attempt;reset role");
  }
}
async function opp(title = "Synthetic maintenance") {
  const s = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: s.id,
    title,
    reference: crypto.randomUUID(),
    decision: "shortlisted",
  });
}
async function document(opportunity_id: string, ready = false) {
  const text = "Synthetic retained public RFP text.";
  const d = await f.command("document.prepare", {
    eligibility_attested: true,
    client_id: crypto.randomUUID(),
    kind: "rfp",
    opportunity_id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: text.length,
    hash: "a".repeat(64),
  });
  if (ready)
    await f.rpc("accept_uploaded_document", [
      d.id,
      f.owner,
      "a".repeat(64),
      text.length,
      text,
      "ready",
      crypto.randomUUID(),
    ]);
  return d;
}
it("deduplicates confirmed 7/3/1 day reminders and routes date-only deadlines to review", async () => {
  for (const days of [6.5, 2.5, 0.5]) {
    const o = await opp();
    await f.db.query(
      "update public.opportunities set deadline_at=now()+$2*interval '1 day',deadline_timezone='Asia/Riyadh' where id=$1",
      [o.id, days],
    );
  }
  const ambiguous = await opp();
  await f.db.query(
    "update public.opportunities set deadline_raw='Tomorrow, time unspecified' where id=$1",
    [ambiguous.id],
  );
  await f.rpc("maintenance_tick");
  expect(
    (
      await f.db.query(
        "select * from public.notifications where dedupe_key like 'deadline%'",
      )
    ).rows,
  ).toHaveLength(4);
  await f.db.exec(
    "update public.operations set last_maintenance_at=now()-interval '2 hours'",
  );
  await f.rpc("maintenance_tick");
  expect(
    (
      await f.db.query(
        "select * from public.notifications where dedupe_key like 'deadline%'",
      )
    ).rows,
  ).toHaveLength(4);
  const status = await userRpc("workspace_status");
  expect(status.calls_today).toBe(0);
  expect(status.usage_timezone).toBe("Asia/Riyadh");
  expect(status.last_maintenance_at).toBeTruthy();
});
it("expires abandoned uploads, protects accepted evidence and releases storage only on verified cleanup", async () => {
  const o = await opp(),
    pending = await document(o.id),
    retained = await document(o.id, true);
  await f.db.exec(
    "update public.documents set created_at=now()-interval '100 days'",
  );
  await f.rpc("maintenance_tick");
  const rows = (await f.db.query<any>("select id,status from public.documents"))
    .rows;
  expect(rows.find((x) => x.id === pending.id).status).toBe("expired");
  expect(rows.find((x) => x.id === retained.id).status).toBe("ready");
  const before = await userRpc("workspace_status"),
    claimed = await f.rpc("claim_storage_cleanup");
  expect(claimed).toHaveLength(1);
  await f.db.exec("savepoint lease_test");
  await expect(
    f.rpc("complete_storage_cleanup", [
      claimed[0].id,
      crypto.randomUUID(),
      true,
    ]),
  ).rejects.toThrow("STALE_LEASE");
  await f.db.exec(
    "rollback to savepoint lease_test;release savepoint lease_test",
  );
  await f.rpc("complete_storage_cleanup", [
    claimed[0].id,
    claimed[0].lease_token,
    true,
  ]);
  const after = await userRpc("workspace_status");
  expect(
    Number(before.reserved_storage_bytes) -
      Number(after.reserved_storage_bytes),
  ).toBe(claimed[0].estimated_size);
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) select workspace_id,storage_key,expected_size,'Synthetic erroneous cleanup request' from public.documents where id=$1",
    [retained.id],
  );
  expect(await f.rpc("claim_storage_cleanup")).toEqual([]);
  expect(
    (
      await f.db.query<any>(
        "select error_code from public.storage_cleanup_queue where status='blocked'",
      )
    ).rows[0].error_code,
  ).toBe("ACTIVE_REFERENCE_FOUND");
});
it("requires a current purge preview and exact confirmation, then removes the full commercial graph and queues originals", async () => {
  const h = commercialHelpers(f),
    s = await h.setup();
  await h.calculate(s);
  await h.calculate(s, "delivery");
  const o = (await f.db.query<any>("select * from public.opportunities"))
    .rows[0];
  await document(o.id, true);
  const job = crypto.randomUUID();
  await f.db.query(
    "insert into public.jobs(id,workspace_id,type,entity_id,input_hash,status,created_by) values($1,$2,'classify_opportunity',$3,repeat('a',64),'failed',$4)",
    [job, f.w, s.plan, f.owner],
  );
  await f.db.query(
    "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1,$2,gen_random_uuid(),'synthetic','gemini','synthetic',repeat('a',64),current_date,1,100,100,'unknown',$3)",
    [f.w, job, f.owner],
  );
  const first = await userRpc("preview_opportunity_purge", [o.id]);
  expect(first.counts.proposal_versions).toBe(1);
  expect(first.files).toHaveLength(1);
  await expect(
    userRpc("purge_opportunity", [
      o.id,
      first.preview_hash,
      o.title,
      "Synthetic purge reason",
      true,
    ]),
  ).rejects.toThrow("ARCHIVE_AND_STOP_PROCESSING_FIRST");
  await userRpc("archive_opportunity", [
    o.id,
    o.revision,
    true,
    "Synthetic archival reason",
  ]);
  await expect(
    userRpc("purge_opportunity", [
      o.id,
      first.preview_hash,
      o.title,
      "Synthetic purge reason",
      true,
    ]),
  ).rejects.toThrow("STALE_PURGE_PREVIEW");
  const preview = await userRpc("preview_opportunity_purge", [o.id]);
  await expect(
    userRpc("purge_opportunity", [
      o.id,
      preview.preview_hash,
      o.title,
      "Synthetic purge reason",
      false,
    ]),
  ).rejects.toThrow("PURGE_CONFIRMATION_REQUIRED");
  const result = await userRpc("purge_opportunity", [
    o.id,
    preview.preview_hash,
    o.title,
    "Synthetic purge reason",
    true,
  ]);
  expect(result.counts.proposals).toBe(1);
  const usage = (await f.db.query<any>("select * from public.provider_usage"))
    .rows;
  expect(usage).toHaveLength(1);
  expect(usage[0].job_id).toBeNull();
  expect(usage[0].state).toBe("unknown");
  expect(
    (
      await f.db.query<any>(
        "select result from app_private.idempotency_records where result->>'id'=$1",
        [o.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select * from public.proposal_versions")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select * from public.documents")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select * from public.rate_catalog")).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "select * from public.storage_cleanup_queue where status='pending'",
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    await userRpc("purge_opportunity", [
      o.id,
      preview.preview_hash,
      o.title,
      "Synthetic purge reason",
      true,
    ]),
  ).toEqual(result);
});

it("denies maintenance and purge operations to ordinary members", async () => {
  const o = await opp();
  await f.db.query(
    "update public.memberships set role='Reviewer' where user_id=$1",
    [f.owner],
  );
  await expect(
    userRpc("archive_opportunity", [
      o.id,
      o.revision,
      true,
      "Synthetic archival reason",
    ]),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  await expect(userRpc("preview_opportunity_purge", [o.id])).rejects.toThrow(
    "ROLE_FORBIDDEN",
  );
  await expect(userRpc("maintenance_tick")).rejects.toThrow(
    "permission denied",
  );
  await expect(userRpc("claim_storage_cleanup")).rejects.toThrow(
    "permission denied",
  );
});
