// @vitest-environment node
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import { ModelDeferred } from "../../supabase/functions/_shared/model";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";

let f: Awaited<ReturnType<typeof workflowFixture>>;
let calls: string[] = [];
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  calls = [];
  await f.db.exec("begin");
});
afterEach(async () => f.db.exec("rollback"));
const row = async (sql: string, args: unknown[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  calls.push(name === "model_graph_store" ? `${name}:${args.action}` : name);
  await f.db.exec("savepoint accepted_poll_rpc;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) value`,
        entries.map(([, value]) =>
          value && typeof value === "object" ? JSON.stringify(value) : value,
        ),
      )
    ).rows[0]?.value;
  } catch (error) {
    await f.db.exec("rollback to savepoint accepted_poll_rpc");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role;release savepoint accepted_poll_rpc");
  }
}
async function setup() {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
  });
  const connection = await f.command("model.connection.save", {
    provider: "openai",
    label: "Synthetic poll account",
    credential_alias: "APP_MODEL_OPENAI_KEY",
    project_ref: "fixture-account",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic poll model",
    model: "fixture-model",
    enabled: true,
    capabilities: defaultCapabilities("openai"),
    expected_revision: 0,
  });
  await f.command("model.task_route.save", {
    task: "default",
    model_ids: [model.id],
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
    max_parallel_requests: 4,
  });
  const item = await f.command("knowledge.save", {
    title: "Synthetic proposal evidence",
    content: "Proposed workflow includes a documented handover.",
    category: "company",
    enabled: true,
    evidence: "Synthetic fixture only",
  });
  const eligible = (await f.rpc("eligibility_candidates")).items.find(
    (entry: any) => entry.entity_id === item.id,
  );
  const manifest = [
    {
      entity_kind: eligible.entity_kind,
      entity_id: eligible.entity_id,
      content_hash: eligible.content_hash,
    },
  ];
  const authorization = await f.command("content.authorize", {
    ...manifest[0],
    provider: "openai",
    attestation: "nonconfidential_nonpersonal",
  });
  const source = await row(
    "insert into sources(workspace_id,name,kind,created_by) values($1,'Synthetic poll source','manual',$2) returning id",
    [f.w, f.owner],
  );
  const opportunity = await row(
    "insert into opportunities(workspace_id,source_id,title,created_by) values($1,$2,'Synthetic poll opportunity',$3) returning id",
    [f.w, source.id, f.owner],
  );
  const plan = await row(
    "insert into generation_plans(workspace_id,opportunity_id,kind,status,stage,input_hash,frozen_context,evidence_revision,created_by) values($1,$2,'proposal','running','drafting',repeat('a',64),'{}',1,$3) returning *",
    [f.w, opportunity.id, f.owner],
  );
  const queued = await row(
    "insert into jobs(workspace_id,type,entity_id,input_hash,created_by,status,checkpoint) values($1,'draft_section',$2,$3,$4,'queued','{\"model_executor\":2}') returning id",
    [f.w, plan.id, plan.input_hash, f.owner],
  );
  const step = await row(
    "insert into generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by) values($1,$2,$3,'draft_section','drafting',1,'{}',$4) returning id",
    [f.w, plan.id, queued.id, f.owner],
  );
  let job = await rpc("claim_backend_job_v5");
  const environments = modelEnvironments((name) =>
    name.endsWith("_KEY")
      ? "fixture-key"
      : name.endsWith("_PROJECT")
        ? "fixture-account"
        : undefined,
  );
  const backend = { internal: rpc } as unknown as Backend;
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    methods.push(init?.method ?? "POST");
    calls.push(`HTTP:${init?.method ?? "POST"}`);
    return Response.json({
      id: "fixture-accepted-poll",
      status: init?.method === "GET" ? "in_progress" : "queued",
    });
  };
  const options = {
    backend,
    prefix: `step:${step.id}`,
    task: "draft_section" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest,
    environments,
    language: "en" as const,
    repair: false,
    fetcher,
  };
  await expect(executeGuardedModel({ ...options, job })).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  await f.db.query(
    "update jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  job = await rpc("claim_backend_job_v5");
  expect(job.id).toBe(queued.id);
  const thread = await row(
    "select * from app_private.model_graph_threads where job_id=$1",
    [job.id],
  );
  const usage = await row(
    "select * from public.provider_usage where job_id=$1",
    [job.id],
  );
  expect(methods).toEqual(["POST"]);
  return {
    job,
    thread,
    usage,
    options,
    methods,
    authorization,
    model,
    connection,
    plan,
    step,
  };
}
const prepare = (
  s: Awaited<ReturnType<typeof setup>>,
  override: Record<string, unknown> = {},
) =>
  rpc("prepare_accepted_model_poll", {
    job_id: s.job.id,
    lease: s.job.lease_token,
    thread_id: s.thread.id,
    graph_input_hash: s.thread.input_hash,
    manifest: s.options.manifest,
    ...override,
  });
