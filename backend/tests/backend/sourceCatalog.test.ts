// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { databaseWithMigrations } from "./databaseFixture";
import {
  buildSourceSeedSql,
  catalogSchema,
  catalogSourceId,
  readSourceCatalog,
  type SourceCatalog,
} from "../../scripts/backend/sourceCatalog";

const owner = "00000000-0000-4000-8000-000000000001";
const outsider = "00000000-0000-4000-8000-000000000002";
let db: PGlite, workspace: string, catalog: SourceCatalog;
beforeAll(async () => {
  catalog = await readSourceCatalog();
  db = await databaseWithMigrations();
  await db.query(
    "insert into auth.users values($1,'owner@example.test',now()),($2,'outsider@example.test',now())",
    [owner, outsider],
  );
  await db.query(
    "insert into auth.identities values($1,'email','{\"sub\":\"synthetic-owner\"}')",
    [owner],
  );
  workspace = (
    await db.query<{ id: string }>(
      "select public.bootstrap_workspace($1,'Synthetic catalog test') as id",
      [owner],
    )
  ).rows[0].id;
}, 30000);
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db?.close();
});

describe("official source catalog administrative seeder", () => {
  it("covers the three requested countries with unique official references", () => {
    expect(catalog.sources).toHaveLength(35);
    expect(
      ["SA", "JO", "PS"].map(
        (country) =>
          catalog.sources.filter((s) => s.country === country).length,
      ),
    ).toEqual([14, 11, 10]);
    expect(
      catalogSchema.safeParse({
        ...catalog,
        sources: [catalog.sources[0], catalog.sources[0]],
      }).success,
    ).toBe(false);
    expect(
      catalogSchema.safeParse({
        ...catalog,
        sources: [{ ...catalog.sources[0], url: "https://127.0.0.1/" }],
      }).success,
    ).toBe(false);
  });
  it("inserts all references and audit events without creating opportunities or enabling collection", async () => {
    await db.exec(buildSourceSeedSql(catalog, workspace, owner));
    const sources = (await db.query("select * from public.sources")).rows;
    expect(sources).toHaveLength(35);
    for (const row of sources)
      expect(row).toMatchObject({
        workspace_id: workspace,
        kind: "manual",
        approval: "proposed",
        health: "unknown",
        adapter_required: true,
        approved_hosts: [],
        next_due: null,
        created_by: owner,
      });
    const audits = (
      await db.query<{ request_id: string }>(
        "select * from public.audit_events where action='source.catalog.seed'",
      )
    ).rows;
    expect(audits).toHaveLength(35);
    expect(new Set(audits.map((a) => a.request_id)).size).toBe(1);
    expect(audits[0]).toMatchObject({ actor_id: owner, entity_type: "source" });
    for (const table of [
      "jobs",
      "opportunities",
      "documents",
      "model_settings",
    ])
      expect(
        (await db.query(`select * from public.${table}`)).rows,
      ).toHaveLength(0);
  });
  it("preserves an existing URL, user edits, paused state and revisions on repeated runs", async () => {
    await db.query(
      "insert into public.sources(workspace_id,name,kind,url,created_by,approval) values($1,'User-managed reference','manual',$2,$3,'paused')",
      [workspace, catalog.sources[0].url + "#view", owner],
    );
    const sql = buildSourceSeedSql(catalog, workspace, owner);
    await db.exec(sql);
    const id = catalogSourceId(workspace, catalog.sources[1].key);
    await db.query(
      "update public.sources set name='Owner edited',url='https://example.test/changed',approval='paused',revision=9,adapter_config='{}' where id=$1",
      [id],
    );
    await db.exec(sql);
    expect((await db.query("select * from public.sources")).rows).toHaveLength(
      35,
    );
    expect(
      (
        await db.query(
          "select * from public.audit_events where action='source.catalog.seed'",
        )
      ).rows,
    ).toHaveLength(34);
    expect(
      (
        await db.query(
          "select name,url,approval,revision from public.sources where id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({
      name: "Owner edited",
      url: "https://example.test/changed",
      approval: "paused",
      revision: 9,
    });
    expect(
      (
        await db.query(
          "select * from public.sources where name='User-managed reference'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rolls back the entire insertion on workspace capacity failure", async () => {
    await db.query(
      "insert into public.sources(workspace_id,name,kind,created_by) select $1,'Synthetic existing '||n,'manual',$2 from generate_series(1,499) n",
      [workspace, owner],
    );
    await db.exec("savepoint before_seed");
    await expect(
      db.exec(buildSourceSeedSql(catalog, workspace, owner)),
    ).rejects.toThrow("SOURCE_CAP_REACHED");
    await db.exec("rollback to savepoint before_seed");
    expect((await db.query("select * from public.sources")).rows).toHaveLength(
      499,
    );
    expect(
      (
        await db.query(
          "select * from public.audit_events where action='source.catalog.seed'",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("requires a real active Owner and leaves browser roles unable to run administrative SQL", async () => {
    await db.exec("savepoint before_seed");
    await expect(
      db.exec(buildSourceSeedSql(catalog, workspace, outsider)),
    ).rejects.toThrow("ACTIVE_OWNER_REQUIRED");
    await db.exec("rollback to savepoint before_seed; set role authenticated");
    await expect(
      db.exec(buildSourceSeedSql(catalog, workspace, owner)),
    ).rejects.toThrow(/permission denied/);
    await db.exec("rollback to savepoint before_seed; reset role");
    await db.query(
      "update public.memberships set active=false where user_id=$1",
      [owner],
    );
    await expect(
      db.exec(buildSourceSeedSql(catalog, workspace, owner)),
    ).rejects.toThrow("ACTIVE_OWNER_REQUIRED");
  });
  it("quotes catalog text safely and namespaces stable identities by workspace", async () => {
    const name = "Synthetic ' \\ $source_seed$ ; DROP TABLE public.sources; --";
    await db.exec(
      buildSourceSeedSql(
        { ...catalog, sources: [{ ...catalog.sources[0], name }] },
        workspace,
        owner,
      ),
    );
    expect((await db.query("select name from public.sources")).rows).toEqual([
      { name },
    ]);
    expect(catalogSourceId(workspace, "sa-etimad")).not.toBe(
      catalogSourceId(outsider, "sa-etimad"),
    );
  });
});
