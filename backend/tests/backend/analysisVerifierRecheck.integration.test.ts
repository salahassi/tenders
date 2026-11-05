// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture, claimModelWorker5 } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

it("creates a separate verifier child in the same plan without replacing completed sibling work", async () => {
  const s = await createRecheckFixture(f);
  const before = await s.snapshot();
  const siblingJob = await s.row("public.jobs", s.sibling.id);
  const siblingStep = (
    await f.db.query<any>(
      "select * from public.generation_steps where job_id=$1",
      [s.sibling.id],
    )
  ).rows[0];
  expect(siblingJob.status).toBe("succeeded");
  expect(siblingStep.status).toBe("completed");
  expect(siblingStep.output.requirements).toEqual([]);
  const child = await s.createChild();
  expect(child.plan_id).toBe(s.plan.id);
  expect(child.parent_job_id).toBe(s.parent.id);
  expect(child.id).not.toBe(s.parent.id);
  expect(await s.row("public.jobs", s.sibling.id)).toEqual(siblingJob);
  expect(await s.row("public.generation_steps", siblingStep.id)).toEqual(
    siblingStep,
  );
  const parent = await s.row("public.jobs", s.parent.id);
  expect(parent).toEqual({
    ...s.parent,
    status: "canceled",
    cancel_requested: true,
    revision: s.parent.revision + 1,
    updated_at: parent.updated_at,
  });
  const parentStep = await s.row("public.generation_steps", s.step.id);
  expect(parentStep).toEqual({
    ...s.step,
    status: "split",
    revision: s.step.revision + 1,
    updated_at: parentStep.updated_at,
  });
  const childJob = await s.row("public.jobs", child.id);
  const childStep = await s.row("public.generation_steps", child.step_id);
  expect(childJob).toMatchObject({
    entity_id: s.plan.id,
    type: "analyze_chunk",
    status: "queued",
    attempts: 0,
    input_hash: s.plan.input_hash,
    created_by: f.owner,
  });
  const { minimum_worker_executor, ...immutableRecheckPins } =
    childJob.checkpoint;
  expect(minimum_worker_executor).toBe(5);
  expect(immutableRecheckPins).toEqual({
    verifier_recheck: {
      version: 1,
      parent_job_id: s.parent.id,
      parent_thread_id: s.threadId,
      candidate_id: s.candidate.id,
      candidate_hash: s.candidateHash,
      input_hash: s.inputHash,
    },
  });
  expect(childStep).toMatchObject({
    plan_id: s.plan.id,
    task: s.step.task,
    stage: s.step.stage,
    input: s.step.input,
    depth: s.step.depth,
    repair_count: 0,
    status: "queued",
  });
  const after = await s.snapshot();
  for (const table of Object.keys(before).filter(
    (name) =>
      ![
        "public.generation_plans",
        "public.generation_steps",
        "public.jobs",
        "public.audit_events",
        "app_private.analysis_verifier_rechecks",
      ].includes(name),
  ))
    expect(after[table], table).toEqual(before[table]);
  expect(after["public.generation_plans"]).toHaveLength(
    before["public.generation_plans"].length,
  );
  expect(after["public.jobs"]).toHaveLength(before["public.jobs"].length + 1);
  expect(after["public.generation_steps"]).toHaveLength(
    before["public.generation_steps"].length + 1,
  );
  const audits = after["public.audit_events"]
    .filter((row) => !before["public.audit_events"].includes(row))
    .map((row) => JSON.parse(row));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: "generation.verifier_recheck",
    entity_type: "job",
    entity_id: child.id,
    actor_id: f.owner,
    reason: s.payload.reason,
  });
  expect(
    before["public.audit_events"].every((row) =>
      after["public.audit_events"].includes(row),
    ),
  ).toBe(true);
  const lineage = JSON.parse(
    after["app_private.analysis_verifier_rechecks"][0],
  );
  expect(lineage).toMatchObject({
    child_job_id: child.id,
    parent_job_id: s.parent.id,
    plan_id: s.plan.id,
    writer_usage_id: s.usage.id,
    candidate_id: s.candidate.id,
    verification_revision: 4,
    verifier_limit: 3,
    verifier_repair_limit: 1,
    requested_by: f.owner,
  });
  expect(lineage.requested_at).toBeTruthy();
  const claimed = await s.claimChild(child);
  const seed = await claimed.store.action("recheck_seed", {
    input_hash: s.inputHash,
    task: "analyze_chunk",
  });
  expect(seed.value).toEqual(s.candidate.value);
  expect(seed).toMatchObject({
    candidate_hash: s.candidateHash,
    parent_job_id: s.parent.id,
    parent_thread_id: s.threadId,
    verification_revision: 4,
  });
  expect(
    (
      await f.db.query<any>(
        "select candidates,unit from app_private.model_graph_budgets where thread_id=$1",
        [claimed.threadId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await claimed.store.action("candidate_budget", {
        unit: `verifier-${s.candidateHash}`,
      })
    ).count,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>("select * from public.provider_usage where id=$1", [
        s.usage.id,
      ])
    ).rows[0],
  ).toEqual(s.usage);
});

