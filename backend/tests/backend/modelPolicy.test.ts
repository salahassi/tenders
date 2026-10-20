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
it("uses the stored-content check for an authorized confidentiality requirement and keeps explicit consent necessary", async () => {
  const item = await f.command("knowledge.save", {
    title: "Synthetic handling requirements",
    content: "The supplier shall maintain confidentiality of project data.",
    category: "company",
    enabled: true,
    evidence: "Synthetic fixture only",
  });
  const ref = (await f.rpc("eligibility_candidates")).items.find(
    (x: any) => x.entity_id === item.id,
  );
  expect(
    (
      await f.db.query(
        "select id from public.content_authorizations where entity_id=$1",
        [item.id],
      )
    ).rows,
  ).toHaveLength(0);
  const result = await f.command("content.authorize", {
    entity_kind: ref.entity_kind,
    entity_id: ref.entity_id,
    content_hash: ref.content_hash,
    provider: "qwen_free",
    attestation: "nonconfidential_nonpersonal",
  });
  expect(result).toMatchObject({
    entity_id: item.id,
    provider: "qwen_free",
    revoked_at: null,
  });
  await expect(
    f.command("content.authorize", {
      entity_kind: ref.entity_kind,
      entity_id: ref.entity_id,
      content_hash: "a".repeat(64),
      provider: "qwen_free",
      attestation: "nonconfidential_nonpersonal",
    }),
  ).rejects.toThrow("STALE_INPUT");
  await expect(
    f.command("knowledge.save", {
      title: "Synthetic restricted file",
      content: "Confidential: internal information",
      category: "company",
      enabled: true,
      evidence: "Fixture",
    }),
  ).rejects.toThrow("DATA_POLICY_BLOCKED");
});
it("preserves ordinary confidentiality obligations in text and structured business content", async () => {
  for (const text of [
    "The vendor shall keep project data confidential.",
    "Confidential data must be protected by access controls.",
    "يجب الحفاظ على سرية بيانات المشروع.",
  ]) {
    for (const content of [text, JSON.stringify({ text })]) {
      await expect(
        f.command("knowledge.save", {
          title: "Synthetic handling requirement",
          content,
          category: "company",
          enabled: true,
          evidence: "Synthetic fixture only",
        }),
      ).resolves.toHaveProperty("id");
    }
  }
  for (const text of [
    "CONFIDENTIAL: project data",
    "CONFIDENTIAL",
    "classification: confidential",
    "Document\nConfidential\nPrivate contents",
    "سرية: بيانات داخلية",
    "سرية",
    "Strictly private document",
    "api_key=example",
    "person@example.test",
  ]) {
    for (const content of [text, JSON.stringify({ text })]) {
      await expect(
        f.command("knowledge.save", {
          title: "Synthetic restricted content",
          content,
          category: "company",
          enabled: true,
          evidence: "Synthetic fixture only",
        }),
      ).rejects.toThrow("DATA_POLICY_BLOCKED");
    }
  }
});
async function reserve(s: Awaited<ReturnType<typeof setup>>, key = "first") {
  return f.rpc("reserve_model_call", [
    s.job.id,
    s.job.lease_token,
    key,
    "a".repeat(64),
    1000,
    2048,
    JSON.stringify([s.ref]),
    "qwen_free",
  ]);
}
async function addGemini(s: Awaited<ReturnType<typeof setup>>) {
  const settings = await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "gemini_free",
    model: "gemini-3.8-flash",
    project_ref: "synthetic-project",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
    quota_remaining_tokens: 100000,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  });
  await f.command("content.authorize", {
    entity_kind: s.ref.entity_kind,
    entity_id: s.ref.entity_id,
    content_hash: s.ref.content_hash,
    provider: "gemini_free",
    attestation: "nonconfidential_nonpersonal",
  });
  return settings;
}
it("accepts the UI failover rank and permits a different provider after explicit quota rejection", async () => {
  const s = await setup();
  expect((await addGemini(s)).failover_rank).toBe(1);
  const u = await reserve(s);
  await f.rpc("settle_model_call", [
    u.id,
    null,
    null,
    null,
    "PROVIDER_QUOTA_WAIT",
  ]);
  const next = await f.rpc("reserve_model_call", [
    s.job.id,
    s.job.lease_token,
    "fallback",
    "b".repeat(64),
    1000,
    2048,
    JSON.stringify([s.ref]),
    "gemini_free",
  ]);
  expect(next.provider).toBe("gemini_free");
  expect(next.state).toBe("reserved");
});
it("keeps unknown generation usage blocking other providers", async () => {
  const s = await setup();
  await addGemini(s);
  const u = await reserve(s);
  await f.rpc("settle_model_call", [
    u.id,
    null,
    null,
    null,
    "MODEL_NETWORK_UNCERTAIN",
  ]);
  await expect(
    f.rpc("reserve_model_call", [
      s.job.id,
      s.job.lease_token,
      "fallback",
      "b".repeat(64),
      1000,
      2048,
      JSON.stringify([s.ref]),
      "gemini_free",
    ]),
  ).rejects.toThrow("USAGE_REVIEW_REQUIRED");
});
it("skips expired profiles without preventing a verified provider from running", async () => {
  const s = await setup();
  await addGemini(s);
  await f.db.query(
    "update public.model_settings set quota_ends_at=now()-interval '1 day' where provider='qwen_free'",
  );
  const pool = await f.rpc("model_preflight", [
    s.job.id,
    s.job.lease_token,
    JSON.stringify([s.ref]),
  ]);
  expect(pool.providers.map((p: any) => p.provider)).toEqual(["gemini_free"]);
});
it("binds consent to the exact content and provider; rejects stale hashes", async () => {
  const s = await setup();
  expect(
    (
      await f.rpc("model_preflight", [
        s.job.id,
        s.job.lease_token,
        JSON.stringify([s.ref]),
      ])
    ).providers[0].provider,
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
it("keeps reservations without rejection telemetry and never invents measured zeros", async () => {
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
  expect(
    (
      await f.db.query<any>(
        "select app_private.generation_reservation_rejected(u) released from public.provider_usage u where id=$1",
        [u.id],
      )
    ).rows[0].released,
  ).toBe(false);
  await expect(reserve(s, "second")).rejects.toThrow("MODEL_RATE_WAIT");
});

it("releases confirmed initial 429 reservations, preserves null usage, and keeps ambiguous/poll requests reserved", async () => {
  const s = await setup(),
    u = await reserve(s);
  const attempt = await f.rpc("start_model_attempt", [
    s.job.id,
    s.job.lease_token,
    "qwen_free",
    "synthetic-model",
    "synthetic",
    "classify_opportunity",
  ]);
  await f.rpc("settle_model_call", [
    u.id,
    null,
    null,
    null,
    "PROVIDER_QUOTA_WAIT",
  ]);
  await f.rpc("finish_model_attempt", [
    attempt,
    s.job.lease_token,
    "PROVIDER_QUOTA_WAIT",
    true,
    u.id,
    JSON.stringify({ http_status: 429, request_phase: "generation" }),
  ]);
  const released = async () =>
    (
      await f.db.query<any>(
        "select app_private.generation_reservation_rejected(u) released from public.provider_usage u where id=$1",
        [u.id],
      )
    ).rows[0].released;
  const status = async () => {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      f.owner,
    ]);
    await f.db.exec("set role authenticated");
    try {
      return await f.rpc("workspace_status");
    } finally {
      await f.db.exec("reset role");
    }
  };
  expect(await released()).toBe(true);
  expect(await status()).toMatchObject({
    calls_today: 1,
    input_tokens_today: "0",
    output_tokens_today: "0",
    estimated_usage_records: 0,
  });
  expect(
    (
      await f.db.query<any>(
        "select actual_input,actual_output,reserved_output from public.provider_usage where id=$1",
        [u.id],
      )
    ).rows[0],
  ).toEqual({ actual_input: null, actual_output: null, reserved_output: 2048 });
  await f.db.query(
    "update public.model_attempts set request_phase='poll' where id=$1",
    [attempt],
  );
  expect(await released()).toBe(false);
  await f.db.query(
    "update public.model_attempts set request_phase='generation',http_status=503 where id=$1",
    [attempt],
  );
  expect(await released()).toBe(false);
  await f.db.query(
    "update public.model_attempts set http_status=429 where id=$1",
    [attempt],
  );
  await f.db.query(
    "update public.provider_usage set provider='gemini_free',remote_request_id='accepted-request',remote_deadline=now()+interval '1 hour' where id=$1",
    [u.id],
  );
  await f.db.query(
    "update public.model_attempts set provider='gemini_free' where id=$1",
    [attempt],
  );
  expect(await released()).toBe(false);
  await f.db.query(
    "update public.provider_usage set provider='qwen_free',remote_request_id=null,remote_deadline=null,state='unknown' where id=$1",
    [u.id],
  );
  await f.db.query(
    "update public.model_attempts set provider='qwen_free' where id=$1",
    [attempt],
  );
  expect(await released()).toBe(false);
  expect(await status()).toMatchObject({
    input_tokens_today: "1000",
    output_tokens_today: "2048",
    unknown_usage: 1,
    estimated_usage_records: 1,
  });
  await f.db.query(
    "update public.provider_usage set state='settled',actual_input=100,actual_output=20 where id=$1",
    [u.id],
  );
  expect(await status()).toMatchObject({
    input_tokens_today: "100",
    output_tokens_today: "20",
  });
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','app_private.generation_reservation_rejected(public.provider_usage)','execute') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
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
    (
      await f.db.query<any>(
        "select enabled from public.model_settings where provider='qwen_free'",
      )
    ).rows[0].enabled,
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
