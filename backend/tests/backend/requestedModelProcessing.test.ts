// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_attempt");
  try {
    return await run();
  } catch (error) {
    await f.db.exec("rollback to savepoint expected_attempt");
    throw error;
  } finally {
    await f.db.exec("release savepoint expected_attempt");
  }
}
async function sourceOpportunity() {
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic requested workflow",
    reference: "SYNTHETIC",
    decision: "shortlisted",
    description: "Implement an approval workflow.",
    language: "en",
  });
}
async function uploaded(opportunityId: string) {
  const text =
    "Implement an approval workflow and provide handover documentation.";
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunityId,
    original_name: "synthetic-rfp.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
  });
  const accepted = await f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    "a".repeat(64),
    100,
    text,
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: accepted.id,
    expected_revision: accepted.revision,
  });
  return accepted;
}
async function plan() {
  const opportunity = await sourceOpportunity();
  const document = await uploaded(opportunity.id);
  const input = { id: opportunity.id, expected_revision: opportunity.revision };
  const key = crypto.randomUUID();
  const result = await f.command("proposal.generate", input, key);
  const job = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=(select job_id from public.generation_steps where plan_id=$1 order by ordinal limit 1) returning *",
      [result.id],
    )
  ).rows[0];
  const reference = result.frozen_context.blocks[0].reference;
  return { opportunity, document, result, job, reference, input, key };
}
async function check(jobId: string, refs: any[], provider = "qwen_free") {
  return attempt(() =>
    f.db.query(
      "select app_private.check_requested_model_payload($1,$2,$3::jsonb)",
      [jobId, provider, JSON.stringify(refs)],
    ),
  );
}
async function manualConfig() {
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
}

it.each(["Owner", "Editor"])(
  "uses an authorized %s request without separate file or provider consent",
  async (role) => {
    await f.db.query(
      "update public.memberships set role=$1 where workspace_id=$2 and user_id=$3",
      [role, f.w, f.owner],
    );
    const p = await plan();
    expect(
      (await f.db.query("select id from public.content_authorizations")).rows,
    ).toHaveLength(0);
    for (const provider of ["qwen_free", "openai", "qwencloud"])
      await expect(
        check(p.job.id, [p.reference], provider),
      ).resolves.toBeTruthy();
    const stored = (
      await f.db.query<any>(
        "select * from app_private.generation_processing_requests where plan_id=$1",
        [p.result.id],
      )
    ).rows[0];
    expect(stored).toMatchObject({
      requested_by: f.owner,
      operation: "proposal.generate",
      idempotency_key: p.key,
    });
    expect(
      (await f.db.query("select id from public.content_authorizations")).rows,
    ).toHaveLength(0);
    expect(
      (await f.db.query("select id from public.provider_usage")).rows,
    ).toHaveLength(0);
  },
);

it("passes requested RFP input through manual, legacy automatic and task-catalog preflights", async () => {
  const p = await plan();
  await manualConfig();
  const manual = await f.rpc("model_preflight", [
    p.job.id,
    p.job.lease_token,
    JSON.stringify([p.reference]),
  ]);
  expect(manual.providers.some((x: any) => x.provider === "qwen_free")).toBe(
    true,
  );
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
  });
  await f.db.query("update public.jobs set checkpoint=$2::jsonb where id=$1", [
    p.job.id,
    JSON.stringify({
      model_routing: {
        lease: p.job.lease_token,
        providers: [{ provider: "qwen_free", enabled: true }],
      },
    }),
  ]);
  const legacy = await f.rpc("model_preflight", [
    p.job.id,
    p.job.lease_token,
    JSON.stringify([p.reference]),
  ]);
  expect(legacy.providers).toHaveLength(1);
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||'{\"model_executor\":2}'::jsonb where id=$1",
    [p.job.id],
  );
  const catalog = await f.rpc("task_model_preflight", [
    p.job.id,
    p.job.lease_token,
    JSON.stringify([p.reference]),
  ]);
  expect(catalog.providers).toHaveLength(1);
});

