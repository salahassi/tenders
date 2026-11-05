// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { Backend } from "../../supabase/functions/_shared/backend";
import {
  buildDeliveryExport,
  DOCX_MIME,
} from "../../supabase/functions/_shared/deliveryExport";
import {
  deliveryBytes,
  processDeliveryExport,
} from "../../supabase/functions/_shared/deliveryWorker";
import {
  type RenderModel,
  verifyExportDocx,
} from "../../supabase/functions/_shared/export";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";
import {
  deliveryPipelineFixture,
  type DeliveryPipelineFixture,
} from "./deliveryPipelineFixture";

// Migrated SQL, real commands/leases, worker, renderer, DOCX validation and API
// handlers run together. Auth-token validation and object transport are local
// test adapters; this does not establish hosted Auth/Storage or visual acceptance.
let f: DeliveryPipelineFixture["f"];
let fonts: DeliveryPipelineFixture["fonts"];
let rpc: DeliveryPipelineFixture["rpc"];
let sql: DeliveryPipelineFixture["sql"];
let transport: DeliveryPipelineFixture["transport"];
beforeAll(async () => {
  ({ f, fonts, rpc, sql, transport } = await deliveryPipelineFixture());
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function twoVolumeOpportunity() {
  await f.db.query(
    "insert into public.templates(workspace_id,title,language,volume_mode,required_sections,fixed_blocks,content_hash,approved,approved_by,approved_at,created_by) values($1,'Synthetic two-volume template','en','separate',$2::jsonb,'[]',repeat('a',64),true,$3,now(),$3)",
    [
      f.w,
      JSON.stringify([
        {
          key: "approach",
          title: "Proposed approach",
          purpose: "Explain implementation",
          volume: "technical",
          applicable: true,
          rationale: "",
        },
        {
          key: "commercial",
          title: "Commercial response",
          purpose: "Confirm commercial inputs",
          volume: "financial",
          applicable: true,
          rationale: "",
        },
      ]),
      f.owner,
    ],
  );
  const source = await f.command("source.create", {
    name: "Synthetic delivery pipeline",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic operating manual proposal",
    reference: "SYNTHETIC-PIPELINE",
    description:
      "Deliver an operating manual with two approval stages within thirty days.",
    language: "en",
    decision: "shortlisted",
  });
}

it("binds prepare, SQL claims, real two-volume rendering, retry and current-authority downloads without overwriting retained bytes", async () => {
  const t = transport();
  const opportunity = await twoVolumeOpportunity();
  const prepared = await t.request("commands", {
    commands: [
      {
        operation: "delivery.snapshot.prepare",
        input: {
          opportunity_id: opportunity.id,
          expected_revision: opportunity.revision,
        },
      },
    ],
  });
  expect(prepared.status).toBe(200);
  const snapshot = (await prepared.json()).data[0];
  expect(snapshot.payload).toMatchObject({
    separate_volumes: true,
    input_state: "available",
    content_state: "source_draft",
    substantive_complete: false,
    approval_state: "draft",
  });
  const firstJob = await rpc("claim_backend_job_v5");
  expect(firstJob).toMatchObject({
    type: "render_delivery",
    entity_id: snapshot.id,
    status: "running",
  });
  const firstContext = await rpc("delivery_export_context", {
    job_id: firstJob.id,
    lease: firstJob.lease_token,
  });
  expect(firstContext.artifacts.map((item: any) => item.volume)).toEqual([
    "financial",
    "technical",
  ]);
  const [firstArtifact, secondArtifact] = firstContext.artifacts;
  let rejectSecond = true;
  const render = vi.fn(async (model: RenderModel) => {
    if (model.volume === secondArtifact.volume && rejectSecond) {
      rejectSecond = false;
      throw Error("Synthetic second-volume renderer interruption.");
    }
    return new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
  });
  await expect(
    processDeliveryExport(t.backend as unknown as Backend, firstJob, render),
  ).resolves.toEqual({ error_code: "DELIVERY_RENDER_FAILED" });
  const partial = (
    await (await t.request(`delivery-snapshots/${snapshot.id}/package`)).json()
  ).data;
  expect(partial.status).toBe("preparing");
  expect(partial.job).toMatchObject({
    id: firstJob.id,
    status: "retry_wait",
    error_code: "DELIVERY_RENDER_FAILED",
  });
  expect(partial.artifacts.map((item: any) => item.status)).toEqual([
    "ready",
    "pending",
  ]);
  expect(t.objects.size).toBe(1);
  const firstBlob = t.objects.get(firstArtifact.storage_key)!;
  const retained = await deliveryBytes(
    firstBlob,
    buildDeliveryExport(snapshot, firstArtifact.volume),
  );
  expect(partial.artifacts[0]).toMatchObject({
    id: firstArtifact.id,
    content_hash: retained.hash,
    expected_size: retained.size,
  });

  // Even the verified first file cannot be downloaded as a complete package.
  const readsBeforeIncompleteDownload =
    t.backend.deliveryObject.mock.calls.length;
  const incompleteDownload = await t.request(
    `delivery-artifacts/${firstArtifact.id}/download`,
  );
  expect(incompleteDownload.status).toBe(422);
  expect((await incompleteDownload.json()).error.code).toBe(
    "DELIVERY_EXPORT_INCOMPLETE",
  );
  expect(t.backend.deliveryObject).toHaveBeenCalledTimes(
    readsBeforeIncompleteDownload,
  );

  // Advance only the fixture's due time; retry still uses the canonical SQL
  // claim and a fresh lease, preserving the same logical job and object keys.
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [firstJob.id],
  );
  const retryJob = await rpc("claim_backend_job_v5");
  expect(retryJob).toMatchObject({
    id: firstJob.id,
    entity_id: snapshot.id,
    status: "running",
  });
  expect(retryJob.lease_token).not.toBe(firstJob.lease_token);
  const completed = await processDeliveryExport(
    t.backend as unknown as Backend,
    retryJob,
    render,
  );
  expect(completed).toMatchObject({
    id: firstJob.id,
    status: "succeeded",
    lease_token: null,
    lease_until: null,
  });
  expect(render.mock.calls.map(([model]) => model.volume)).toEqual([
    "financial",
    "technical",
    "technical",
  ]);
  expect(t.backend.storeDeliveryObject.mock.calls.map(([key]) => key)).toEqual([
    firstArtifact.storage_key,
    secondArtifact.storage_key,
  ]);
  expect(t.objects.get(firstArtifact.storage_key)).toBe(firstBlob);
  const packageResponse = await t.request(
    `delivery-snapshots/${snapshot.id}/package`,
  );
  expect(packageResponse.status).toBe(200);
  const complete = (await packageResponse.json()).data;
  expect(complete.status).toBe("ready");
  expect(complete.artifacts).toHaveLength(2);
  expect(complete.artifacts.every((item: any) => item.status === "ready")).toBe(
    true,
  );
  expect(complete.artifacts[0]).toMatchObject({
    id: firstArtifact.id,
    content_hash: retained.hash,
    expected_size: retained.size,
  });
  expect(JSON.stringify(complete)).not.toMatch(
    /storage_key|source_manifest|content_blocks/,
  );
  for (const artifact of complete.artifacts) {
    const response = await t.request(
      `delivery-artifacts/${artifact.id}/download`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(DOCX_MIME);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const model = buildDeliveryExport(snapshot, artifact.volume);
    expect(verifyExportDocx(bytes, model)).toBe(true);
    expect(await deliveryBytes(bytes, model)).toMatchObject({
      hash: artifact.content_hash,
      size: artifact.expected_size,
    });
  }

  // Auth and first SQL authorization succeed, then membership changes while
  // object transport is in flight. The second real SQL check must deny bytes.
  t.state.revokeOnRead = true;
  const beforeRevocationCalls = t.backend.internal.mock.calls.length;
  const revoked = await t.request(
    `delivery-artifacts/${firstArtifact.id}/download`,
  );
  expect(revoked.status).toBe(403);
  expect(revoked.headers.get("content-type")).toContain("application/json");
  expect(revoked.headers.has("content-disposition")).toBe(false);
  expect((await revoked.json()).error.code).toBe("ROLE_FORBIDDEN");
  expect(t.backend.internal.mock.calls.slice(beforeRevocationCalls)).toEqual([
    [
      "delivery_artifact_context",
      { artifact_id: firstArtifact.id, actor_id: f.owner },
    ],
    [
      "authorize_delivery_artifact_download",
      {
        artifact_id: firstArtifact.id,
        actor_id: f.owner,
        actual_hash: retained.hash,
      },
    ],
  ]);
  expect(t.objects.get(firstArtifact.storage_key)).toBe(firstBlob);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.generation_plans",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select active_version_id,state from public.proposals where id=$1",
        [snapshot.proposal_id],
      )
    ).rows[0],
  ).toEqual({ active_version_id: null, state: "draft" });
}, 30000);

