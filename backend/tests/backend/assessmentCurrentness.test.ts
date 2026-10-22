// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function fixture(completed = true) {
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "gemini_free",
    model: "synthetic-flash",
    project_ref: "synthetic-project",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_mode: "provider_managed",
    quota_ends_at: null,
    quota_remaining_tokens: null,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  });
  const source = await f.command("source.create", {
    name: "Synthetic assessment feed",
    kind: "rss",
    url: "https://example.test/feed",
    approved_hosts: ["example.test"],
    policy_note: "Synthetic fixture source",
  });
  const o = (
    await f.db.query<any>(
      "insert into public.opportunities(workspace_id,source_id,title,description,created_by) values($1,$2,'Synthetic software notice','Synthetic public description',$3) returning *",
      [f.w, source.id, f.owner],
    )
  ).rows[0];
  const plan = await f.command("opportunity.assess", {
    id: o.id,
    expected_revision: o.revision,
  });
  await f.db.query(
    "update public.generation_plans set created_at=now()-interval '1 minute' where id=$1",
    [plan.id],
  );
  const job = (
    await f.db.query<any>("select * from public.jobs where entity_id=$1", [
      plan.id,
    ])
  ).rows[0];
  await f.db.query(
    "update public.opportunities set assessment_pending=false where id=$1",
    [o.id],
  );
  if (completed) {
    await f.db.query(
      "update public.generation_plans set status='completed',stage='completed' where id=$1",
      [plan.id],
    );
    await f.db.query("update public.jobs set status='succeeded' where id=$1", [
      job.id,
    ]);
    await f.db.query(
      "insert into public.fit_assessments(workspace_id,opportunity_id,plan_id,evidence_coverage,routing,result,input_hash,evidence_revision,created_by) values($1,$2,$3,80,'recommended',$4::jsonb,$5,$6,$7)",
      [
        f.w,
        o.id,
        plan.id,
        JSON.stringify({
          summary: "Synthetic accepted assessment",
          scope_decision: { status: "in_scope" },
        }),
        plan.input_hash,
        plan.evidence_revision,
        f.owner,
      ],
    );
  }
  return { o, plan, job, source };
}
async function state(id: string) {
  return (
    await f.db.query<any>(
      "select assessment_current,assessment_state,inbox_visible from public.opportunity_discovery where id=$1",
      [id],
    )
  ).rows[0];
}

it("keeps a completed result current after an unrelated notice changes without rewriting its evidence or calling a model", async () => {
  const base = await fixture();
  const before = (
    await f.db.query<any>(
      "select * from public.fit_assessments where plan_id=$1",
      [base.plan.id],
    )
  ).rows[0];
  const other = (
    await f.db.query<any>(
      "insert into public.opportunities(workspace_id,source_id,title,created_by,archived) values($1,$2,'Other synthetic notice',$3,true) returning id",
      [f.w, base.source.id, f.owner],
    )
  ).rows[0];
  await f.db.query(
    "update public.opportunities set description='Changed other synthetic notice' where id=$1",
    [other.id],
  );
  expect(await state(base.o.id)).toEqual({
    assessment_current: true,
    assessment_state: "assessed",
    inbox_visible: true,
  });
  expect(await f.rpc("schedule_assessment_refresh")).toEqual({ scheduled: 0 });
  expect(
    (
      await f.db.query<any>(
        "select * from public.fit_assessments where plan_id=$1",
        [base.plan.id],
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
});

it.each(["notice", "company addition", "scope", "attachment", "language"])(
  "queues a completed assessment when its consumed %s changes even if assessment_pending was cleared",
  async (kind) => {
    const base = await fixture();
    if (kind === "notice")
      await f.db.query(
        "update public.opportunities set description='New mandatory synthetic condition' where id=$1",
        [base.o.id],
      );
    if (kind === "company addition") {
      const note = await f.command("knowledge.save", {
        title: "Synthetic capability",
        category: "company",
        content: "Synthetic software service evidence.",
        enabled: true,
      });
      await f.command("knowledge.verify", {
        id: note.id,
        expected_revision: note.revision,
      });
    }
    if (kind === "scope")
      await f.db.query(
        'update public.workspaces set discovery_policy=discovery_policy||\'{"scope":"keywords","include_keywords":["Synthetic changed service"]}\'::jsonb,evidence_revision=evidence_revision+1 where id=$1',
        [f.w],
      );
    if (kind === "attachment")
      await f.db.query(
        'update public.opportunities set notice_evidence=\'{"version":"1","status":"partial","attachments":[{"url":"https://example.test/changed.pdf","status":"unread"}]}\' where id=$1',
        [base.o.id],
      );
    if (kind === "language")
      await f.db.query(
        "update public.opportunities set language='ar' where id=$1",
        [base.o.id],
      );
    await f.db.query(
      "update public.opportunities set assessment_pending=false where id=$1",
      [base.o.id],
    );
    expect(await state(base.o.id)).toEqual({
      assessment_current: false,
      assessment_state: "pending_schedule",
      inbox_visible: false,
    });
    expect(await f.rpc("schedule_assessment_refresh")).toEqual({
      scheduled: 1,
    });
    expect(await state(base.o.id)).toEqual({
      assessment_current: false,
      assessment_state: "queued",
      inbox_visible: false,
    });
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.generation_plans where opportunity_id=$1",
          [base.o.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.fit_assessments where opportunity_id=$1",
          [base.o.id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);

it("preserves a pending remote request, graph budget and frozen input when another evidence item changes", async () => {
  const base = await fixture(false);
  const checkpoint = {
    graph_thread: "d".repeat(64),
    model_round: { round: 2 },
  };
  await f.db.query(
    "update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',checkpoint=$2::jsonb,next_attempt_at=now()+interval '3 minutes' where id=$1",
    [base.job.id, JSON.stringify(checkpoint)],
  );
  await f.db.query(
    "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,candidate_count) values($1,$2,$3,$4,'classify_opportunity',2)",
    [checkpoint.graph_thread, f.w, base.job.id, base.plan.input_hash],
  );
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',2)",
    [checkpoint.graph_thread],
  );
  await f.db.query(
    "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by) values($1,$2,gen_random_uuid(),'synthetic-call','gemini_free','synthetic-flash',$3,current_date,1,100,100,'reserved','synthetic-request',now()+interval '20 minutes',$4)",
    [f.w, base.job.id, base.plan.input_hash, f.owner],
  );
  const before = (
    await f.db.query<any>(
      "select to_jsonb(j) job,(select to_jsonb(u) from public.provider_usage u where u.job_id=j.id) usage from public.jobs j where id=$1",
      [base.job.id],
    )
  ).rows[0];
  await f.command("knowledge.save", {
    title: "Synthetic unused note",
    category: "company",
    content: "Disabled synthetic input",
    enabled: false,
  });
  expect(await f.rpc("schedule_assessment_refresh")).toEqual({ scheduled: 0 });
  expect(await state(base.o.id)).toMatchObject({
    assessment_state: "retry_wait",
  });
  await f.db.query("select app_private.refresh_proposal_evidence($1)", [
    base.plan.id,
  ]);
  const after = (
    await f.db.query<any>(
      "select to_jsonb(j) job,(select to_jsonb(u) from public.provider_usage u where u.job_id=j.id) usage from public.jobs j where id=$1",
      [base.job.id],
    )
  ).rows[0];
  expect(after).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select frozen_context,input_hash from public.generation_plans where id=$1",
        [base.plan.id],
      )
    ).rows[0],
  ).toEqual({
    frozen_context: base.plan.frozen_context,
    input_hash: base.plan.input_hash,
  });
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1",
        [checkpoint.graph_thread],
      )
    ).rows[0].candidates,
  ).toBe(2);
});