async function graphSnapshot(jobId: string) {
  return row(
    `select
    (select jsonb_agg(to_jsonb(c) order by c.checkpoint_id) from app_private.model_graph_checkpoints c join app_private.model_graph_threads t on t.id=c.thread_id where t.job_id=$1) checkpoints,
    (select jsonb_agg(to_jsonb(r) order by r.id) from app_private.model_graph_results r join app_private.model_graph_threads t on t.id=r.thread_id where t.job_id=$1) results,
    (select jsonb_agg(to_jsonb(b) order by b.unit) from app_private.model_graph_budgets b join app_private.model_graph_threads t on t.id=b.thread_id where t.job_id=$1) budgets`,
    [jobId],
  );
}

it("prepares only the accepted request without changing graph state, usage charges or frozen metadata", async () => {
  const s = await setup();
  const before = await graphSnapshot(s.job.id);
  const prepared = await prepare(s);
  expect(prepared).toMatchObject({
    version: 1,
    operation: "draft_section",
    pending: {
      id: s.usage.id,
      remote_request_id: "fixture-accepted-poll",
      input_hash: s.usage.input_hash,
    },
    configuration: {
      model_config_id: s.model.id,
      connection_id: s.connection.id,
    },
  });
  expect(prepared.request_prefix).toBe(`step:${s.step.id}:candidate-0`);
  expect(await graphSnapshot(s.job.id)).toEqual(before);
  const usage = await row("select * from public.provider_usage where id=$1", [
    s.usage.id,
  ]);
  expect(usage).toMatchObject({
    state: "reserved",
    actual_input: null,
    actual_output: null,
    lease_token: s.job.lease_token,
    call_key: s.usage.call_key,
    input_hash: s.usage.input_hash,
  });
  expect(
    (
      await row(
        "select count(*)::int count from provider_usage where job_id=$1",
        [s.job.id],
      )
    ).count,
  ).toBe(1);
  expect(s.methods).toEqual(["POST"]);
});

it.each(["revoked", "cancelled", "stale_lease", "expired_lease"])(
  "rechecks current %s authority before allowing a pending GET",
  async (reason) => {
    const s = await setup();
    if (reason === "revoked")
      await f.command("content.revoke", {
        id: s.authorization.id,
        expected_revision: s.authorization.revision,
      });
    if (reason === "cancelled")
      await f.db.query("update jobs set cancel_requested=true where id=$1", [
        s.job.id,
      ]);
    if (reason === "expired_lease")
      await f.db.query(
        "update jobs set lease_until=now()-interval '1 second' where id=$1",
        [s.job.id],
      );
    const before = await graphSnapshot(s.job.id);
    await expect(
      prepare(
        s,
        reason === "stale_lease" ? { lease: crypto.randomUUID() } : {},
      ),
    ).rejects.toMatchObject({
      code:
        reason === "revoked" ? "DATA_AUTHORIZATION_REQUIRED" : "STALE_LEASE",
    });
    expect(await graphSnapshot(s.job.id)).toEqual(before);
    expect(s.methods).toEqual(["POST"]);
    expect(
      await row("select * from provider_usage where id=$1", [s.usage.id]),
    ).toEqual(s.usage);
  },
);

it("keeps an accepted request pollable after its model is disabled without admitting a new reservation", async () => {
  const s = await setup();
  await f.command("model.configuration.save", {
    id: s.model.id,
    expected_revision: 1,
    connection_id: s.connection.id,
    label: "Disabled synthetic model",
    model: "fixture-model",
    enabled: false,
    capabilities: defaultCapabilities("openai"),
  });
  expect((await prepare(s)).pending.id).toBe(s.usage.id);
  expect(
    (
      await row(
        "select count(*)::int count from provider_usage where job_id=$1",
        [s.job.id],
      )
    ).count,
  ).toBe(1);
});