async function authoredFixture(t: ReturnType<typeof transport>) {
  const source = await f.command("source.create", {
    name: "Synthetic human authoring",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic operating manual",
    reference: "SYNTHETIC-AUTHORING",
    description:
      "Provide an operating manual validated by a witnessed walkthrough.",
    language: "en",
    decision: "shortlisted",
  });
  let sources = await f.rpc("source_review_context", [opportunity.id]);
  const initial = sources.source_evidence.spans[0];
  await f.command("source.authority.review", {
    opportunity_id: opportunity.id,
    entity_kind: "notice",
    entity_id: opportunity.id,
    content_hash: initial.content_hash,
    expected_revision: 0,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic fixture is explicitly issued by the buyer.",
  });
  sources = await f.rpc("source_review_context", [opportunity.id]);
  const reviewed = await f.command("source.obligation.review", {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [sources.source_evidence.spans[0]],
    semantics: {
      modality: "required",
      actor: "Supplier",
      negated: false,
      conditions: [],
      exceptions: [],
      consequences: [],
      quantities: [],
      dates: [],
    },
    status: "confirmed",
    reason: "Supplier must deliver the manual and demonstrate it.",
  });
  const requirements = (
    await f.db.query<{ data: any }>(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[]) data",
      [f.w, opportunity.id, [reviewed.review_id]],
    )
  ).rows[0].data;
  const prepared = await f.command("delivery.snapshot.prepare", {
    opportunity_id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const proposal = (
    await f.db.query<{ delivery_revision: number }>(
      "select delivery_revision from public.proposals where id=$1",
      [prepared.proposal_id],
    )
  ).rows[0];
  const opened = await t.request("proposal-authoring/open", {
    snapshot_id: prepared.id,
    expected_delivery_revision: proposal.delivery_revision,
  });
  expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(200);
  const context = (await opened.json()).data;
  const response =
    "We will map each operational step through a facilitated process walkthrough and record the responsible role and exception path. We will deliver a versioned operating manual containing process maps, escalation instructions, and a change register. Acceptance will use a witnessed walkthrough of the manual against the agreed process map, recording each discrepancy and its resolution in an acceptance log.";
  const body = {
    ...context.revision.body,
    requirements,
    sections: [
      {
        key: "operating-manual",
        title: "Operating manual delivery",
        volume: "technical",
        content_blocks: [{ type: "paragraph", text: response }],
        requirement_ids: [requirements[0].id],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      },
    ],
    fulfillment: [
      {
        requirement_id: requirements[0].id,
        response_section_key: "operating-manual",
        response_excerpt: response,
        method: "facilitated process walkthrough",
        deliverable: "versioned operating manual",
        acceptance_evidence:
          "recording each discrepancy and its resolution in an acceptance log",
        conditions_preserved: [],
        exceptions_preserved: [],
        consequences_preserved: [],
        facts: [],
      },
    ],
  };
  return { opportunity, prepared, context, body, reviewed, response };
}
function reviewInput(context: any, body: any) {
  return {
    expected_revision: context.session.revision,
    reason:
      "I reviewed implementation, deliverable and acceptance demonstration against the current buyer obligation.",
    inventory_review: {
      source_ids: [
        ...new Set(context.source_manifest.map((s: any) => s.entity_id)),
      ],
      coverage_statement:
        "Complete synthetic notice reviewed; the manual obligation is bound to its exact passage and current authority.",
    },
    responses: body.fulfillment.map((item: any) => ({
      requirement_id: item.requirement_id,
      response_excerpt: item.response_excerpt,
      rationale:
        "Response defines an actual walkthrough method, versioned deliverable and discrepancy-based acceptance demonstration.",
    })),
  };
}

it("completes supplied substantive responses with all models unavailable through real API, persistence, renderer2 and download; never auto-approves", async () => {
  const t = transport(),
    a = await authoredFixture(t);
  const saved = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    { expected_revision: a.context.session.revision, body: a.body },
  );
  expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
  const context = (await saved.json()).data;
  expect(context.published_snapshot.payload).toMatchObject({
    version: 2,
    substantive_complete: false,
    content_state: "authored_draft",
    approval_state: "draft",
  });
  const reviewed = await t.request(
    `proposal-authoring/${context.session.id}/review`,
    reviewInput(context, a.body),
  );
  expect(reviewed.status, JSON.stringify(await reviewed.clone().json())).toBe(
    200,
  );
  const result = (await reviewed.json()).data;
  expect(result.report.substantive_complete).toBe(true);
  expect(result.snapshot.payload).toMatchObject({
    version: 2,
    content_state: "substantive_draft",
    assurance_state: "human_reviewed",
    approval_state: "draft",
    substantive_complete: true,
  });
  expect(await f.rpc("claim_backend_job_v3")).toBeNull();
  const job = await f.rpc("claim_backend_job_v5");
  expect(job.checkpoint).toMatchObject({
    model_executor: 4,
    delivery_renderer_version: "2",
  });
  await processDeliveryExport(
    t.backend as unknown as Backend,
    job,
    async (model) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
  );
  const packaged = await t.request(
    `delivery-snapshots/${result.snapshot.id}/package`,
  );
  expect(packaged.status).toBe(200);
  const pack = (await packaged.json()).data;
  expect(pack.status).toBe("ready");
  expect(pack.snapshot.substantive_complete).toBe(true);
  const download = await t.request(
    `delivery-artifacts/${pack.artifacts[0].id}/download`,
  );
  expect(download.status).toBe(200);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const model = buildDeliveryExport(result.snapshot, "combined");
  await verifyExportDocx(bytes, model);
  expect(
    model.blocks.some((b: any) =>
      b.text?.includes("facilitated process walkthrough"),
    ),
  ).toBe(true);
  expect(
    model.blocks.some((b: any) =>
      b.text?.includes("substantive responses reviewed"),
    ),
  ).toBe(true);
  expect(
    model.blocks.some(
      (b: any) =>
        b.type === "placeholder" && b.text?.includes("Final approval"),
    ),
  ).toBe(true);
  expect(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int n from public.provider_usage where workspace_id=$1",
        [f.w],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int n from public.approvals where workspace_id=$1 and invalidated_at is null",
        [f.w],
      )
    ).rows[0].n,
  ).toBe(0);
  const proposal = (
    await f.db.query<any>("select revision from public.proposals where id=$1", [
      a.prepared.proposal_id,
    ])
  ).rows[0];
  const adopted = await t.request(
    `proposal-authoring/${context.session.id}/adopt`,
    {
      expected_revision: context.session.revision,
      expected_proposal_revision: proposal.revision,
      review_id: result.snapshot.payload.authoring.review_id,
    },
  );
  expect(adopted.status, JSON.stringify(await adopted.clone().json())).toBe(
    200,
  );
  const version = (await adopted.json()).data;
  expect(version.approval_state).toBe("draft");
  const persisted = (
    await f.db.query<any>(
      "select v.*,g.execution_policy from public.proposal_versions v join public.generation_plans g on g.id=v.plan_id where v.id=$1",
      [version.proposal_version_id],
    )
  ).rows[0];
  expect(persisted.status).toBe("draft");
  expect(persisted.consistency_report).toBeNull();
  expect(persisted.execution_policy.mode).toBe(
    "authorized_structured_authoring",
  );
  await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [
    f.owner,
  ]);
  const readiness = await f.rpc("proposal_readiness", [
    version.proposal_version_id,
  ]);
  expect(
    readiness.blockers.some((b: string) =>
      b.includes("AUTHORING_RESPONSE_RECONCILIATION_REQUIRED"),
    ),
  ).toBe(false);
  expect(readiness.blockers.length).toBeGreaterThan(0);
  const old = await t.request(`delivery-snapshots/${a.prepared.id}/context`);
  expect(old.status).toBe(200);
  expect((await old.json()).data.payload.version).toBe(1);
}, 30000);