it("covers the requested manual notice without enabling automatic-public policy", async () => {
  const opportunity = await sourceOpportunity();
  await f.db.query(
    "update public.opportunities set assessment_pending=false where id=$1",
    [opportunity.id],
  );
  await f.db.query(
    "delete from public.jobs where entity_id in (select id from public.generation_plans where opportunity_id=$1)",
    [opportunity.id],
  );
  const p = await f.command("opportunity.assess", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const job = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where entity_id=$1 returning *",
      [p.id],
    )
  ).rows[0];
  await expect(
    check(job.id, [p.frozen_context.notice.reference]),
  ).resolves.toBeTruthy();
  expect(
    (
      await f.db.query<any>(
        "select discovery_policy from public.workspaces where id=$1",
        [f.w],
      )
    ).rows[0].discovery_policy.auto_public_notices,
  ).not.toBe(true);
});

it("resumes an existing blocked plan canonically without changing frozen work or graph accounting", async () => {
  const p = await plan();
  await f.db.query(
    "delete from app_private.generation_processing_requests where plan_id=$1",
    [p.result.id],
  );
  await f.db.query(
    "update public.jobs set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED',lease_token=null,lease_until=null,checkpoint='{\"retained\":\"synthetic\"}' where entity_id=$1",
    [p.result.id],
  );
  await f.db.query(
    "update public.generation_plans set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED' where id=$1",
    [p.result.id],
  );
  const before = (
    await f.db.query<any>(
      "select frozen_context,input_hash,evidence_revision from public.generation_plans where id=$1",
      [p.result.id],
    )
  ).rows[0];
  const jobsBefore = (
    await f.db.query<any>(
      "select attempts,failure_count,checkpoint from public.jobs where entity_id=$1",
      [p.result.id],
    )
  ).rows;
  const resumed = await f.command("generation.retry", {
    id: p.result.id,
    expected_revision: p.result.revision,
    reason: "Resume the requested work.",
  });
  expect(resumed.status).toBe("queued");
  expect(
    (
      await f.db.query<any>(
        "select frozen_context,input_hash,evidence_revision from public.generation_plans where id=$1",
        [p.result.id],
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select attempts,failure_count,checkpoint from public.jobs where entity_id=$1",
        [p.result.id],
      )
    ).rows,
  ).toEqual(jobsBefore);
  const j = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
      [p.job.id],
    )
  ).rows[0];
  await expect(check(j.id, [p.reference])).resolves.toBeTruthy();
});

it("rejects stale text, unrelated same-workspace input and another workspace's content", async () => {
  const p = await plan();
  await expect(
    check(p.job.id, [{ ...p.reference, content_hash: "b".repeat(64) }]),
  ).rejects.toThrow("STALE_INPUT");
  const other = await sourceOpportunity();
  const unrelated = await uploaded(other.id);
  await expect(
    check(p.job.id, [
      {
        entity_kind: "document",
        entity_id: unrelated.id,
        content_hash: unrelated.extraction_hash,
      },
    ]),
  ).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
  await expect(
    check(p.job.id, [
      {
        entity_kind: "document",
        entity_id: crypto.randomUUID(),
        content_hash: "a".repeat(64),
      },
    ]),
  ).rejects.toThrow("NOT_FOUND");
});

