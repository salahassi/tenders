// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { seedExtraction } from "./sourceExtractionFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});

async function enqueue(
  type: string,
  entity = crypto.randomUUID(),
  future = false,
) {
  return (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,next_attempt_at,status)
    values($1,$2,$3,'queue-fixture',$4,now()+case when $5 then interval '1 hour' else interval '0' end,'queued') returning *`,
      [f.w, type, entity, f.owner, future],
    )
  ).rows[0];
}
async function finish(id: string) {
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null,updated_at=now(),revision=revision+1 where id=$1",
    [id],
  );
}
async function reserve(job: any) {
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,
    settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    values($1,$2::uuid,gen_random_uuid(),$2::uuid::text,'openai','fixture-model',repeat('a',64),current_date,1,100,100,'reserved','resp_fixture',now()+interval '1 hour',$3)`,
    [f.w, job.id, f.owner],
  );
  await f.db.query(
    "update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',next_attempt_at=now()+interval '1 hour' where id=$1",
    [job.id],
  );
}
async function staticListing(future = false, automatic = false) {
  const url = "https://public.example.test/notices/" + crypto.randomUUID();
  const source = await f.command("source.create", {
    name: "Synthetic static listing",
    kind: "manual",
    url,
  });
  const extraction = seedExtraction("ps-najah");
  extraction.url = url;
  extraction.buyer = "Synthetic buyer";
  const configured = await f.command("source.configure", {
    id: source.id,
    expected_revision: source.revision,
    url,
    kind: "link_directory",
    approved_hosts: ["public.example.test"],
    policy_note: "Synthetic public source",
    poll_interval_hours: 6,
    adapter_config: {
      official_listing: "synthetic",
      extraction,
      ...(automatic ? { automatic: true } : {}),
    },
  });
  const approved = await f.command("source.action", {
    id: source.id,
    expected_revision: configured.revision,
    action: "approve",
    reason: "Synthetic test",
  });
  const j = await enqueue("source_collect", source.id, future);
  await f.db.query("update public.jobs set input_hash=$2 where id=$1", [
    j.id,
    String(approved.revision),
  ]);
  await f.db.query(
    "insert into app_private.queue_owner_service values($1,'background',$2,99)",
    [f.w, source.id],
  );
  return j;
}
async function readyBrowserListing() {
  const url = "https://public.example.test/tenders";
  const source = await f.command("source.create", {
    name: "Synthetic browser listing",
    kind: "manual",
    url,
  });
  await f.command("source.action", {
    id: source.id,
    expected_revision: source.revision,
    action: "approve",
    reason: "Synthetic public page",
  });
  const job = await f.rpc("claim_backend_job_v2");
  await f.rpc("queue_source_browser_page", [job.id, job.lease_token]);
  const browser = await f.rpc("claim_source_browser_page");
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    JSON.stringify({
      requested_url: url,
      url,
      text: "Synthetic public tender listing for queue fairness acceptance.",
      links: [],
      partial: false,
      rendered: true,
    }),
    null,
  ]);
  await f.db.query(
    "update app_private.queue_dispatch_state set cursor=0 where workspace_id=$1",
    [f.w],
  );
  await f.db.query(
    "update app_private.queue_owner_service set last_dispatch=99 where workspace_id=$1 and entity_id=$2",
    [f.w, source.id],
  );
  return job;
}
it("consumes a ready browser page before unseen assessments when admission is available", async () => {
  const ready = await readyBrowserListing();
  const assessment = await enqueue("classify_opportunity");
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(ready.id);
  await finish(ready.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(assessment.id);
});
it("does not give browser/model work preference when admitted requests fill capacity", async () => {
  await readyBrowserListing();
  const limit = (
    await f.db.query<{ n: number }>(
      "select app_private.model_request_limit($1) n",
      [f.w],
    )
  ).rows[0].n;
  for (let i = 0; i < limit; i++) await reserve(await enqueue("draft_section"));
  const directory = await enqueue("source_candidates");
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(directory.id);
});
it("gives a retried static listing a background turn and an unseen assessment the next cycle", async () => {
  const first = await staticListing(),
    second = await staticListing();
  const assessment = await enqueue("classify_opportunity");
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 minute' where id=$1",
    [first.id],
  );
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(first.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  await finish(first.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(assessment.id);
  await finish(assessment.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(second.id);
  expect(
    (await f.db.query("select * from public.provider_usage")).rows,
  ).toHaveLength(0);
});
it("alternates configured automatic fetches with assessment owners without requiring model capacity", async () => {
  const first = await staticListing(false, true);
  const second = await staticListing(false, true);
  const assessment = await enqueue("classify_opportunity");
  const accepted = await enqueue("draft_section");
  await reserve(accepted);
  const limit = (
    await f.db.query<{ n: number }>(
      "select app_private.model_request_limit($1) n",
      [f.w],
    )
  ).rows[0].n;
  for (let i = 1; i < limit; i++) await reserve(await enqueue("draft_section"));
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 minute' where id=$1",
    [first.id],
  );
  const claimed = await f.rpc("claim_backend_job_v2");
  expect(claimed.id).toBe(first.id);
  expect(claimed.lease_token).toBeTruthy();
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  await finish(first.id);
  // Free admission using only fixture settlement; the ordinary owner turn remains.
  await f.db.query("update public.provider_usage set state='settled'");
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(assessment.id);
  await finish(assessment.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(second.id);
  expect(
    (await f.db.query("select * from public.provider_usage")).rows,
  ).toHaveLength(limit);
});
it.each([
  "missing",
  "invalid",
  "missing_marker",
  "empty_marker",
  "saved_model_page",
])(
  "retains normal priority for an automatic source with %s extraction evidence",
  async (mode) => {
    const sourceJob = await staticListing(false, true);
    if (mode === "missing")
      await f.db.query(
        "update public.sources set adapter_config=adapter_config-'extraction' where id=$1",
        [sourceJob.entity_id],
      );
    if (mode === "invalid")
      await f.db.query(
        "update public.sources set adapter_config=jsonb_set(adapter_config,'{extraction}','{}') where id=$1",
        [sourceJob.entity_id],
      );
    if (mode === "missing_marker")
      await f.db.query(
        "update public.sources set adapter_config=adapter_config-'official_listing' where id=$1",
        [sourceJob.entity_id],
      );
    if (mode === "empty_marker")
      await f.db.query(
        "update public.sources set adapter_config=jsonb_set(adapter_config,'{official_listing}',to_jsonb(''::text)) where id=$1",
        [sourceJob.entity_id],
      );
    if (mode === "saved_model_page") {
      // The old saved page lacks selector-preserving markup and still needs inference.
      const first = await f.rpc("claim_backend_job_v2");
      expect(first.id).toBe(sourceJob.id);
      await f.rpc("auto_source_context", [first.id, first.lease_token]);
      await f.db.query(
        "update public.source_readings set page=jsonb_build_object('text','Synthetic old saved page') where job_id=$1",
        [first.id],
      );
      await f.db.query(
        "update public.jobs set status='queued',lease_token=null,lease_until=null where id=$1",
        [first.id],
      );
      await f.db.query(
        "update app_private.queue_dispatch_state set cursor=0 where workspace_id=$1",
        [f.w],
      );
    }
    const unseen = await enqueue("classify_opportunity");
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(unseen.id);
  },
);
it("preserves proposal slots, future due times and source revisions for automatic configured fetches", async () => {
  const future = await staticListing(true, true);
  const stale = await staticListing(false, true);
  await f.db.query("update public.jobs set input_hash='obsolete' where id=$1", [
    stale.id,
  ]);
  const due = await staticListing(false, true);
  const proposal = await enqueue("draft_section");
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(proposal.id);
  await finish(proposal.id);
  const next = await f.rpc("claim_backend_job_v2");
  expect(next.id).not.toBe(stale.id);
  if (next.id !== due.id) {
    // Source revision repair creates a fresh eligible collection job normally.
    expect(next.entity_id).toBe(stale.entity_id);
    expect(next.input_hash).not.toBe("obsolete");
    await finish(next.id);
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(due.id);
  }
  expect(
    (
      await f.db.query<any>("select status from public.jobs where id=$1", [
        stale.id,
      ])
    ).rows[0].status,
  ).toBe("canceled");
  expect(
    (
      await f.db.query<any>("select attempts from public.jobs where id=$1", [
        future.id,
      ])
    ).rows[0].attempts,
  ).toBe(0);
});

it("preserves proposal slots and future eligibility when static collection is waiting", async () => {
  const delayed = await staticListing(true);
  const due = await staticListing();
  const proposal = await enqueue("draft_section");
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(proposal.id);
  await finish(proposal.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(due.id);
  await finish(due.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (
      await f.db.query<{ attempts: number }>(
        "select attempts from public.jobs where id=$1",
        [delayed.id],
      )
    ).rows[0].attempts,
  ).toBe(0);
});

it("finishes saved proposal units before fresh siblings without taking other owners' or collection's turns", async () => {
  const owner = crypto.randomUUID();
  const fresh = await enqueue("draft_section", owner);
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 hour' where id=$1",
    [fresh.id],
  );
  const continuing = await enqueue("draft_section", owner);
  await f.db.query(
    "update public.jobs set checkpoint=jsonb_build_object('graph_thread','fixture'),error_code='MODEL_IN_PROGRESS',status='retry_wait' where id=$1",
    [continuing.id],
  );
  const other = await enqueue("draft_section");
  const collection = await enqueue("source_collect");
  const first = await f.rpc("claim_backend_job_v2");
  expect(first.id).toBe(continuing.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  await finish(first.id);
  const background = await f.rpc("claim_backend_job_v2");
  expect(background.id).toBe(collection.id);
  await finish(background.id);
  const nextOwner = await f.rpc("claim_backend_job_v2");
  expect(nextOwner.id).toBe(other.id);
  await finish(nextOwner.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(fresh.id);
});

it("does not wake a saved continuation before its due time or bypass accepted-request capacity", async () => {
  const owner = crypto.randomUUID();
  const delayed = await enqueue("draft_section", owner, true);
  await f.db.query(
    "update public.jobs set checkpoint=jsonb_build_object('graph_thread','fixture'),error_code='MODEL_IN_PROGRESS',status='retry_wait' where id=$1",
    [delayed.id],
  );
  const fresh = await enqueue("draft_section", owner);
  const current = await f.rpc("claim_backend_job_v2");
  expect(current.id).toBe(fresh.id);
  await finish(current.id);
  const accepted = await enqueue("draft_section");
  await reserve(accepted);
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    delayed.id,
  ]);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (
      await f.db.query<any>("select attempts from public.jobs where id=$1", [
        delayed.id,
      ])
    ).rows[0].attempts,
  ).toBe(0);
});

it("serves three proposal owners and background work under continuously arriving work", async () => {
  const owners = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const owner of owners)
    for (let i = 0; i < 4; i++) await enqueue("draft_section", owner);
  const background = await enqueue("classify_opportunity");
  const claims = [];
  for (let i = 0; i < 12; i++) {
    const j = await f.rpc("claim_backend_job_v2");
    expect(j).not.toBeNull();
    claims.push(j);
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
    await finish(j.id);
    if (j.type === "classify_opportunity")
      await enqueue("classify_opportunity");
    else await enqueue("draft_section", j.entity_id);
  }
  expect(claims[1].id).toBe(background.id);
  expect(claims.filter((j) => j.type === "classify_opportunity")).toHaveLength(
    6,
  );
  for (const owner of owners)
    expect(claims.filter((j) => j.entity_id === owner)).toHaveLength(2);
});

it("executes local transitions at full model capacity without claiming new inference or early polling", async () => {
  const waiting = await enqueue("draft_section");
  await reserve(waiting);
  const inference = await enqueue("draft_section");
  const delayed = await enqueue("advance_plan", crypto.randomUUID(), true);
  const transition = await enqueue("advance_plan");
  const j = await f.rpc("claim_backend_local_job");
  expect(j.id).toBe(transition.id);
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  await finish(j.id);
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  const attempts = (
    await f.db.query<any>(
      "select id,attempts from public.jobs where id=any($1::uuid[])",
      [[inference.id, delayed.id, waiting.id]],
    )
  ).rows;
  expect(attempts.every((j) => j.attempts === 0)).toBe(true);
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    waiting.id,
  ]);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(waiting.id);
});