it("replays exactly one child idempotently and rejects altered selections or request keys without mutation", async () => {
  const s = await createRecheckFixture(f),
    key = crypto.randomUUID();
  const child = await s.createChild(key),
    before = await s.snapshot();
  expect(await s.createChild(key)).toEqual(child);
  expect(await s.snapshot()).toEqual(before);
  await expect(s.createChild(crypto.randomUUID())).rejects.toThrow(
    "IDEMPOTENCY_CONFLICT",
  );
  await expect(
    s.recheck({ ...s.payload, reason: "A different request" }, key),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(await s.snapshot()).toEqual(before);
});

it("serializes overlapping queued requests to the same child without spending a writer allowance", async () => {
  const s = await createRecheckFixture(f),
    key = crypto.randomUUID();
  // PGlite queues statements on one connection. This exercises duplicate
  // admission after serialization; it does not claim a two-session lock test.
  const invoke = () =>
    f.db.query<any>(
      "select app_private.recheck_analysis_verifier($1::jsonb,$2) value",
      [JSON.stringify(s.payload), key],
    );
  const results = await Promise.all([invoke(), invoke()]);
  expect(results[0].rows[0].value).toEqual(results[1].rows[0].value);
  expect(
    (await f.db.query("select * from app_private.analysis_verifier_rechecks"))
      .rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
        [s.threadId],
      )
    ).rows[0].candidates,
  ).toBe(1);
});