it("retains business-content checks, active identity and existing Company Knowledge permissions", async () => {
  const p = await plan();
  const knowledge = await f.command("knowledge.save", {
    title: "Synthetic company",
    content: "Builds workflow software.",
    category: "company",
    enabled: true,
    evidence: "Synthetic fixture only",
  });
  const k = (await f.rpc("eligibility_candidates")).items.find(
    (x: any) => x.entity_id === knowledge.id,
  );
  await expect(check(p.job.id, [k])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
  await f.db.query(
    "update public.identity_allowlist set status='inactive' where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(check(p.job.id, [p.reference])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
});

it("does not treat an automatic plan's Owner attribution as a request", async () => {
  const p = await plan();
  await f.db.query(
    "delete from app_private.generation_processing_requests where plan_id=$1",
    [p.result.id],
  );
  await expect(check(p.job.id, [p.reference])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
});

it("retains later exact revocation and does not refresh authorization on idempotent replay", async () => {
  const p = await plan();
  const before = (
    await f.db.query<any>(
      "select requested_at from app_private.generation_processing_requests where plan_id=$1",
      [p.result.id],
    )
  ).rows[0];
  await f.command("proposal.generate", p.input, p.key);
  expect(
    (
      await f.db.query<any>(
        "select requested_at from app_private.generation_processing_requests where plan_id=$1",
        [p.result.id],
      )
    ).rows[0],
  ).toEqual(before);
  await f.db.query(
    "insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by,revoked_at) values($1,'document',$2,$3,'qwen_free','nonconfidential_nonpersonal',$4,clock_timestamp()+interval '1 second')",
    [f.w, p.reference.entity_id, p.reference.content_hash, f.owner],
  );
  await expect(check(p.job.id, [p.reference])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
});

it("keeps the request ledger and scoped helper inaccessible to clients and service RPC callers", async () => {
  const p = await plan();
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','app_private.check_requested_model_payload(uuid,text,jsonb)','execute') browser,has_function_privilege('service_role','app_private.check_requested_model_payload(uuid,text,jsonb)','execute') service,has_table_privilege('authenticated','app_private.generation_processing_requests','select') ledger",
      )
    ).rows[0],
  ).toEqual({ browser: false, service: false, ledger: false });
  await f.db.query(
    "update public.memberships set role='Reviewer' where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(f.command("proposal.generate", p.input)).rejects.toThrow(
    "ROLE_FORBIDDEN",
  );
  await expect(check(p.job.id, [p.reference])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
});

it("preserves source-page processing in the existing automatic policy path", async () => {
  const p = await plan();
  await expect(
    check(p.job.id, [
      {
        entity_kind: "source_page",
        entity_id: p.job.id,
        content_hash: "a".repeat(64),
      },
    ]),
  ).rejects.toThrow("STALE_INPUT");
});

it("rejects restricted content even for a valid requested document", async () => {
  const p = await plan();
  // A legacy stored row may predate current intake checks. Seed that case
  // only in this rolled-back fixture, then restore every trigger before send.
  await f.db.exec("alter table public.documents disable trigger user");
  await f.db.query(
    "update public.documents set extracted_text='CONFIDENTIAL: Synthetic restricted contents.' where id=$1",
    [p.document.id],
  );
  await f.db.exec("alter table public.documents enable trigger user");
  await expect(check(p.job.id, [p.reference])).rejects.toThrow(
    "DATA_POLICY_BLOCKED",
  );
});

it("does not use older replayed commands as new authorization after a retry and revocation", async () => {
  const p = await plan();
  await f.db.query(
    "update public.jobs set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED',lease_token=null,lease_until=null where entity_id=$1",
    [p.result.id],
  );
  await f.db.query(
    "update public.generation_plans set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED' where id=$1",
    [p.result.id],
  );
  await f.command("generation.retry", {
    id: p.result.id,
    expected_revision: p.result.revision,
    reason: "Synthetic newer user request.",
  });
  const latest = (
    await f.db.query<any>(
      "select * from app_private.generation_processing_requests where plan_id=$1",
      [p.result.id],
    )
  ).rows[0];
  await f.command("proposal.generate", p.input, p.key);
  expect(
    (
      await f.db.query<any>(
        "select * from app_private.generation_processing_requests where plan_id=$1",
        [p.result.id],
      )
    ).rows[0],
  ).toEqual(latest);
  await f.db.query(
    "insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by,revoked_at) values($1,'document',$2,$3,'qwen_free','nonconfidential_nonpersonal',$4,clock_timestamp()+interval '1 second')",
    [f.w, p.reference.entity_id, p.reference.content_hash, f.owner],
  );
  await f.command("proposal.generate", p.input, p.key);
  const j = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
      [p.job.id],
    )
  ).rows[0];
  await expect(check(j.id, [p.reference])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
});

it("authorizes a permitted single-job retry without restarting sibling work", async () => {
  const p = await plan();
  await f.db.query(
    "delete from app_private.generation_processing_requests where plan_id=$1",
    [p.result.id],
  );
  await f.db.query(
    "update public.jobs set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED',lease_token=null,lease_until=null where id=$1",
    [p.job.id],
  );
  await f.db.query(
    "update public.generation_plans set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED' where id=$1",
    [p.result.id],
  );
  const result = await f.command("job.action", {
    id: p.job.id,
    expected_revision: p.job.revision,
    action: "retry",
    reason: "Resume this selected task.",
  });
  expect(result.id).toBe(p.job.id);
  expect(
    (
      await f.db.query<any>(
        "select operation from app_private.generation_processing_requests where plan_id=$1",
        [p.result.id],
      )
    ).rows[0].operation,
  ).toBe("job.action");
  const j = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
      [p.job.id],
    )
  ).rows[0];
  await expect(check(j.id, [p.reference])).resolves.toBeTruthy();
});

