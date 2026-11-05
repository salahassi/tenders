import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback;reset role");
});
const tuple = (value: string, unit = "terminals") => ({
  modality: "required",
  actor: "supplier",
  negated: false,
  conditions: [],
  exceptions: [],
  consequences: [],
  quantities: [{ value, unit, currency: null }],
  dates: [],
});
async function row(sql: string, args: any[] = []) {
  return (await f.db.query<any>(sql, args)).rows[0];
}
async function attempt(fn: () => Promise<any>) {
  await f.db.exec("savepoint expected");
  try {
    return await fn();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected");
  }
}
async function setup(broad = false) {
  const source = await f.command("source.create", {
    name: "Synthetic resolution",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic scope",
    reference: "SYNTHETIC",
    description:
      "Supplier shall deliver 9 terminals. Supplier shall deliver 3 cabinets.",
    language: "en",
    decision: "shortlisted",
  });
  async function context() {
    return f.rpc("source_review_context", [opportunity.id]);
  }
  async function authority(src: any, more: any = {}) {
    return f.command("source.authority.review", {
      opportunity_id: opportunity.id,
      entity_kind: src.reference.entity_kind,
      entity_id: src.reference.entity_id,
      content_hash: src.reference.content_hash,
      expected_revision: src.authority.revision,
      role: "buyer_rfp",
      status: "confirmed",
      supersedes: null,
      precedence: 0,
      reason: "Synthetic human authority",
      ...more,
    });
  }
  async function review(span: any, semantics: any, more: any = {}) {
    return f.command("source.obligation.review", {
      opportunity_id: opportunity.id,
      review_id: null,
      expected_revision: 0,
      spans: Array.isArray(span) ? span : [span],
      semantics,
      status: "confirmed",
      reason: "Synthetic human meaning",
      ...more,
    });
  }
  async function span(src: any, quote: string) {
    const start = src.text.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    return (
      await row(
        "select app_private.source_span_from_block($1::jsonb,$2,$3) value",
        [JSON.stringify(src), start, start + quote.length],
      )
    ).value;
  }
  async function document(text: string, hash: string) {
    const d = await f.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: opportunity.id,
      original_name: "synthetic.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 100,
      hash,
    });
    const a = await f.rpc("accept_uploaded_document", [
      d.id,
      f.owner,
      hash,
      100,
      text,
      "ready",
      crypto.randomUUID(),
    ]);
    await f.command("document.confirm", {
      id: a.id,
      expected_revision: a.revision,
    });
    return d;
  }
  const first = await document(
    "Supplier shall deliver 9 terminals. Supplier shall deliver 3 cabinets.",
    "a".repeat(64),
  );
  let ctx = await context();
  await authority(
    ctx.sources.find((x: any) => x.reference.entity_id === first.id),
  );
  ctx = await context();
  const original = ctx.sources.find(
    (x: any) => x.reference.entity_id === first.id,
  );
  const oldSpan = await span(
    original,
    broad ? original.text : "Supplier shall deliver 9 terminals.",
  );
  const cabinetSpan = await span(
    original,
    "Supplier shall deliver 3 cabinets.",
  );
  const old = await review(oldSpan, tuple("9"));
  const cabinet = await review(cabinetSpan, tuple("3", "cabinets"));
  const d = await document(
    "Supplier shall deliver 14 terminals.",
    "b".repeat(64),
  );
  ctx = await context();
  await authority(
    ctx.sources.find((x: any) => x.reference.entity_id === d.id),
    {
      role: "buyer_addendum",
      precedence: 1,
      supersedes: {
        entity_id: original.reference.entity_id,
        content_hash: original.reference.content_hash,
      },
    },
  );
  ctx = await context();
  const src = ctx.sources.find((x: any) => x.reference.entity_id === d.id);
  const replacementSpan = await span(src, src.text);
  const replacement = await review(replacementSpan, tuple("14"), {
    supersedes_review_id: old.review_id,
  });
  ctx = await context();
  return {
    opportunity,
    original,
    oldSpan,
    cabinetSpan,
    replacementSpan,
    old,
    cabinet,
    replacement,
    ctx,
    context,
    authority,
    review,
    span,
    document,
  };
}
function candidate(span: any, semantics: any) {
  return {
    text: span.quote,
    category: "functional",
    mandatory: true,
    source_refs: [{ id: span.id, quote: span.quote }],
    interpretation: "Synthetic interpretation",
    acceptance_evidence: "Synthetic count inspection",
    owner_question: null,
    source_semantics: {
      ...semantics,
      version: 1,
      source_span_ids: [span.id],
      authority_role: span.authority.role,
      authority_status: span.authority.status,
      review_status: "pending",
      review_id: null,
    },
  };
}
async function resolution(s: Awaited<ReturnType<typeof setup>>) {
  return (
    await row("select app_private.source_resolution($1,$2) value", [
      f.w,
      s.opportunity.id,
    ])
  ).value;
}
async function assertCandidate(
  s: Awaited<ReturnType<typeof setup>>,
  c: any,
  context = s.ctx,
) {
  return f.db.query(
    "select app_private.assert_requirement_resolution($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)",
    [
      f.w,
      s.opportunity.id,
      JSON.stringify(context),
      JSON.stringify(c.source_semantics),
      JSON.stringify(c.source_refs),
    ],
  );
}
it("pins new predecessor revisions and preserves whole sources and unaffected reviewed units", async () => {
  const s = await setup();
  const r = await resolution(s);
  expect(r.unresolved_edges).toEqual([]);
  expect(r.supersessions).toHaveLength(1);
  expect(r.supersessions[0].predecessor.id).toBe(s.old.review_id);
  expect(r.active_reviews.map((x: any) => x.id).sort()).toEqual(
    [s.cabinet.review_id, s.replacement.review_id].sort(),
  );
  expect(
    s.ctx.source_evidence.spans.some((x: any) => x.quote === s.original.text),
  ).toBe(true);
  expect(
    (
      await row(
        "select supersedes_review_revision revision from public.source_obligation_reviews where review_id=$1",
        [s.replacement.review_id],
      )
    ).revision,
  ).toBe(1);
});
it("rejects old9 pending re-extraction through the raw enclosing chunk and preserves cabinet3", async () => {
  const s = await setup();
  const raw = s.ctx.source_evidence.spans.find(
    (x: any) => x.quote === s.original.text,
  );
  await expect(
    attempt(() => assertCandidate(s, candidate(raw, tuple("9")))),
  ).rejects.toThrow("SOURCE_OBLIGATION_SUPERSEDED");
  await assertCandidate(s, candidate(raw, tuple("3", "cabinets")));
  expect(
    (
      await row(
        "select app_private.source_resolution_candidate($1::jsonb,$2::jsonb) value",
        [JSON.stringify(s.ctx), JSON.stringify(candidate(raw, tuple("9")))],
      )
    ).value.kind,
  ).toBe("retired");
});
it("never subtracts a broad review evidence range containing unrelated clauses", async () => {
  const s = await setup(true);
  expect(
    (await resolution(s)).supersessions[0].predecessor.spans[0].quote,
  ).toContain("3 cabinets");
  expect(
    s.ctx.source_evidence.spans.some((x: any) => x.quote === s.original.text),
  ).toBe(true);
  await assertCandidate(s, candidate(s.cabinetSpan, tuple("3", "cabinets")));
});
it("invalidates a decision-time predecessor pin after the predecessor changes", async () => {
  const s = await setup();
  await s.review(s.oldSpan, tuple("9"), {
    review_id: s.old.review_id,
    expected_revision: 1,
  });
  const r = await resolution(s);
  expect(r.supersessions).toEqual([]);
  expect(r.unresolved_edges[0].reason).toBe("PREDECESSOR_REVISION_CHANGED");
  await expect(
    attempt(() =>
      assertCandidate(s, candidate(s.cabinetSpan, tuple("3", "cabinets"))),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_REVIEW_REQUIRED");
});
it("revocation restores the predecessor and invalidates the frozen resolution", async () => {
  const s = await setup();
  await s.review(s.replacementSpan, tuple("14"), {
    review_id: s.replacement.review_id,
    expected_revision: 1,
    status: "revoked",
    supersedes_review_id: null,
  });
  const r = await resolution(s);
  expect(r.supersessions).toEqual([]);
  expect(r.active_reviews.map((x: any) => x.id)).toContain(s.old.review_id);
  await expect(
    attempt(() =>
      assertCandidate(s, candidate(s.cabinetSpan, tuple("3", "cabinets"))),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_STALE");
});
it("uses executor5 for marked contexts while preserving historical floors", async () => {
  expect(
    await row(
      "select app_private.minimum_generation_executor('{\"source_contract_version\":1,\"source_resolution_version\":1}') current,app_private.minimum_generation_executor('{\"source_contract_version\":1}') old,app_private.minimum_generation_executor('{}') legacy",
    ),
  ).toEqual({ current: 5, old: 4, legacy: 1 });
});
async function planFor(s: Awaited<ReturnType<typeof setup>>, context = s.ctx) {
  return await row(
    "insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) values($1,$2,'assessment','analysis','running',(select evidence_revision from public.workspaces where id=$1),repeat('0',64),$3::jsonb,$4) returning *",
    [f.w, s.opportunity.id, JSON.stringify(context), f.owner],
  );
}
async function persist(plan: any, c: any) {
  return f.db.query(
    "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)",
    [
      crypto.randomUUID(),
      f.w,
      plan.id,
      plan.opportunity_id,
      c.text,
      c.category,
      c.mandatory,
      JSON.stringify(c.source_refs),
      JSON.stringify(c.source_semantics),
      c.interpretation,
      c.acceptance_evidence,
      f.owner,
    ],
  );
}
it("the real requirement INSERT independently rejects retired pending rows and accepts unchanged units", async () => {
  const s = await setup();
  const p = await planFor(s);
  const raw = s.ctx.source_evidence.spans.find(
    (x: any) => x.quote === s.original.text,
  );
  await expect(
    attempt(() => persist(p, candidate(raw, tuple("9")))),
  ).rejects.toThrow("SOURCE_OBLIGATION_SUPERSEDED");
  await persist(p, candidate(raw, tuple("3", "cabinets")));
  expect(
    (
      await row(
        "select count(*)::int n from public.requirements where plan_id=$1",
        [p.id],
      )
    ).n,
  ).toBe(1);
});
it("mixed9+3 and changed-actor9 are unresolved rather than dropped or admitted", async () => {
  const s = await setup();
  const raw = s.ctx.source_evidence.spans.find(
    (x: any) => x.quote === s.original.text,
  );
  for (const meaning of [
    {
      ...tuple("9"),
      quantities: [
        ...tuple("9").quantities,
        ...tuple("3", "cabinets").quantities,
      ],
    },
    { ...tuple("9"), actor: "contractor" },
  ]) {
    const c = candidate(raw, meaning);
    await expect(attempt(() => assertCandidate(s, c))).rejects.toThrow(
      "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
    );
    await expect(
      attempt(() =>
        row(
          "select app_private.source_resolution_candidate($1::jsonb,$2::jsonb) value",
          [JSON.stringify(s.ctx), JSON.stringify(c)],
        ),
      ),
    ).rejects.toThrow("SOURCE_OBLIGATION_RESOLUTION_REQUIRED");
  }
});
it("a partial multi-source authority edge remains unresolved even though the older command accepts any matching span", async () => {
  const s = await setup();
  const d = await s.document(
    "Supplier shall also provide training.",
    "c".repeat(64),
  );
  let ctx = await s.context();
  await s.authority(
    ctx.sources.find((x: any) => x.reference.entity_id === d.id),
  );
  ctx = await s.context();
  const src = ctx.sources.find((x: any) => x.reference.entity_id === d.id);
  const extra = await s.span(src, src.text);
  const old = await s.review([s.oldSpan, extra], tuple("9"));
  const replacement = await s.review(s.replacementSpan, tuple("14"), {
    supersedes_review_id: old.review_id,
  });
  const r = await resolution(s);
  expect(r.unresolved_edges).toContainEqual({
    predecessor_review_id: old.review_id,
    replacement_review_id: replacement.review_id,
    replacement_revision: 1,
    reason: "SUPERSESSION_AUTHORITY_INCOMPLETE",
  });
});
it("A to B to C keeps A retired when C is revoked and restores B", async () => {
  const s = await setup();
  const d = await s.document(
    "Supplier shall deliver 18 terminals.",
    "c".repeat(64),
  );
  let ctx = await s.context();
  const b = ctx.sources.find(
    (x: any) => x.reference.entity_id === s.replacementSpan.entity_id,
  );
  await s.authority(
    ctx.sources.find((x: any) => x.reference.entity_id === d.id),
    {
      role: "buyer_addendum",
      precedence: 2,
      supersedes: {
        entity_id: b.reference.entity_id,
        content_hash: b.reference.content_hash,
      },
    },
  );
  ctx = await s.context();
  const src = ctx.sources.find((x: any) => x.reference.entity_id === d.id);
  const span = await s.span(src, src.text);
  const c = await s.review(span, tuple("18"), {
    supersedes_review_id: s.replacement.review_id,
  });
  expect((await resolution(s)).supersessions).toHaveLength(2);
  await s.review(span, tuple("18"), {
    review_id: c.review_id,
    expected_revision: 1,
    status: "revoked",
    supersedes_review_id: null,
  });
  const r = await resolution(s);
  expect(r.supersessions).toHaveLength(1);
  expect(r.supersessions[0].predecessor.id).toBe(s.old.review_id);
  expect(r.active_reviews.map((x: any) => x.id)).toContain(
    s.replacement.review_id,
  );
});
it("unmarked histories require fresh generation without rewriting stored bytes", async () => {
  const s = await setup();
  const {
    source_resolution_version: _,
    source_resolution: __,
    ...legacy
  } = s.ctx;
  const p = await planFor(s, legacy);
  await expect(
    attempt(() =>
      f.db.query("select app_private.assert_plan_source_resolution($1)", [
        p.id,
      ]),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_REFRESH_REQUIRED");
  expect(
    (
      await row(
        "select frozen_context,input_hash,created_at from public.generation_plans where id=$1",
        [p.id],
      )
    ).frozen_context,
  ).toEqual(legacy);
});
it("legacy edges use only a single provable predecessor revision, never tied timestamps", async () => {
  const s = await setup();
  await f.db.exec(
    "alter table public.source_obligation_reviews disable trigger source_obligation_immutable",
  );
  await f.db.query(
    "update public.source_obligation_reviews set supersedes_review_revision=null where review_id=$1",
    [s.replacement.review_id],
  );
  await f.db.exec(
    "alter table public.source_obligation_reviews enable trigger source_obligation_immutable",
  );
  expect((await resolution(s)).supersessions).toHaveLength(1);
  await s.review(s.oldSpan, tuple("9"), {
    review_id: s.old.review_id,
    expected_revision: 1,
  });
  const r = await resolution(s);
  expect(r.unresolved_edges[0].reason).toBe("PREDECESSOR_REVISION_UNPINNED");
  expect(
    (
      await row(
        "select count(distinct created_at)::int n from public.source_obligation_reviews",
      )
    ).n,
  ).toBe(1);
});
it("a revoked replacement source authority invalidates suppression and its frozen use", async () => {
  const s = await setup();
  const ctx = await s.context();
  const src = ctx.sources.find(
    (x: any) => x.reference.entity_id === s.replacementSpan.entity_id,
  );
  await s.authority(src, { role: "buyer_addendum", status: "revoked" });
  const r = await resolution(s);
  expect(r.supersessions).toEqual([]);
  expect(r.unresolved_edges[0].reason).toBe("REVIEW_SOURCE_STALE");
  await expect(
    attempt(() =>
      assertCandidate(s, candidate(s.cabinetSpan, tuple("3", "cabinets"))),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_REVIEW_REQUIRED");
});
async function auditFixture() {
  const s = await setup();
  const p = await planFor(s);
  const raw = s.ctx.source_evidence.spans.find(
    (x: any) => x.quote === s.original.text,
  );
  const analyzed = [
    candidate(raw, tuple("9")),
    candidate(s.cabinetSpan, tuple("3", "cabinets")),
    candidate(s.replacementSpan, tuple("14")),
    candidate(raw, tuple("4", "sensors")),
  ];
  const job = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,'analyze_chunk',$2,$3,'succeeded',$4) returning id",
    [f.w, p.id, p.input_hash, f.owner],
  );
  const step = await row(
    "insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values($1,$2,$3,'analyze_chunk','analysis',1,'{}',$4::jsonb,'completed',$5) returning id",
    [f.w, p.id, job.id, JSON.stringify({ requirements: analyzed }), f.owner],
  );
  const requirements: any[] = [{ ...analyzed[3], id: crypto.randomUUID() }];
  const seeded: any[] = [];
  for (const review of s.ctx.source_resolution.active_reviews) {
    const canonical = (
      await row(
        "select app_private.source_obligation_inventory($1,$2,$3::uuid[]) value",
        [f.w, s.opportunity.id, [review.id]],
      )
    ).value[0];
    const id = (
      await row(
        "select app_private.source_review_requirement_id($1,$2::jsonb) value",
        [p.id, JSON.stringify(review)],
      )
    ).value;
    requirements.push({
      ...candidate(review.spans[0], review.semantics),
      ...canonical,
      id,
    });
    seeded.push({
      review_id: review.id,
      revision: review.revision,
      requirement_id: id,
    });
  }
  const audit = {
    version: 1,
    retired: [
      {
        step_id: step.id,
        requirement_index: 0,
        predecessor_review_id: s.old.review_id,
        predecessor_revision: 1,
        replacement_review_id: s.replacement.review_id,
        replacement_revision: 1,
      },
    ],
    seeded,
  };
  async function validate(reqs = requirements, dispositions: any = audit) {
    return row(
      "select app_private.validate_source_resolution_inventory(p,$2::jsonb,$3::jsonb) value from public.generation_plans p where id=$1",
      [p.id, JSON.stringify(reqs), JSON.stringify(dispositions)],
    );
  }
  return { s, p, step, analyzed, requirements, audit, validate };
}
it("independently validates every retirement, active seed, and retained nonmatching analysis row", async () => {
  const x = await auditFixture();
  expect((await x.validate()).value).toEqual(x.audit);
  await expect(
    attempt(() => x.validate(x.requirements, { ...x.audit, retired: [] })),
  ).rejects.toThrow("SOURCE_RESOLUTION_AUDIT_INVALID");
  await expect(
    attempt(() =>
      x.validate(x.requirements, {
        ...x.audit,
        retired: [{ ...x.audit.retired[0], requirement_index: 1 }],
      }),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_AUDIT_INVALID");
  await expect(
    attempt(() => x.validate(x.requirements.slice(1))),
  ).rejects.toThrow("SOURCE_RESOLUTION_INVENTORY_INCOMPLETE");
  await expect(
    attempt(() => x.validate(x.requirements.slice(0, -1))),
  ).rejects.toThrow("SOURCE_RESOLUTION_ACTIVE_UNIT_MISSING");
  await expect(
    attempt(() =>
      x.validate([
        ...x.requirements,
        {
          ...x.requirements[0],
          id: crypto.randomUUID(),
          source_semantics: {
            ...x.requirements[0].source_semantics,
            ...tuple("5", "sensors"),
          },
        },
      ]),
    ),
  ).rejects.toThrow("SOURCE_RESOLUTION_INVENTORY_INVALID");
});
it("canonical advance stores the checked audit and preserves accepted analysis bytes", async () => {
  const x = await auditFixture();
  const lease = crypto.randomUUID();
  const job = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,lease_token,lease_until) values($1,'advance_plan',$2,$3,'running',$4,$5,clock_timestamp()+interval '2 minutes') returning id",
    [f.w, x.p.id, x.p.input_hash, f.owner, lease],
  );
  const step = await row(
    "insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,status,created_by) values($1,$2,$3,'advance_plan','analysis',2,'{}','queued',$4) returning id",
    [f.w, x.p.id, job.id, f.owner],
  );
  await f.rpc("advance_generation", [
    job.id,
    lease,
    "planning",
    JSON.stringify(x.requirements),
    JSON.stringify([
      {
        task: "plan_proposal",
        input: { requirement_ids: x.requirements.map((r: any) => r.id) },
      },
    ]),
    JSON.stringify({ source_resolution_dispositions: x.audit }),
  ]);
  expect(
    (
      await row("select output from public.generation_steps where id=$1", [
        step.id,
      ])
    ).output.source_resolution_dispositions,
  ).toEqual(x.audit);
  expect(
    (
      await row("select output from public.generation_steps where id=$1", [
        x.step.id,
      ])
    ).output,
  ).toEqual({ requirements: x.analyzed });
  expect(
    (
      await row(
        "select count(*)::int n from public.requirements where plan_id=$1",
        [x.p.id],
      )
    ).n,
  ).toBe(3);
});
it("legacy current-request UX cancels only the old plan and creates a newly pinned successor", async () => {
  const s = await setup();
  const delivery = await f.command("delivery.snapshot.prepare", {
    opportunity_id: s.opportunity.id,
    expected_revision: s.opportunity.revision,
  });
  const {
    source_resolution_version: _,
    source_resolution: __,
    ...legacy
  } = s.ctx;
  const p = await row(
    "insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) values($1,$2,$3,'proposal','analysis','blocked',(select evidence_revision from public.workspaces where id=$1),repeat('f',64),$4::jsonb,$5) returning *",
    [
      f.w,
      s.opportunity.id,
      delivery.proposal_id,
      JSON.stringify({
        ...legacy,
        generated_delivery_version: 3,
        proposal_consistency_version: 1,
      }),
      f.owner,
    ],
  );
  let error: any;
  try {
    await f.command("generation.retry", {
      id: p.id,
      expected_revision: p.revision,
      reason: "Synthetic current continuation",
    });
  } catch (e) {
    error = e;
  }
  expect(error?.message).toBe("PROPOSAL_CURRENT_CONTRACT_REQUIRED");
  const { currentProposalCommands, currentProposalRequest } =
    await import("../../../frontend/src/lib/currentProposalRequest");
  const details = currentProposalRequest(
    JSON.parse(error.detail),
    s.opportunity.id,
  );
  expect(details).not.toBeNull();
  const commands = await currentProposalCommands(details!);
  await f.db.exec("set local role authenticated");
  await f.rpc("app_batch_prepare", [
    JSON.stringify(commands),
    crypto.randomUUID(),
  ]);
  await f.db.exec("reset role");
  const before = await row(
    "select * from public.generation_plans where id=$1",
    [p.id],
  );
  expect(before.status).toBe("canceled");
  expect(before.frozen_context).toEqual(p.frozen_context);
  expect(before.input_hash).toBe(p.input_hash);
  expect(before.created_at).toEqual(p.created_at);
  const fresh = await row(
    "select * from public.generation_plans where opportunity_id=$1 and kind='proposal' and id<>$2",
    [s.opportunity.id, p.id],
  );
  expect(fresh.frozen_context.source_resolution_version).toBe(1);
  expect(fresh.frozen_context.source_resolution).toEqual(
    s.ctx.source_resolution,
  );
  expect(fresh.issuance_request_id).toMatch(/^[a-f0-9-]{36}$/);
});
it("does not retire pending generic empty-slot meanings or choose between duplicate active units", async () => {
  const s = await setup();
  const raw = s.ctx.source_evidence.spans.find(
    (x: any) => x.quote === s.original.text,
  );
  const empty = { ...tuple("9"), quantities: [] };
  const context = structuredClone(s.ctx);
  context.source_resolution.supersessions[0].predecessor.semantics = empty;
  await expect(
    attempt(() =>
      row(
        "select app_private.source_resolution_candidate($1::jsonb,$2::jsonb) value",
        [JSON.stringify(context), JSON.stringify(candidate(raw, empty))],
      ),
    ),
  ).rejects.toThrow("SOURCE_OBLIGATION_RESOLUTION_REQUIRED");
  await expect(
    attempt(() =>
      row(
        "select app_private.source_resolution_candidate($1::jsonb,$2::jsonb) value",
        [
          JSON.stringify(context),
          JSON.stringify(candidate(s.cabinetSpan, tuple("3", "cabinets"))),
        ],
      ),
    ),
  ).resolves.toBeTruthy();
  const duplicate = structuredClone(s.ctx);
  const cabinet = duplicate.source_resolution.active_reviews.find(
    (r: any) => r.id === s.cabinet.review_id,
  );
  duplicate.source_resolution.active_reviews.push({
    ...cabinet,
    id: crypto.randomUUID(),
  });
  await expect(
    attempt(() =>
      row(
        "select app_private.source_resolution_candidate($1::jsonb,$2::jsonb) value",
        [
          JSON.stringify(duplicate),
          JSON.stringify(candidate(s.cabinetSpan, tuple("3", "cabinets"))),
        ],
      ),
    ),
  ).rejects.toThrow("SOURCE_OBLIGATION_RESOLUTION_REQUIRED");
});
it("resolves a 64-review source catalog with a single source census per resolver operation", async () => {
  const s = await setup();
  const text = Array.from(
    { length: 64 },
    (_, i) =>
      `Supplier shall deliver ${i + 20} sensor modules for segment ${i + 1}.`,
  ).join(" ");
  const d = await s.document(text, "d".repeat(64));
  let ctx = await s.context();
  await s.authority(
    ctx.sources.find((x: any) => x.reference.entity_id === d.id),
  );
  ctx = await s.context();
  const src = ctx.sources.find((x: any) => x.reference.entity_id === d.id);
  for (let i = 0; i < 64; i++) {
    const quote = `Supplier shall deliver ${i + 20} sensor modules for segment ${i + 1}.`;
    await s.review(
      await s.span(src, quote),
      tuple(String(i + 20), `sensor modules for segment ${i + 1}`),
    );
  }
  const start = performance.now();
  const result = await s.context();
  expect(result.source_resolution.active_reviews).toHaveLength(66);
  expect(result.source_evidence.reviews).toHaveLength(66);
  expect(performance.now() - start).toBeLessThan(5000);
});
