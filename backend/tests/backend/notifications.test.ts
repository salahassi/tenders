// @vitest-environment node
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  notificationMessage,
  processNotificationEmail,
  smtpFailure,
  smtpStatus,
} from "../../supabase/functions/_shared/notifications";
import {
  environment,
  type Backend,
} from "../../supabase/functions/_shared/backend";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const settings = {
  expected_revision: 0,
  email_enabled: true,
  failure_alerts: true,
  review_reminders: true,
  review_interval_hours: 24,
  language: "ar",
};
const env = environment(
  (name) =>
    ({
      APP_SMTP_HOST: "smtp.example.test",
      APP_SMTP_PORT: "465",
      APP_SMTP_USER: "synthetic",
      APP_SMTP_PASSWORD: "synthetic-secret",
      APP_SMTP_FROM: "notices@example.test",
    })[name],
);
async function pref() {
  return f.command("notification.preferences", settings);
}
async function deliveries() {
  return (
    await f.db.query<any>(
      "select * from public.notification_deliveries order by created_at,id",
    )
  ).rows;
}
async function current(id: string) {
  return (await f.db.query<any>("select * from public.jobs where id=$1", [id]))
    .rows[0];
}
const backend = () =>
  ({
    internal: async (name: string, args: Record<string, unknown> = {}) => {
      const entries = Object.entries(args);
      return (
        await f.db.query<any>(
          `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) data`,
          entries.map(([, v]) => v),
        )
      ).rows[0].data;
    },
  }) as unknown as Backend;