it("retains incomplete draft, rejects client pass flags, and never labels source restatement as substantive", async () => {
  const t = transport(),
    a = await authoredFixture(t);
  const forged = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    { expected_revision: 1, body: { ...a.body, substantive_complete: true } },
  );
  expect(forged.status).toBe(400);
  const source = a.body.requirements[0].text;
  a.body.sections[0].content_blocks = [{ type: "paragraph", text: source }];
  a.body.fulfillment[0] = {
    ...a.body.fulfillment[0],
    response_excerpt: source,
    method: source,
    deliverable: source,
    acceptance_evidence: source,
  };
  const saved = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    { expected_revision: 1, body: a.body },
  );
  expect(saved.status).toBe(200);
  const context = (await saved.json()).data;
  const reviewed = await t.request(
    `proposal-authoring/${context.session.id}/review`,
    reviewInput(context, a.body),
  );
  expect(reviewed.status).toBe(200);
  const result = (await reviewed.json()).data;
  expect(result.report.substantive_complete).toBe(false);
  expect(
    result.report.diagnostics.some(
      (d: any) => d.code === "SOURCE_RESTATEMENT_ONLY",
    ),
  ).toBe(true);
  expect(result.snapshot.payload.content_state).toBe("authored_draft");
});

it("binds replay, concurrent editor revision, current authority and sources at the service boundary", async () => {
  const t = transport(),
    a = await authoredFixture(t),
    key = crypto.randomUUID(),
    input = { expected_revision: 1, body: a.body };
  const first = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    input,
    key,
  );
  expect(first.status).toBe(200);
  const one = (await first.json()).data;
  const replay = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    input,
    key,
  );
  expect(replay.status, JSON.stringify(await replay.clone().json())).toBe(200);
  expect((await replay.json()).data.published_snapshot.id).toBe(
    one.published_snapshot.id,
  );
  const conflict = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    input,
  );
  expect(conflict.status).toBe(409);
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  const revoked = await t.request(
    `proposal-authoring/${a.context.session.id}/review`,
    reviewInput(one, a.body),
  );
  expect(revoked.status).toBe(403);
  expect(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int n from public.proposal_authoring_reviews where workspace_id=$1",
        [f.w],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("keeps authored text and original immutable revision when source edits require an explicit unreviewed successor", async () => {
  const t = transport(),
    a = await authoredFixture(t);
  const saved = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    { expected_revision: 1, body: a.body },
  );
  expect(saved.status).toBe(200);
  const previous = (await saved.json()).data;
  await f.db.query(
    "update public.opportunities set description=description||' Include an exception-handling appendix.',revision=revision+1 where id=$1",
    [a.opportunity.id],
  );
  const stale = await t.request(
    `proposal-authoring/${a.context.session.id}/context`,
  );
  expect(stale.status).toBe(409);
  const metadata = await t.request(
    `delivery-snapshots/${previous.published_snapshot.id}/authoring-status`,
  );
  expect(metadata.status).toBe(200);
  const status = (await metadata.json()).data;
  const refreshed = await t.request(
    `proposal-authoring/${a.context.session.id}/refresh`,
    {
      expected_revision: status.revision,
      expected_delivery_revision: status.delivery_revision,
    },
  );
  expect(refreshed.status, JSON.stringify(await refreshed.clone().json())).toBe(
    200,
  );
  const next = (await refreshed.json()).data;
  expect(next.session.predecessor_id).toBe(a.context.session.id);
  expect(next.revision.predecessor_revision_id).toBe(previous.revision.id);
  expect(next.revision.body.sections[0].content_blocks[0].text).toBe(
    a.response,
  );
  expect(next.revision.body.requirements).toEqual([]);
  expect(next.revision.body.fulfillment).toEqual([]);
  expect(next.published_snapshot.payload).toMatchObject({
    substantive_complete: false,
    assurance_state: "unreviewed",
  });
  expect(
    next.published_snapshot.payload.gaps.some(
      (g: any) => g.id === "changed-source-review",
    ),
  ).toBe(true);
  const retained = (
    await f.db.query<any>(
      "select body_hash,body from public.proposal_authoring_revisions where id=$1",
      [previous.revision.id],
    )
  ).rows[0];
  expect(retained.body_hash).toBe(previous.revision.body_hash);
  expect(retained.body.sections[0].content_blocks[0].text).toBe(a.response);
  const tables = (
    await f.db.query<{ tables: string[] }>(
      "select app_private.backup_tables() tables",
    )
  ).rows[0].tables;
  for (const name of [
    "proposal_authoring_sessions",
    "proposal_authoring_revisions",
    "proposal_authoring_reviews",
    "proposal_authoring_adoptions",
  ])
    expect(tables).toContain(name);
  const scope = (
    await f.db.query<any>("select app_private.purge_scope($1,$2) result", [
      f.w,
      a.opportunity.id,
    ])
  ).rows[0].result;
  expect(scope.proposal_authoring_sessions.ids).toContain(a.context.session.id);
  expect(scope.proposal_authoring_revisions.ids).toContain(
    previous.revision.id,
  );
});

it("cannot invoke trusted authoring publishers as authenticated SQL or reuse an unverified company claim", async () => {
  const t = transport(),
    a = await authoredFixture(t);
  await expect(
    sql(
      "authenticated",
      f.owner,
      "select public.proposal_authoring_context($1,$2)",
      [a.context.session.id, f.owner],
    ),
  ).rejects.toThrow();
  a.body.sections[0].company_claims = [
    {
      claim: "We hold a certified service capability.",
      source_id: crypto.randomUUID(),
      quote: "Certified service capability",
    },
  ];
  const invalid = await t.request(
    `proposal-authoring/${a.context.session.id}/save`,
    { expected_revision: 1, body: a.body },
  );
  expect(invalid.status).toBe(422);
  expect((await invalid.json()).error.code).toBe("AUTHORING_REUSE_UNVERIFIED");
  const delivered = (
    await f.db.query<any>(
      "select count(*)::int n from public.proposal_delivery_snapshots where workspace_id=$1 and payload->>'version'='2'",
      [f.w],
    )
  ).rows[0].n;
  expect(delivered).toBe(0);
});