it("handles a healthy pending GET in one preparation round trip while preserving graph and usage", async () => {
  const s = await setup();
  const before = await graphSnapshot(s.job.id);
  calls = [];
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  const get = calls.indexOf("HTTP:GET");
  expect(get).toBe(1);
  expect(calls.slice(0, get)).toEqual(["prepare_accepted_model_poll"]);
  expect(calls).toEqual([
    "prepare_accepted_model_poll",
    "HTTP:GET",
    "finish_model_attempt",
    "defer_pending_model_request",
  ]);
  expect(s.methods).toEqual(["POST", "GET"]);
  expect(await graphSnapshot(s.job.id)).toEqual(before);
  expect(
    await row(
      "select state,actual_input,actual_output from provider_usage where id=$1",
      [s.usage.id],
    ),
  ).toEqual({ state: "reserved", actual_input: null, actual_output: null });
  expect(
    await row(
      "select status,lease_token,error_code,extract(epoch from next_attempt_at-now())::int delay from jobs where id=$1",
      [s.job.id],
    ),
  ).toEqual({
    status: "retry_wait",
    lease_token: null,
    error_code: "MODEL_IN_PROGRESS",
    delay: 10,
  });
});

it("keeps the preparation RPC inaccessible to browser roles", async () => {
  expect(
    await row(
      "select has_function_privilege('anon','public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb)','execute') anon,has_function_privilege('authenticated','public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb)','execute') authenticated,has_function_privilege('service_role','public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb)','execute') service",
    ),
  ).toEqual({ anon: false, authenticated: false, service: true });
});