it("keeps foreign-workspace content unavailable even when it exists", async () => {
  const p = await plan();
  // The live app is single-workspace; remove only this fixture constraint
  // to exercise the lower-level isolation guarantee against an existing row.
  await f.db.exec(
    "alter table public.workspaces drop constraint workspaces_singleton_key",
  );
  const foreignWorkspace = (
    await f.db.query<any>(
      "insert into public.workspaces(name,created_by) values('Synthetic other workspace',$1) returning id",
      [f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "insert into public.workspace_actors(workspace_id,id,kind) values($1,$2,'historical')",
    [foreignWorkspace, f.owner],
  );
  const foreignKnowledge = (
    await f.db.query<any>(
      "insert into public.knowledge_items(workspace_id,title,content,category,created_by) values($1,'Synthetic foreign content','Unrelated external workspace data.','company',$2) returning id",
      [foreignWorkspace, f.owner],
    )
  ).rows[0].id;
  const ref = (
    await f.db.query<any>(
      "select app_private.content_record($1,'knowledge',$2) v",
      [foreignWorkspace, foreignKnowledge],
    )
  ).rows[0].v;
  await expect(check(p.job.id, [ref])).rejects.toThrow("NOT_FOUND");
});

it("includes requested review text and its attached file without separate provider reviews", async () => {
  const p = await plan();
  const version = (
    await f.db.query<any>(
      "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,1,repeat('d',64),$3) returning *",
      [f.w, p.result.proposal_id, f.owner],
    )
  ).rows[0];
  await f.db.query(
    "update public.proposals set active_version_id=$2 where id=$1",
    [p.result.proposal_id, version.id],
  );
  const proposal = (
    await f.db.query<any>("select * from public.proposals where id=$1", [
      p.result.proposal_id,
    ])
  ).rows[0];
  await f.command("review.save", {
    id: proposal.id,
    expected_revision: proposal.revision,
    base_version_id: version.id,
    source_signature: "Synthetic review",
    inputs: [
      {
        client_id: crypto.randomUUID(),
        target_kind: "general",
        target_id: "general",
        body: "Explain the acceptance-testing approach.",
      },
    ],
  });
  const review = (
    await f.db.query<any>(
      "select * from public.review_inputs where proposal_id=$1",
      [proposal.id],
    )
  ).rows[0];
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "review",
    review_input_id: review.id,
    original_name: "synthetic-review.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "c".repeat(64),
  });
  const accepted = await f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    "c".repeat(64),
    100,
    "Explain support and handover acceptance.",
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: accepted.id,
    expected_revision: accepted.revision,
  });
  await f.db.query(
    "update public.jobs set status='canceled',lease_token=null,lease_until=null where entity_id=$1",
    [p.result.id],
  );
  await f.db.query(
    "update public.generation_plans set status='canceled' where id=$1",
    [p.result.id],
  );
  const current = (
    await f.db.query<any>("select * from public.proposals where id=$1", [
      proposal.id,
    ])
  ).rows[0];
  const regenerated = await f.command("proposal.regenerate", {
    id: current.id,
    expected_revision: current.revision,
    base_version_id: version.id,
    input_hash: "b".repeat(64),
  });
  const job = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=(select job_id from public.generation_steps where plan_id=$1 order by ordinal limit 1) returning *",
      [regenerated.id],
    )
  ).rows[0];
  const refs = regenerated.frozen_context.reviews.map((x: any) => x.reference);
  expect(refs.some((r: any) => r.entity_kind === "review")).toBe(true);
  expect(refs.some((r: any) => r.entity_kind === "document")).toBe(true);
  await expect(check(job.id, refs, "openai")).resolves.toBeTruthy();
  expect(
    (await f.db.query("select id from public.content_authorizations")).rows,
  ).toHaveLength(0);
});

it("removes request metadata when its plan is deleted by existing lifecycle paths", async () => {
  const p = await plan();
  await f.db.query("delete from public.generation_steps where plan_id=$1", [
    p.result.id,
  ]);
  await f.db.query("delete from public.jobs where entity_id=$1", [p.result.id]);
  await f.db.query("delete from public.generation_plans where id=$1", [
    p.result.id,
  ]);
  expect(
    (
      await f.db.query(
        "select plan_id from app_private.generation_processing_requests where plan_id=$1",
        [p.result.id],
      )
    ).rows,
  ).toHaveLength(0);
});