it("stores only the caller's preferences with revision and replay protection", async () => {
  const a = await f.command(
    "notification.preferences",
    settings,
    "00000000-0000-4000-8000-000000000101",
  );
  expect(a.user_id).toBe(f.owner);
  expect(
    (
      await f.command(
        "notification.preferences",
        settings,
        "00000000-0000-4000-8000-000000000101",
      )
    ).revision,
  ).toBe(1);
  await expect(
    f.command(
      "notification.preferences",
      { ...settings, language: "en" },
      "00000000-0000-4000-8000-000000000101",
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(f.command("notification.preferences", settings)).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  await expect(
    f.command("notification.preferences", {
      ...settings,
      expected_revision: 1,
      user_id: crypto.randomUUID(),
    }),
  ).rejects.toThrow("INVALID_INPUT");
});
it("does not expose preferences/outbox or delivery authority to another browser identity", async () => {
  await pref();
  await f.command("notification.test", {});
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    crypto.randomUUID(),
  ]);
  await f.db.exec("set local role authenticated");
  expect(
    (await f.db.query("select * from public.notification_preferences")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select * from public.notification_deliveries")).rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','public.claim_notification_delivery()','EXECUTE') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
  await f.db.exec("reset role");
});
it("queues once, sends only to the verified member and records SMTP acceptance", async () => {
  await pref();
  const queued = await f.command(
    "notification.test",
    {},
    "00000000-0000-4000-8000-000000000102",
  );
  await f.command(
    "notification.test",
    {},
    "00000000-0000-4000-8000-000000000102",
  );
  expect(await deliveries()).toHaveLength(1);
  const send = vi.fn(async (_message: unknown) => ({
    accepted: ["owner@example.test"],
    messageId: "synthetic-smtp-id",
  }));
  await processNotificationEmail(backend(), env, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({
    to: "owner@example.test",
    from: "notices@example.test",
  });
  expect((await deliveries())[0]).toMatchObject({
    id: queued.id,
    status: "sent",
    attempts: 1,
    message_id: "synthetic-smtp-id",
  });
  await processNotificationEmail(backend(), env, send);
  expect(send).toHaveBeenCalledTimes(1);
});
it("does not consume a delivery attempt when SMTP is missing", async () => {
  await pref();
  await f.command("notification.test", {});
  const send = vi.fn();
  await processNotificationEmail(backend(), { ...env, smtp: undefined }, send);
  expect(send).not.toHaveBeenCalled();
  expect((await deliveries())[0]).toMatchObject({
    status: "queued",
    attempts: 0,
  });
});
it("cancels queued messages when preferences or membership are revoked", async () => {
  const p = await pref();
  await f.command("notification.test", {});
  await f.command("notification.preferences", {
    ...settings,
    expected_revision: p.revision,
    email_enabled: false,
  });
  expect((await deliveries())[0].status).toBe("canceled");
  await f.command("notification.preferences", {
    ...settings,
    expected_revision: 2,
  });
  await f.db.query(
    "insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key) values($1,$2,'test','second')",
    [f.w, f.owner],
  );
  await f.db.query(
    "update public.memberships set active=false where user_id=$1",
    [f.owner],
  );
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
  expect((await deliveries()).every((d) => d.status === "canceled")).toBe(true);
});
it("retries explicit temporary SMTP rejection but preserves uncertain DATA delivery", async () => {
  await pref();
  await f.command("notification.test", {});
  await processNotificationEmail(backend(), env, async () => {
    throw { responseCode: 451 };
  });
  expect((await deliveries())[0]).toMatchObject({
    status: "retry_wait",
    attempts: 1,
    error_code: "SMTP_TEMPORARY_REJECTION",
  });
  await f.db.exec(
    "update public.notification_deliveries set next_attempt_at=now()",
  );
  await processNotificationEmail(backend(), env, async () => {
    throw { code: "ETIMEDOUT", command: "DATA" };
  });
  expect((await deliveries())[0]).toMatchObject({
    status: "delivery_unknown",
    attempts: 2,
  });
  const send = vi.fn();
  await processNotificationEmail(backend(), env, send);
  expect(send).not.toHaveBeenCalled();
  expect(
    (
      await f.db.query(
        "select * from public.notifications where dedupe_key like 'email-delivery:%'",
      )
    ).rows,
  ).toHaveLength(1);
});
it("keeps accepted mail out of retry if the database acknowledgement fails", async () => {
  const d = {
    id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
    recipient: "owner@example.test",
    language: "en",
    kind: "test",
    payload: {},
  };
  const calls: string[] = [];
  const b = {
    internal: async (name: string) => {
      calls.push(name);
      if (name === "claim_notification_delivery") return d;
      throw new Error("synthetic db unavailable");
    },
  } as unknown as Backend;
  const send = vi.fn(async (_message: unknown) => ({
    accepted: [d.recipient],
    messageId: "synthetic",
  }));
  await expect(processNotificationEmail(b, env, send)).rejects.toThrow(
    "synthetic db unavailable",
  );
  expect(calls).toEqual([
    "claim_notification_delivery",
    "finish_notification_delivery",
  ]);
  expect(send).toHaveBeenCalledTimes(1);
});
it("marks a lost SMTP lease unknown and never silently resends it", async () => {
  await pref();
  await f.command("notification.test", {});
  const d = await f.rpc("claim_notification_delivery");
  await f.db.exec(
    "update public.notification_deliveries set lease_until=now()-interval '1 second'",
  );
  await f.rpc("automation_notification_tick");
  expect((await deliveries())[0].status).toBe("delivery_unknown");
  await expect(
    f.rpc("finish_notification_delivery", [
      d.id,
      d.lease_token,
      "sent",
      null,
      "synthetic",
    ]),
  ).rejects.toThrow("STALE_LEASE");
});
it("sends no empty review reminders, deduplicates pending digests and rechecks the queue before sending", async () => {
  await pref();
  await f.db.exec(
    "update public.notification_preferences set next_review_at=now()-interval '1 hour'",
  );
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(0);
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  const opp = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic opportunity",
    language: "en",
  });
  const prop = (
    await f.db.query<any>(
      "insert into public.proposals(workspace_id,opportunity_id,title,state,created_by) values($1,$2,'Synthetic proposal','draft',$3) returning id",
      [f.w, opp.id, f.owner],
    )
  ).rows[0];
  const ver = (
    await f.db.query<any>(
      "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,1,repeat('a',64),$3) returning id",
      [f.w, prop.id, f.owner],
    )
  ).rows[0];
  await f.db.query(
    "update public.proposals set active_version_id=$1 where id=$2",
    [ver.id, prop.id],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.exec(
      "update public.notification_preferences set next_review_at=now()-interval '1 hour'",
    );
    await f.rpc("automation_notification_tick");
  }
  expect(await deliveries()).toHaveLength(1);
  expect((await deliveries())[0].payload).toEqual({
    discoveries: 0,
    proposals: 1,
  });
  await f.db.query("update public.proposals set state='approved' where id=$1", [
    prop.id,
  ]);
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
  expect((await deliveries())[0].error_code).toBe("REVIEW_INBOX_EMPTY");
});
it("alerts once after four exhausted rounds and keeps automatic slower recovery", async () => {
  await pref();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  const id = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,status,created_by,input_hash) values($1,'classify_opportunity',$2,'queued',$3,repeat('a',64)) returning id",
      [f.w, crypto.randomUUID(), f.owner],
    )
  ).rows[0].id;
  for (let i = 1; i <= 5; i++) {
    const lease = crypto.randomUUID();
    await f.db.query(
      "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes',attempts=attempts+1 where id=$1",
      [id, lease],
    );
    await f.rpc("fail_generation", [
      id,
      lease,
      "MODEL_ROUND_EXHAUSTED",
      null,
      null,
    ]);
    expect((await current(id)).status).toBe("retry_wait");
    expect((await current(id)).failure_count).toBe(i);
    await f.rpc("automation_notification_tick");
    expect(await deliveries()).toHaveLength(i < 4 ? 0 : 1);
  }
  expect(
    (
      await f.db.query<any>(
        "select next_attempt_at>=now()+interval '1 hour' slower from public.jobs where id=$1",
        [id],
      )
    ).rows[0].slower,
  ).toBe(true);
});
it("uses TLS/STARTTLS configuration and never exposes the SMTP password", () => {
  expect(smtpStatus(env)).toEqual({
    configured: true,
    issues: [],
    protocol: "SMTP",
    encryption: "TLS",
  });
  expect(
    smtpStatus({ ...env, smtp: { ...env.smtp!, port: 587 } }).encryption,
  ).toBe("STARTTLS");
  expect(
    smtpStatus({ ...env, smtp: { ...env.smtp!, port: 25 } }).configured,
  ).toBe(false);
  expect(
    smtpStatus({ ...env, smtp: { ...env.smtp!, password: "" } }).issues,
  ).toEqual(["APP_SMTP_PASSWORD"]);
  expect(
    smtpStatus({
      ...env,
      smtp: { ...env.smtp!, from: "TenderDesk <notices@example.test>" },
    }).configured,
  ).toBe(true);
  expect(
    smtpStatus({
      ...env,
      smtp: {
        ...env.smtp!,
        from: "notices@example.test\r\nBcc:other@example.test",
      },
    }).configured,
  ).toBe(false);
  expect(JSON.stringify(smtpStatus(env))).not.toContain("synthetic-secret");
  expect(smtpFailure({ code: "EAUTH" })).toEqual({
    outcome: "failed",
    code: "SMTP_AUTH_FAILED",
  });
  expect(smtpFailure({ code: "ETIMEDOUT", command: "CONN" }).outcome).toBe(
    "retry",
  );
});
it("builds a minimal Arabic digest without attaching company or tender content", () => {
  const result = notificationMessage(
    {
      id: crypto.randomUUID(),
      lease_token: crypto.randomUUID(),
      recipient: "owner@example.test",
      kind: "review_digest",
      language: "ar",
      payload: { discoveries: 3, proposals: 1 },
    },
    env,
  );
  expect(result.subject).toContain("المراجعة");
  expect(result.text).toContain("3");
  expect(result.text).toContain("#/review");
  expect(result.text).toContain("section=notifications");
  expect(result).not.toHaveProperty("attachments");
  expect(result).not.toHaveProperty("html");
});