it("returns a ready response to the graph exactly once for candidate validation and accounting", async () => {
  const s = await setup();
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: [
      { type: "paragraph", text: "Proposed workflow requires buyer approval." },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  s.options.fetcher = async (_url, init) => {
    s.methods.push(init?.method ?? "POST");
    if (init?.method === "DELETE")
      return Response.json({ id: "fixture-accepted-poll", deleted: true });
    expect(init?.method).toBe("GET");
    return Response.json({
      id: "fixture-accepted-poll",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(candidate) }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  expect(s.methods).toEqual(["POST", "GET", "DELETE"]);
  expect(
    await row(
      "select state,actual_input,actual_output,graph_candidate_recorded from provider_usage where id=$1",
      [s.usage.id],
    ),
  ).toEqual({
    state: "settled",
    actual_input: 10,
    actual_output: 8,
    graph_candidate_recorded: true,
  });
  const saved = await row(
    "select value from app_private.model_graph_results where thread_id=$1 and result_key='candidate-0'",
    [s.thread.id],
  );
  expect(saved.value.result).toEqual(candidate);
  expect(
    await row(
      "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
      [s.thread.id],
    ),
  ).toEqual({ candidates: 1 });
  expect(
    await row(
      "select status,result_id from app_private.model_graph_threads where id=$1",
      [s.thread.id],
    ),
  ).toEqual({ status: "running", result_id: null });
  expect(
    (
      await row(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
        [s.thread.id],
      )
    ).count,
  ).toBe(0);
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  expect(s.methods).toEqual(["POST", "GET", "DELETE"]);
});

it.each([
  "graph_input",
  "thread",
  "round_target",
  "unknown_usage",
  "recorded_candidate",
  "missing_pin",
  "pin_version",
  "metadata_input",
  "metadata_graph",
  "metadata_operation",
  "metadata_prompt",
  "missing_round",
  "duplicate_reservation",
])(
  "falls back without side effects when %s proof is unavailable",
  async (reason) => {
    const s = await setup();
    if (reason === "round_target")
      await f.db.query(
        "update jobs set checkpoint=jsonb_set(checkpoint,'{model_round,remaining,0,model}',to_jsonb('different-model'::text)) where id=$1",
        [s.job.id],
      );
    if (reason === "unknown_usage")
      await f.db.query(
        "update provider_usage set state='unknown' where id=$1",
        [s.usage.id],
      );
    if (reason === "recorded_candidate")
      await f.db.query(
        "update provider_usage set graph_candidate_recorded=true where id=$1",
        [s.usage.id],
      );
    if (reason === "missing_pin")
      await f.db.query(
        "delete from app_private.model_graph_results where thread_id=$1 and result_key like 'semantic-instructions-%'",
        [s.thread.id],
      );
    if (reason === "pin_version")
      await f.db.query(
        "update app_private.model_graph_results set value=jsonb_set(value,'{version}','99') where thread_id=$1 and result_key like 'semantic-instructions-%'",
        [s.thread.id],
      );
    if (reason === "metadata_input")
      await f.db.query(
        "update provider_usage set execution_metadata=jsonb_set(coalesce(execution_metadata,(select a.execution_metadata from model_attempts a where a.usage_id=provider_usage.id and a.sent order by a.id limit 1)),'{input_hash}',to_jsonb(repeat('f',64))) where id=$1",
        [s.usage.id],
      );
    if (reason === "metadata_graph")
      await f.db.query(
        "update provider_usage set execution_metadata=jsonb_set(coalesce(execution_metadata,(select a.execution_metadata from model_attempts a where a.usage_id=provider_usage.id and a.sent order by a.id limit 1)),'{graph_thread}',to_jsonb(repeat('f',64))) where id=$1",
        [s.usage.id],
      );
    if (reason === "metadata_operation")
      await f.db.query(
        "update provider_usage set execution_metadata=jsonb_set(coalesce(execution_metadata,(select a.execution_metadata from model_attempts a where a.usage_id=provider_usage.id and a.sent order by a.id limit 1)),'{operation}','\"verify_grounding\"') where id=$1",
        [s.usage.id],
      );
    if (reason === "metadata_prompt") {
      await f.db.query(
        "update provider_usage set execution_metadata=jsonb_set(execution_metadata,'{prompt_version}','\"unsupported-prompt\"') where id=$1",
        [s.usage.id],
      );
      await f.db.query(
        "update model_attempts set execution_metadata=jsonb_set(execution_metadata,'{prompt_version}','\"unsupported-prompt\"') where usage_id=$1",
        [s.usage.id],
      );
    }
    if (reason === "missing_round")
      await f.db.query(
        "update jobs set checkpoint=checkpoint-'model_round' where id=$1",
        [s.job.id],
      );
    if (reason === "duplicate_reservation")
      await f.db.query(
        "insert into provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_project_ref,remote_deadline,created_by,model_config_id,connection_id) select workspace_id,job_id,lease_token,'synthetic-duplicate',provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_project_ref,remote_deadline,created_by,model_config_id,connection_id from provider_usage where id=$1",
        [s.usage.id],
      );
    const before = await row(
      "select to_jsonb(j) job,to_jsonb(u) usage,(select count(*)::int from model_attempts a where a.job_id=j.id) attempts from jobs j join provider_usage u on u.job_id=j.id where j.id=$1",
      [s.job.id],
    );
    const graph = await graphSnapshot(s.job.id);
    expect(
      await prepare(
        s,
        reason === "graph_input"
          ? { graph_input_hash: "f".repeat(64) }
          : reason === "thread"
            ? { thread_id: "f".repeat(64) }
            : {},
      ),
    ).toBeNull();
    expect(
      await row(
        "select to_jsonb(j) job,to_jsonb(u) usage,(select count(*)::int from model_attempts a where a.job_id=j.id) attempts from jobs j join provider_usage u on u.job_id=j.id where j.id=$1",
        [s.job.id],
      ),
    ).toEqual(before);
    expect(await graphSnapshot(s.job.id)).toEqual(graph);
    expect(s.methods).toEqual(["POST"]);
  },
);

it("rejects an expired issuance without extending its deadline or consuming the accepted response", async () => {
  const s = await setup();
  const issuance = await row(
    "insert into proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at) select $1,$2,$3,'generation.retry',$4,t,t+interval '600 seconds' from (select clock_timestamp()-interval '601 seconds' t) c returning *",
    [f.w, s.plan.id, f.owner, crypto.randomUUID()],
  );
  await f.db.exec("select set_config('app.issuance_authorizing','true',true)");
  await f.db.query(
    "update jobs set checkpoint=checkpoint||jsonb_build_object('issuance_request_id',$2::uuid) where id=$1",
    [s.job.id, issuance.id],
  );
  await f.db.exec("select set_config('app.issuance_authorizing','',true)");
  await expect(prepare(s)).rejects.toMatchObject({
    code: "PROPOSAL_ISSUANCE_TIMEOUT",
  });
  expect(
    await row("select * from proposal_issuance_requests where id=$1", [
      issuance.id,
    ]),
  ).toEqual(issuance);
  expect(
    await row("select * from provider_usage where id=$1", [s.usage.id]),
  ).toEqual(s.usage);
  expect(s.methods).toEqual(["POST"]);
});

it("retains request-selected source authority without requiring a duplicate per-provider grant", async () => {
  const s = await setup();
  await f.db.query("delete from content_authorizations where id=$1", [
    s.authorization.id,
  ]);
  await f.db.query(
    "update knowledge_items set category='previous_proposal' where id=$1",
    [s.options.manifest[0].entity_id],
  );
  await f.db.query(
    "update generation_plans set frozen_context=jsonb_build_object('knowledge',jsonb_build_array(jsonb_build_object('kind','style','reference',$2::jsonb))) where id=$1",
    [s.plan.id, JSON.stringify(s.options.manifest[0])],
  );
  await f.db.query(
    "insert into app_private.generation_processing_requests(plan_id,workspace_id,requested_by,operation,idempotency_key,requested_at) values($1,$2,$3,'proposal.generate',$4,clock_timestamp())",
    [s.plan.id, f.w, f.owner, crypto.randomUUID()],
  );
  expect((await prepare(s)).pending.id).toBe(s.usage.id);
  const authorization = await f.command("content.authorize", {
    ...s.options.manifest[0],
    provider: "openai",
    attestation: "nonconfidential_nonpersonal",
  });
  await f.command("content.revoke", {
    id: authorization.id,
    expected_revision: authorization.revision,
  });
  // The fixture wraps all commands in one transaction, so SQL now() predates
  // requested_at. Reproduce the later committed revocation time explicitly.
  await f.db.query(
    "update content_authorizations set revoked_at=clock_timestamp() where id=$1",
    [authorization.id],
  );
  await expect(prepare(s)).rejects.toMatchObject({
    code: "DATA_AUTHORIZATION_REQUIRED",
  });
  expect(s.methods).toEqual(["POST"]);
});

it("returns an expired remote response to the normal accounting path without polling", async () => {
  const s = await setup();
  await f.db.query(
    "update provider_usage set remote_deadline=clock_timestamp()-interval '1 second' where id=$1",
    [s.usage.id],
  );
  const before = await row("select * from provider_usage where id=$1", [
    s.usage.id,
  ]);
  expect(await prepare(s)).toBeNull();
  expect(
    await row("select * from provider_usage where id=$1", [s.usage.id]),
  ).toEqual(before);
  expect(s.methods).toEqual(["POST"]);
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toBeTruthy();
  expect(s.methods).toEqual(["POST"]);
  expect(
    await row("select state,error_code from provider_usage where id=$1", [
      s.usage.id,
    ]),
  ).toEqual({ state: "unknown", error_code: "MODEL_RESULT_EXPIRED" });
});

it("rechecks authorization after a ready GET before consuming its receipt", async () => {
  const s = await setup();
  s.options.fetcher = async (_url, init) => {
    s.methods.push(init?.method ?? "POST");
    expect(init?.method).toBe("GET");
    await f.command("content.revoke", {
      id: s.authorization.id,
      expected_revision: s.authorization.revision,
    });
    return Response.json({
      id: "fixture-accepted-poll",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: '{"key":"approach","title":"Approach","content_blocks":[{"type":"paragraph","text":"Proposed work requires approval."}],"requirement_ids":[],"evidence_refs":[],"company_claims":[],"assumptions":[],"questions":[]}',
            },
          ],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toMatchObject({ code: "DATA_AUTHORIZATION_REQUIRED" });
  expect(s.methods).toEqual(["POST", "GET"]);
  expect(
    await row(
      "select state,actual_input,actual_output,graph_candidate_recorded from provider_usage where id=$1",
      [s.usage.id],
    ),
  ).toEqual({
    state: "reserved",
    actual_input: null,
    actual_output: null,
    graph_candidate_recorded: false,
  });
  expect(
    (
      await row(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key in ('candidate-0','accepted')",
        [s.thread.id],
      )
    ).count,
  ).toBe(0);
});

it("does not accept a ready receipt whose content fails the original draft schema", async () => {
  const s = await setup();
  s.options.fetcher = async (_url, init) => {
    s.methods.push(init?.method ?? "POST");
    if (init?.method === "DELETE")
      return Response.json({ id: "fixture-accepted-poll", deleted: true });
    expect(init?.method).toBe("GET");
    return Response.json({
      id: "fixture-accepted-poll",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"status":"ready"}' }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toBeTruthy();
  expect(s.methods.filter((method) => method !== "DELETE")).toEqual([
    "POST",
    "GET",
  ]);
  expect(
    (
      await row(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
        [s.thread.id],
      )
    ).count,
  ).toBe(0);
  expect(
    await row(
      "select status,result_id from app_private.model_graph_threads where id=$1",
      [s.thread.id],
    ),
  ).toMatchObject({ result_id: null });
  expect(
    await row(
      "select state,actual_input,actual_output from provider_usage where id=$1",
      [s.usage.id],
    ),
  ).toEqual({ state: "settled", actual_input: 10, actual_output: 8 });
});

it("uses the same bounded pending path for the verifier after a retained writer result", async () => {
  const s = await setup();
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: [
      { type: "paragraph", text: "Proposed workflow requires buyer approval." },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  s.options.fetcher = async (_url, init) => {
    const method = init?.method ?? "POST";
    s.methods.push(method);
    calls.push(`HTTP:${method}`);
    if (method === "DELETE")
      return Response.json({ id: "fixture-accepted-poll", deleted: true });
    if (method === "POST")
      return Response.json({
        id: "fixture-accepted-verifier",
        status: "queued",
      });
    return Response.json({
      id: "fixture-accepted-poll",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(candidate) }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  await expect(
    executeGuardedModel({ ...s.options, job: s.job }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  let job = await rpc("claim_backend_job_v5");
  expect(job.id).toBe(s.job.id);
  await expect(
    executeGuardedModel({ ...s.options, job }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  await f.db.query(
    "update jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  job = await rpc("claim_backend_job_v5");
  expect(job.checkpoint.model_operation.task).toBe("verify_grounding");
  const before = await graphSnapshot(job.id);
  calls = [];
  s.options.fetcher = async (_url, init) => {
    expect(init?.method).toBe("GET");
    calls.push("HTTP:GET");
    return Response.json({
      id: "fixture-accepted-verifier",
      status: "in_progress",
    });
  };
  await expect(
    executeGuardedModel({ ...s.options, job }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  expect(calls).toEqual([
    "prepare_accepted_model_poll",
    "HTTP:GET",
    "finish_model_attempt",
    "defer_pending_model_request",
  ]);
  expect(await graphSnapshot(job.id)).toEqual(before);
  expect(
    (
      await row(
        "select count(*)::int count from provider_usage where job_id=$1",
        [job.id],
      )
    ).count,
  ).toBe(2);
  expect(
    (
      await row(
        "select count(*)::int count from provider_usage where job_id=$1 and state='reserved'",
        [job.id],
      )
    ).count,
  ).toBe(1);
});

it("preserves normal expiration accounting when the remote deadline passes after preparation", async () => {
  const s = await setup();
  const internal = s.options.backend.internal;
  let prepared = false;
  s.options.backend.internal = async (name: string, args: any) => {
    const result = await internal.call(s.options.backend, name, args);
    if (name === "prepare_accepted_model_poll" && result) {
      prepared = true;
      vi.spyOn(Date, "now").mockReturnValue(
        Date.parse(result.pending.remote_deadline) + 1,
      );
    }
    return result;
  };
  try {
    await expect(
      executeGuardedModel({ ...s.options, job: s.job }),
    ).rejects.toBeTruthy();
    expect(prepared).toBe(true);
    expect(s.methods).toEqual(["POST"]);
    expect(
      await row("select state,error_code from provider_usage where id=$1", [
        s.usage.id,
      ]),
    ).toEqual({ state: "unknown", error_code: "MODEL_RESULT_EXPIRED" });
    expect(
      (
        await row(
          "select count(*)::int count from provider_usage where job_id=$1",
          [s.job.id],
        )
      ).count,
    ).toBe(1);
  } finally {
    vi.restoreAllMocks();
  }
});