async function optionalStyleAndRate() {
  const style = await f.command("knowledge.save", {
    title: "Synthetic historical style",
    content: "Use concise section headings and explain acceptance evidence.",
    category: "previous_proposal",
    enabled: true,
    evidence: "Synthetic style fixture only",
  });
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "company",
    knowledge_item_id: style.id,
    original_name: "synthetic-style.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "e".repeat(64),
  });
  const document = await f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    "e".repeat(64),
    100,
    "Organize the response with clear headings and acceptance criteria.",
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: document.id,
    expected_revision: document.revision,
  });
  let rate = await f.command("rate.save", {
    expected_revision: 0,
    title: "Synthetic approved labor",
    unit: "day",
    currency: "SAR",
    unit_cost: "1000",
    zero_confirmed: false,
    valid_from: "2020-01-01",
    valid_until: "2099-01-01",
    source_reference: "Synthetic public rate source",
    public_approved: true,
  });
  rate = await f.command("rate.approve", {
    id: rate.id,
    expected_revision: rate.revision,
  });
  return { style, document, rate };
}

it("processes selected historical style text, style files and approved rates from a direct request", async () => {
  await optionalStyleAndRate();
  const p = await plan();
  const styleRefs = p.result.frozen_context.knowledge
    .filter((x: any) => x.kind === "style")
    .map((x: any) => x.reference);
  const rates = p.result.frozen_context.rates.map((x: any) => x.reference);
  expect(styleRefs.some((r: any) => r.entity_kind === "knowledge")).toBe(true);
  expect(styleRefs.some((r: any) => r.entity_kind === "document")).toBe(true);
  expect(rates).toHaveLength(1);
  await expect(
    check(p.job.id, [...styleRefs, ...rates], "openai"),
  ).resolves.toBeTruthy();
  expect(
    (await f.db.query("select id from public.content_authorizations")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select id from public.provider_usage")).rows,
  ).toHaveLength(0);
  await expect(
    check(p.job.id, [{ ...rates[0], content_hash: "f".repeat(64) }]),
  ).rejects.toThrow("STALE_INPUT");
});

it("keeps unrelated optional style and rates out of an existing request", async () => {
  const p = await plan();
  const optional = await optionalStyleAndRate();
  for (const [kind, id] of [
    ["knowledge", optional.style.id],
    ["document", optional.document.id],
    ["rate", optional.rate.id],
  ]) {
    const ref = (
      await f.db.query<any>("select app_private.content_record($1,$2,$3) v", [
        f.w,
        kind,
        id,
      ])
    ).rows[0].v;
    await expect(
      check(p.job.id, [
        {
          entity_kind: ref.entity_kind,
          entity_id: ref.entity_id,
          content_hash: ref.content_hash,
        },
      ]),
    ).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
  }
});

it("rechecks current eligibility for selected style and rates and leaves automatic policy unchanged", async () => {
  const optional = await optionalStyleAndRate();
  const p = await plan();
  const styleRefs = p.result.frozen_context.knowledge
    .filter((x: any) => x.kind === "style")
    .map((x: any) => x.reference);
  const rateRef = p.result.frozen_context.rates[0].reference;
  await f.db.query(
    "update public.rate_catalog set approved=false where id=$1",
    [optional.rate.id],
  );
  await expect(check(p.job.id, [rateRef])).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
  await f.db.query(
    "update public.knowledge_items set expiry_date=current_date-1 where id=$1",
    [optional.style.id],
  );
  for (const ref of styleRefs)
    await expect(check(p.job.id, [ref])).rejects.toThrow(
      "DATA_AUTHORIZATION_REQUIRED",
    );
  await f.db.query(
    "update public.knowledge_items set expiry_date=null where id=$1",
    [optional.style.id],
  );
  await f.db.query(
    "delete from app_private.generation_processing_requests where plan_id=$1",
    [p.result.id],
  );
  for (const ref of styleRefs)
    await expect(check(p.job.id, [ref])).rejects.toThrow(
      "DATA_AUTHORIZATION_REQUIRED",
    );
});