it.each(["lineage", "audit"])(
  "rolls back every partial child/parent mutation when the %s write fails",
  async (point) => {
    const s = await createRecheckFixture(f);
    const table =
      point === "lineage"
        ? "app_private.analysis_verifier_rechecks"
        : "public.audit_events";
    await f.db
      .exec(`create function app_private.synthetic_recheck_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_ATOMIC_FAILURE';end $$;
    create trigger synthetic_recheck_failure before insert on ${table} for each row execute function app_private.synthetic_recheck_failure();`);
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow("SYNTHETIC_ATOMIC_FAILURE");
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each(["expected_revision", "expected_step_revision"])(
  "refuses stale %s while preserving all history",
  async (field) => {
    const s = await createRecheckFixture(f),
      before = await s.snapshot();
    await expect(
      s.recheck({
        ...s.payload,
        [field]: (s.payload[field as keyof typeof s.payload] as number) + 1,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(await s.snapshot()).toEqual(before);
  },
);

it("accepts unchanged selected work after a sibling completes and advances the shared plan revision", async () => {
  const s = await createRecheckFixture(f);
  const selectedPlanRevision = s.payload.expected_plan_revision;
  const siblingId = (
    await f.db.query<any>(
      "select app_private.enqueue_generation(p,'analyze_chunk',$2::jsonb) id from public.generation_plans p where p.id=$1",
      [s.plan.id, JSON.stringify(s.step.input)],
    )
  ).rows[0].id;
  const sibling = await claimModelWorker5(f, s.rpc);
  expect(sibling.id).toBe(siblingId);
  await s.rpc("complete_generation_step", {
    job_id: sibling.id,
    lease: sibling.lease_token,
    result: s.candidate.value.result,
  });
  const progressed = await s.row("public.generation_plans", s.plan.id);
  expect(progressed.revision).toBeGreaterThan(selectedPlanRevision);
  expect(progressed.frozen_context).toEqual(s.plan.frozen_context);
  expect(progressed.input_hash).toBe(s.plan.input_hash);
  expect(await s.row("public.jobs", s.parent.id)).toEqual(s.parent);
  expect(await s.row("public.generation_steps", s.step.id)).toEqual(s.step);
  const completedSibling = await s.row("public.jobs", sibling.id);
  const completedStep = (
    await f.db.query<any>(
      "select * from public.generation_steps where job_id=$1",
      [sibling.id],
    )
  ).rows[0];
  const child = await s.createChild();
  expect(child.plan_id).toBe(s.plan.id);
  expect(await s.row("public.jobs", sibling.id)).toEqual(completedSibling);
  expect(await s.row("public.generation_steps", completedStep.id)).toEqual(
    completedStep,
  );
  const audit = (
    await f.db.query<any>(
      "select details from public.audit_events where action='generation.verifier_recheck' and entity_id=$1",
      [child.id],
    )
  ).rows[0];
  expect(audit.details).toEqual({
    selected_plan_revision: selectedPlanRevision,
    observed_plan_revision: progressed.revision,
  });
});

it.each([
  ["canceled", "status='canceled'", "STATE_CONFLICT"],
  ["failed", "status='failed'", "STATE_CONFLICT"],
  ["advanced stage", "stage='planning'", "STATE_CONFLICT"],
  ["changed input", "input_hash=repeat('d',64)", "STALE_INPUT"],
  [
    "changed frozen context",
    'frozen_context=frozen_context||\'{"language":"ar"}\'::jsonb',
    "STALE_INPUT",
  ],
] as const)(
  "still refuses a %s plan after its shared revision advances",
  async (_label, change, code) => {
    const s = await createRecheckFixture(f);
    await f.db.query(
      `update public.generation_plans set ${change},revision=revision+1 where id=$1`,
      [s.plan.id],
    );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(code);
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each([
  [
    "active parent",
    "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '1 hour' where id=$1",
    "STATE_CONFLICT",
  ],
  [
    "residual lease",
    "update public.jobs set lease_token=gen_random_uuid() where id=$1",
    "STATE_CONFLICT",
  ],
  [
    "non-exhausted failure",
    "update public.jobs set error_code='PROVIDER_REQUEST_FAILED' where id=$1",
    "STATE_CONFLICT",
  ],
  [
    "canceled parent",
    "update public.jobs set cancel_requested=true where id=$1",
    "STATE_CONFLICT",
  ],
] as const)(
  "refuses %s without changing any selected row",
  async (_name, sql, code) => {
    const s = await createRecheckFixture(f);
    await f.db.query(sql, [s.parent.id]);
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(code);
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each([0, 1])(
  "does not grant a new allowance when historical verifier phase %i already used revision four",
  async (index) => {
    const s = await createRecheckFixture(f);
    await f.db.query(
      "update app_private.model_graph_results set value=jsonb_set(value,'{version}','4') where id=$1",
      [s.verificationPins[index].id],
    );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(
      "MODEL_RECHECK_IDENTITY_CHANGED",
    );
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each([0, 1])(
  "refuses missing historical verifier phase %i without changing paid history",
  async (index) => {
    const s = await createRecheckFixture(f);
    await f.db.query(
      "delete from app_private.model_graph_results where id=$1",
      [s.verificationPins[index].id],
    );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(
      "MODEL_RECHECK_IDENTITY_CHANGED",
    );
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each([
  [
    "unknown writer output",
    "update public.provider_usage set actual_output=null where id=$1",
    "usage",
    "MODEL_RECHECK_WRITER_UNSETTLED",
  ],
  [
    "unrecorded writer",
    "update public.provider_usage set graph_candidate_recorded=false where id=$1",
    "usage",
    "MODEL_RECHECK_WRITER_UNSETTLED",
  ],
  [
    "wrong writer phase",
    "update public.provider_usage set call_key='unrelated:writer' where id=$1",
    "usage",
    "MODEL_RECHECK_IDENTITY_CHANGED",
  ],
  [
    "wrong writer producer",
    "update public.provider_usage set remote_project_ref='other-project' where id=$1",
    "usage",
    "MODEL_RECHECK_IDENTITY_CHANGED",
  ],
  [
    "altered candidate bytes",
    "update app_private.model_graph_results set value=jsonb_set(value,'{result,summary}','\"Changed candidate\"') where id=$1",
    "candidate",
    "MODEL_RECHECK_IDENTITY_CHANGED",
  ],
  [
    "writer allowance reset",
    "update app_private.model_graph_budgets set candidates=0 where thread_id=$1 and unit='writer'",
    "thread",
    "MODEL_RECHECK_IDENTITY_CHANGED",
  ],
  [
    "accepted parent",
    "update app_private.model_graph_threads set status='accepted' where id=$1",
    "thread",
    "MODEL_RECHECK_IDENTITY_CHANGED",
  ],
] as const)(
  "refuses %s before admitting a new verifier allowance",
  async (_label, sql, target, code) => {
    const s = await createRecheckFixture(f);
    await f.db.query(sql, [
      target === "usage"
        ? s.usage.id
        : target === "candidate"
          ? s.candidate.id
          : s.threadId,
    ]);
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(code);
    expect(await s.snapshot()).toEqual(before);
  },
);

it("rejects a formerly selected plan after a newer plan exists", async () => {
  const s = await createRecheckFixture(f);
  await f.db.query(
    `insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,created_at)
    select workspace_id,opportunity_id,proposal_id,kind,stage,'canceled',evidence_revision,input_hash,frozen_context,created_by,now()+interval '1 second'
    from public.generation_plans where id=$1`,
    [s.plan.id],
  );
  const before = await s.snapshot();
  await expect(s.createChild()).rejects.toThrow("STATE_CONFLICT");
  expect(await s.snapshot()).toEqual(before);
});

it.each(["reserved", "unknown"])(
  "refuses %s provider usage even after the old request deadline",
  async (state) => {
    const s = await createRecheckFixture(f);
    await f.db.query(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,remote_project_ref,created_by)
       values($1,$2,gen_random_uuid(),'synthetic-other-pending','openai','fixture-background',repeat('a',64),current_date,1,100,50,$3,'synthetic-response',now()-interval '3 days','fixture-project',$4)`,
      [f.w, s.parent.id, state, f.owner],
    );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow("USAGE_REVIEW_REQUIRED");
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each(["Editor", "inactive", "allowlist"])(
  "requires current Owner authorization (%s)",
  async (kind) => {
    const s = await createRecheckFixture(f);
    if (kind === "Editor")
      await f.db.query(
        "update public.memberships set role='Editor' where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    else if (kind === "inactive")
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    else
      await f.db.query(
        "delete from public.identity_allowlist where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow("ROLE_FORBIDDEN");
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each(["document", "notice", "active_version"])(
  "refuses changed %s rather than verifying old evidence",
  async (kind) => {
    const s = await createRecheckFixture(f);
    if (kind === "document")
      await f.db.query(
        "update public.documents set extraction_hash=repeat('f',64) where id=$1",
        [s.document.id],
      );
    else if (kind === "notice")
      await f.db.query(
        "update public.opportunities set description='Changed buyer obligation' where id=$1",
        [s.opportunity.id],
      );
    else {
      const version = (
        await f.db.query<any>(
          "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,1,repeat('a',64),$3) returning id",
          [f.w, s.plan.proposal_id, f.owner],
        )
      ).rows[0].id;
      await f.db.query(
        "update public.proposals set active_version_id=$2 where id=$1",
        [s.plan.proposal_id, version],
      );
    }
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(
      kind === "active_version" ? "STATE_CONFLICT" : "STALE_INPUT",
    );
    expect(await s.snapshot()).toEqual(before);
  },
);

it.each([
  [
    "candidate hash",
    (s: any) => ({ ...s.payload, candidate_hash: "0".repeat(64) }),
  ],
  [
    "candidate artifact hash",
    (s: any) => ({ ...s.payload, candidate_content_hash: "0".repeat(64) }),
  ],
  [
    "graph input hash",
    (s: any) => ({ ...s.payload, expected_graph_input_hash: "0".repeat(64) }),
  ],
  [
    "wrong candidate",
    (s: any) => ({ ...s.payload, candidate_id: s.retained.id }),
  ],
] as const)(
  "rejects changed %s with no admitted child",
  async (_name, payload) => {
    const s = await createRecheckFixture(f),
      before = await s.snapshot();
    await expect(s.recheck(payload(s))).rejects.toThrow(
      "MODEL_RECHECK_IDENTITY_CHANGED",
    );
    expect(await s.snapshot()).toEqual(before);
  },
);
