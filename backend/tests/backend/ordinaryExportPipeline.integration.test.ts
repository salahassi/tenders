// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { deliveryPipelineFixture } from "./deliveryPipelineFixture";
import { commercialHelpers } from "./commercialFixture";
import { processOrdinaryExport } from "../../supabase/functions/_shared/ordinaryExportWorker";
import {
  buildExportModel,
  verifyExportDocx,
  type RenderModel,
} from "../../supabase/functions/_shared/export";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";
import type { Backend } from "../../supabase/functions/_shared/backend";
let fixture: Awaited<ReturnType<typeof deliveryPipelineFixture>>;
beforeAll(async () => {
  fixture = await deliveryPipelineFixture();
}, 30000);
afterAll(async () => fixture?.f.db.close());
beforeEach(async () => fixture.f.db.exec("begin"));
afterEach(async () => fixture.f.db.exec("rollback"));
async function setup(separate = false) {
  const { f } = fixture;
  const data = await commercialHelpers(f).setup();
  await f.db.query(
    "update public.proposal_versions set separate_volumes=$1 where id=$2",
    [separate, data.version],
  );
  await f.db.query(
    "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
    [data.plan],
  );
  const transport = fixture.transport();
  Object.assign(transport.backend, {
    object: async (key: string) => {
      const blob = await transport.backend.deliveryObject(key);
      if (!blob) throw Error("missing");
      return blob;
    },
  });
  const command = async (
    op: string,
    input: unknown,
    key: string = crypto.randomUUID(),
  ) => {
    const response = await transport.request(
      "commands",
      { commands: [{ operation: op, input }] },
      key as ReturnType<typeof crypto.randomUUID>,
    );
    const body = await response.json();
    if (response.status !== 200) throw Error(JSON.stringify(body));
    return body.data[0];
  };
  const prepare = (key?: string) =>
    command(
      "export.package.prepare",
      {
        proposal_version_id: data.version,
        expected_revision: 1,
        mode: "draft",
      },
      key as ReturnType<typeof crypto.randomUUID>,
    );
  const render = vi.fn(
    async (model: RenderModel) =>
      new Uint8Array(
        await (await renderDocx(model, fixture.fonts)).arrayBuffer(),
      ),
  );
  const run = async () => {
    const job = await fixture.rpc("claim_backend_job_v4");
    expect(job?.type).toBe("render_export");
    return {
      job,
      result: await processOrdinaryExport(
        transport.backend as unknown as Backend,
        job,
        render,
      ),
    };
  };
  return { ...data, ...transport, command, prepare, render, run };
}
it("persists one canonical ordinary draft across reload keys and renders/downloads without browser work", async () => {
  const d = await setup();
  const pending = await d.prepare();
  expect(pending.status).toBe("preparing");
  expect(pending.artifacts[0].id).toBeNull();
  expect(
    Date.parse(pending.deadline_at) - Date.parse(pending.accepted_at),
  ).toBe(600000);
  expect((await d.prepare()).id).toBe(pending.id);
  expect((await d.prepare()).deadline_at).toBe(pending.deadline_at);
  const { result } = await d.run();
  expect(result.status).toBe("ready");
  expect(result.artifacts[0].export_id).toBeTruthy();
  const artifact = result.artifacts[0];
  const response = await d.request(`export-artifacts/${artifact.id}/download`);
  expect(response.status).toBe(200);
  const request = await fixture.rpc(
    "export_context",
    { request_id: artifact.export_id },
    "synthetic-owner",
  );
  verifyExportDocx(
    new Uint8Array(await response.arrayBuffer()),
    buildExportModel(request, 2),
  );
  expect(d.render).toHaveBeenCalledTimes(1);
  const counts = (
    await fixture.f.db.query<any>(
      "select (select count(*) from public.export_packages) packages,(select count(*) from public.export_artifacts) artifacts,(select count(*) from public.provider_usage) usage",
    )
  ).rows[0];
  expect(Number(counts.packages)).toBe(1);
  expect(Number(counts.artifacts)).toBe(1);
  expect(Number(counts.usage)).toBe(0);
});
it("requires both real volumes before any package download", async () => {
  const d = await setup(true);
  const pending = await d.prepare();
  expect(pending.artifacts).toHaveLength(2);
  const job = await fixture.rpc("claim_backend_job_v4");
  const original = d.backend.internal.getMockImplementation()!;
  d.backend.internal.mockImplementation(async (name, args) => {
    if (name === "finish_export_package") throw Error("simulated process loss");
    return original(name, args);
  });
  // Interrupted finalization is retryable; verified siblings are preserved.
  const result = await processOrdinaryExport(
    d.backend as unknown as Backend,
    job,
    d.render,
  );
  expect(result.error_code).toBe("DELIVERY_RENDER_FAILED");
  const rows = (
    await fixture.f.db.query<any>(
      "select artifact_id from public.export_package_volumes where package_id=$1",
      [pending.id],
    )
  ).rows;
  expect(rows.every((r) => r.artifact_id)).toBe(true);
  expect(
    (await d.request(`export-artifacts/${rows[0].artifact_id}/download`))
      .status,
  ).not.toBe(200);
  d.backend.internal.mockImplementation(original);
  await fixture.f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  const resumed = await d.run();
  expect(resumed.result.status).toBe("ready");
  expect(d.render).toHaveBeenCalledTimes(2);
});
it("reuses independently verified object bytes after lost upload acknowledgement", async () => {
  const d = await setup();
  await d.prepare();
  const store = d.backend.storeDeliveryObject.getMockImplementation()!;
  d.backend.storeDeliveryObject.mockImplementation(async (...args) => {
    await store(...args);
    throw Error("upload reply lost");
  });
  const { result } = await d.run();
  expect(result.status).toBe("ready");
  expect(d.render).toHaveBeenCalledTimes(1);
  expect(d.objects.size).toBe(1);
});
it("fails a source change after rendering before upload and retains the proposal version", async () => {
  const d = await setup();
  await d.prepare();
  const original = d.render.getMockImplementation()!;
  d.render.mockImplementation(async (model) => {
    const bytes = await original(model);
    await fixture.f.db.query(
      "update public.opportunities set title='Changed scope' where id=(select opportunity_id from public.generation_plans where id=$1)",
      [d.plan],
    );
    return bytes;
  });
  const { result } = await d.run();
  expect(result.error_code).toMatch(/STALE|SOURCE/);
  expect(d.objects.size).toBe(0);
  expect(
    (
      await fixture.f.db.query<any>(
        "select count(*) n from public.proposal_versions where id=$1",
        [d.version],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("checks membership again after fetching bytes before download response", async () => {
  const d = await setup();
  await d.prepare();
  const { result } = await d.run();
  d.state.revokeOnRead = true;
  const response = await d.request(
    `export-artifacts/${result.artifacts[0].id}/download`,
  );
  expect(response.status).toBe(403);
});
it("expires queue wait at 600 seconds, explicit retry gets a new authorization, replay keeps it", async () => {
  const d = await setup();
  const pending = await d.prepare();
  await fixture.f.db.query(
    "update public.export_packages set accepted_at=x.t-interval '601 seconds',deadline_at=x.t-interval '1 second' from(select clock_timestamp() t) x where id=$1",
    [pending.id],
  );
  // Set using one timestamp, so the immutable exact600 interval remains true.
  const expired = await fixture.rpc(
    "export_package_context",
    { package_id: pending.id },
    "synthetic-owner",
  );
  expect(expired.error_code).toBe("EXPORT_ISSUANCE_TIMEOUT");
  const input = { id: pending.id, expected_revision: expired.revision },
    key = crypto.randomUUID();
  const retry = await d.command("export.package.retry", input, key);
  expect(retry.status).toBe("preparing");
  expect(retry.job.id).not.toBe(pending.job.id);
  expect(await d.command("export.package.retry", input, key)).toEqual(retry);
  expect((await d.run()).result.status).toBe("ready");
});
it("rejects old executors and atomically reserves the complete two-volume capacity", async () => {
  const d = await setup(true);
  await fixture.f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/capacity',250000000,'Synthetic capacity fixture')",
    [fixture.f.w],
  );
  await expect(d.prepare()).rejects.toThrow("STORAGE_CAP_REACHED");
  expect(
    (
      await fixture.f.db.query<any>(
        "select count(*) n from public.export_packages",
      )
    ).rows[0].n,
  ).toBe(0);
  await fixture.f.db.exec("delete from public.storage_cleanup_queue");
  await d.prepare();
  expect(await fixture.rpc("claim_backend_job_v2")).toBeNull();
  expect(await fixture.rpc("claim_backend_job_v3")).toBeNull();
  expect((await fixture.rpc("claim_backend_job_v4")).type).toBe(
    "render_export",
  );
});
it("terminates known failed jobs early and releases unconfirmed slots for delayed cleanup", async () => {
  const d = await setup();
  const pending = await d.prepare();
  await fixture.f.db.query(
    "update public.jobs set status='blocked',error_code='DELIVERY_RENDER_FAILED' where id=$1",
    [pending.job.id],
  );
  const closed = await fixture.rpc(
    "export_package_context",
    { package_id: pending.id },
    "synthetic-owner",
  );
  expect(closed.status).toBe("blocked");
  expect(closed.error_code).toBe("DELIVERY_RENDER_FAILED");
  const receipt = (
    await fixture.f.db.query<any>(
      "select s.reserved_bytes,c.estimated_size,c.eligible_at>clock_timestamp() deferred from public.export_package_volumes s join public.storage_cleanup_queue c using(storage_key) where package_id=$1",
      [pending.id],
    )
  ).rows[0];
  expect(Number(receipt.reserved_bytes)).toBe(0);
  expect(Number(receipt.estimated_size)).toBe(10485760);
  expect(receipt.deferred).toBe(true);
});
it("denies stale revision while preserving existing Reviewer draft-export authorization", async () => {
  const d = await setup();
  const pending = await d.prepare();
  await fixture.f.db.query(
    "update public.jobs set status='failed',error_code='DELIVERY_RENDER_FAILED' where id=$1",
    [pending.job.id],
  );
  const closed = await fixture.rpc(
    "export_package_context",
    { package_id: pending.id },
    "synthetic-owner",
  );
  await expect(
    d.command("export.package.retry", {
      id: pending.id,
      expected_revision: closed.revision - 1,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await fixture.f.db.query(
    "update public.memberships set role='Reviewer' where workspace_id=$1 and user_id=$2",
    [fixture.f.w, fixture.f.owner],
  );
  expect(
    (
      await d.command("export.package.retry", {
        id: pending.id,
        expected_revision: closed.revision,
      })
    ).status,
  ).toBe("preparing");
});
it("includes package metadata in backup and removes it through canonical confirmed opportunity purge", async () => {
  const d = await setup();
  const pending = await d.prepare();
  const names = (
    await fixture.f.db.query<any>("select app_private.backup_tables() names")
  ).rows[0].names;
  expect(names).toContain("export_packages");
  expect(names).toContain("export_package_volumes");
  const opp = (
    await fixture.f.db.query<any>(
      "select o.* from public.opportunities o join public.proposals p on p.opportunity_id=o.id where p.id=$1",
      [d.proposal],
    )
  ).rows[0];
  await fixture.f.rpc("archive_opportunity", [
    opp.id,
    opp.revision,
    true,
    "Synthetic ordinary export purge test",
  ]);
  const preview = await fixture.f.rpc("preview_opportunity_purge", [opp.id]);
  expect(preview.counts.export_packages).toBe(1);
  expect(preview.counts.export_package_volumes).toBe(1);
  await fixture.f.rpc("purge_opportunity", [
    opp.id,
    preview.preview_hash,
    opp.title,
    "Synthetic confirmed ordinary export purge",
    true,
  ]);
  expect(
    (
      await fixture.f.db.query<any>(
        "select count(*) n from public.export_packages where id=$1",
        [pending.id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await fixture.f.db.query<any>(
        "select estimated_size from public.storage_cleanup_queue where reason='owner_confirmed_purge'",
      )
    ).rows.some((x) => Number(x.estimated_size) === 10485760),
  ).toBe(true);
});
async function approve(d: Awaited<ReturnType<typeof setup>>) {
  const { f } = fixture;
  const h = commercialHelpers(f);
  const estimate = await h.calculate(d),
    delivery = await h.calculate(d, "delivery");
  await f.command("estimate.approve", {
    id: estimate.id,
    expected_revision: estimate.revision,
  });
  await f.command("delivery.approve", {
    id: delivery.id,
    expected_revision: delivery.revision,
  });
  await f.command("inventory.confirm", {
    proposal_version_id: d.version,
    expected_revision: 1,
  });
  await f.command("compliance.save", {
    proposal_version_id: d.version,
    requirement_id: d.requirement,
    expected_revision: 0,
    status: "answered",
    section_keys: ["approach"],
    evidence_refs: [],
    rationale:
      "The implementation response addresses this synthetic requirement.",
  });
  await f.command("proposal.approve", {
    proposal_version_id: d.version,
    expected_revision: 1,
    reason:
      "Owner reviewed the exact synthetic content, evidence and calculations.",
  });
  return (
    await f.db.query<any>(
      "select revision from public.proposal_versions where id=$1",
      [d.version],
    )
  ).rows[0].revision;
}
it("renders the real approved ordinary final and rechecks its approval before download", async () => {
  const d = await setup();
  const revision = await approve(d);
  const pending = await d.command("export.package.prepare", {
    proposal_version_id: d.version,
    expected_revision: revision,
    mode: "final",
  });
  expect(pending.mode).toBe("final");
  const { result } = await d.run();
  expect(result.status).toBe("ready");
  expect(d.render.mock.calls[0][0].mode).toBe("final");
  const path = `export-artifacts/${result.artifacts[0].id}/download`;
  expect((await d.request(path)).status).toBe(200);
  await fixture.f.db.query(
    "update public.approvals set invalidated_at=clock_timestamp() where proposal_version_id=$1",
    [d.version],
  );
  expect((await d.request(path)).status).toBe(409);
});
it("rejects final approval invalidation during rendering before any artifact is written", async () => {
  const d = await setup();
  const revision = await approve(d);
  await d.command("export.package.prepare", {
    proposal_version_id: d.version,
    expected_revision: revision,
    mode: "final",
  });
  const original = d.render.getMockImplementation()!;
  d.render.mockImplementation(async (model) => {
    const bytes = await original(model);
    await fixture.f.db.query(
      "update public.approvals set invalidated_at=clock_timestamp() where proposal_version_id=$1",
      [d.version],
    );
    return bytes;
  });
  expect((await d.run()).result.error_code).toBe("STALE_EXPORT_APPROVAL");
  expect(d.objects.size).toBe(0);
});
it("regenerates an expired artifact only after explicit retry while preserving its historical receipt", async () => {
  const d = await setup();
  const pending = await d.prepare();
  const first = (await d.run()).result;
  const old = first.artifacts[0];
  await fixture.f.db.query(
    "update public.export_artifacts set status='expired' where id=$1",
    [old.id],
  );
  const expired = await fixture.rpc(
    "export_package_context",
    { package_id: pending.id },
    "synthetic-owner",
  );
  expect(expired.error_code).toBe("EXPORT_PACKAGE_BYTES_UNAVAILABLE");
  await d.command("export.package.retry", {
    id: pending.id,
    expected_revision: expired.revision,
  });
  const next = (await d.run()).result;
  expect(next.artifacts[0].id).not.toBe(old.id);
  expect(next.artifacts[0].export_id).toBe(old.export_id);
  expect(
    (
      await fixture.f.db.query<any>(
        "select status,content_hash from public.export_artifacts where id=$1",
        [old.id],
      )
    ).rows[0],
  ).toEqual({ status: "expired", content_hash: old.content_hash });
});
it("keeps the original renderer output policy unchanged and marks new missing-input runs yellow", async () => {
  const d = await setup();
  await fixture.f.db.query(
    "update public.proposal_sections set body='Proposed workflow. [INPUT REQUIRED: approved company certificate]' where proposal_version_id=$1",
    [d.version],
  );
  await d.prepare();
  const { result } = await d.run();
  expect(result.status).toBe("ready");
  const req = await fixture.rpc(
    "export_context",
    { request_id: result.artifacts[0].export_id },
    "synthetic-owner",
  );
  expect(
    buildExportModel({
      ...req,
      snapshot: { ...req.snapshot, export_renderer_version: undefined },
    }).placeholder_version,
  ).toBeUndefined();
  expect(buildExportModel(req).placeholder_version).toBe(2);
  expect(buildExportModel(req, 2).placeholder_version).toBe(2);
  const response = await d.request(
    `export-artifacts/${result.artifacts[0].id}/download`,
  );
  verifyExportDocx(
    new Uint8Array(await response.arrayBuffer()),
    buildExportModel(req, 2),
  );
});
it("prevents direct mutation of frozen package identity", async () => {
  const d = await setup();
  const pending = await d.prepare();
  await fixture.f.db.exec("savepoint immutable_probe");
  await expect(
    fixture.f.db.query(
      "update public.export_packages set mode='final' where id=$1",
      [pending.id],
    ),
  ).rejects.toThrow("EXPORT_PACKAGE_IMMUTABLE");
  await fixture.f.db.exec(
    "rollback to savepoint immutable_probe;release savepoint immutable_probe",
  );
});
it("public backup/restore retains verified package receipts but requires current authorization and fresh draft issuance", async () => {
  const d = await setup();
  const pending = await d.prepare();
  const ready = (await d.run()).result;
  const { workflowFixture } = await import("./workflowFixture");
  const target = await workflowFixture("00000000-0000-4000-8000-000000000088");
  async function userRpc(f: typeof target, name: string, args: unknown[] = []) {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      f.owner,
    ]);
    await f.db.exec("set role authenticated;savepoint restore_probe");
    try {
      return await f.rpc(name, args);
    } catch (e) {
      await f.db.exec("rollback to savepoint restore_probe");
      throw e;
    } finally {
      await f.db.exec("release savepoint restore_probe;reset role");
    }
  }
  try {
    await target.db.exec("begin");
    const manifest = await userRpc(fixture.f, "workspace_backup_manifest"),
      rows: any[] = [];
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].hash).toBe(ready.artifacts[0].content_hash);
    for (let i = 0; i < manifest.rows.length; i += 15)
      rows.push(
        ...(await userRpc(fixture.f, "workspace_backup_rows", [
          JSON.stringify(manifest.rows.slice(i, i + 15).map((r: any) => r.key)),
        ])),
      );
    const begun = await userRpc(target, "begin_workspace_restore", [
      JSON.stringify(manifest),
      true,
    ]);
    for (let i = 0; i < rows.length; i += 10)
      await userRpc(target, "stage_restore_rows", [
        begun.id,
        JSON.stringify(rows.slice(i, i + 10)),
      ]);
    for (const file of begun.files)
      await target.rpc("complete_restore_file", [
        file.id,
        target.owner,
        file.content_hash ?? file.hash,
        file.expected_size ?? file.size,
      ]);
    expect(
      (await userRpc(target, "commit_workspace_restore", [begun.id])).state,
    ).toBe("committed");
    const restored = (
      await target.db.query<any>(
        "select status,error_code,binding_hash from public.export_packages where id=$1",
        [pending.id],
      )
    ).rows[0];
    expect(restored.status).toBe("blocked");
    expect(restored.error_code).toBe("EXPORT_RESTORED_REVIEW_REQUIRED");
    expect(
      (
        await target.db.query<any>(
          "select content_hash,status from public.export_artifacts where id=$1",
          [ready.artifacts[0].id],
        )
      ).rows[0],
    ).toEqual({
      content_hash: ready.artifacts[0].content_hash,
      status: "ready",
    });
    await expect(
      userRpc(target, "artifact_context", [ready.artifacts[0].id]),
    ).rejects.toThrow();
    const fresh = await target.command("export.package.prepare", {
      proposal_version_id: d.version,
      expected_revision: 1,
      mode: "draft",
    });
    expect(fresh.status).toBe("preparing");
    expect(fresh.id).not.toBe(pending.id);
  } finally {
    await target.db.close();
  }
}, 30000);
it("dispatches the persisted export job after the original caller is gone, reusing an uploaded object", async () => {
  const d = await setup();
  await d.prepare();
  const slot = (
    await fixture.f.db.query<any>(
      "select s.storage_key,to_jsonb(r) request from public.export_package_volumes s join public.export_requests r on r.id=s.export_id",
    )
  ).rows[0];
  const bytes = await d.render(buildExportModel(slot.request));
  d.objects.set(slot.storage_key, new Blob([new Uint8Array(bytes)]));
  const { createWorkerHandler } =
    await import("../../supabase/functions/worker/handler");
  const { modelEnvironments } =
    await import("../../supabase/functions/_shared/backend");
  const env = {
    url: "https://synthetic.supabase.co",
    publishableKey: "synthetic-public",
    serviceKey: "synthetic-service",
    allowedOrigins: [],
    workerSecret: "synthetic-worker",
    models: modelEnvironments(() => undefined),
  };
  const original = d.backend.internal.getMockImplementation()!;
  d.backend.internal.mockImplementation((name, args) =>
    name.startsWith("export_") ||
    [
      "complete_export_package_volume",
      "finish_export_package",
      "fail_export_package",
    ].includes(name)
      ? original(name, args)
      : Promise.resolve(name === "claim_storage_cleanup" ? [] : null),
  );
  Object.assign(d.backend, {
    claim: () => fixture.rpc("claim_backend_job_v4"),
    invocationBudgetMs: 0,
    invocationStartedAt: Date.now(),
  });
  const external = vi.fn<typeof fetch>(async () => {
    throw Error("No network request is expected");
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const handler = createWorkerHandler(
      env,
      async () => [],
      () => d.backend as unknown as Backend,
      external,
    );
    const response = await handler(
      new Request("https://synthetic.test/worker", {
        method: "POST",
        headers: { "x-worker-secret": env.workerSecret },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("ready");
    expect(external).not.toHaveBeenCalled();
    expect(d.backend.storeDeliveryObject).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
async function artifactFailure(
  d: Awaited<ReturnType<typeof setup>>,
  error_code: "EXPORT_ARTIFACT_MISSING" | "ARTIFACT_MISMATCH",
) {
  await d.prepare();
  const ready = (await d.run()).result;
  const artifact = ready.artifacts[0];
  const context = await fixture.rpc(
    "artifact_context",
    { artifact_id: artifact.id },
    "synthetic-owner",
  );
  return {
    ready,
    artifact,
    context,
    args: {
      artifact_id: artifact.id,
      actor_id: fixture.f.owner,
      package_id: context.package.id,
      expected_revision: context.package.revision,
      expected_hash: artifact.content_hash,
      expected_storage_key: context.artifact.storage_key,
      error_code,
      actual_size: error_code === "ARTIFACT_MISMATCH" ? 3 : null,
    },
  };
}
it.each(["EXPORT_ARTIFACT_MISSING", "ARTIFACT_MISMATCH"] as const)(
  "records only definitive %s and permits an explicit fresh artifact retry",
  async (code) => {
    const d = await setup();
    const { artifact, context, args } = await artifactFailure(d, code);
    if (code === "EXPORT_ARTIFACT_MISSING")
      d.objects.delete(context.artifact.storage_key);
    else d.objects.set(context.artifact.storage_key, new Blob(["bad"]));
    expect(
      await fixture.rpc("report_export_package_artifact_failure", args),
    ).toEqual({ invalidated: true });
    expect(
      await fixture.rpc("report_export_package_artifact_failure", args),
    ).toEqual({ invalidated: false });
    const blocked = await fixture.rpc(
      "export_package_context",
      { package_id: args.package_id },
      "synthetic-owner",
    );
    expect(blocked.error_code).toBe("EXPORT_PACKAGE_BYTES_UNAVAILABLE");
    expect(
      (
        await fixture.f.db.query<any>(
          "select content_hash,status from public.export_artifacts where id=$1",
          [artifact.id],
        )
      ).rows[0],
    ).toEqual({ content_hash: artifact.content_hash, status: "expired" });
    expect(
      (
        await fixture.f.db.query<any>(
          "select count(*) n from public.audit_events where action='export.package.artifact_invalidated' and entity_id=$1",
          [artifact.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const cleanup = (
      await fixture.f.db.query<any>(
        "select estimated_size from public.storage_cleanup_queue where storage_key=$1",
        [context.artifact.storage_key],
      )
    ).rows;
    expect(cleanup).toHaveLength(code === "ARTIFACT_MISMATCH" ? 1 : 0);
    await d.command("export.package.retry", {
      id: args.package_id,
      expected_revision: blocked.revision,
    });
    const next = (await d.run()).result;
    expect(next.status).toBe("ready");
    expect(next.artifacts[0].id).not.toBe(artifact.id);
  },
);
it("requires service authority, exact failure CAS and current source before invalidating a ready package", async () => {
  const d = await setup();
  const { args, artifact } = await artifactFailure(
    d,
    "EXPORT_ARTIFACT_MISSING",
  );
  const acl = (
    await fixture.f.db.query<any>(
      "select has_function_privilege('authenticated','public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint)','EXECUTE') allowed",
    )
  ).rows[0];
  expect(acl.allowed).toBe(false);
  for (const altered of [
    { expected_revision: args.expected_revision - 1 },
    { expected_hash: "f".repeat(64) },
    { expected_storage_key: "wrong/private/key" },
  ])
    expect(
      await fixture.rpc("report_export_package_artifact_failure", {
        ...args,
        ...altered,
      }),
    ).toEqual({ invalidated: false });
  await fixture.f.db.query(
    "update public.opportunities set title='Changed source before failure receipt' where id=(select opportunity_id from public.generation_plans where id=$1)",
    [d.plan],
  );
  await expect(
    fixture.rpc("report_export_package_artifact_failure", args),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
  expect(
    (
      await fixture.f.db.query<any>(
        "select status from public.export_artifacts where id=$1",
        [artifact.id],
      )
    ).rows[0].status,
  ).toBe("ready");
});
