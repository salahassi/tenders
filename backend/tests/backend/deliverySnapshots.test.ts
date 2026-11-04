// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture, claimModelWorker4 } from "./workflowFixture";
import { deliveryPayloadSchema } from "../../supabase/functions/_shared/deliveryContract";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_failure");
  try {
    return await run();
  } catch (error) {
    await f.db.exec("rollback to savepoint expected_failure");
    throw error;
  } finally {
    await f.db.exec("release savepoint expected_failure;reset role");
  }
}
async function row(sql: string, args: unknown[] = []) {
  return (await f.db.query<any>(sql, args)).rows[0];
}
async function opportunity(
  description = "Synthetic RFP: deliver an approval workflow with an auditable handover.",
) {
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic procurement",
    reference: "SYNTHETIC",
    description,
    language: "en",
    decision: "shortlisted",
  });
}
async function upload(
  o: any,
  text = "Synthetic scope: implement two approval stages; do not remove the approval condition.",
  status = "ready",
) {
  const hash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const d = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: o.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash,
  });
  return f.rpc("accept_uploaded_document", [
    d.id,
    f.owner,
    hash,
    100,
    text,
    status,
    crypto.randomUUID(),
  ]);
}
async function prepare(
  o: any,
  extra = {},
  key?: ReturnType<typeof crypto.randomUUID>,
) {
  return f.command(
    "delivery.snapshot.prepare",
    { opportunity_id: o.id, expected_revision: o.revision, ...extra },
    key,
  );
}
async function plan(o: any) {
  await upload(o);
  return f.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
}
async function context(snapshot: string) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  return attempt(async () => {
    await f.db.exec("set role authenticated");
    return f.rpc("delivery_context", [snapshot]);
  });
}
async function counts() {
  return row(`select (select count(*)::int from public.provider_usage) usage,
    (select count(*)::int from public.model_attempts) attempts,
    (select count(*)::int from public.jobs where type<>'render_delivery') jobs,
    (select count(*)::int from public.proposal_versions) versions`);
}

it("creates a durable insufficient-information template without a model, attachment or approved version", async () => {
  const o = await opportunity(""),
    before = await counts();
  const s = await prepare(o, { intake_failure: "EMPTY_FILE" });
  const payload = deliveryPayloadSchema.parse(s.payload);
  expect(payload).toMatchObject({
    input_state: "insufficient",
    content_state: "template",
    assurance_state: "unreviewed",
    substantive_complete: false,
    approval_state: "draft",
  });
  expect(payload.notice).toContain("Insufficient");
  expect(payload.input_materials).toMatchObject({
    intake_failure: "EMPTY_FILE",
    intake_failure_source: "client_reported",
    documents: [],
  });
  expect(payload.sections.every((x) => x.kind === "response")).toBe(true);
  expect(payload.gaps.some((x) => x.reason === "INSUFFICIENT_INPUT")).toBe(
    true,
  );
  for (const section of payload.sections)
    for (const block of section.content_blocks) {
      expect(block.type).toBe("placeholder");
      if (block.type === "placeholder")
        expect(payload.gaps.some((g) => g.id === block.gap_id)).toBe(true);
    }
  expect(await counts()).toEqual(before);
  expect(await row("select count(*)::int n from public.documents")).toEqual({
    n: 0,
  });
  expect(await context(s.id)).toEqual(s);
});

it.each([
  "EMPTY_FILE",
  "INVALID_FILE",
  "UNSUPPORTED_FORMAT",
  "EXTRACTION_LIMIT",
  "EXTRACTION_FAILED",
])(
  "keeps usable scope when a supplied file reports %s",
  async (intake_failure) => {
    const o = await opportunity(),
      s = await prepare(o, { intake_failure });
    const payload = deliveryPayloadSchema.parse(s.payload);
    expect(payload).toMatchObject({
      input_state: "partial",
      content_state: "source_draft",
      substantive_complete: false,
    });
    expect(
      payload.sections.some(
        (x) =>
          x.kind === "source_extract" &&
          JSON.stringify(x.content_blocks).includes(o.description),
      ),
    ).toBe(true);
    expect(payload.gaps).toContainEqual(
      expect.objectContaining({ id: "intake-failure", reason: "UNREAD_INPUT" }),
    );
    expect(payload.gaps.every((x) => x.reason !== "INSUFFICIENT_INPUT")).toBe(
      true,
    );
  },
);

