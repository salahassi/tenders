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

async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_failure");
  try {
    return await run();
  } catch (error) {
    await f.db.exec("rollback to savepoint expected_failure");
    throw error;
  } finally {
    await f.db.exec("release savepoint expected_failure");
  }
}

async function opportunity() {
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  return f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic workflow improvement",
    reference: "SYNTHETIC",
    description: "Propose an internal approval workflow and handover approach.",
    language: "en",
    decision: "shortlisted",
  });
}

async function upload(
  opportunityId: string,
  status = "ready",
  text = "Synthetic meeting notes about garden maintenance. This is a reference note, not a request for proposal.",
) {
  const hash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunityId,
    original_name: "synthetic-reference.txt",
    mime_type: "text/plain",
    size: 100,
    hash,
  });
  return f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    hash,
    100,
    text,
    status,
    crypto.randomUUID(),
  ]);
}

async function request(o: any) {
  return f.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
}

async function version(p: any, ordinal = 1) {
  const v = (
    await f.db.query<any>(
      "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by,plan_id,evidence_revision,package_hash) values($1,$2,$3,repeat('a',64),$4,$5,$6,$7) returning *",
      [
        f.w,
        p.proposal_id,
        ordinal,
        f.owner,
        p.id,
        p.evidence_revision,
        (
          await f.db.query<any>(
            "select package_hash from public.document_packages where id=$1",
            [p.package_id],
          )
        ).rows[0].package_hash,
      ],
    )
  ).rows[0];
  await f.db.query(
    "update public.proposals set active_version_id=$1 where id=$2",
    [v.id, p.proposal_id],
  );
  return v;
}

async function baseForRegeneration() {
  const o = await opportunity();
  await upload(o.id);
  const p = await request(o),
    v = await version(p);
  await f.db.query(
    "update public.generation_plans set status='completed' where id=$1",
    [p.id],
  );
  await f.db.query(
    "update public.jobs set status='canceled' where entity_id=$1",
    [p.id],
  );
  return { p, v };
}

async function regenerate(
  base: Awaited<ReturnType<typeof baseForRegeneration>>,
) {
  const p = (
    await f.db.query<any>("select * from public.proposals where id=$1", [
      base.p.proposal_id,
    ])
  ).rows[0];
  return f.command("proposal.regenerate", {
    id: p.id,
    expected_revision: p.revision,
    base_version_id: base.v.id,
    input_hash: base.p.input_hash,
  });
}

async function addReview(
  base: Awaited<ReturnType<typeof baseForRegeneration>>,
) {
  const p = (
    await f.db.query<any>("select * from public.proposals where id=$1", [
      base.p.proposal_id,
    ])
  ).rows[0];
  await f.command("review.save", {
    id: p.id,
    expected_revision: p.revision,
    base_version_id: base.v.id,
    source_signature: "Synthetic scoped feedback",
    inputs: [
      {
        client_id: crypto.randomUUID(),
        target_kind: "general",
        target_id: "general",
        body: "Explain the handover approach.",
      },
    ],
  });
  return (
    await f.db.query<any>(
      "select * from public.review_inputs where proposal_id=$1",
      [p.id],
    )
  ).rows[0];
}

