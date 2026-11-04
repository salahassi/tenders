// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";

const migration = "20261104212818_bounded_command_batch_results.sql";
const legacyCommands = [
  {
    operation: "source.create",
    input: { name: "Synthetic saved legacy batch", kind: "manual" },
  },
];
const legacyKey = "synthetic-before-transport-cutover";
let f: Awaited<ReturnType<typeof workflowFixture>>;
let legacyReceipt: unknown;
let oldAuthority: unknown;

async function sql<T = any>(query: string, args: unknown[] = []) {
  return (await f.db.query<T>(query, args)).rows;
}
async function rpc(name: string, args: unknown[], actor = f.owner) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    actor,
  ]);
  await f.db.exec("set role authenticated;savepoint chunk_rpc");
  try {
    return (
      await sql(
        `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`,
        args,
      )
    )[0].result;
  } catch (error) {
    await f.db.exec("rollback to savepoint chunk_rpc");
    throw error;
  } finally {
    await f.db.exec("release savepoint chunk_rpc;reset role");
  }
}
const prepare = (commands: unknown, key: string = crypto.randomUUID()) =>
  rpc("app_batch_prepare", [JSON.stringify(commands), key]);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function values(manifest: any) {
  expect(manifest.version).toBe(1);
  expect(manifest.chunk_bytes).toBe(262144);
  expect(manifest.results).toHaveLength(manifest.result_count);
  const result = [];
  for (const descriptor of manifest.results) {
    const parts: Buffer[] = [];
    for (let index = 0; index < descriptor.chunk_count; index++) {
      const chunk = await rpc("app_batch_result_chunk", [
        manifest.receipt_id,
        descriptor.ordinal,
        index,
      ]);
      expect(chunk).toMatchObject({
        version: 1,
        receipt_id: manifest.receipt_id,
        result_ordinal: descriptor.ordinal,
        chunk_index: index,
      });
      expect(chunk.data_base64).not.toMatch(/[\r\n\s]/);
      const bytes = Buffer.from(chunk.data_base64, "base64");
      expect(bytes.byteLength).toBe(chunk.byte_length);
      expect(bytes.byteLength).toBeLessThanOrEqual(262144);
      expect(digest(bytes)).toBe(chunk.sha256);
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    expect(bytes.byteLength).toBe(descriptor.byte_length);
    expect(digest(bytes)).toBe(descriptor.sha256);
    result.push(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  }
  return result;
}
beforeAll(async () => {
  f = await workflowFixture(
    undefined,
    "20261104172700_storage_write_retirement_proofs.sql",
  );
  await f.db.exec("begin");
  await rpc("app_batch", [JSON.stringify(legacyCommands), legacyKey]);
  await f.db.exec("commit");
  legacyReceipt = await sql(
    "select to_jsonb(r) value from app_private.idempotency_records r order by method,route,key",
  );
  oldAuthority = await sql(
    "select n.nspname,p.proname,p.proowner,p.prosecdef,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname='app_batch') or (n.nspname='app_private' and p.proname='apply_batch') order by n.nspname",
  );
  await f.db.exec(
    await readFile(
      new URL(`../../supabase/migrations/${migration}`, import.meta.url),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

it("preserves every old receipt and old function authority while cutting off both aggregate entry points before effects", async () => {
  expect(
    await sql(
      "select to_jsonb(r) value from app_private.idempotency_records r order by method,route,key",
    ),
  ).toEqual(legacyReceipt);
  expect(
    await sql(
      "select n.nspname,p.proname,p.proowner,p.prosecdef,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname='app_batch') or (n.nspname='app_private' and p.proname='apply_batch') order by n.nspname",
    ),
  ).toEqual(oldAuthority);
  await expect(
    rpc("app_batch", [JSON.stringify(legacyCommands), "new-old-path"]),
  ).rejects.toThrow("TRANSPORT_UPGRADE_REQUIRED");
  await expect(
    f.db.query("select app_private.apply_batch($1,$2)", [
      JSON.stringify(legacyCommands),
      "private-old-path",
    ]),
  ).rejects.toThrow("TRANSPORT_UPGRADE_REQUIRED");
});

it("rejects historical replay before remutation and keeps the original aggregate authoritative", async () => {
  await expect(prepare(legacyCommands, legacyKey)).rejects.toThrow(
    "BATCH_LEGACY_NORMALIZATION_REQUIRED",
  );
  await expect(
    prepare(
      [{ ...legacyCommands[0], input: { name: "Different", kind: "manual" } }],
      legacyKey,
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    await sql(
      "select to_jsonb(r) value from app_private.idempotency_records r order by method,route,key",
    ),
  ).toEqual(legacyReceipt);
  expect(
    (
      await sql(
        "select count(*)::int n from app_private.command_batch_receipts",
      )
    )[0].n,
  ).toBe(0);
});

it("rejects late legacy inserts but preserves historical purge UPDATE and retention DELETE", async () => {
  await f.db.exec("savepoint late_legacy_insert");
  await expect(f.db.query("insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values($1,$2,'BATCH','commands','late-legacy',repeat('a',64),'[]')", [f.w, f.owner])).rejects.toThrow("TRANSPORT_UPGRADE_REQUIRED");
  await f.db.exec("rollback to savepoint late_legacy_insert;release savepoint late_legacy_insert");
  await f.db.query("update app_private.idempotency_records set result='{\"purged\":true}' where method='BATCH' and key=$1", [legacyKey]);
  expect((await sql("select result from app_private.idempotency_records where method='BATCH' and key=$1", [legacyKey]))[0].result).toEqual({ purged: true });
  await f.db.query("delete from app_private.idempotency_records where method='BATCH' and key=$1", [legacyKey]);
  expect(await sql("select key from app_private.idempotency_records where method='BATCH' and key=$1", [legacyKey])).toEqual([]);
});

it("returns every ordered result, preserves bytes and replays without repeating writes or audit", async () => {
  const commands = [
    {
      operation: "source.create",
      input: { name: 'Synthetic "quoted" source', kind: "manual" },
    },
    {
      operation: "source.create",
      input: { name: "مصدر اختبار عربي", kind: "manual" },
    },
  ];
  const key = crypto.randomUUID();
  const first = await prepare(commands, key);
  expect(first.results.map((x: any) => x.ordinal)).toEqual([0, 1]);
  const output = await values(first);
  expect(output.map((x) => x.name)).toEqual(commands.map((x) => x.input.name));
  const counts = await sql(
    "select (select count(*) from public.sources)::int sources,(select count(*) from public.audit_events)::int audits,(select count(*) from app_private.command_batch_chunks)::int chunks",
  );
  expect(await prepare(commands, key)).toEqual(first);
  expect(await values(first)).toEqual(output);
  expect(
    await sql(
      "select (select count(*) from public.sources)::int sources,(select count(*) from public.audit_events)::int audits,(select count(*) from app_private.command_batch_chunks)::int chunks",
    ),
  ).toEqual(counts);
  expect(
    (
      await sql(
        "select count(*)::int n from app_private.idempotency_records where method='BATCH' and key=$1",
        [key],
      )
    )[0].n,
  ).toBe(0);
});

it("rolls back all earlier commands, audits and chunks when a later real command fails", async () => {
  const before = await sql(
    "select (select count(*) from public.sources)::int sources,(select count(*) from public.audit_events)::int audits,(select count(*) from app_private.idempotency_records)::int records",
  );
  await expect(
    prepare([
      {
        operation: "source.create",
        input: { name: "Must roll back", kind: "manual" },
      },
      {
        operation: "export.renew",
        input: { id: crypto.randomUUID(), expected_revision: 1 },
      },
    ]),
  ).rejects.toThrow("REVISION_CONFLICT");
  expect(
    await sql(
      "select (select count(*) from public.sources)::int sources,(select count(*) from public.audit_events)::int audits,(select count(*) from app_private.idempotency_records)::int records",
    ),
  ).toEqual(before);
  expect(
    (
      await sql(
        "select count(*)::int n from app_private.command_batch_receipts",
      )
    )[0].n,
  ).toBe(0);
  expect(
    (
      await sql("select count(*)::int n from app_private.command_batch_chunks")
    )[0].n,
  ).toBe(0);
});

it("frames a genuine large authorized export result across fixed binary chunks without changing Arabic", async () => {
  const data = await commercialHelpers(f).setup();
  await f.db.query(
    "update public.proposal_sections set body=repeat('أ',100000) where proposal_version_id=$1",
    [data.version],
  );
  await f.db.query(
    "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by) values($1,$2,'second','Second',repeat('ب',100000),1,$3)",
    [f.w, data.version, f.owner],
  );
  const manifest = await prepare([
    {
      operation: "export.prepare",
      input: {
        proposal_version_id: data.version,
        expected_revision: 1,
        mode: "draft",
        volume: "combined",
      },
    },
  ]);
  expect(manifest.results[0].chunk_count).toBeGreaterThan(1);
  const [result] = await values(manifest);
  expect(result.snapshot.sections[0].body).toBe("أ".repeat(100000));
  expect(result.snapshot.sections[1].body).toBe("ب".repeat(100000));
});

it("rechecks ownership and current membership for every chunk and manifest replay", async () => {
  const key = crypto.randomUUID();
  const manifest = await prepare(legacyCommands, key);
  await expect(
    rpc(
      "app_batch_result_chunk",
      [manifest.receipt_id, 0, 0],
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("BATCH_RESULT_NOT_FOUND");
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    rpc("app_batch_result_chunk", [manifest.receipt_id, 0, 0]),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  await expect(prepare(legacyCommands, key)).rejects.toThrow("ACCESS_PENDING");
});

it("does not turn expired results into another business mutation", async () => {
  const key = crypto.randomUUID();
  const manifest = await prepare(legacyCommands, key);
  await f.db.query(
    "update app_private.command_batch_receipts set expires_at=now()-interval '1 second' where id=$1",
    [manifest.receipt_id],
  );
  await expect(
    rpc("app_batch_result_chunk", [manifest.receipt_id, 0, 0]),
  ).rejects.toThrow("BATCH_RESULT_EXPIRED");
  await expect(prepare(legacyCommands, key)).rejects.toThrow(
    "BATCH_RESULT_EXPIRED",
  );
});

it("purges only matching UUID results across a chunk boundary and rolls the invalidation back on late purge failure", async () => {
  const source = await f.command("source.create", {
    name: "Synthetic purge target",
    kind: "manual",
  });
  const target = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic selected purge",
    reference: "P1",
    decision: "shortlisted",
  });
  const data = await commercialHelpers(f).setup();
  await f.db.query(
    "update public.proposal_sections set body=$1 where proposal_version_id=$2",
    [target.id + "测".repeat(99964), data.version],
  );
  const input = {
    proposal_version_id: data.version,
    expected_revision: 1,
    mode: "draft",
    volume: "combined",
  };
  const initialKey = crypto.randomUUID();
  await f.command("export.prepare", input, initialKey);
  const initial = (
    await sql(
      "select result::text value from app_private.idempotency_records where method='COMMAND' and route='export.prepare' and key=$1",
      [initialKey],
    )
  )[0].value;
  const prefixBytes = Buffer.byteLength(
    initial.slice(0, initial.indexOf(target.id)),
  );
  const characters = Math.floor((262144 - 18 - prefixBytes) / 3);
  expect(characters).toBeGreaterThan(0);
  await f.db.query(
    "update public.proposal_sections set body=$1 where proposal_version_id=$2",
    [
      "测".repeat(characters) +
        target.id +
        "测".repeat(100000 - characters - 36),
      data.version,
    ],
  );
  const key = crypto.randomUUID();
  const commands = [{ operation: "export.prepare", input }];
  const selected = await prepare(commands, key);
  const unrelated = await prepare(legacyCommands);
  expect(
    (
      await sql(
        "select count(*)::int n from app_private.command_batch_chunks where receipt_id=$1 and position(convert_to($2,'UTF8') in data)>0",
        [selected.receipt_id, target.id],
      )
    )[0].n,
  ).toBe(0);
  const saved = await values(selected);
  expect(saved[0].snapshot.sections[0].body).toContain(target.id);
  await rpc("archive_opportunity", [
    target.id,
    target.revision,
    true,
    "Synthetic owner selected purge",
  ]);
  const preview = await rpc("preview_opportunity_purge", [target.id]);
  const args = [
    target.id,
    preview.preview_hash,
    target.title,
    "Synthetic owner approved removal",
    true,
  ];
  await f.db.exec(
    "create function app_private.synthetic_late_purge() returns trigger language plpgsql as $$begin if new.action='opportunity.purged' then raise exception 'SYNTHETIC_LATE_PURGE';end if;return new;end$$;create trigger synthetic_late_purge before insert on public.audit_events for each row execute function app_private.synthetic_late_purge();",
  );
  await expect(rpc("purge_opportunity", args)).rejects.toThrow(
    "SYNTHETIC_LATE_PURGE",
  );
  expect(await values(selected)).toEqual(saved);
  await f.db.exec(
    "drop trigger synthetic_late_purge on public.audit_events;drop function app_private.synthetic_late_purge()",
  );
  await rpc("purge_opportunity", args);
  await expect(
    rpc("app_batch_result_chunk", [selected.receipt_id, 0, 0]),
  ).rejects.toThrow("BATCH_RESULT_PURGED");
  await expect(prepare(commands, key)).rejects.toThrow("BATCH_RESULT_PURGED");
  expect((await values(unrelated))[0].name).toBe(legacyCommands[0].input.name);
});

it.each([
  [null, 0],
  [-1, 0],
  [0, null],
  [0, -1],
  [1, 0],
  [0, 1],
])(
  "rejects invalid ordinal/index %j/%j without an aggregate fallback",
  async (ordinal, index) => {
    const manifest = await prepare(legacyCommands);
    await expect(
      rpc("app_batch_result_chunk", [manifest.receipt_id, ordinal, index]),
    ).rejects.toThrow("INVALID_INPUT");
  },
);

it("keeps private result data and helper RPCs inaccessible to authenticated/service roles", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect(
      (
        await sql(
          "select has_table_privilege($1,'app_private.command_batch_chunks','SELECT') allowed",
          [role],
        )
      )[0].allowed,
    ).toBe(false);
    expect(
      (
        await sql(
          "select has_function_privilege($1,'app_private.command_batch_access(uuid)','EXECUTE') allowed",
          [role],
        )
      )[0].allowed,
    ).toBe(false);
  }
  expect(
    (
      await sql(
        "select has_function_privilege('authenticated','public.app_batch_prepare(jsonb,text)','EXECUTE') allowed",
      )
    )[0].allowed,
  ).toBe(true);
});

it("preserves the existing100-command admission boundary and rejects null input before effects", async () => {
  await expect(prepare(null)).rejects.toThrow("INVALID_INPUT");
  await expect(
    prepare(Array.from({ length: 101 }, () => legacyCommands[0])),
  ).rejects.toThrow("INVALID_INPUT");
  expect(
    (
      await sql(
        "select count(*)::int n from app_private.command_batch_receipts",
      )
    )[0].n,
  ).toBe(0);
});