it("preserves exact source language and hashes while exposing unread sibling input", async () => {
  const o = await opportunity(""),
    d = await upload(o),
    unread = await upload(o, "", "needs_ocr"),
    s = await prepare(o);
  const payload = deliveryPayloadSchema.parse(s.payload);
  expect(payload).toMatchObject({
    content_state: "source_draft",
    input_state: "partial",
    substantive_complete: false,
  });
  expect(
    payload.sections.some((x) =>
      JSON.stringify(x.content_blocks).includes(
        "do not remove the approval condition",
      ),
    ),
  ).toBe(true);
  expect(payload.source_manifest).toContainEqual({
    entity_kind: "document",
    entity_id: d.id,
    content_hash: d.extraction_hash,
  });
  expect(payload.gaps).toContainEqual(
    expect.objectContaining({
      reason: "UNREAD_INPUT",
      source_ids: [unread.id],
    }),
  );
  expect(await counts()).toEqual({
    usage: 0,
    attempts: 0,
    jobs: 0,
    versions: 0,
  });
});

it("publishes before model work without making its own active generation base stale", async () => {
  const o = await opportunity(),
    p = await plan(o);
  const prop = await row("select * from public.proposals where id=$1", [
    p.proposal_id,
  ]);
  const s = await context(prop.active_delivery_snapshot_id);
  expect(s.plan_id).toBe(p.id);
  expect(p.frozen_context.delivery_projection_version).toBe(1);
  expect(s.base_version_id).toBeNull();
  expect(prop.active_version_id).toBeNull();
  expect(p.base_version_id).toBeNull();
  expect(prop.delivery_revision).toBe(1);
  expect((await counts()).usage).toBe(0);
  const job = await claimModelWorker4(f, f.rpc);
  expect(job.id).toBeTruthy();
  const current = await f.rpc("generation_context", [job.id, job.lease_token]);
  expect(current.plan.id).toBe(p.id);
  expect(current.plan.base_version_id).toBeNull();
});