it("keeps the processing queue running if notification infrastructure fails", async () => {
  const { createWorkerHandler } =
    await import("../../supabase/functions/worker/handler");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const claim = vi.fn(async () => null);
  const b = {
    claim,
    internal: async (name: string) => {
      if (name === "automation_notification_tick")
        throw Error("synthetic notification outage");
      if (name === "claim_storage_cleanup") return [];
      return null;
    },
  } as unknown as Backend;
  try {
    const handler = createWorkerHandler(
      { ...env, workerSecret: "synthetic-worker" },
      async () => [],
      () => b,
    );
    const response = await handler(
      new Request("https://synthetic.test/worker", {
        method: "POST",
        headers: { "x-worker-secret": "synthetic-worker" },
      }),
    );
    expect(response.status).toBe(200);
    expect(claim).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

it("identifies SMTP sender verification and sandbox restrictions without returning raw responses", () => {
  const verification = smtpFailure({
    responseCode: 550,
    response:
      "The synthetic.test domain is not verified. Please add and verify your domain.",
  });
  expect(verification).toEqual({
    outcome: "failed",
    code: "SMTP_SENDER_DOMAIN_UNVERIFIED",
  });
  const sandbox = smtpFailure({
    responseCode: 550,
    response: "You can only send testing emails to your own email address.",
  });
  expect(sandbox.code).toBe("SMTP_TEST_RECIPIENT_RESTRICTED");
  expect(JSON.stringify(verification)).not.toContain("synthetic.test");
});

async function failedTask() {
  const id = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,status,created_by,input_hash,error_code,failure_count,attempts) values($1,'classify_opportunity',$2,'blocked',$3,repeat('a',64),'MODEL_ROUND_EXHAUSTED',3,4) returning id",
      [f.w, crypto.randomUUID(), f.owner],
    )
  ).rows[0].id;
  await f.db.query("select app_private.recover_processing_job($1)", [id]);
  return id;
}
it("batches concurrent failures without re-emailing an outage for newly affected tasks", async () => {
  await pref();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await failedTask());
  await f.rpc("automation_notification_tick");
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
  expect((await deliveries())[0].payload).toMatchObject({
    total: 5,
    groups: [{ error_code: "MODEL_ROUND_EXHAUSTED", count: 5, retrying: true }],
  });
  await f.db.query("update public.jobs set status='succeeded' where id=$1", [
    ids[0],
  ]);
  await f.db.query("update public.jobs set cancel_requested=true where id=$1", [
    ids[1],
  ]);
  const d = await f.rpc("claim_notification_delivery");
  expect(d.payload.total).toBe(3);
  const message = notificationMessage(d, env);
  expect(message.text).toContain("ملخص 3");
  expect(message.text).toContain("إعادة المحاولة تلقائية");
  await f.rpc("finish_notification_delivery", [
    d.id,
    d.lease_token,
    "sent",
    null,
    "synthetic",
  ]);
  await failedTask();
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
  await f.db.exec(
    "update public.notification_deliveries set started_at=now()-interval '26 hours',sent_at=now()-interval '26 hours',created_at=now()-interval '26 hours'",
  );
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
});
it("cancels a fully recovered summary and does not re-email legacy sent notifications", async () => {
  await pref();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  const id = await failedTask();
  await f.db.exec(
    "insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key,notification_id,status) select workspace_id,recipient_user_id,'processing_failure',dedupe_key,id,'sent' from public.notifications where dedupe_key like 'automation-failure:%'",
  );
  await f.db.exec(
    "update public.notification_deliveries set created_at=now()-interval '2 hours'",
  );
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
  const fresh = await failedTask();
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
  await f.db.exec("update public.jobs set status='succeeded'");
  await f.rpc("automation_notification_tick");
  await failedTask();
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(2);
  await f.db.exec(
    "update public.jobs set status='succeeded'; update public.notification_deliveries set next_attempt_at=now() where status='queued'",
  );
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
  expect((await deliveries())[1]).toMatchObject({
    status: "canceled",
    error_code: "PROCESSING_RECOVERED",
  });
  expect((await current(id)).status).toBe("succeeded");
});

