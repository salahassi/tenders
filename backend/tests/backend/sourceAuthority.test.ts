import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  canonicalSourceSpanId,
  resolveSourceSpan,
} from "../../supabase/functions/_shared/sourceEvidence";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback;reset role"));
const tuple = {
  modality: "required",
  actor: "supplier",
  negated: false,
  conditions: ["after buyer acceptance"],
  exceptions: ["unless canceled"],
  consequences: ["payment withheld"],
  quantities: [{ value: "٣", unit: "units", currency: "USD" }],
  dates: [{ value: "2026-11-04", event: "handover" }],
};
async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic scope",
    reference: "SYNTHETIC",
    description:
      "Supplier shall deliver ٣ units after buyer acceptance unless canceled. Payment withheld. USD 20, handover 2026-11-04. لا يلغى الشرط 😀",
    language: "en",
    decision: "shortlisted",
  });
  const context = await f.rpc("source_review_context", [opportunity.id]);
  return { opportunity, context };
}
async function authority(opportunity: any, source: any, more: any = {}) {
  return f.command("source.authority.review", {
    opportunity_id: opportunity.id,
    entity_kind: source.reference.entity_kind,
    entity_id: source.reference.entity_id,
    content_hash: source.reference.content_hash,
    expected_revision: source.authority.revision,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic human reviewed buyer identity",
    ...more,
  });
}
async function review(opportunity: any, span: any, more: any = {}) {
  return f.command("source.obligation.review", {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [span],
    semantics: tuple,
    status: "confirmed",
    reason: "Synthetic human reviewed original clause",
    ...more,
  });
}
async function inventory(opportunity: any, ids: string[]) {
  return (
    await f.db.query<any>(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[]) result",
      [f.w, opportunity.id, ids],
    )
  ).rows[0].result;
}
async function attempt<T>(fn: () => Promise<T>) {
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
it("never infers buyer authority from a source type or model-selected flag; persists exact current reviewed tuples", async () => {
  const { opportunity, context } = await setup();
  expect(context.sources[0].authority).toMatchObject({
    role: "unknown",
    status: "unconfirmed",
  });
  await authority(opportunity, context.sources[0]);
  const current = await f.rpc("source_review_context", [opportunity.id]);
  const span = current.source_evidence.spans[0];
  expect(span.id).toBe(canonicalSourceSpanId(span));
  expect(resolveSourceSpan(span, current.sources[0])).toBe(span.quote);
  const saved = await review(opportunity, span);
  const rows = await inventory(opportunity, [saved.review_id]);
  expect(rows[0]).toMatchObject({
    id: saved.review_id,
    mandatory: true,
    source_semantics: {
      ...tuple,
      review_status: "confirmed",
      authority_role: "buyer_rfp",
    },
  });
  expect(rows[0].text).toBe(span.quote);
  expect(
    (
      await f.db.query<any>(
        "select app_private.check_source_semantics($1,$2::jsonb,$3::jsonb) valid",
        [
          f.w,
          JSON.stringify(rows[0].source_semantics),
          JSON.stringify(rows[0].source_refs),
        ],
      )
    ).rows[0].valid,
  ).toBe(true);
});
it("rejects every frozen identity mutation, including source text, hash, offset, authority and extraction version", async () => {
  const { opportunity, context } = await setup();
  const span = context.source_evidence.spans[0];
  for (const patch of [
    { quote: "fabricated" },
    { content_hash: "b".repeat(64) },
    { block_hash: "b".repeat(64) },
    { start: 1 },
    { end: span.end - 1 },
    { extraction_version: "wrong" },
    {
      authority: { ...span.authority, role: "buyer_rfp", status: "confirmed" },
    },
    { entity_id: crypto.randomUUID() },
  ])
    await expect(review(opportunity, { ...span, ...patch })).rejects.toThrow(
      "SOURCE_SPAN_STALE",
    );
});
it("binds confirmation to current hash and latest authority; revocation preserves history but invalidates use", async () => {
  const { opportunity, context } = await setup();
  await authority(opportunity, context.sources[0]);
  const current = await f.rpc("source_review_context", [opportunity.id]);
  const saved = await review(opportunity, current.source_evidence.spans[0]);
  await authority(opportunity, current.sources[0], {
    status: "revoked",
    reason: "Buyer authority withdrawn",
  });
  await expect(
    attempt(() => inventory(opportunity, [saved.review_id])),
  ).rejects.toThrow("SOURCE_SPAN_STALE");
  expect(
    (await f.rpc("source_review_context", [opportunity.id])).source_evidence
      .reviews,
  ).toEqual([]);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.source_obligation_reviews",
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    attempt(() => f.db.exec("delete from public.source_obligation_reviews")),
  ).rejects.toThrow("SOURCE_REVIEW_IMMUTABLE");
});
it("checks idempotency and revision under workspace lock; malformed/null tuples fail closed", async () => {
  const { opportunity, context } = await setup();
  const payload = {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [context.source_evidence.spans[0]],
    semantics: tuple,
    status: "confirmed",
    reason: "Human reviewed",
  };
  const first = await f.command(
    "source.obligation.review",
    payload,
    "00000000-0000-4000-8000-000000000002",
  );
  expect(
    await f.command(
      "source.obligation.review",
      payload,
      "00000000-0000-4000-8000-000000000002",
    ),
  ).toEqual(first);
  await expect(
    f.command(
      "source.obligation.review",
      { ...payload, reason: "different" },
      "00000000-0000-4000-8000-000000000002",
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    review(opportunity, context.source_evidence.spans[0], {
      review_id: first.review_id,
      expected_revision: 0,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  for (const semantics of [
    null,
    {},
    { ...tuple, conditions: null },
    { ...tuple, quantities: [{ value: 20, unit: "kg", currency: null }] },
  ])
    await expect(
      review(opportunity, context.source_evidence.spans[0], { semantics }),
    ).rejects.toThrow("INVALID_SOURCE_SEMANTICS");
});
it("leaves old snapshot contracts byte-identical while pinning new source contracts", async () => {
  const { opportunity } = await setup();
  const document = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("accept_uploaded_document", [
    document.id,
    f.owner,
    "a".repeat(64),
    100,
    "Synthetic source clause",
    "ready",
    "accept-source",
  ]);
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  expect(plan.frozen_context.source_contract_version).toBe(1);
  expect(plan.frozen_context.source_evidence.spans.length).toBeGreaterThan(0);
  const old = { ...plan.frozen_context };
  delete old.source_contract_version;
  delete old.source_evidence;
  delete old.repair_contract_version;
  const args = [
    f.w,
    opportunity.id,
    plan.proposal_id,
    plan.package_id,
    JSON.stringify(old),
  ];
  const result = (
    await f.db.query<any>(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,$5::jsonb) current, app_private.draft_generation_snapshot_before_source_authority($1,$2,$3,$4,$5::jsonb) previous",
      args,
    )
  ).rows[0];
  expect(result.current).toEqual(result.previous);
  expect(result.current.source_contract_version).toBeUndefined();
});
it("cannot use another workspace or opportunity source and denies removed actors before idempotent replay", async () => {
  const { opportunity, context } = await setup();
  await expect(
    authority(opportunity, context.sources[0], {
      entity_id: crypto.randomUUID(),
    }),
  ).rejects.toThrow("NOT_FOUND");
  const payload = {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [context.source_evidence.spans[0]],
    semantics: tuple,
    status: "confirmed",
    reason: "Human reviewed",
  };
  await f.command(
    "source.obligation.review",
    payload,
    "00000000-0000-4000-8000-000000000003",
  );
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    f.command(
      "source.obligation.review",
      payload,
      "00000000-0000-4000-8000-000000000003",
    ),
  ).rejects.toThrow("NOT_FOUND");
});
async function upload(opportunity: any, text: string, hash = "a".repeat(64)) {
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
  await f.rpc("accept_uploaded_document", [
    d.id,
    f.owner,
    hash,
    100,
    text,
    "ready",
    crypto.randomUUID(),
  ]);
  return d;
}
it("requires a current explicit addendum relation and clause review before replacing an older obligation", async () => {
  const { opportunity } = await setup();
  const first = await upload(opportunity, "Supplier shall deliver 3 units.");
  const second = await upload(
    opportunity,
    "Addendum: supplier shall deliver 5 units.",
    "b".repeat(64),
  );
  let context = await f.rpc("source_review_context", [opportunity.id]);
  const oldSource = context.sources.find(
    (s: any) => s.reference.entity_id === first.id,
  );
  const newSource = context.sources.find(
    (s: any) => s.reference.entity_id === second.id,
  );
  await authority(opportunity, oldSource);
  context = await f.rpc("source_review_context", [opportunity.id]);
  const oldSpan = context.source_evidence.spans.find(
    (s: any) => s.entity_id === first.id,
  );
  const oldReview = await review(opportunity, oldSpan);
  await authority(opportunity, newSource, {
    role: "buyer_addendum",
    precedence: 99,
  });
  context = await f.rpc("source_review_context", [opportunity.id]);
  let newSpan = context.source_evidence.spans.find(
    (s: any) => s.entity_id === second.id,
  );
  await expect(
    review(opportunity, newSpan, { supersedes_review_id: oldReview.review_id }),
  ).rejects.toThrow("INVALID_SOURCE_PRECEDENCE");
  expect(await inventory(opportunity, [oldReview.review_id])).toHaveLength(1);
  await authority(
    opportunity,
    context.sources.find((s: any) => s.reference.entity_id === second.id),
    {
      role: "buyer_addendum",
      precedence: 99,
      supersedes: { entity_id: first.id, content_hash: oldSpan.content_hash },
    },
  );
  context = await f.rpc("source_review_context", [opportunity.id]);
  newSpan = context.source_evidence.spans.find(
    (s: any) => s.entity_id === second.id,
  );
  const replacement = await review(opportunity, newSpan, {
    supersedes_review_id: oldReview.review_id,
    semantics: {
      ...tuple,
      quantities: [{ value: "5", unit: "units", currency: null }],
    },
  });
  await expect(
    attempt(() => inventory(opportunity, [oldReview.review_id])),
  ).rejects.toThrow("SOURCE_OBLIGATION_SUPERSEDED");
  expect(
    (await inventory(opportunity, [replacement.review_id]))[0].text,
  ).toContain("5 units");
  expect(
    (await f.rpc("source_review_context", [opportunity.id])).sources.some(
      (s: any) => s.reference.entity_id === first.id,
    ),
  ).toBe(true);
});
it("server persistence accepts a source-bound pending draft and rejects quote/authority/confirmation tampering", async () => {
  const { opportunity } = await setup();
  await upload(opportunity, "Supplier shall deliver 3 units after acceptance.");
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const span = plan.frozen_context.source_evidence.spans.find(
    (s: any) => s.entity_kind === "document",
  );
  const semantics = {
    ...tuple,
    version: 1,
    source_span_ids: [span.id],
    authority_role: "unknown",
    authority_status: "unconfirmed",
    review_status: "pending",
    review_id: null,
  };
  async function insert(change: any = {}) {
    const value = {
      id: crypto.randomUUID(),
      text: span.quote,
      source_refs: [{ id: span.id, quote: span.quote }],
      source_semantics: semantics,
      ...change,
    };
    return f.db.query(
      "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,created_by,source_semantics) values($1,$2,$3,$4,$5,'scope',true,$6::jsonb,'Pending meaning','Review',$7,$8::jsonb)",
      [
        value.id,
        f.w,
        plan.id,
        opportunity.id,
        value.text,
        JSON.stringify(value.source_refs),
        f.owner,
        JSON.stringify(value.source_semantics),
      ],
    );
  }
  await insert();
  await expect(
    attempt(() => insert({ text: "Supplier may deliver 30 units." })),
  ).rejects.toThrow("SOURCE_SPAN_TEXT_INVALID");
  await expect(
    attempt(() =>
      insert({
        source_semantics: {
          ...semantics,
          authority_role: "buyer_rfp",
          authority_status: "confirmed",
        },
      }),
    ),
  ).rejects.toThrow("SOURCE_AUTHORITY_INVALID");
  await expect(
    attempt(() =>
      insert({
        source_semantics: {
          ...semantics,
          review_status: "confirmed",
          review_id: crypto.randomUUID(),
        },
      }),
    ),
  ).rejects.toThrow("SOURCE_SEMANTICS_STALE");
});
it("keeps unresolved meaning out of confirmed inventory and excludes published superseded extraction parents", async () => {
  const { opportunity, context } = await setup();
  for (const change of [
    { modality: "unknown" },
    { actor: null },
    { negated: null },
  ])
    await expect(
      review(opportunity, context.source_evidence.spans[0], {
        semantics: { ...tuple, ...change },
      }),
    ).rejects.toThrow("SOURCE_SEMANTICS_UNRESOLVED");
  const parent = await upload(opportunity, "Synthetic original parent.");
  const child = await upload(
    opportunity,
    "Synthetic verified successor.",
    "b".repeat(64),
  );
  // Test the integration boundary with the same canonical UUID-return contract.
  await f.db.exec(
    `create or replace function app_private.current_document_extraction(w uuid,document_id uuid) returns uuid language sql stable as $$select case when document_id='${parent.id}'::uuid then '${child.id}'::uuid else document_id end$$`,
  );
  const current = await f.rpc("source_review_context", [opportunity.id]);
  expect(
    current.sources.some((s: any) => s.reference.entity_id === parent.id),
  ).toBe(false);
  expect(
    current.sources.some((s: any) => s.reference.entity_id === child.id),
  ).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.document_blocks where document_id=$1",
        [parent.id],
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
});
it("allows explicit informational or confirmed nonbuyer meaning without inventing an actor", async () => {
  const { opportunity, context } = await setup();
  await authority(opportunity, context.sources[0], { role: "reference" });
  let current = await f.rpc("source_review_context", [opportunity.id]);
  for (const modality of ["informational", "permitted"]) {
    const saved = await review(opportunity, current.source_evidence.spans[0], {
      semantics: { ...tuple, modality, actor: null },
    });
    const row = (await inventory(opportunity, [saved.review_id]))[0];
    expect(row.mandatory).toBe(false);
    expect(row.source_review_reason).toBe(
      "Synthetic human reviewed original clause",
    );
    expect(
      (
        await f.db.query<any>(
          "select app_private.check_source_semantics($1,$2::jsonb,$3::jsonb) valid",
          [
            f.w,
            JSON.stringify(row.source_semantics),
            JSON.stringify(row.source_refs),
          ],
        )
      ).rows[0].valid,
    ).toBe(true);
  }
});
