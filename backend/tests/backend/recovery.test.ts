// @vitest-environment node
import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { workflowFixture } from "./workflowFixture";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
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
    await source.command("model.routing", {
      enabled: true,
      expected_revision: 0,
    });
    const connection = await source.command("model.connection.save", {
      provider: "openai",
      label: "Recovery fixture",
      credential_alias: "APP_MODEL_OPENAI_KEY",
      project_ref: "fixture",
      enabled: true,
      expected_revision: 0,
    });
    const model = await source.command("model.configuration.save", {
      connection_id: connection.id,
      label: "Recovery model",
      model: "fixture-model",
      capabilities: defaultCapabilities("openai"),
      enabled: true,
      expected_revision: 0,
    });
    await source.command("model.task_route.save", {
      task: "default",
      model_ids: [model.id],
      inherit_default: false,
      strategy: "priority",
      profile: null,
      expected_revision: 0,
    });
    await source.command("model.execution.configure", {
      enabled: true,
      expected_revision: 0,
    });
    const probe = await source.command("model.probe", {}),
      lease = crypto.randomUUID();
    await source.db.query(
      "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '5 minutes',checkpoint='{\"model_executor\":2}' where id=$1",
      [probe.id, lease],
    );
    const saver = new ModelGraphStore(
      {
        internal: async (name: string, args: Record<string, unknown>) => {
          const entries = Object.entries(args);
          return (
            await source.db.query<any>(
              `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) value`,
              entries.map(([, v]) =>
                typeof v === "object" ? JSON.stringify(v) : v,
              ),
            )
          ).rows[0].value;
        },
      },
      { id: probe.id, lease_token: lease },
      "c".repeat(64),
    );
    await saver.action("init", {
      task: "connection_probe",
      input_hash: "d".repeat(64),
      graph_version: 1,
    });
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values.resultRef = "fixture reference";
    await saver.put(
      { configurable: { thread_id: saver.thread } },
      checkpoint,
      { source: "loop", step: 1, parents: {} },
      {},
    );
    const graphResult = await saver.action("result_put", {
      key: "accepted",
      value: { status: "ready" },
    });
    await saver.action("accept", { result_id: graphResult.id });
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
      target.command("model.connection.save", {
        provider: "openai",
        label: "Blocked during restore",
        credential_alias: "APP_MODEL_OPENAI_KEY",
        project_ref: "fixture",
        enabled: true,
        expected_revision: 0,
      }),
    ).rejects.toThrow("RESTORE_IN_PROGRESS");
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
    expect(
      (
        await target.db.query<any>(
          "select model,enabled from public.model_configurations",
        )
      ).rows[0],
    ).toEqual({ model: "fixture-model", enabled: false });
    expect(
      (
        await target.db.query<any>(
          "select enabled from public.model_execution_settings",
        )
      ).rows[0].enabled,
    ).toBe(false);
    expect(
      (
        await target.db.query<any>(
          "select model_ids from public.model_task_routes",
        )
      ).rows[0].model_ids,
    ).toEqual([model.id]);
    expect(
      (
        await target.db.query<any>(
          "select value from app_private.model_graph_results",
        )
      ).rows[0].value,
    ).toEqual({ status: "ready" });
    expect(
      (
        await target.db.query<any>(
          "select count(*)::int count from app_private.model_graph_checkpoints",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await target.db.query<any>(
          "select status,cancel_requested from public.jobs where id=$1",
          [probe.id],
        )
      ).rows[0],
    ).toEqual({ status: "canceled", cancel_requested: true });
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
