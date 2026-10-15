// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup() {
  const item = await f.command("knowledge.save", {
    title: "Synthetic company facts",
    content: "Builds approval software.",
    category: "company",
    enabled: true,
    evidence: "Synthetic test record",
  });
  const candidates = await f.rpc("eligibility_candidates");
  const ref = candidates.items.find((x: any) => x.entity_id === item.id);
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "qwen_free",
    model: "synthetic-model",
    project_ref: "synthetic",
    free_only: true,
    billing_verified: true,
    free_quota_only: true,
    quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
    quota_remaining_tokens: 100000,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
  });
  await f.command("content.authorize", {
    entity_kind: ref.entity_kind,
    entity_id: ref.entity_id,
    content_hash: ref.content_hash,
    provider: "qwen_free",
    attestation: "nonconfidential_nonpersonal",
  });
  const job = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,created_by,status,lease_token,lease_until,input_hash) values($1,'classify_opportunity',$2,$3,'running',gen_random_uuid(),now()+interval '3 minutes',repeat('b',64)) returning *",
      [f.w, item.id, f.owner],
    )
  ).rows[0];
  return { item, ref, job };
}
async function reserve(s: Awaited<ReturnType<typeof setup>>, key = "first") {
  return f.rpc("reserve_model_call", [
    s.job.id,
    s.job.lease_token,
    key,
    "a".repeat(64),
    1000,
    2048,
    JSON.stringify([s.ref]),
  ]);
}
it("binds consent to the exact content and provider; rejects stale hashes", async () => {
  const s = await setup();
  expect(
    (
      await f.rpc("model_preflight", [
        s.job.id,
        s.job.lease_token,
        JSON.stringify([s.ref]),
      ])
    ).provider,
  ).toBe("qwen_free");
  await f.command("knowledge.save", {
    id: s.item.id,
    expected_revision: s.item.revision,
    title: s.item.title,
    content: "Changed evidence",
    category: "company",
    enabled: true,
    evidence: "Changed synthetic record",
  });
  await expect(
    f.rpc("model_preflight", [
      s.job.id,
      s.job.lease_token,
      JSON.stringify([s.ref]),
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("retains uncertain reservations after lease termination and permits documented Owner reconciliation", async () => {
  const s = await setup(),
    u = await reserve(s);
  await f.db.query(
    "update public.jobs set status='blocked',lease_token=null,lease_until=null where id=$1",
    [s.job.id],
  );
  const usage = (
    await f.db.query<any>("select * from public.provider_usage where id=$1", [
      u.id,
    ])
  ).rows[0];
  expect(usage.state).toBe("unknown");
  const result = await f.command("usage.resolve", {
    id: u.id,
    expected_revision: usage.revision,
    actual_input: 100,
    actual_output: 500,
    thinking_tokens: 50,
    reason: "Synthetic provider ledger verification",
  });
  expect(result.state).toBe("settled");
  expect(result.reserved_output).toBe(2048);
});
it("keeps rejected-call reservations in accounting without inventing measured zeros", async () => {
  const s = await setup(),
    u = await reserve(s);
  await f.rpc("settle_model_call", [
    u.id,
    null,
    null,
    null,
    "PROVIDER_QUOTA_WAIT",
  ]);
  const usage = (
    await f.db.query<any>("select * from public.provider_usage where id=$1", [
      u.id,
    ])
  ).rows[0];
  expect(usage.state).toBe("settled");
  expect(usage.actual_input).toBeNull();
  expect(usage.reserved_input).toBe(1000);
  await expect(reserve(s, "second")).rejects.toThrow("MODEL_RATE_WAIT");
});
it("blocks duplicate or concurrent calls while one reservation is unresolved", async () => {
  const s = await setup();
  await reserve(s);
  await expect(reserve(s, "second")).rejects.toThrow("USAGE_REVIEW_REQUIRED");
});
it("disables the provider when measured usage exceeds its reservation", async () => {
  const s = await setup(),
    u = await reserve(s);
  await f.rpc("settle_model_call", [u.id, 2000, 2048, 0, null]);
  expect(
    (await f.db.query<any>("select enabled from public.model_settings")).rows[0]
      .enabled,
  ).toBe(false);
});
it("rejects personal content at storage before any Owner model attestation", async () => {
  await expect(
    f.command("knowledge.save", {
      category: "company",
      title: "Synthetic contact",
      content: "person@example.test",
      enabled: true,
      evidence: "",
    }),
  ).rejects.toThrow("DATA_POLICY_BLOCKED");
  expect(
    (await f.db.query("select id from public.knowledge_items")).rows,
  ).toHaveLength(0);
});
