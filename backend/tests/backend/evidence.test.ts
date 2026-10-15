// @vitest-environment node
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { databaseWithMigrations } from "./databaseFixture";
const owner = "00000000-0000-4000-8000-000000000001",
  reviewer = "00000000-0000-4000-8000-000000000002";
let db: PGlite, w: string, o: string, p: string, v: string;
async function command(
  actor: string,
  operation: string,
  input: unknown,
  key = crypto.randomUUID(),
): Promise<any> {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    actor,
  ]);
  await db.exec("set role authenticated");
  try {
    return (
      await db.query<{ result: any }>(
        "select public.app_command($1,$2::jsonb,$3) result",
        [operation, JSON.stringify(input), key],
      )
    ).rows[0].result;
  } finally {
    await db.exec("reset role");
  }
}
async function prepare(
  kind = "rfp",
  target: Record<string, string> = { opportunity_id: o },
  actor = owner,
) {
  return command(actor, "document.prepare", {
    eligibility_attested: true,
    client_id: crypto.randomUUID(),
    kind,
    ...target,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 50,
    hash: "a".repeat(64),
  });
}
async function accept(id: string, text: string, actor = owner) {
  return db.query(
    "select public.accept_uploaded_document($1,$2,$3,50,$4,'ready',$5)",
    [id, actor, "a".repeat(64), text, crypto.randomUUID()],
  );
}
beforeAll(async () => {
  db = await databaseWithMigrations();
  for (const [id, role] of [
    [owner, "Owner"],
    [reviewer, "Reviewer"],
  ]) {
    await db.query("insert into auth.users values($1,$2,now())", [
      id,
      `${role}@example.test`,
    ]);
    await db.query("insert into auth.identities values($1,'email',$2::jsonb)", [
      id,
      JSON.stringify({ sub: id }),
    ]);
  }
  w = (
    await db.query<{ id: string }>(
      "select public.bootstrap_workspace($1,'Synthetic evidence') id",
      [owner],
    )
  ).rows[0].id;
  await db.query(
    "insert into public.memberships(workspace_id,user_id,role,created_by) values($1,$2,'Reviewer',$3)",
    [w, reviewer, owner],
  );
  await db.query(
    "insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values($1,'email',$2::uuid::text,'Reviewer@example.test',$2::uuid,'Reviewer',$3)",
    [w, reviewer, owner],
  );
  const source = await command(owner, "source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  o = (
    await command(owner, "opportunity.create", {
      source_id: source.id,
      title: "Synthetic test",
      reference: "T1",
    })
  ).id;
  p = crypto.randomUUID();
  v = crypto.randomUUID();
  await db.query(
    "insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values($1,$2,$3,'Synthetic',$4)",
    [p, w, o, owner],
  );
  await db.query(
    "insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,$3,1,$4,$5)",
    [v, w, p, "b".repeat(64), owner],
  );
  await db.query(
    "update public.proposals set active_version_id=$1 where id=$2",
    [v, p],
  );
  await db.query(
    "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by) values($1,$2,'scope','Scope','Synthetic scope',0,$3)",
    [w, v, owner],
  );
}, 30000);
afterAll(async () => db?.close());
it("assembles bounded extraction parts without accepting gaps or changed retries", async () => {
  const d = await prepare();
  await command(owner, "document.extraction", {
    id: d.id,
    parts: [{ ordinal: 1, text: "second" }],
  });
  await expect(
    db.query("select public.upload_extraction($1)", [d.id]),
  ).rejects.toThrow("EXTRACTION_INCOMPLETE");
  await command(owner, "document.extraction", {
    id: d.id,
    parts: [{ ordinal: 0, text: "first" }],
  });
  expect(
    (
      await db.query<{ t: string }>("select public.upload_extraction($1) t", [
        d.id,
      ])
    ).rows[0].t,
  ).toBe("firstsecond");
  await expect(
    command(owner, "document.extraction", {
      id: d.id,
      parts: [{ ordinal: 0, text: "changed" }],
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await accept(d.id, "firstsecond");
  await expect(
    command(owner, "document.extraction", {
      id: d.id,
      parts: [{ ordinal: 0, text: "changed" }],
    }),
  ).rejects.toThrow("UPLOAD_ALREADY_FINALIZED");
  await command(owner, "document.archive", {
    id: d.id,
    expected_revision: 2,
    reason: "Synthetic cleanup",
  });
});
it("preserves immutable original hashes and overlapping source blocks; seals only confirmed extraction", async () => {
  const d = await prepare(),
    text = "Synthetic evidence ".repeat(1000);
  await accept(d.id, text);
  const rows = (
    await db.query<{ text: string; locator: { start: number; end: number } }>(
      "select text,locator from public.document_blocks where document_id=$1 order by ordinal",
      [d.id],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0].text.slice(-1000)).toBe(rows[1].text.slice(0, 1000));
  expect(rows[1].locator.start).toBe(11001);
  await expect(accept(d.id, "changed")).rejects.toThrow(
    "UPLOAD_ALREADY_FINALIZED",
  );
  await expect(
    db.query("select app_private.seal_package($1,$2,$3)", [w, o, owner]),
  ).rejects.toThrow("EXTRACTION_REVIEW_REQUIRED");
  await command(owner, "document.confirm", { id: d.id, expected_revision: 2 });
  const one = (
    await db.query(
      "select (app_private.seal_package($1,$2,$3)).package_hash hash",
      [w, o, owner],
    )
  ).rows;
  const two = (
    await db.query(
      "select (app_private.seal_package($1,$2,$3)).package_hash hash",
      [w, o, owner],
    )
  ).rows;
  expect(two).toEqual(one);
  await db.query("select public.verify_document_pages($1,180)", [d.id]);
});
it("enforces actual aggregate PDF page counts and invalidates approvals after evidence changes", async () => {
  const d = await prepare();
  await expect(
    db.query("select public.verify_document_pages($1,21)", [d.id]),
  ).rejects.toThrow("PACKAGE_PAGE_CAP_REACHED");
  await db.query("update public.proposals set state='approved' where id=$1", [
    p,
  ]);
  await accept(d.id, "Another synthetic addendum.");
  expect(
    (
      await db.query<{ state: string }>(
        "select state from public.proposals where id=$1",
        [p],
      )
    ).rows[0].state,
  ).toBe("draft");
});
it("permits reviewer-owned text and file-only feedback without changing saved sections", async () => {
  const revision = (
    await db.query<{ revision: number }>(
      "select revision from public.proposals where id=$1",
      [p],
    )
  ).rows[0].revision;
  const result = await command(reviewer, "review.save", {
    id: p,
    base_version_id: v,
    expected_revision: revision,
    source_signature: "synthetic",
    inputs: [{ target_kind: "section", target_id: "scope", body: "" }],
  });
  const review = result.inputs[0];
  const d = await prepare("review", { review_input_id: review.id }, reviewer);
  await accept(d.id, "Synthetic reviewer evidence.", reviewer);
  expect(
    (
      await db.query<{ body: string }>(
        "select body from public.proposal_sections where proposal_version_id=$1",
        [v],
      )
    ).rows[0].body,
  ).toBe("Synthetic scope");
  await expect(
    prepare("review", { review_input_id: review.id }, owner),
  ).rejects.toThrow("REVIEW_TARGET_INVALID");
  await expect(prepare("rfp", { opportunity_id: o }, reviewer)).rejects.toThrow(
    "ROLE_FORBIDDEN",
  );
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    reviewer,
  ]);
  await db.exec("set role authenticated");
  await expect(
    db.query("update public.document_blocks set text='tampered'"),
  ).rejects.toThrow("permission denied");
  await db.exec("reset role");
});
it("revoked uploaders cannot finalize pending originals", async () => {
  const revision = (
    await db.query<{ revision: number }>(
      "select revision from public.proposals where id=$1",
      [p],
    )
  ).rows[0].revision;
  const result = await command(reviewer, "review.save", {
    id: p,
    base_version_id: v,
    expected_revision: revision,
    source_signature: "synthetic",
    inputs: [{ target_kind: "general", target_id: "general", body: "pending" }],
  });
  const d = await prepare(
    "review",
    {
      review_input_id: result.inputs.find(
        (x: any) => x.target_kind === "general",
      ).id,
    },
    reviewer,
  );
  await db.query(
    "update public.memberships set active=false where user_id=$1",
    [reviewer],
  );
  await expect(accept(d.id, "Not authorized.", reviewer)).rejects.toThrow(
    "NOT_FOUND",
  );
});