it("upgrades existing long pool waits with an audit actor and preserves canceled work", async () => {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  const id = await failedTask(),
    canceled = await failedTask();
  await f.db.query(
    "update public.jobs set next_attempt_at=now()+interval '20 hours',cancel_requested=(id=$2) where id in ($1,$2)",
    [id, canceled],
  );
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/20261019141931_provider_specific_retry_wait.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await f.db.exec(
    migration.slice(migration.indexOf("-- Repair old pool-wide delays")),
  );
  expect(
    (
      await f.db.query<any>(
        "select next_attempt_at<=now()+interval '1 hour' as repaired from public.jobs where id=$1",
        [id],
      )
    ).rows[0].repaired,
  ).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select next_attempt_at>now()+interval '19 hours' as preserved from public.jobs where id=$1",
        [canceled],
      )
    ).rows[0].preserved,
  ).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select actor_id from public.audit_events where action='job.retry_policy.corrected' and entity_id=$1",
        [id],
      )
    ).rows[0].actor_id,
  ).toBe(f.owner);
});

it("rechecks the interval at send time and safely retries the same SMTP delivery", async () => {
  await f.command("notification.preferences", {
    ...settings,
    failure_interval_hours: 1,
  });
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  await failedTask();
  await f.rpc("automation_notification_tick");
  const sent = await f.rpc("claim_notification_delivery");
  await f.rpc("finish_notification_delivery", [
    sent.id,
    sent.lease_token,
    "sent",
    null,
    "synthetic",
  ]);
  await f.db.exec(
    "update public.notification_deliveries set started_at=now()-interval '2 hours',sent_at=now()-interval '2 hours',created_at=now()-interval '2 hours'",
  );
  const different = await failedTask();
  await f.db.query(
    "update public.jobs set error_code='SOURCE_TEMPORARY_FAILURE' where id=$1",
    [different],
  );
  await f.rpc("automation_notification_tick");
  await f.command("notification.preferences", {
    ...settings,
    expected_revision: 1,
    failure_interval_hours: 24,
  });
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
  const pending = (await deliveries()).find((d) => d.status === "queued");
  expect(pending.attempts).toBe(0);
  expect(pending.payload.total).toBe(2);
  expect(new Date(pending.next_attempt_at).getTime()).toBeGreaterThan(
    Date.now() + 21 * 3600000,
  );
  await f.db.exec(
    "update public.notification_deliveries set sent_at=now()-interval '26 hours',started_at=now()-interval '26 hours' where status='sent'; update public.notification_deliveries set next_attempt_at=now() where status='queued'",
  );
  const first = await f.rpc("claim_notification_delivery");
  expect(first.payload.total).toBe(2);
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
  await f.rpc("finish_notification_delivery", [
    first.id,
    first.lease_token,
    "retry",
    "SMTP_REJECTED",
    null,
  ]);
  await f.db.exec(
    "update public.notification_deliveries set next_attempt_at=now() where status='retry_wait'",
  );
  await f.rpc("automation_notification_tick");
  const retry = await f.rpc("claim_notification_delivery");
  expect(retry.id).toBe(first.id);
  expect(retry.attempts).toBe(2);
});

