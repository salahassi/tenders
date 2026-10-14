// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

const owner = "00000000-0000-4000-8000-000000000001",
  editor = "00000000-0000-4000-8000-000000000002",
  reviewer = "00000000-0000-4000-8000-000000000003",
  outsider = "00000000-0000-4000-8000-000000000004";
let db: PGlite;
let workspace: string;
let source: string;
async function asUser(id: string, query: string, params: unknown[] = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
  try {
    return await db.query(query, params);
  } finally {
    await db.exec("reset role");
  }
}
const command = (
  id: string,
  operation: string,
  input: unknown,
  key = crypto.randomUUID(),
) =>
  asUser(id, "select public.app_command($1,$2::jsonb,$3) as data", [
    operation,
    JSON.stringify(input),
    key,
  ]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;
  `);
  const migrationsDirectory = new URL(
    "../../supabase/migrations/",
    import.meta.url,
  );
  for (const name of (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort())
    await db.exec(
      await readFile(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  for (const [id, role] of [
    [owner, "Owner"],
    [editor, "Editor"],
    [reviewer, "Reviewer"],
    [outsider, "unapproved"],
  ]) {
    await db.query("insert into auth.users values($1,$2,now())", [
      id,
      `${role.toLowerCase()}@example.test`,
    ]);
    await db.query(
      "insert into auth.identities values($1,'github',$2::jsonb)",
      [id, JSON.stringify({ sub: `synthetic-${role}` })],
    );
  }
  const result = await db.query<{ id: string }>(
    "select public.bootstrap_workspace($1,'Synthetic policy test') as id",
    [owner],
  );
  workspace = result.rows[0].id;
  for (const [id, role] of [
    [editor, "Editor"],
    [reviewer, "Reviewer"],
  ]) {
    await db.query(
      "insert into public.memberships(workspace_id,user_id,role,created_by) values($1,$2,$3,$4)",
      [workspace, id, role, owner],
    );
    await db.query(
      "insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values($1,'github',$2,$3,$4,$5,$6)",
      [
        workspace,
        `synthetic-${role}`,
        `${role.toLowerCase()}@example.test`,
        id,
        role,
        owner,
      ],
    );
  }
}, 30000);
afterAll(async () => {
  await db?.close();
});

describe("real PostgreSQL migrations and authorization", () => {
  it("locks bootstrap after one verified owner and denies unapproved reads", async () => {
    await expect(
      db.query("select public.bootstrap_workspace($1,'Duplicate')", [owner]),
    ).rejects.toThrow("BOOTSTRAP_CLOSED");
    expect(
      (await asUser(outsider, "select * from public.workspaces")).rows,
    ).toEqual([]);
    expect(
      (await asUser(owner, "select * from public.workspaces")).rows,
    ).toHaveLength(1);
    await expect(
      command(outsider, "source.create", { name: "Denied", kind: "manual" }),
    ).rejects.toThrow("ACCESS_PENDING");
  });
  it("enforces actor roles, direct-write denial and atomic idempotency", async () => {
    const key = crypto.randomUUID(),
      input = { name: "Synthetic manual source", kind: "manual" };
    const first = await command(editor, "source.create", input, key),
      replay = await command(editor, "source.create", input, key);
    expect(first.rows).toEqual(replay.rows);
    source = (first.rows[0] as { data: { id: string } }).data.id;
    await expect(
      command(
        editor,
        "source.create",
        { ...input, name: "Different body" },
        key,
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(command(reviewer, "source.create", input)).rejects.toThrow(
      "ROLE_FORBIDDEN",
    );
    await expect(
      asUser(editor, "update public.sources set approval='approved'"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      command(editor, "source.action", {
        id: source,
        action: "approve",
        reason: "Test",
        expected_revision: 1,
      }),
    ).rejects.toThrow("ROLE_FORBIDDEN");
    expect(
      (
        await db.query(
          "select * from public.audit_events where action='source.create'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rejects stale revisions and prevents last owner removal", async () => {
    const created = await command(editor, "opportunity.create", {
      source_id: source,
      title: "Synthetic software service",
      reference: "SYN-1",
    });
    const id = (created.rows[0] as { data: { id: string } }).data.id;
    await command(editor, "opportunity.decision", {
      id,
      target_state: "shortlisted",
      reason: "Known scope",
      expected_revision: 1,
    });
    await expect(
      command(editor, "opportunity.decision", {
        id,
        target_state: "declined",
        reason: "Stale edit",
        expected_revision: 1,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      command(owner, "membership.set", {
        user_id: owner,
        role: "Editor",
        active: true,
        reason: "Test",
        expected_revision: 1,
      }),
    ).rejects.toThrow("LAST_OWNER_REQUIRED");
  });
  it("reserves a private file path and rejects unauthorized storage and oversize uploads", async () => {
    const knowledge = await command(editor, "knowledge.save", {
      category: "team",
      title: "Synthetic team",
      content: "Fictional records",
    });
    const id = (knowledge.rows[0] as { data: { id: string } }).data.id;
    const reservation = await command(editor, "document.prepare", {
      kind: "company",
      knowledge_item_id: id,
      original_name: "team.txt",
      mime_type: "text/plain",
      size: 64,
      hash: "a".repeat(64),
    });
    const doc = (
      reservation.rows[0] as { data: { id: string; storage_key: string } }
    ).data;
    expect(doc.storage_key).toBe(`${workspace}/${doc.id}`);
    await expect(
      asUser(
        outsider,
        "insert into storage.objects(bucket_id,name) values('tenderdesk-private',$1)",
        [doc.storage_key],
      ),
    ).rejects.toThrow(/row-level security/);
    await asUser(
      editor,
      "insert into storage.objects(bucket_id,name) values('tenderdesk-private',$1)",
      [doc.storage_key],
    );
    await expect(
      command(editor, "document.prepare", {
        kind: "company",
        knowledge_item_id: id,
        original_name: "large.txt",
        mime_type: "text/plain",
        size: 10485761,
        hash: "b".repeat(64),
      }),
    ).rejects.toThrow(/check constraint/);
    expect(
      (await asUser(outsider, "select * from storage.objects")).rows,
    ).toEqual([]);
    await expect(
      asUser(
        editor,
        "select public.accept_uploaded_document($1,$2,$3,64,'text','ready','synthetic-completion')",
        [doc.id, editor, "a".repeat(64)],
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("keeps multiple section and question inputs scoped, including a file-only input", async () => {
    const opportunity = (
      await db.query<{ id: string }>(
        "select id from public.opportunities limit 1",
      )
    ).rows[0].id;
    const proposal = crypto.randomUUID(),
      version = crypto.randomUUID(),
      question = crypto.randomUUID();
    await db.query(
      "insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values($1,$2,$3,'Synthetic proposal',$4)",
      [proposal, workspace, opportunity, owner],
    );
    await db.query(
      "insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,$3,1,$4,$5)",
      [version, workspace, proposal, "c".repeat(64), owner],
    );
    await db.query(
      "update public.proposals set active_version_id=$1 where id=$2",
      [version, proposal],
    );
    for (const key of ["scope", "terms"])
      await db.query(
        "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by) values($1,$2,$3,$3,'Saved content',0,$4)",
        [workspace, version, key, owner],
      );
    await db.query(
      "insert into public.questions(id,workspace_id,opportunity_id,question,created_by) values($1,$2,$3,'Which team is available?',$4)",
      [question, workspace, opportunity, owner],
    );
    await command(editor, "review.save", {
      id: proposal,
      base_version_id: version,
      source_signature: "fixture",
      expected_revision: 1,
      inputs: [
        { target_kind: "section", target_id: "scope", body: "عدّل النطاق" },
        { target_kind: "section", target_id: "terms", body: "Revise validity" },
        { target_kind: "question", target_id: question, body: "" },
      ],
    });
    const inputs = await db.query<{
      id: string;
      target_id: string;
      body: string;
    }>("select id,target_id,body from public.review_inputs order by target_id");
    expect(inputs.rows).toHaveLength(3);
    const empty = inputs.rows.find((x) => x.target_id === question)!;
    expect(empty.body).toBe("");
    await command(editor, "document.prepare", {
      kind: "review",
      review_input_id: empty.id,
      original_name: "answer.txt",
      mime_type: "text/plain",
      size: 32,
      hash: "d".repeat(64),
    });
    expect(
      (
        await db.query(
          "select ordinal from public.proposal_versions where proposal_id=$1",
          [proposal],
        )
      ).rows,
    ).toEqual([{ ordinal: 1 }]);
    expect(
      (
        await db.query(
          "select body from public.proposal_sections where proposal_version_id=$1",
          [version],
        )
      ).rows.every(
        (r: unknown) => (r as { body: string }).body === "Saved content",
      ),
    ).toBe(true);
  });
  it("finalizes originals once, detects changed replays, and denies a revoked identity", async () => {
    const knowledge = await command(editor, "knowledge.save", {
      category: "other",
      title: "Synthetic completion evidence",
      content: "Synthetic",
    });
    const knowledgeId = (knowledge.rows[0] as { data: { id: string } }).data.id;
    const reservation = await command(editor, "document.prepare", {
      kind: "company",
      knowledge_item_id: knowledgeId,
      original_name: "evidence.txt",
      mime_type: "text/plain",
      size: 32,
      hash: "e".repeat(64),
    });
    const documentId = (reservation.rows[0] as { data: { id: string } }).data
      .id;
    const complete = (text = "Synthetic evidence") =>
      db.query(
        "select public.accept_uploaded_document($1,$2,$3,32,$4,'ready','completion-once') as data",
        [documentId, editor, "e".repeat(64), text],
      );
    expect((await complete()).rows).toEqual((await complete()).rows);
    await expect(complete("Changed replay")).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(
      (
        await db.query(
          "select * from public.audit_events where entity_id=$1 and action='document.accepted'",
          [documentId],
        )
      ).rows,
    ).toHaveLength(1);
    await db.query(
      "update public.identity_allowlist set status='inactive' where user_id=$1",
      [editor],
    );
    await expect(complete()).rejects.toThrow("NOT_FOUND");
    await db.query(
      "update public.identity_allowlist set status='active' where user_id=$1",
      [editor],
    );
  });
  it("revoking membership removes direct record access", async () => {
    await command(owner, "membership.set", {
      user_id: reviewer,
      role: "Reviewer",
      active: false,
      reason: "Pilot revoked",
      expected_revision: 1,
    });
    expect(
      (await asUser(reviewer, "select * from public.sources")).rows,
    ).toEqual([]);
    await expect(
      asUser(reviewer, "select public.claim_backend_job()"),
    ).rejects.toThrow(/permission denied/);
  });
});
