// @vitest-environment node
import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
it("restores original-inclusive business history into a clean project with no users, approvals or processing enabled", async () => {
  const source = await workflowFixture(),
    target = await workflowFixture("00000000-0000-4000-8000-000000000088");
  async function rpc(f: typeof source, name: string, args: unknown[] = []) {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      f.owner,
    ]);
    await f.db.exec("set role authenticated;savepoint rpc_attempt");
    try {
      return await f.rpc(name, args);
    } catch (e) {
      await f.db.exec("rollback to savepoint rpc_attempt");
      throw e;
    } finally {
      await f.db.exec("release savepoint rpc_attempt;reset role");
    }
  }
  try {
    await source.db.exec("begin");
    await target.db.exec("begin");
    const bytes = "Synthetic public RFP original for recovery verification.";
    const knowledge = await source.command("knowledge.save", {
      category: "other",
      title: "Synthetic recovery attachment",
      content: "",
      enabled: true,
    });
    const reservation = await source.command("document.prepare", {
      eligibility_attested: true,
      client_id: crypto.randomUUID(),
      kind: "company",
      knowledge_item_id: knowledge.id,
      original_name: "synthetic.txt",
      mime_type: "text/plain",
      size: bytes.length,
      hash: hash(bytes),
    });
    await source.rpc("accept_uploaded_document", [
      reservation.id,
      source.owner,
      hash(bytes),
      bytes.length,
      bytes,
      "ready",
      crypto.randomUUID(),
    ]);
    const h = commercialHelpers(source),
      s = await h.setup();
    s.input.lines[0].quantity = "11";
    const estimate = await h.calculate(s),
      delivery = await h.calculate(s, "delivery");
    await source.command("estimate.approve", {
      id: estimate.id,
      expected_revision: estimate.revision,
    });
    await source.command("delivery.approve", {
      id: delivery.id,
      expected_revision: delivery.revision,
    });
    await source.command("inventory.confirm", {
      proposal_version_id: s.version,
      expected_revision: 1,
    });
    await source.command("compliance.save", {
      proposal_version_id: s.version,
      requirement_id: s.requirement,
      expected_revision: 0,
      status: "answered",
      section_keys: ["approach"],
      evidence_refs: [],
      rationale: "Synthetic response covers the requirement.",
    });
    await source.command("proposal.approve", {
      proposal_version_id: s.version,
      expected_revision: 1,
      reason: "Synthetic Owner acceptance before backup.",
    });
    expect(
      (
        await source.db.query<any>(
          "select status from public.proposal_versions",
        )
      ).rows[0].status,
    ).toBe("approved");
    const manifest = await rpc(source, "workspace_backup_manifest"),
      all: any[] = [];
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].hash).toBe(hash(bytes));
    expect(
      manifest.rows.some((r: any) =>
        /memberships|identity_allowlist|invitations/.test(r.key),
      ),
    ).toBe(false);
    for (let i = 0; i < manifest.rows.length; i += 15)
      all.push(
        ...(await rpc(source, "workspace_backup_rows", [
          JSON.stringify(manifest.rows.slice(i, i + 15).map((r: any) => r.key)),
        ])),
      );
    for (const row of all) expect(hash(row.data)).toBe(row.hash);
    const begun = await rpc(target, "begin_workspace_restore", [
      JSON.stringify(manifest),
      true,
    ]);
    await expect(
      target.command("source.create", {
        name: "Cannot edit during restore",
        kind: "manual",
      }),
    ).rejects.toThrow("RESTORE_IN_PROGRESS");
    await expect(
      rpc(target, "stage_restore_rows", [
        begun.id,
        JSON.stringify([{ ...all[0], data: all[0].data + " " }]),
      ]),
    ).rejects.toThrow("BACKUP_ROW_HASH_MISMATCH");
    for (let i = 0; i < all.length; i += 10)
      await rpc(target, "stage_restore_rows", [
        begun.id,
        JSON.stringify(all.slice(i, i + 10)),
      ]);
    await expect(
      rpc(target, "commit_workspace_restore", [begun.id]),
    ).rejects.toThrow("RESTORE_INCOMPLETE");
    expect(
      (await target.db.query("select * from public.opportunities")).rows,
    ).toHaveLength(0);
    await target.db.exec("savepoint file_verification");
    await expect(
      target.rpc("complete_restore_file", [
        begun.files[0].id,
        target.owner,
        "f".repeat(64),
        bytes.length,
      ]),
    ).rejects.toThrow("BACKUP_FILE_HASH_MISMATCH");
    await target.db.exec(
      "rollback to savepoint file_verification;release savepoint file_verification",
    );
    await target.rpc("complete_restore_file", [
      begun.files[0].id,
      target.owner,
      hash(bytes),
      bytes.length,
    ]);
    expect(
      (await rpc(target, "commit_workspace_restore", [begun.id])).state,
    ).toBe("committed");
    expect(
      (await rpc(target, "commit_workspace_restore", [begun.id])).state,
    ).toBe("committed");
    const restored = (
      await target.db.query<any>(
        "select * from public.estimate_versions where id=$1",
        [estimate.id],
      )
    ).rows[0];
    expect(restored.calculated.display_gross).toBe("16698.00");
    expect(restored.status).toBe("ready");
    expect(restored.created_by).toBe(source.owner);
    expect(
      (await target.db.query<any>("select * from public.approvals")).rows[0]
        .invalidated_at,
    ).not.toBeNull();
    expect(
      (await target.db.query<any>("select * from public.proposal_versions"))
        .rows[0].status,
    ).toBe("draft");
    expect(
      (await target.db.query<any>("select * from public.sources")).rows.every(
        (r: any) => r.approval === "paused",
      ),
    ).toBe(true);
    expect(
      (await target.db.query("select * from auth.users")).rows,
    ).toHaveLength(1);
    expect(
      (await target.db.query("select * from public.memberships")).rows,
    ).toHaveLength(1);
    expect(
      (
        await target.db.query<any>(
          "select kind from public.workspace_actors where id=$1",
          [source.owner],
        )
      ).rows[0].kind,
    ).toBe("historical");
    const context = await rpc(target, "recovery_file_context", [
      "documents",
      reservation.id,
    ]);
    expect(context.hash).toBe(hash(bytes));
    expect(context.storage_key).toContain(`/restore/${begun.id}/`);
    await expect(
      rpc(target, "begin_workspace_restore", [JSON.stringify(manifest), true]),
    ).rejects.toThrow("RESTORE_TARGET_NOT_EMPTY");
  } finally {
    await source.db.close();
    await target.db.close();
  }
}, 30000);