it("starts a draft from an unconfirmed non-RFP document without fabricating extraction review", async () => {
  const o = await opportunity(),
    d = await upload(o.id),
    p = await request(o);
  expect(p.status).toBe("queued");
  expect(p.frozen_context.draft_input_version).toBe(1);
  expect(p.frozen_context.blocks[0].reference).toMatchObject({
    entity_kind: "document",
    entity_id: d.id,
    content_hash: d.extraction_hash,
  });
  expect(p.frozen_context.input_materials.documents).toEqual([
    expect.objectContaining({
      document_id: d.id,
      used_for_draft: true,
      status: "ready",
    }),
  ]);
  expect(
    (
      await f.db.query<any>(
        "select extraction_confirmed_at from public.documents where id=$1",
        [d.id],
      )
    ).rows[0].extraction_confirmed_at,
  ).toBeNull();
  expect(
    (
      await f.db.query(
        "select * from public.generation_steps where plan_id=$1 and task='analyze_chunk'",
        [p.id],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query("select * from public.requirements where plan_id=$1", [
        p.id,
      ])
    ).rows,
  ).toHaveLength(0);
});

it("skips an unread attachment while keeping the readable document and original package hashes", async () => {
  const o = await opportunity(),
    readable = await upload(o.id),
    unread = await upload(o.id, "needs_ocr", ""),
    p = await request(o);
  expect(
    p.frozen_context.blocks.every((b: any) => b.document_id === readable.id),
  ).toBe(true);
  expect(p.frozen_context.input_materials.documents).toContainEqual(
    expect.objectContaining({
      document_id: unread.id,
      status: "needs_ocr",
      used_for_draft: false,
      extracted_characters: 0,
    }),
  );
  const manifest = (
    await f.db.query<any>(
      "select manifest from public.document_packages where id=$1",
      [p.package_id],
    )
  ).rows[0].manifest;
  expect(manifest).toContainEqual(
    expect.objectContaining({
      id: unread.id,
      original_hash: unread.original_hash,
      extraction_hash: unread.extraction_hash,
    }),
  );
  await expect(
    attempt(() =>
      f.db.query("select app_private.seal_package($1,$2,$3)", [
        f.w,
        o.id,
        f.owner,
      ]),
    ),
  ).rejects.toThrow("EXTRACTION_REVIEW_REQUIRED");
});

it("uses the actual notice when attached file text is unavailable", async () => {
  const o = await opportunity();
  await upload(o.id, "needs_processing", "");
  const p = await request(o);
  expect(p.frozen_context.input_materials.uses_notice_fallback).toBe(true);
  expect(p.frozen_context.blocks).toEqual([p.frozen_context.notice]);
  expect(p.frozen_context.blocks[0].id).toBe(o.id);
  const job = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=(select job_id from public.generation_steps where plan_id=$1 order by ordinal limit 1) returning *",
      [p.id],
    )
  ).rows[0];
  await expect(
    f.db.query(
      "select app_private.check_requested_model_payload($1,'openai',$2::jsonb)",
      [job.id, JSON.stringify([p.frozen_context.notice.reference])],
    ),
  ).resolves.toBeDefined();
});

it("keeps a skipped extraction out of existing paid inputs when it later becomes readable", async () => {
  const o = await opportunity(),
    unread = await upload(o.id, "needs_ocr", ""),
    p = await request(o);
  const frozen = JSON.stringify(p.frozen_context);
  await f.db.query(
    "update public.documents set status='ready',extracted_text='Newly extracted synthetic reference',extraction_hash=repeat('b',64) where id=$1",
    [unread.id],
  );
  await f.db.query(
    "insert into public.document_blocks(workspace_id,document_id,ordinal,locator,text,text_hash,created_by) values($1,$2,1,'{}','Newly extracted synthetic reference',repeat('c',64),$3)",
    [f.w, unread.id, f.owner],
  );
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  await f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]);
  const after = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      p.id,
    ])
  ).rows[0];
  expect(JSON.stringify(after.frozen_context)).toBe(frozen);
  expect(after.input_hash).toBe(p.input_hash);
  expect(after.frozen_context.blocks).toEqual([p.frozen_context.notice]);
});

it("ignores new unused attachments but rejects changed text that the request actually consumed", async () => {
  const o = await opportunity(),
    used = await upload(o.id),
    p = await request(o);
  await upload(o.id, "ready", "A new unused reference for a future request.");
  await f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]);
  await f.db.query(
    "update public.documents set extracted_text='Changed consumed text',extraction_hash=repeat('b',64) where id=$1",
    [used.id],
  );
  await f.db.query(
    "update public.document_blocks set text='Changed consumed text',text_hash=repeat('c',64) where document_id=$1",
    [used.id],
  );
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  await expect(
    attempt(() =>
      f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]),
    ),
  ).rejects.toThrow("STALE_INPUT");
});

it("keeps final source-review requirements while allowing draft export and later exact-text confirmation", async () => {
  const o = await opportunity(),
    d = await upload(o.id),
    p = await request(o),
    v = await version(p);
  const message =
    "Review the extracted text used by this draft before final approval.";
  expect((await f.rpc("proposal_readiness", [v.id])).blockers).toContain(
    message,
  );
  const exported = await f.command("export.prepare", {
    proposal_version_id: v.id,
    expected_revision: v.revision,
    mode: "draft",
    volume: "combined",
  });
  expect(exported.mode).toBe("draft");
  await f.command("document.confirm", {
    id: d.id,
    expected_revision: d.revision,
  });
  expect((await f.rpc("proposal_readiness", [v.id])).blockers).not.toContain(
    message,
  );
});

