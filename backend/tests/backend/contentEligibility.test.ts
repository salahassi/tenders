// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
it("requires an exact-original attestation before an upload reservation exists", async () => {
  const s = await f.command("source.create", {
      name: "Manual",
      kind: "manual",
    }),
    o = await f.command("opportunity.create", {
      source_id: s.id,
      title: "Synthetic",
      reference: "X",
    });
  const input = {
    kind: "rfp",
    opportunity_id: o.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
  };
  await expect(f.command("document.prepare", input)).rejects.toThrow(
    "ORIGINAL_ELIGIBILITY_REQUIRED",
  );
  expect(
    (await f.db.query("select id from public.documents")).rows,
  ).toHaveLength(0);
  const d = await f.command("document.prepare", {
    ...input,
    eligibility_attested: true,
  });
  const row = (
    await f.db.query<any>("select * from public.documents where id=$1", [d.id])
  ).rows[0];
  expect(row.eligibility_hash).toBe(input.hash);
  expect(row.eligibility_reviewed_by).toBe(f.owner);
  expect(row.eligibility_reviewed_at).toBeTruthy();
});
it("rejects prohibited free text transactionally before persistence", async () => {
  const s = await f.command("source.create", {
    name: "Manual",
    kind: "manual",
  });
  await expect(
    f.command("opportunity.create", {
      source_id: s.id,
      title: "Synthetic",
      reference: "X",
      description: "Contact a.person@example.test",
    }),
  ).rejects.toThrow("DATA_POLICY_BLOCKED");
  expect(
    (await f.db.query("select id from public.opportunities")).rows,
  ).toHaveLength(0);
});