it("keeps the equality helper and discovery rows inaccessible to a nonmember and anonymous role", async () => {
  const base = await fixture();
  await f.db.exec("set role authenticated");
  expect(
    (
      await f.db.query<any>(
        "select app_private.assessment_inputs_current($1) current",
        [base.plan.id],
      )
    ).rows[0].current,
  ).toBe(true);
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    "00000000-0000-4000-8000-000000009999",
  ]);
  expect(
    (
      await f.db.query<any>(
        "select app_private.assessment_inputs_current($1) current",
        [base.plan.id],
      )
    ).rows[0].current,
  ).toBe(false);
  expect(
    (await f.db.query("select * from public.opportunity_discovery")).rows,
  ).toEqual([]);
  await f.db.exec("reset role");
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('anon','app_private.assessment_inputs_current(uuid)','execute') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
});

it.each(["content", "disabled", "expired", "unverified"])(
  "invalidates a completed assessment when consumed company evidence becomes %s",
  async (change) => {
    const note = await f.command("knowledge.save", {
      title: "Synthetic verified capability",
      category: "company",
      content: "Synthetic service capability for the assessment fixture.",
      enabled: true,
    });
    await f.command("knowledge.verify", {
      id: note.id,
      expected_revision: note.revision,
    });
    const base = await fixture();
    const changeSql = {
      content: "content='Changed synthetic company evidence'",
      disabled: "enabled=false",
      expired: "expiry_date=current_date-1",
      unverified: "verified=false,verified_at=null,verified_by=null",
    }[change]!;
    await f.db.query(
      `update public.knowledge_items set ${changeSql} where id=$1`,
      [note.id],
    );
    await f.db.query(
      "update public.opportunities set assessment_pending=false where id=$1",
      [base.o.id],
    );
    expect(await state(base.o.id)).toMatchObject({
      assessment_current: false,
      assessment_state: "pending_schedule",
    });
    expect(await f.rpc("schedule_assessment_refresh")).toEqual({
      scheduled: 1,
    });
  },
);

it.each(["declined", "rejected source"])(
  "does not automatically spend another assessment on a %s notice",
  async (reason) => {
    const base = await fixture();
    if (reason === "declined")
      await f.db.query(
        "update public.opportunities set decision='declined' where id=$1",
        [base.o.id],
      );
    else
      await f.db.query(
        "update public.sources set approval='rejected' where id=$1",
        [base.source.id],
      );
    await f.db.query(
      "update public.opportunities set description='Changed synthetic notice',assessment_pending=true where id=$1",
      [base.o.id],
    );
    expect(await f.rpc("schedule_assessment_refresh")).toEqual({
      scheduled: 0,
    });
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.generation_plans where opportunity_id=$1",
          [base.o.id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);

it("does not restart a deliberately canceled assessment when unrelated evidence changes", async () => {
  const base = await fixture(false);
  await f.db.query(
    "update public.generation_plans set status='canceled' where id=$1",
    [base.plan.id],
  );
  await f.db.query(
    "update public.jobs set status='canceled',cancel_requested=true where id=$1",
    [base.job.id],
  );
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  expect(await state(base.o.id)).toMatchObject({
    assessment_state: "not_started",
  });
  expect(await f.rpc("schedule_assessment_refresh")).toEqual({ scheduled: 0 });
});

it("ignores unused style material while preserving a current assessment", async () => {
  const base = await fixture();
  await f.command("knowledge.save", {
    title: "Synthetic style sample",
    category: "previous_proposal",
    content: "Synthetic writing style only.",
    enabled: true,
  });
  expect(await state(base.o.id)).toMatchObject({ assessment_current: true });
  expect(await f.rpc("schedule_assessment_refresh")).toEqual({ scheduled: 0 });
});