it("does not replace an ambiguous SMTP send with another email for the same outage", async () => {
  await pref();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  expect(
    (await f.rpc("notification_settings")).preferences.failure_interval_hours,
  ).toBe(24);
  await failedTask();
  await f.rpc("automation_notification_tick");
  const d = await f.rpc("claim_notification_delivery");
  await f.rpc("finish_notification_delivery", [
    d.id,
    d.lease_token,
    "unknown",
    "SMTP_DELIVERY_UNCONFIRMED",
    null,
  ]);
  await f.db.exec(
    "update public.notification_deliveries set started_at=now()-interval '26 hours'",
  );
  await failedTask();
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toHaveLength(1);
  expect((await deliveries())[0].status).toBe("delivery_unknown");
  expect(await f.rpc("claim_notification_delivery")).toBeNull();
});

it("does not backfill pre-opt-in failures or expose incident state", async () => {
  await pref();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  await failedTask();
  await f.db.exec(
    "update public.notifications set created_at=now()-interval '1 day'",
  );
  await f.rpc("automation_notification_tick");
  expect(await deliveries()).toEqual([]);
  const access = (
    await f.db.query<any>(
      "select has_table_privilege('authenticated','app_private.notification_failure_state','SELECT') browser, has_function_privilege('authenticated','app_private.reported_failure_keys(uuid,uuid)','EXECUTE') callable",
    )
  ).rows[0];
  expect(access).toEqual({ browser: false, callable: false });
});