it("uses the owning plan to classify assessment transitions and enforces stage dependencies", async () => {
  const source = await f.command("source.create", {
    name: "Queue source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    title: "Queue fixture",
    source_id: source.id,
    description: "Synthetic fixture",
    decision: "shortlisted",
    language: "en",
  });
  const plan = (
    await f.db.query<any>(
      `insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,input_hash,evidence_revision,frozen_context,created_by)
    values($1,$2,'assessment','assessment','running','fixture',1,'{}',$3) returning *`,
      [f.w, opportunity.id, f.owner],
    )
  ).rows[0];
  const assessment = await enqueue("classify_opportunity", plan.id);
  expect(
    (
      await f.db.query<any>(
        "select app_private.queue_work_class(j) value from public.jobs j where id=$1",
        [assessment.id],
      )
    ).rows[0].value,
  ).toBe("background");
  const transition = await enqueue("advance_plan", plan.id);
  await f.db.query(
    `insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
    values($1,$2,$3,'classify_opportunity','assessment',0,'{}',$4)`,
    [f.w, plan.id, assessment.id, f.owner],
  );
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  await f.db.query(
    "update public.generation_steps set status='completed',output='{}' where job_id=$1",
    [assessment.id],
  );
  expect((await f.rpc("claim_backend_local_job")).id).toBe(transition.id);
});

it("keeps scheduler state private and exposes only the service local claim", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const permissions = (
      await f.db.query<any>(
        `select has_table_privilege($1,'app_private.queue_dispatch_state','SELECT') state,
      has_function_privilege($1,'app_private.next_fair_job(uuid,boolean)','EXECUTE') picker,
      has_function_privilege($1,'public.claim_backend_local_job()','EXECUTE') claim`,
        [role],
      )
    ).rows[0];
    expect(permissions).toEqual({
      state: false,
      picker: false,
      claim: role === "service_role",
    });
  }
});
