// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
type Scenario = Awaited<ReturnType<typeof createRecheckFixture>>;
// Real synthetic paid-candidate/old-report/prompt/budget state. Retries enter the
// public app command and complete latest migration stack; no transport calls.
const protectedTables = [
  "public.provider_usage",
  "public.model_attempts",
  "public.proposal_versions",
  "public.documents",
  "public.document_blocks",
  "public.document_packages",
  "public.content_authorizations",
  "app_private.model_graph_threads",
  "app_private.model_graph_results",
  "app_private.model_graph_budgets",
  "app_private.model_graph_checkpoints",
  "app_private.model_graph_writes",
];
async function protectedState() {
  const result: Record<string, string[]> = {};
  for (const table of protectedTables)
    result[table] = (
      await f.db.query<{ value: string }>(
        `select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`,
      )
    ).rows.map((r) => r.value);
  return result;
}
async function completeSnapshot(s: Scenario) {
  const result = await s.snapshot();
  for (const table of [
    "public.proposal_issuance_requests",
    "public.proposal_delivery_snapshots",
    "public.proposal_delivery_artifacts",
  ])
    result[table] = (
      await f.db.query<{ value: string }>(
        `select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`,
      )
    ).rows.map((r) => r.value);
  return result;
}
async function receipt(s: Scenario, condition: string) {
  const terminal = condition.includes("terminal");
  const remote =
    condition !== "expired-no-remote" && condition !== "before-boundary";
  const usage = (
    await f.db.query<any>(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
      application_day,settings_revision,reserved_input,reserved_output,state,error_code,remote_request_id,remote_deadline,
      created_at,connection_id,model_config_id,created_by)
     values($1,$2,gen_random_uuid(),$3,'openai',$4,$5,current_date,1,100,100,'unknown',$6,$7,
      case when $8::boolean then null when $9::boolean then now() else now()+interval '1 hour' end,
      now()-$10::int*interval '1 millisecond',$11,$12,$13) returning *`,
      [
        f.w,
        s.parent.id,
        `${s.prefix}:candidate-0:unknown-recovery`,
        "historical-openai",
        s.writerHash,
        terminal ? "PROVIDER_BACKGROUND_TERMINATED" : "MODEL_NETWORK_UNCERTAIN",
        remote ? "synthetic-unknown-remote" : null,
        !remote || condition === "known-remote-no-deadline",
        condition === "at-remote-deadline",
        condition === "before-boundary" ? 899999 : terminal ? 1000 : 900000,
        null,
        null,
        f.owner,
      ],
    )
  ).rows[0];
  if (terminal)
    await f.db.query(
      `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,
     round_number,worker_attempt,status,result_code,usage_id,sent,finish_reason,connection_id,model_config_id,response_id)
     values($1,$2,$3,'openai',$4,$5,'analyze_chunk',2,1,'failed',$6,$7,true,$8,$9,$10,$11)`,
      [
        f.w,
        s.parent.id,
        usage.lease_token,
        condition === "terminal-wrong-model"
          ? "different-model"
          : "historical-openai",
        s.connection.project_ref,
        condition === "terminal-wrong-response"
          ? "PROVIDER_REQUEST_REJECTED"
          : "PROVIDER_BACKGROUND_TERMINATED",
        usage.id,
        condition === "terminal-not-finished" ? "in_progress" : "failed",
        null,
        null,
        condition === "terminal-wrong-response"
          ? "different-remote"
          : usage.remote_request_id,
      ],
    );
  if (condition === "manual-terminal")
    await f.db.query(
      "update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_routing,mode}','\"manual\"') where id=$1",
      [s.parent.id],
    );
  return usage;
}
async function retryInput(s: Scenario) {
  const job = await s.row("public.jobs", s.parent.id);
  return {
    id: job.id,
    expected_revision: job.revision,
    action: "retry",
    reason: "Explicit synthetic historical recovery qualification",
  };
}
it.each(["terminal-proven", "expired-no-remote", "at-remote-deadline"])(
  "current-contract retry %s preserves all paid pins, exhausted budgets, unknown receipt and accepted sibling",
  async (condition) => {
    const s = await createRecheckFixture(f);
    const u = await receipt(s, condition),
      before = await protectedState();
    let priorAuthorization: any;
    if (condition === "terminal-proven") {
      // Immutable already-expired synthetic authorization. The explicit retry
      // must create its own deadline; it may not extend or edit this old row.
      priorAuthorization = (
        await f.db.query<any>(
          `insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,
          accepted_at,deadline_at,outcome,error_code,completed_at)
         select $1,$2,$3,'job.action','synthetic-old-authorization',t,t+interval '600 seconds','failed',
          'PROPOSAL_ISSUANCE_TIMEOUT',t+interval '600 seconds' from (select now()-interval '601 seconds' t) clock returning *`,
          [f.w, s.plan.id, f.owner],
        )
      ).rows[0];
      await f.db.query(
        "update public.generation_plans set issuance_request_id=$2 where id=$1",
        [s.plan.id, priorAuthorization.id],
      );
      await f.db.exec(
        "select set_config('app.issuance_authorizing','true',true)",
      );
      await f.db.query(
        "update public.jobs set checkpoint=checkpoint||jsonb_build_object('issuance_request_id',$2::uuid,'issuance_deadline_version',1) where id=$1",
        [s.parent.id, priorAuthorization.id],
      );
      await f.db.exec("select set_config('app.issuance_authorizing','',true)");
    }
    const sibling = await s.row("public.jobs", s.sibling.id);
    const siblingStep = (
      await f.db.query<any>(
        "select * from public.generation_steps where job_id=$1",
        [s.sibling.id],
      )
    ).rows[0];
    const beforeCommand = await completeSnapshot(s);
    const payload = await retryInput(s),
      key = crypto.randomUUID();
    const result = await f.command("job.action", payload, key);
    expect(result).toMatchObject({
      id: s.parent.id,
      status: "queued",
      attempts: s.parent.attempts,
      input_hash: s.parent.input_hash,
    });
    const plan = await s.row("public.generation_plans", s.plan.id);
    expect(plan).toMatchObject({
      frozen_context: s.plan.frozen_context,
      input_hash: s.plan.input_hash,
    });
    const request = await s.row(
      "public.proposal_issuance_requests",
      plan.issuance_request_id,
    );
    expect(request).toMatchObject({
      operation: "job.action",
      outcome: "active",
      file_capacity_acquired: false,
      reserved_file_bytes: 0,
    });
    expect(
      new Date(request.deadline_at).getTime() -
        new Date(request.accepted_at).getTime(),
    ).toBe(600000);
    if (priorAuthorization) {
      expect(request.id).not.toBe(priorAuthorization.id);
      expect(new Date(request.accepted_at).getTime()).toBeGreaterThan(
        new Date(priorAuthorization.deadline_at).getTime(),
      );
      expect(
        await s.row("public.proposal_issuance_requests", priorAuthorization.id),
      ).toEqual(priorAuthorization);
    }
    const resumed = await s.row("public.jobs", s.parent.id);
    expect(resumed.checkpoint).toEqual({
      ...s.parent.checkpoint,
      minimum_worker_executor: 4,
      issuance_deadline_version: 1,
      issuance_request_id: request.id,
    });
    expect(await s.row("public.jobs", s.sibling.id)).toEqual(sibling);
    expect(
      (
        await f.db.query<any>(
          "select * from public.generation_steps where id=$1",
          [siblingStep.id],
        )
      ).rows[0],
    ).toEqual(siblingStep);
    expect(await protectedState()).toEqual(before);
    expect(await s.row("public.provider_usage", u.id)).toEqual(u);
    const after = await completeSnapshot(s);
    const authorizationTables = new Set([
      "public.generation_plans",
      "public.jobs",
      "public.audit_events",
      "app_private.idempotency_records",
      "app_private.generation_processing_requests",
      "public.proposal_issuance_requests",
    ]);
    for (const table of Object.keys(beforeCommand)) {
      if (!authorizationTables.has(table))
        expect(after[table], table).toEqual(beforeCommand[table]);
      else if (table !== "app_private.generation_processing_requests") {
        const changedId =
          table === "public.generation_plans"
            ? s.plan.id
            : table === "public.jobs"
              ? s.parent.id
              : null;
        for (const retained of beforeCommand[table])
          if (JSON.parse(retained).id !== changedId)
            expect(after[table], table).toContain(retained);
      }
    }
    expect(await f.command("job.action", payload, key)).toEqual(result);
    expect(await completeSnapshot(s)).toEqual(after);
    await expect(
      f.command(
        "job.action",
        { ...payload, reason: "Different authorization" },
        key,
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(await completeSnapshot(s)).toEqual(after);
    expect((await s.rpc("claim_backend_job_v3"))?.id).not.toBe(s.parent.id);
  },
);
it.each([
  "before-boundary",
  "active-remote",
  "manual-terminal",
  "terminal-wrong-model",
  "terminal-wrong-response",
  "terminal-not-finished",
])(
  "current-contract retry refuses %s without authorizing time, changing paid history or resetting allowance",
  async (condition) => {
    const s = await createRecheckFixture(f);
    await receipt(s, condition);
    const before = await completeSnapshot(s);
    await expect(f.command("job.action", await retryInput(s))).rejects.toThrow(
      "USAGE_REVIEW_REQUIRED",
    );
    expect(await completeSnapshot(s)).toEqual(before);
  },
);
it.each(["stale-source", "revoked-owner"])(
  "terminal unknown accounting does not bypass %s on current-contract retry",
  async (condition) => {
    const s = await createRecheckFixture(f);
    await receipt(s, "terminal-proven");
    if (condition === "stale-source")
      await f.db.query(
        "update public.documents set extraction_hash=repeat('e',64) where id=$1",
        [s.document.id],
      );
    else
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    const before = await completeSnapshot(s);
    await expect(f.command("job.action", await retryInput(s))).rejects.toThrow(
      condition === "stale-source" ? "STALE_INPUT" : "FORBIDDEN",
    );
    expect(await completeSnapshot(s)).toEqual(before);
  },
);
it("legacy paid partial plan requires explicit successor; old paid results, source, budgets and accepted sibling never move to the successor", async () => {
  const s = await createRecheckFixture(f, { historicalDeliveryContract: true });
  await receipt(s, "terminal-proven");
  const before = await completeSnapshot(s),
    paid = await protectedState();
  const siblingStep = (
    await f.db.query<any>(
      "select * from public.generation_steps where job_id=$1",
      [s.sibling.id],
    )
  ).rows[0];
  for (const [operation, payload] of [
    ["job.action", await retryInput(s)],
    ["generation.retry", { id: s.plan.id, expected_revision: s.plan.revision }],
    [
      "proposal.generate",
      { id: s.opportunity.id, expected_revision: s.opportunity.revision },
    ],
  ] as const) {
    let error: any;
    try {
      await f.command(operation, payload);
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe("PROPOSAL_CURRENT_CONTRACT_REQUIRED");
    expect(JSON.parse(error.detail)).toMatchObject({
      plan_id: s.plan.id,
      preserved_input_hash: s.plan.input_hash,
      cancel_required: true,
      next_operation: "proposal.generate",
      base_version_id: null,
    });
    expect(await completeSnapshot(s)).toEqual(before);
  }
  await f.command("generation.cancel", {
    id: s.plan.id,
    expected_revision: s.plan.revision,
    reason: "Explicit current successor",
  });
  const canceled = await s.row("public.generation_plans", s.plan.id);
  const payload = {
      id: s.opportunity.id,
      expected_revision: s.opportunity.revision,
    },
    key = crypto.randomUUID();
  const successor = await f.command("proposal.generate", payload, key);
  expect(successor.id).not.toBe(s.plan.id);
  const current = await s.row("public.generation_plans", successor.id);
  expect(current.frozen_context).toMatchObject({
    generated_delivery_version: 3,
    proposal_consistency_version: 1,
  });
  expect(current.issuance_request_id).toBeTruthy();
  expect(await s.row("public.generation_plans", s.plan.id)).toEqual(canceled);
  expect(canceled).toMatchObject({
    frozen_context: s.plan.frozen_context,
    input_hash: s.plan.input_hash,
    status: "canceled",
  });
  expect(await protectedState()).toEqual(paid);
  expect(
    (
      await f.db.query<any>(
        "select * from public.generation_steps where id=$1",
        [siblingStep.id],
      )
    ).rows[0],
  ).toEqual(siblingStep);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from app_private.model_graph_threads t join public.jobs j on j.id=t.job_id where j.entity_id=$1",
        [successor.id],
      )
    ).rows[0].n,
  ).toBe(0);
  const after = await completeSnapshot(s);
  expect(await f.command("proposal.generate", payload, key)).toEqual(successor);
  expect(await completeSnapshot(s)).toEqual(after);
});