it("reuses an exact draft package and keeps private helpers inaccessible to browser roles", async () => {
  const o = await opportunity();
  await upload(o.id);
  const a = (
    await f.db.query<any>(
      "select (app_private.seal_draft_package($1,$2,$3)).*",
      [f.w, o.id, f.owner],
    )
  ).rows[0];
  const b = (
    await f.db.query<any>(
      "select (app_private.seal_draft_package($1,$2,$3)).*",
      [f.w, o.id, f.owner],
    )
  ).rows[0];
  expect(a.id).toBe(b.id);
  for (const signature of [
    "app_private.seal_draft_package(uuid,uuid,uuid)",
    "app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)",
  ]) {
    expect(
      (
        await f.db.query<any>(
          "select has_function_privilege('authenticated',$1,'EXECUTE') allowed",
          [signature],
        )
      ).rows[0].allowed,
    ).toBe(false);
  }
  await expect(
    attempt(() =>
      f.db.query(
        "select app_private.draft_generation_snapshot($1,$2,null,null)",
        [f.w, crypto.randomUUID()],
      ),
    ),
  ).rejects.toThrow("NOT_FOUND");
});

it("cannot seal or snapshot another existing workspace's opportunity", async () => {
  // Production is single-workspace; remove only that fixture constraint to
  // exercise the lower-level boundary against an existing foreign record.
  await f.db.exec(
    "alter table public.workspaces drop constraint workspaces_singleton_key",
  );
  const foreignWorkspace = (
    await f.db.query<any>(
      "insert into public.workspaces(name,created_by) values('Synthetic foreign workspace',$1) returning id",
      [f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "insert into public.workspace_actors(workspace_id,id,kind) values($1,$2,'historical')",
    [foreignWorkspace, f.owner],
  );
  const source = (
    await f.db.query<any>(
      "insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic foreign source','manual',$2) returning id",
      [foreignWorkspace, f.owner],
    )
  ).rows[0];
  const foreign = (
    await f.db.query<any>(
      "insert into public.opportunities(workspace_id,source_id,title,created_by) values($1,$2,'Synthetic foreign opportunity',$3) returning id",
      [foreignWorkspace, source.id, f.owner],
    )
  ).rows[0];
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  await expect(
    attempt(() =>
      f.db.query(
        "select app_private.draft_generation_snapshot($1,$2,null,null)",
        [f.w, foreign.id],
      ),
    ),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    attempt(() =>
      f.db.query("select app_private.seal_draft_package($1,$2,$3)", [
        f.w,
        foreign.id,
        f.owner,
      ]),
    ),
  ).rejects.toThrow("NOT_FOUND");
});

it("requires an attached reference while accepting files regardless of RFP classification", async () => {
  const o = await opportunity();
  await expect(request(o)).rejects.toThrow("READABLE_RFP_REQUIRED");
});

it("continues a draft past a new attachment but exposes that omitted file at final approval", async () => {
  const o = await opportunity();
  await upload(o.id);
  const p = await request(o),
    added = await upload(
      o.id,
      "ready",
      "A synthetic addendum attached after the request.",
    );
  await f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]);
  const v = await version(p);
  const message =
    "New attachments were added after this draft started; regenerate with those inputs or remove them before final approval.";
  expect((await f.rpc("proposal_readiness", [v.id])).blockers).toContain(
    message,
  );
  await expect(
    f.command("export.prepare", {
      proposal_version_id: v.id,
      expected_revision: v.revision,
      mode: "draft",
      volume: "combined",
    }),
  ).resolves.toMatchObject({ mode: "draft" });
  await f.db.query("update public.documents set archived=true where id=$1", [
    added.id,
  ]);
  expect((await f.rpc("proposal_readiness", [v.id])).blockers).not.toContain(
    message,
  );
});

it("retains baseline staleness for new direct review text", async () => {
  const base = await baseForRegeneration(),
    p = await regenerate(base);
  await addReview(base);
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  await expect(
    attempt(() =>
      f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]),
    ),
  ).rejects.toThrow("STALE_INPUT");
});

it("checks late review attachments against the regeneration base after the new version becomes active", async () => {
  const base = await baseForRegeneration(),
    review = await addReview(base),
    p = await regenerate(base);
  const d = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "review",
    review_input_id: review.id,
    original_name: "synthetic-late-review.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "e".repeat(64),
  });
  await f.rpc("accept_uploaded_document", [
    d.id,
    f.owner,
    "e".repeat(64),
    100,
    "Synthetic later attachment explaining the review.",
    "ready",
    crypto.randomUUID(),
  ]);
  await f.db.query("select app_private.refresh_proposal_evidence($1)", [p.id]);
  const v = await version(p, 2);
  expect((await f.rpc("proposal_readiness", [v.id])).blockers).toContain(
    "New attachments were added after this draft started; regenerate with those inputs or remove them before final approval.",
  );
});