it("replays idempotently and checks both current source authority and body identity", async () => {
  const o = await opportunity(),
    key = crypto.randomUUID(),
    s = await prepare(o, {}, key);
  expect(await prepare(o, {}, key)).toEqual(s);
  expect(await prepare(o)).toEqual(s);
  expect(
    await row("select count(*)::int n from public.proposal_delivery_snapshots"),
  ).toEqual({ n: 1 });
  expect(
    await row(
      "select count(*)::int n from public.audit_events where action='delivery.snapshot.created'",
    ),
  ).toEqual({ n: 1 });
  await expect(
    prepare(o, { intake_failure: "EMPTY_FILE" }, key),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await f.db.query(
    "update public.opportunities set description='Synthetic changed scope' where id=$1",
    [o.id],
  );
  await expect(prepare(o, {}, key)).rejects.toThrow("STALE_INPUT");
  await expect(context(s.id)).rejects.toThrow("STALE_INPUT");
});

it("rejects stale refresh revisions without overwriting immutable history or human version selection", async () => {
  const o = await opportunity(),
    s = await prepare(o),
    prop = await row("select * from public.proposals where id=$1", [
      s.proposal_id,
    ]);
  await f.db.query(
    "update public.proposals set revision=revision+1 where id=$1",
    [prop.id],
  );
  await expect(
    f.command("delivery.snapshot.refresh", {
      proposal_id: prop.id,
      expected_revision: prop.revision,
      expected_delivery_revision: prop.delivery_revision,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await expect(
    f.command("delivery.snapshot.refresh", {
      proposal_id: prop.id,
      expected_revision: prop.revision + 1,
      expected_delivery_revision: 0,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await expect(
    attempt(() =>
      f.db.query(
        "update public.proposal_delivery_snapshots set payload=payload where id=$1",
        [s.id],
      ),
    ),
  ).rejects.toThrow("DELIVERY_SNAPSHOT_IMMUTABLE");
  expect((await context(s.id)).content_hash).toBe(s.content_hash);
  expect(
    await row(
      "select active_version_id,delivery_revision from public.proposals where id=$1",
      [prop.id],
    ),
  ).toEqual({ active_version_id: null, delivery_revision: 1 });
});

it.each(["archive", "hash", "membership", "allowlist"])(
  "denies current content access after %s revocation",
  async (kind) => {
    const o = await opportunity(),
      d = await upload(o),
      s = await prepare(o);
    if (kind === "archive")
      await f.db.query(
        "update public.documents set archived=true where id=$1",
        [d.id],
      );
    if (kind === "hash")
      await f.db.query(
        "update public.documents set extraction_hash=repeat('f',64) where id=$1",
        [d.id],
      );
    if (kind === "membership")
      await f.db.query(
        "update public.memberships set active=false where user_id=$1",
        [f.owner],
      );
    if (kind === "allowlist")
      await f.db.query(
        "update public.identity_allowlist set status='inactive' where user_id=$1",
        [f.owner],
      );
    await expect(context(s.id)).rejects.toThrow(
      /ROLE_FORBIDDEN|DELIVERY_SOURCE_UNAVAILABLE|STALE_INPUT/,
    );
    await expect(
      attempt(() => f.rpc("delivery_context_for_actor", [s.id, f.owner])),
    ).rejects.toThrow(/ROLE_FORBIDDEN|DELIVERY_SOURCE_UNAVAILABLE|STALE_INPUT/);
  },
);

it("allows metadata but prevents direct payload and actor-impersonation RPC reads", async () => {
  const o = await opportunity(),
    s = await prepare(o);
  const metadata = await attempt(async () => {
    await f.db.exec("set role authenticated");
    return f.db.query(
      "select * from public.proposal_delivery_records where id=$1",
      [s.id],
    );
  });
  expect(metadata.rows).toHaveLength(1);
  expect(metadata.rows[0]).not.toHaveProperty("payload");
  await expect(
    attempt(async () => {
      await f.db.exec("set role authenticated");
      return f.db.query(
        "select payload from public.proposal_delivery_snapshots where id=$1",
        [s.id],
      );
    }),
  ).rejects.toThrow("permission denied");
  await expect(
    attempt(async () => {
      await f.db.exec("set role authenticated");
      return f.rpc("delivery_context_for_actor", [s.id, f.owner]);
    }),
  ).rejects.toThrow("permission denied");
  const worker = await attempt(async () => {
    await f.db.exec("set role service_role");
    return f.rpc("delivery_context_for_actor", [s.id, f.owner]);
  });
  expect(worker.id).toBe(s.id);
});

async function section(p: any, accepted: boolean, ordinal: number) {
  const job = await row(
    "select app_private.enqueue_generation(p,'draft_section',$2::jsonb) id from public.generation_plans p where id=$1",
    [
      p.id,
      JSON.stringify({
        section: {
          key: `part-${ordinal}`,
          title: `Synthetic section ${ordinal}`,
          volume: "technical",
        },
      }),
    ],
  );
  const step = await row(
    "select * from public.generation_steps where job_id=$1",
    [job.id],
  );
  const output = {
    key: `part-${ordinal}`,
    title: `Synthetic section ${ordinal}`,
    content_blocks: [
      {
        type: "paragraph",
        text: `Synthetic accepted prose ${ordinal}; do not remove this condition.`,
      },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  await f.db.query(
    "update public.jobs set checkpoint='{" +
      '"model_executor":2' +
      "}' where id=$1",
    [job.id],
  );
  const thread = crypto.randomUUID().replaceAll("-", "").padEnd(64, "b");
  await f.db.query(
    "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values($1,$2,$3,$4,'draft_section',$5)",
    [thread, f.w, job.id, p.input_hash, accepted ? "accepted" : "needs_review"],
  );
  const result = await row(
    "insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values($1,'accepted',$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex')) returning *",
    [thread, JSON.stringify(output)],
  );
  await f.db.query(
    "update app_private.model_graph_threads set result_id=$1 where id=$2",
    [result.id, thread],
  );
  await f.db.query(
    "insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values($1,'semantic-instructions-v1','{\"policy\":\"original synthetic verifier\"}',repeat('c',64))",
    [thread],
  );
  await f.db.query(
    "insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,sent,execution_metadata) values($1,$2,gen_random_uuid(),'openai','synthetic-pinned-model','draft_section',1,1,'succeeded',true,$3::jsonb)",
    [
      f.w,
      job.id,
      JSON.stringify({
        schema_hash: "d".repeat(64),
        prompt_hash: "e".repeat(64),
        input_hash: p.input_hash,
        contract_version: 1,
      }),
    ],
  );
  await f.db.query(
    "update public.generation_steps set status='completed',output=$1::jsonb where id=$2",
    [JSON.stringify(output), step.id],
  );
  return { step, thread, result, output };
}

it("preserves accepted siblings and original pins while excluding modern unaccepted units and new assurance claims", async () => {
  const o = await opportunity(),
    p = await plan(o);
  const initial = await row(
    "select * from public.proposal_delivery_snapshots where plan_id=$1",
    [p.id],
  );
  const first = await section(p, true, 1);
  await section(p, false, 2);
  const second = await section(p, true, 3);
  const prop = await row("select * from public.proposals where id=$1", [
    p.proposal_id,
  ]);
  const s = await context(prop.active_delivery_snapshot_id),
    payload = deliveryPayloadSchema.parse(s.payload);
  const units = payload.sections.filter((x) => x.kind === "accepted_unit");
  expect(units).toHaveLength(2);
  expect(units.map((x) => x.content_blocks)).toEqual([
    first.output.content_blocks,
    second.output.content_blocks,
  ]);
  expect(units[0].provenance).toMatchObject({
    assurance: "legacy_reviewed",
    step_id: first.step.id,
    graph_thread: first.thread,
    accepted_result_id: first.result.id,
    plan_input_hash: p.input_hash,
    pinned_instructions: [
      expect.objectContaining({
        key: "semantic-instructions-v1",
        value: { policy: "original synthetic verifier" },
      }),
    ],
    producer_attempts: [
      expect.objectContaining({
        model: "synthetic-pinned-model",
        execution_metadata: {
          schema_hash: "d".repeat(64),
          prompt_hash: "e".repeat(64),
          input_hash: p.input_hash,
          contract_version: 1,
        },
      }),
    ],
  });
  expect(payload).toMatchObject({
    content_state: "partial_draft",
    assurance_state: "legacy_reviewed",
    substantive_complete: false,
    approval_state: "draft",
  });
  expect(payload.gaps).toContainEqual(
    expect.objectContaining({
      reason: "LEGACY_ASSURANCE_REVIEW_REQUIRED",
      required_for: "final_approval",
    }),
  );
  expect((await context(initial.id)).payload).toEqual(initial.payload);
  expect(prop.active_version_id).toBeNull();
  expect(prop.delivery_revision).toBe(3);
  expect(await prepare(o)).toEqual(s);
  expect(
    await row(
      "select count(*)::int n from public.proposal_delivery_snapshots where proposal_id=$1",
      [prop.id],
    ),
  ).toEqual({ n: 3 });
});

it("includes immutable delivery metadata in backup/purge and defers circular restore references", async () => {
  const o = await opportunity(),
    s = await prepare(o);
  expect(
    (await row("select app_private.backup_tables() names")).names,
  ).toContain("proposal_delivery_snapshots");
  const scope = (
    await row("select app_private.purge_scope($1,$2) value", [f.w, o.id])
  ).value;
  expect(scope.proposal_delivery_snapshots.ids).toEqual([s.id]);
  expect(scope.proposal_delivery_snapshots.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await row(
        "select bool_and(condeferrable) okay from pg_constraint where conrelid='public.proposal_delivery_snapshots'::regclass and contype='f'",
      )
    ).okay,
  ).toBe(true);
  expect(
    (
      await row(
        "select condeferrable okay from pg_constraint where conname='active_delivery_belongs_to_proposal'",
      )
    ).okay,
  ).toBe(true);
});

it("keeps the existing implementation-plan command and strictly validates the new snapshot input", () => {
  expect(
    commandSchemas["delivery.prepare"].safeParse({
      proposal_version_id: crypto.randomUUID(),
      expected_revision: 1,
      input: {},
    }).success,
  ).toBe(false);
  expect(
    commandSchemas["delivery.snapshot.prepare"].safeParse({
      opportunity_id: crypto.randomUUID(),
      expected_revision: 1,
    }).success,
  ).toBe(true);
  expect(
    commandSchemas["delivery.snapshot.prepare"].safeParse({
      opportunity_id: crypto.randomUUID(),
      expected_revision: 1,
      intake_failure: "MODEL_DOWN",
    }).success,
  ).toBe(false);
});

it("removes snapshot payload and pointer through the existing confirmed opportunity purge", async () => {
  const o = await opportunity(),
    s = await prepare(o);
  await f.rpc("archive_opportunity", [
    o.id,
    o.revision,
    true,
    "Synthetic archive for purge test",
  ]);
  const preview = await f.rpc("preview_opportunity_purge", [o.id]);
  expect(preview.counts.proposal_delivery_snapshots).toBe(1);
  await f.rpc("purge_opportunity", [
    o.id,
    preview.preview_hash,
    o.title,
    "Synthetic confirmed purge for test",
    true,
  ]);
  expect(
    await row(
      "select count(*)::int n from public.proposal_delivery_snapshots where id=$1",
      [s.id],
    ),
  ).toEqual({ n: 0 });
  expect(
    await row("select count(*)::int n from public.proposals where id=$1", [
      s.proposal_id,
    ]),
  ).toEqual({ n: 0 });
});

it("checks archived unread attachment metadata even without an extraction hash", async () => {
  const o = await opportunity(),
    unread = await upload(o, "", "needs_ocr"),
    s = await prepare(o);
  expect(
    s.source_manifest.some((ref: any) => ref.entity_id === unread.id),
  ).toBe(false);
  await f.db.query("update public.documents set archived=true where id=$1", [
    unread.id,
  ]);
  await expect(context(s.id)).rejects.toThrow("DELIVERY_SOURCE_UNAVAILABLE");
});

it("retains immutable accepted-unit provenance after generation metadata deletion", async () => {
  const o = await opportunity(),
    p = await plan(o),
    accepted = await section(p, true, 1);
  const s = await row(
    "select * from public.proposal_delivery_snapshots where plan_id=$1 order by ordinal desc limit 1",
    [p.id],
  );
  await f.db.query("delete from public.generation_steps where plan_id=$1", [
    p.id,
  ]);
  await f.db.query("delete from public.generation_plans where id=$1", [p.id]);
  const restored = await context(s.id);
  expect(
    await row("select * from public.proposal_delivery_snapshots where id=$1", [
      s.id,
    ]),
  ).toEqual(s);
  expect(restored.plan_id).toBe(p.id);
  expect(
    restored.payload.sections.find((x: any) => x.kind === "accepted_unit")
      .provenance,
  ).toMatchObject({
    original_unit: accepted.output,
    graph_thread: accepted.thread,
    step_id: accepted.step.id,
  });
  expect(
    await row(
      "select active_delivery_snapshot_id from public.proposals where id=$1",
      [p.proposal_id],
    ),
  ).toEqual({ active_delivery_snapshot_id: s.id });
});

it.each(["canceled", "failed", "completed"])(
  "does not publish or move the delivery pointer for an inserted %s historical plan",
  async (status) => {
    const o = await opportunity(),
      p = await plan(o);
    const before = await row(
      "select active_delivery_snapshot_id,delivery_revision from public.proposals where id=$1",
      [p.proposal_id],
    );
    await f.db.query(
      "insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,created_at) select workspace_id,opportunity_id,proposal_id,kind,stage,$2,evidence_revision,input_hash,frozen_context,created_by,now()+interval '1 second' from public.generation_plans where id=$1",
      [p.id, status],
    );
    expect(
      await row(
        "select active_delivery_snapshot_id,delivery_revision from public.proposals where id=$1",
        [p.proposal_id],
      ),
    ).toEqual(before);
    expect(
      await row(
        "select count(*)::int n from public.proposal_delivery_snapshots where proposal_id=$1",
        [p.proposal_id],
      ),
    ).toEqual({ n: 1 });
  },
);

it("preserves an old frozen projection pin absence and leaves unversioned historical active inserts untouched", async () => {
  const o = await opportunity(),
    p = await plan(o);
  const current = await row(
    "select app_private.draft_generation_snapshot(workspace_id,opportunity_id,proposal_id,package_id,frozen_context-'delivery_projection_version') value from public.generation_plans where id=$1",
    [p.id],
  );
  expect(current.value).not.toHaveProperty("delivery_projection_version");
  await f.db.query(
    "update public.generation_plans set status='canceled' where id=$1",
    [p.id],
  );
  const historical = await row(
    "insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) select workspace_id,opportunity_id,proposal_id,kind,stage,'queued',evidence_revision,input_hash,'{}',created_by from public.generation_plans where id=$1 returning id",
    [p.id],
  );
  expect(
    await row(
      "select count(*)::int n from public.proposal_delivery_snapshots where plan_id=$1",
      [historical.id],
    ),
  ).toEqual({ n: 0 });
  expect(
    await row(
      "select count(*)::int n from public.proposal_delivery_snapshots where plan_id=$1",
      [p.id],
    ),
  ).toEqual({ n: 1 });
});

it("still rejects a newly pinned projection with stale source hashes", async () => {
  const o = await opportunity(),
    p = await plan(o);
  await f.db.query(
    "update public.generation_plans set status='canceled' where id=$1",
    [p.id],
  );
  await expect(
    attempt(() =>
      f.db.query(
        "insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) select workspace_id,opportunity_id,proposal_id,kind,stage,'queued',evidence_revision,input_hash,jsonb_set(frozen_context,'{blocks,0,reference,content_hash}',to_jsonb(repeat('f',64))),created_by from public.generation_plans where id=$1",
        [p.id],
      ),
    ),
  ).rejects.toThrow("STALE_INPUT");
});

it("retains accepted sibling provenance and preserves the human-selected draft when background units finish", async () => {
  const o = await opportunity(),
    p = await plan(o);
  const accepted = await section(p, true, 1);
  const before = await row("select * from public.proposals where id=$1", [
    p.proposal_id,
  ]);
  const original = await context(before.active_delivery_snapshot_id);
  const opened = await f.rpc("proposal_authoring_command", [
    f.owner,
    "open",
    JSON.stringify({
      snapshot_id: original.id,
      expected_delivery_revision: before.delivery_revision,
    }),
    crypto.randomUUID(),
  ]);
  expect(
    opened.revision.body.sections.some((s: any) =>
      JSON.stringify(s.content_blocks).includes("Synthetic accepted prose 1"),
    ),
  ).toBe(true);
  expect(opened.revision.body.requirements).toEqual([]);
  const { buildAuthoredPayload } =
    await import("../../supabase/functions/_shared/proposalAuthoring");
  const payload = buildAuthoredPayload(opened);
  const saved = await f.rpc("publish_authored_delivery", [
    f.owner,
    opened.session.id,
    opened.session.revision,
    opened.context_hash,
    JSON.stringify(payload),
    null,
    crypto.randomUUID(),
  ]);
  expect(saved.payload).toMatchObject({
    substantive_complete: false,
    assurance_state: "unreviewed",
  });
  await section(p, true, 2);
  const after = await row("select * from public.proposals where id=$1", [
    p.proposal_id,
  ]);
  expect(after.active_delivery_snapshot_id).toBe(saved.id);
  expect(after.active_version_id).toBe(before.active_version_id);
  const progress = await row(
    "select * from public.proposal_delivery_snapshots where proposal_id=$1 and plan_id=$2 order by ordinal desc limit 1",
    [p.proposal_id, p.id],
  );
  expect(
    progress.payload.sections.filter((s: any) => s.kind === "accepted_unit"),
  ).toHaveLength(2);
  const retained = await context(original.id);
  expect(
    retained.payload.sections.find((s: any) => s.kind === "accepted_unit")
      .provenance.original_unit,
  ).toEqual(accepted.output);
  expect(
    await f.rpc("proposal_authoring_context", [opened.session.id, f.owner]),
  ).toMatchObject({ revision: { id: opened.revision.id } });
});
