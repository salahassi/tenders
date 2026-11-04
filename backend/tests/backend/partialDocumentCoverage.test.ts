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
const sourceText = "The buyer requires handover. يجب تسليم دليل التشغيل.";
const text = `[Page 1]\n${sourceText}\n\n[Page 2]\n`;
const coverage = {
  version: 1,
  kind: "pdf_pages",
  complete: false,
  pages: [
    { page: 1, status: "readable", characters: Array.from(sourceText).length },
    { page: 2, status: "needs_ocr", characters: 0 },
  ],
};
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
async function prepare() {
  const source = await f.command("source.create", {
    name: "Synthetic mixed PDF",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic source-preserving proposal",
    reference: "SYNTHETIC",
    description: "Respond to the source requirements.",
    language: "en",
    decision: "shortlisted",
  });
  const document = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("verify_document_pages", [document.id, 2]);
  return { opportunity, document };
}
async function accept(
  id: string,
  c: unknown = coverage,
  status = "partial",
  actor = f.owner,
  key = "synthetic-completion",
) {
  return f.rpc("accept_uploaded_document_with_coverage", [
    id,
    actor,
    "a".repeat(64),
    100,
    text,
    status,
    key,
    JSON.stringify(c),
  ]);
}
async function snapshot(
  opportunity: any,
  plan: any,
  prior: unknown,
  name = "draft_generation_snapshot",
) {
  return (
    await f.db.query<any>(
      `select app_private.${name}($1,$2,$3,$4,$5::jsonb) data`,
      [
        f.w,
        opportunity.id,
        plan.proposal_id,
        plan.package_id,
        prior === null ? null : JSON.stringify(prior),
      ],
    )
  ).rows[0].data;
}
it("persists exact partial coverage atomically and includes readable text in a newly frozen draft", async () => {
  const { opportunity, document } = await prepare();
  const accepted = await accept(document.id);
  expect(accepted).toMatchObject({
    status: "partial",
    extraction_coverage: coverage,
    extracted_text: text,
  });
  expect(accepted.extraction_hash).toHaveLength(64);
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  expect(plan.frozen_context.extraction_coverage_version).toBe(1);
  expect(
    plan.frozen_context.blocks.some(
      (block: any) =>
        block.document_id === document.id && block.text.includes(sourceText),
    ),
  ).toBe(true);
  expect(plan.frozen_context.input_materials).toMatchObject({
    uses_notice_fallback: false,
    documents: [
      {
        document_id: document.id,
        used_for_draft: true,
        extraction_coverage: coverage,
      },
    ],
  });
  const content = (
    await f.db.query<any>(
      "select app_private.content_record($1,'document',$2) data",
      [f.w, document.id],
    )
  ).rows[0].data;
  expect(content.content_hash).toBe(accepted.extraction_hash);
  expect(content.content).toBe(text);
  expect(await snapshot(opportunity, plan, plan.frozen_context)).toEqual(
    plan.frozen_context,
  );
});
it("retains exact legacy snapshot selection and shape instead of repinning old paid input", async () => {
  const { opportunity, document } = await prepare();
  await accept(document.id);
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const legacy = await snapshot(
    opportunity,
    plan,
    null,
    "draft_generation_snapshot_before_page_coverage",
  );
  expect(legacy.extraction_coverage_version).toBeUndefined();
  expect(legacy.input_materials.uses_notice_fallback).toBe(true);
  expect(legacy.blocks).toEqual([legacy.notice]);
  expect(await snapshot(opportunity, plan, legacy)).toEqual(legacy);
});
it("replays identical completion without changing hashes/blocks and rejects changed coverage", async () => {
  const { document } = await prepare();
  const first = await accept(document.id);
  const second = await accept(document.id);
  expect(second).toEqual(first);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.document_blocks where document_id=$1",
        [document.id],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    attempt(() =>
      accept(document.id, {
        ...coverage,
        pages: [
          coverage.pages[0],
          { ...coverage.pages[1], status: "extraction_failed" },
        ],
      }),
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("rejects fabricated complete status, page count, page character count and null fields", async () => {
  const { document } = await prepare();
  for (const invalid of [
    { ...coverage, complete: true },
    { ...coverage, pages: [coverage.pages[0]] },
    {
      ...coverage,
      pages: [{ ...coverage.pages[0], characters: 4 }, coverage.pages[1]],
    },
    { ...coverage, kind: null },
    {
      ...coverage,
      pages: [coverage.pages[0], { ...coverage.pages[1], status: null }],
    },
  ])
    await expect(attempt(() => accept(document.id, invalid))).rejects.toThrow(
      "INVALID_EXTRACTION_COVERAGE",
    );
  await expect(
    attempt(() => accept(document.id, coverage, "ready")),
  ).rejects.toThrow("INVALID_EXTRACTION_COVERAGE");
  const row = (
    await f.db.query<any>(
      "select status,extraction_coverage from public.documents where id=$1",
      [document.id],
    )
  ).rows[0];
  expect(row).toEqual({ status: "pending", extraction_coverage: null });
});
it("does not let the old RPC fabricate a partial extraction without coverage", async () => {
  const { document } = await prepare();
  await expect(
    attempt(() =>
      f.rpc("accept_uploaded_document", [
        document.id,
        f.owner,
        "a".repeat(64),
        100,
        text,
        "partial",
        "old-without-coverage",
      ]),
    ),
  ).rejects.toThrow("valid_extraction_coverage");
});
it("membership revocation rolls metadata back and the new internal RPC has no browser grants", async () => {
  const { document } = await prepare();
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(attempt(() => accept(document.id))).rejects.toThrow("NOT_FOUND");
  expect(
    (
      await f.db.query<any>(
        "select extraction_coverage from public.documents where id=$1",
        [document.id],
      )
    ).rows[0].extraction_coverage,
  ).toBeNull();
  const grants = (
    await f.db.query<any>(
      "select has_function_privilege('anon','public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb)','execute') anon,has_function_privilege('authenticated','public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb)','execute') authenticated",
    )
  ).rows[0];
  expect(grants).toEqual({ anon: false, authenticated: false });
});
it("archives a partial source without leaving it available to current content authorization", async () => {
  const { document } = await prepare();
  await accept(document.id);
  await f.db.query("update public.documents set archived=true where id=$1", [
    document.id,
  ]);
  await expect(
    attempt(() =>
      f.db.query("select app_private.content_record($1,'document',$2)", [
        f.w,
        document.id,
      ]),
    ),
  ).rejects.toThrow("NOT_FOUND");
});

it("preserves readable partial review attachments in their active scoped feedback only", async () => {
  const { opportunity, document } = await prepare();
  await accept(document.id);
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const version = (
    await f.db.query<any>(
      "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,1,repeat('b',64),$3) returning id",
      [f.w, plan.proposal_id, f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "update public.proposals set active_version_id=$1 where id=$2",
    [version, plan.proposal_id],
  );
  const review = (
    await f.db.query<any>(
      "insert into public.review_inputs(workspace_id,proposal_id,base_version_id,target_kind,target_id,body,source_signature,created_by) values($1,$2,$3,'general','general','Synthetic review text','synthetic',$4) returning id",
      [f.w, plan.proposal_id, version, f.owner],
    )
  ).rows[0].id;
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "review",
    review_input_id: review,
    original_name: "synthetic-feedback.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("verify_document_pages", [prepared.id, 2]);
  await accept(prepared.id);
  const current = await snapshot(opportunity, plan, null);
  expect(
    current.reviews.some(
      (source: any) =>
        source.reference.entity_id === prepared.id &&
        source.text.includes(sourceText) &&
        source.target_kind === "general",
    ),
  ).toBe(true);
  expect(
    current.input_materials.documents.find(
      (item: any) => item.document_id === prepared.id,
    ),
  ).toMatchObject({ used_for_draft: true, extraction_coverage: coverage });
  expect(await snapshot(opportunity, plan, current)).toEqual(current);
});

it("can preserve coverage for an unavailable restored original without admitting its content", async () => {
  const { document } = await prepare();
  await accept(document.id);
  await f.db.query("update public.documents set status='expired' where id=$1", [
    document.id,
  ]);
  expect(
    (
      await f.db.query<any>(
        "select extraction_coverage from public.documents where id=$1",
        [document.id],
      )
    ).rows[0].extraction_coverage,
  ).toEqual(coverage);
  await expect(
    attempt(() =>
      f.db.query("select app_private.content_record($1,'document',$2)", [
        f.w,
        document.id,
      ]),
    ),
  ).rejects.toThrow("NOT_FOUND");
});
