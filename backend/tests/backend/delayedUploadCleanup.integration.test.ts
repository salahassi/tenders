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
import { processDeliveryExport } from "../../supabase/functions/_shared/deliveryWorker";
import { runWorkerMaintenance } from "../../supabase/functions/worker/maintenance";
import { AppError } from "../../supabase/functions/_shared/http";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";
let fixture: Awaited<ReturnType<typeof deliveryPipelineFixture>>;
beforeAll(async () => {
  fixture = await deliveryPipelineFixture();
}, 30000);
afterAll(async () => fixture?.f.db.close());
beforeEach(async () => fixture.f.db.exec("begin"));
afterEach(async () => fixture.f.db.exec("rollback"));

it.each(["ordinary", "delivery"])(
  "keeps uncertain %s upload quota when a timed-out PUT arrives after an earlier successful missing-object DELETE",
  async (kind) => {
    const { f } = fixture;
    const t = fixture.transport();
    let opportunity: any;
    if (kind === "ordinary") {
      const d = await commercialHelpers(f).setup();
      await f.db.query(
        "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
        [d.plan],
      );
      await f.command("export.package.prepare", {
        proposal_version_id: d.version,
        expected_revision: 1,
        mode: "draft",
      });
    } else {
      const source = await f.command("source.create", {
        name: "Synthetic delayed upload",
        kind: "manual",
      });
      opportunity = await f.command("opportunity.create", {
        source_id: source.id,
        title: "Synthetic scope",
        reference: "S1",
        description:
          "Configure the approval workflow and demonstrate acceptance.",
        decision: "shortlisted",
      });
      await f.command("delivery.snapshot.prepare", {
        opportunity_id: opportunity.id,
        expected_revision: opportunity.revision,
      });
    }
    const job = await fixture.rpc("claim_backend_job_v4");
    await f.db.query("update public.jobs set failure_count=5 where id=$1", [
      job.id,
    ]);
    let lateWrite: (() => void) | undefined;
    let key = "";
    let size = 0;
    t.backend.storeDeliveryObject.mockImplementation(async (path, bytes) => {
      key = path;
      size = bytes.length;
      // The client rejects now; the synthetic storage server still owns its PUT.
      // This explicit deferred callback models remote completion, not fake clocks.
      lateWrite = () => t.objects.set(path, new Blob([new Uint8Array(bytes)]));
      throw new AppError(
        503,
        "DELIVERY_STORAGE_UNAVAILABLE",
        "Synthetic lost upload reply.",
      );
    });
    const render = async (model: Parameters<typeof renderDocx>[0]) =>
      new Uint8Array(
        await (await renderDocx(model, fixture.fonts)).arrayBuffer(),
      );
    const result = await (
      kind === "ordinary" ? processOrdinaryExport : processDeliveryExport
    )(t.backend as unknown as Backend, job, render);
    expect(result).toMatchObject({
      error_code: "DELIVERY_STORAGE_UNAVAILABLE",
    });
    expect(lateWrite).toBeTypeOf("function");
    expect(t.objects.has(key)).toBe(false);
    if (kind === "delivery") {
      await fixture.rpc(
        "archive_opportunity",
        {
          opportunity_id: opportunity.id,
          expected_revision: opportunity.revision,
          archive: true,
          reason: "Synthetic cleanup race",
        },
        "synthetic-owner",
      );
      const preview = await fixture.rpc(
        "preview_opportunity_purge",
        { opportunity_id: opportunity.id },
        "synthetic-owner",
      );
      await fixture.rpc(
        "purge_opportunity",
        {
          opportunity_id: opportunity.id,
          preview_hash: preview.preview_hash,
          confirmed_title: opportunity.title,
          reason: "Synthetic cleanup race",
          acknowledge_history: true,
        },
        "synthetic-owner",
      );
    }
    // Move only cleanup eligibility across its old sixty-second delay; request
    // clocks and actual object transport remain unchanged.
    await f.db.query(
      "update public.storage_cleanup_queue set eligible_at=clock_timestamp()-interval '1 second' where storage_key=$1",
      [key],
    );
    const base = t.backend.internal.getMockImplementation()!;
    t.backend.internal.mockImplementation((name, args) =>
      [
        "claim_storage_cleanup",
        "complete_storage_cleanup",
        "storage_cleanup_context",
        "observe_cleanup_storage_write",
        "defer_storage_cleanup",
        "record_storage_cleanup_deletion",
      ].includes(name)
        ? base(name, args)
        : Promise.resolve(null),
    );
    const removeObject = vi.fn(async (path: string) => {
      t.objects.delete(path);
      return {
        object_id: "00000000-0000-4000-8000-000000000001",
        object_version: "synthetic-version",
      };
    });
    Object.assign(t.backend, { removeObject });
    const env: BackendEnvironment = {
      url: "https://synthetic.test",
      publishableKey: "synthetic",
      serviceKey: "synthetic",
      allowedOrigins: [],
      workerSecret: "synthetic",
      models: modelEnvironments(() => undefined),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runWorkerMaintenance(
        t.backend as unknown as Backend,
        env,
        vi.fn(async () => {
          throw Error("No network expected");
        }),
      );
    } finally {
      warning.mockRestore();
    }
    expect(removeObject).not.toHaveBeenCalled();
    lateWrite!();
    expect(t.objects.has(key)).toBe(true);
    const reserved = (
      await f.db.query<{ bytes: number }>(
        "select app_private.storage_reserved_bytes($1)::int bytes",
        [f.w],
      )
    ).rows[0].bytes;
    // A successful DELETE of an absent key is not a write-settlement receipt.
    expect(reserved).toBeGreaterThanOrEqual(size);
    await f.db.query(
      "update public.storage_cleanup_queue set eligible_at=clock_timestamp()-interval '1 second' where storage_key=$1",
      [key],
    );
    const silence = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runWorkerMaintenance(
        t.backend as unknown as Backend,
        env,
        vi.fn(async () => {
          throw Error("No network expected");
        }),
      );
    } finally {
      silence.mockRestore();
    }
    expect(removeObject).toHaveBeenCalledTimes(1);
    expect(t.objects.has(key)).toBe(false);
    expect(
      (
        await f.db.query<{ bytes: number }>(
          "select app_private.storage_reserved_bytes($1)::int bytes",
          [f.w],
        )
      ).rows[0].bytes,
    ).toBe(0);
    expect(
      (
        await f.db.query<any>(
          "select state,expected_size from public.storage_write_intents where storage_key=$1",
          [key],
        )
      ).rows[0],
    ).toMatchObject({ state: "observed", expected_size: size });
  },
);

async function prepared(kind: "ordinary" | "delivery") {
  const { f } = fixture;
  let snapshot: any;
  if (kind === "ordinary") {
    const d = await commercialHelpers(f).setup();
    await f.db.query(
      "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
      [d.plan],
    );
    await f.command("export.package.prepare", {
      proposal_version_id: d.version,
      expected_revision: 1,
      mode: "draft",
    });
  } else {
    const s = await f.command("source.create", {
      name: "Synthetic single write",
      kind: "manual",
    });
    const o = await f.command("opportunity.create", {
      source_id: s.id,
      title: "Synthetic response",
      reference: "S1",
      description: "Implement approval routing and demonstrate acceptance.",
      decision: "shortlisted",
    });
    snapshot = await f.command("delivery.snapshot.prepare", {
      opportunity_id: o.id,
      expected_revision: o.revision,
    });
  }
  const job = await fixture.rpc("claim_backend_job_v4");
  const context = await fixture.rpc(
    kind === "ordinary" ? "export_render_context" : "delivery_export_context",
    { job_id: job.id, lease: job.lease_token },
  );
  const key =
    kind === "ordinary"
      ? context.volumes[0].storage_key
      : context.artifacts[0].storage_key;
  const t = fixture.transport();
  const render = vi.fn(
    async (model: Parameters<typeof renderDocx>[0]) =>
      new Uint8Array(
        await (await renderDocx(model, fixture.fonts)).arrayBuffer(),
      ),
  );
  const run = (j = job) =>
    (kind === "ordinary" ? processOrdinaryExport : processDeliveryExport)(
      t.backend as unknown as Backend,
      j,
      render,
    );
  return { job, context, key, snapshot, t, render, run };
}

it.each(["ordinary", "delivery"] as const)(
  "does not issue a second %s PUT after absent bytes on retry, then recovers the exact late object",
  async (kind) => {
    const d = await prepared(kind),
      { f } = fixture;
    let arrive: (() => void) | undefined;
    d.t.backend.storeDeliveryObject.mockImplementation(async (key, bytes) => {
      arrive = () => d.t.objects.set(key, new Blob([new Uint8Array(bytes)]));
      throw Error("Synthetic reply lost");
    });
    expect(await d.run()).toMatchObject({
      error_code: "DELIVERY_STORAGE_UNAVAILABLE",
    });
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [d.job.id],
    );
    const next = await fixture.rpc("claim_backend_job_v4");
    expect(await d.run(next)).toMatchObject({
      error_code: "DELIVERY_STORAGE_UNAVAILABLE",
    });
    expect(d.t.backend.storeDeliveryObject).toHaveBeenCalledTimes(1);
    expect(d.render).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db.query<any>(
          "select state from public.storage_write_intents where storage_key=$1",
          [d.key],
        )
      ).rows[0].state,
    ).toBe("unknown");
    arrive!();
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [d.job.id],
    );
    const recovered = await fixture.rpc("claim_backend_job_v4");
    const result = await d.run(recovered);
    expect(result.error_code).toBeFalsy();
    expect(d.t.backend.storeDeliveryObject).toHaveBeenCalledTimes(1);
    expect(d.render).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db.query<any>(
          "select state from public.storage_write_intents where storage_key=$1",
          [d.key],
        )
      ).rows[0].state,
    ).toBe("observed");
  },
);

it.each(["ordinary", "delivery"] as const)(
  "explicit %s retry uses a new key while retaining the previous uncertain allowance",
  async (kind) => {
    const d = await prepared(kind),
      { f } = fixture;
    await f.db.query("update public.jobs set failure_count=5 where id=$1", [
      d.job.id,
    ]);
    d.t.backend.storeDeliveryObject.mockRejectedValueOnce(
      Error("Synthetic no completion receipt"),
    );
    expect(await d.run()).toMatchObject({
      error_code: "DELIVERY_STORAGE_UNAVAILABLE",
    });
    if (kind === "ordinary") {
      const p = (
        await f.db.query<any>(
          "select id,revision from public.export_packages where id=$1",
          [d.job.entity_id],
        )
      ).rows[0];
      await f.command("export.package.retry", {
        id: p.id,
        expected_revision: p.revision,
      });
    } else {
      const p = (
        await f.db.query<any>(
          "select delivery_revision from public.proposals where id=$1",
          [d.snapshot.proposal_id],
        )
      ).rows[0];
      await f.command("delivery.snapshot.retry", {
        snapshot_id: d.snapshot.id,
        expected_delivery_revision: p.delivery_revision,
      });
    }
    const next = await fixture.rpc("claim_backend_job_v4");
    const context = await fixture.rpc(
      kind === "ordinary" ? "export_render_context" : "delivery_export_context",
      { job_id: next.id, lease: next.lease_token },
    );
    const key =
      kind === "ordinary"
        ? context.volumes[0].storage_key
        : context.artifacts[0].storage_key;
    expect(key).not.toBe(d.key);
    expect(
      (
        await f.db.query<any>(
          "select app_private.storage_reserved_bytes($1)::int bytes",
          [f.w],
        )
      ).rows[0].bytes,
    ).toBe(20971520);
    expect(
      (
        await f.db.query<any>(
          "select i.state,c.estimated_size from public.storage_write_intents i join public.storage_cleanup_queue c using(storage_key) where i.storage_key=$1",
          [d.key],
        )
      ).rows[0],
    ).toEqual({ state: "unknown", estimated_size: 10485760 });
    expect((await d.run(next)).error_code).toBeFalsy();
    expect(
      d.t.backend.storeDeliveryObject.mock.calls.map(([path]) => path),
    ).toEqual([d.key, key]);
  },
);

it("preserves a lost begin-RPC acknowledgement as unknown even when no PUT was sent", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  const base = d.t.backend.internal.getMockImplementation()!;
  d.t.backend.internal.mockImplementation(async (name, args) => {
    const result = await base(name, args);
    if (name === "begin_render_storage_write")
      throw Error("Synthetic acknowledgement lost after commit");
    return result;
  });
  await d.run();
  expect(d.t.backend.storeDeliveryObject).not.toHaveBeenCalled();
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [d.job.id],
  );
  await d.run(await fixture.rpc("claim_backend_job_v4"));
  expect(d.t.backend.storeDeliveryObject).not.toHaveBeenCalled();
  expect(d.render).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.db.query<any>(
        "select state from public.storage_write_intents where storage_key=$1",
        [d.key],
      )
    ).rows[0].state,
  ).toBe("unknown");
  expect(
    (
      await f.db.query<any>(
        "select app_private.storage_reserved_bytes($1)::int bytes",
        [f.w],
      )
    ).rows[0].bytes,
  ).toBe(10485760);
});

it.each(["input", "stored_token", "stored_expiry"])(
  "rejects a null cleanup %s before provenance or quota mutation",
  async (field) => {
    const { f } = fixture;
    const cleanup = (
      await f.db.query<any>(
        "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/null-lease',10,'Synthetic lease boundary') returning *",
        [f.w],
      )
    ).rows[0];
    const [j] = await fixture.rpc("claim_storage_cleanup");
    if (field !== "input")
      await f.db.query(
        `update public.storage_cleanup_queue set ${field === "stored_token" ? "lease_token" : "lease_until"}=null where id=$1`,
        [cleanup.id],
      );
    await expect(
      fixture.rpc("storage_cleanup_context", {
        cleanup_id: j.id,
        lease: field === "input" ? null : j.lease_token,
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.db.query<any>(
          "select status,estimated_size from public.storage_cleanup_queue where id=$1",
          [j.id],
        )
      ).rows[0],
    ).toEqual({ status: "running", estimated_size: 10 });
  },
);

it("does not borrow another workspace's private-key provenance", async () => {
  const { f } = fixture;
  await f.db.query(
    "insert into public.storage_write_intents(workspace_id,storage_key,state) values($1,'synthetic/collision','unstarted')",
    [f.w],
  );
  await f.db.exec(
    "alter table public.workspaces drop constraint workspaces_singleton_key",
  );
  const other = (
    await f.db.query<any>(
      "insert into public.workspaces(name,created_by) values('Synthetic isolated other',$1) returning id",
      [f.owner],
    )
  ).rows[0].id;
  await f.db.exec("savepoint collision");
  await expect(
    f.db.query(
      "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/collision',10,'Synthetic key collision')",
      [other],
    ),
  ).rejects.toThrow("STORAGE_WRITE_WORKSPACE_MISMATCH");
  await f.db.exec(
    "rollback to savepoint collision;release savepoint collision",
  );
  expect(
    (
      await f.db.query<any>(
        "select workspace_id,state from public.storage_write_intents where storage_key='synthetic/collision'",
      )
    ).rows[0],
  ).toEqual({ workspace_id: f.w, state: "unstarted" });
});

it("denies user access to send authorization and private intent metadata", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  await expect(
    fixture.rpc(
      "begin_render_storage_write",
      {
        job_id: d.job.id,
        lease: d.job.lease_token,
        storage_key: d.key,
        expected_hash: "a".repeat(64),
        expected_size: 10,
      },
      "synthetic-owner",
    ),
  ).rejects.toThrow();
  await expect(
    fixture.sql(
      "authenticated",
      f.owner,
      "select * from public.storage_write_intents",
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.db.query<any>(
        "select state from public.storage_write_intents where storage_key=$1",
        [d.key],
      )
    ).rows[0].state,
  ).toBe("unstarted");
});

it("reports currently retained uncertainty separately from historical done-key inventory", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  await fixture.rpc("begin_render_storage_write", {
    job_id: d.job.id,
    lease: d.job.lease_token,
    storage_key: d.key,
    expected_hash: "a".repeat(64),
    expected_size: 100,
  });
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason,status) values($1,'synthetic/historical-done',777,'Synthetic already completed history','done')",
    [f.w],
  );
  const status = await fixture.rpc("workspace_status", {}, "synthetic-owner");
  expect(status.storage_write_uncertainty).toEqual({
    unsettled_keys: 1,
    held_bytes: 10485760,
    quiescence_required_keys: 0,
    historical_inventory_keys: 1,
  });
  expect(
    (
      await f.db.query<any>(
        "select status,estimated_size from public.storage_cleanup_queue where storage_key='synthetic/historical-done'",
      )
    ).rows[0],
  ).toEqual({ status: "done", estimated_size: 777 });
});

it("preserves existing counted bytes on a definitive missing ready artifact with legacy write provenance", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  const ready = await d.run();
  const artifact = ready.artifacts[0];
  const context = await fixture.rpc(
    "artifact_context",
    { artifact_id: artifact.id },
    "synthetic-owner",
  );
  await f.db.query(
    "update public.storage_write_intents set state='legacy_unfenced' where storage_key=$1",
    [d.key],
  );
  d.t.objects.delete(d.key);
  const args = {
    artifact_id: artifact.id,
    actor_id: f.owner,
    package_id: context.package.id,
    expected_revision: context.package.revision,
    expected_hash: artifact.content_hash,
    expected_storage_key: d.key,
    error_code: "EXPORT_ARTIFACT_MISSING",
    actual_size: null,
  };
  expect(
    await fixture.rpc("report_export_package_artifact_failure", args),
  ).toEqual({ invalidated: true });
  expect(
    await fixture.rpc("report_export_package_artifact_failure", args),
  ).toEqual({ invalidated: false });
  const held = (
    await f.db.query<any>(
      "select app_private.storage_reserved_bytes($1)::int bytes",
      [f.w],
    )
  ).rows[0].bytes;
  expect(held).toBe(Number(artifact.expected_size));
  expect(
    (
      await f.db.query<any>(
        "select content_hash,status from public.export_artifacts where id=$1",
        [artifact.id],
      )
    ).rows[0],
  ).toEqual({ content_hash: artifact.content_hash, status: "expired" });
  const [cleanup] = await fixture.rpc("claim_storage_cleanup");
  expect(
    await fixture.rpc("storage_cleanup_context", {
      cleanup_id: cleanup.id,
      lease: cleanup.lease_token,
    }),
  ).toMatchObject({ write_state: "legacy_unfenced", can_delete: false });
  await expect(
    fixture.rpc("complete_storage_cleanup", {
      cleanup_id: cleanup.id,
      lease: cleanup.lease_token,
      succeeded: true,
    }),
  ).rejects.toThrow();
});

it("retains observed-write quota after a lost delete reply and subsequent empty deletion response", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  const ready = await d.run(),
    artifact = ready.artifacts[0];
  const o = (
    await f.db.query<any>(
      "select o.* from public.opportunities o join public.export_packages p on p.opportunity_id=o.id where p.id=$1",
      [d.job.entity_id],
    )
  ).rows[0];
  await fixture.rpc(
    "archive_opportunity",
    {
      opportunity_id: o.id,
      expected_revision: o.revision,
      archive: true,
      reason: "Synthetic deletion receipt race",
    },
    "synthetic-owner",
  );
  const preview = await fixture.rpc(
    "preview_opportunity_purge",
    { opportunity_id: o.id },
    "synthetic-owner",
  );
  await fixture.rpc(
    "purge_opportunity",
    {
      opportunity_id: o.id,
      preview_hash: preview.preview_hash,
      confirmed_title: o.title,
      reason: "Synthetic deletion receipt race",
      acknowledge_history: true,
    },
    "synthetic-owner",
  );
  const base = d.t.backend.internal.getMockImplementation()!;
  d.t.backend.internal.mockImplementation((name, args) =>
    [
      "claim_storage_cleanup",
      "storage_cleanup_context",
      "record_storage_cleanup_deletion",
      "complete_storage_cleanup",
      "defer_storage_cleanup",
    ].includes(name)
      ? base(name, args)
      : Promise.resolve(null),
  );
  let calls = 0;
  Object.assign(d.t.backend, {
    removeObject: vi.fn(async (path: string) => {
      calls++;
      if (calls === 1) {
        d.t.objects.delete(path);
        throw new AppError(
          503,
          "STORAGE_DELETE_FAILED",
          "Synthetic lost deletion reply",
        );
      }
      throw new AppError(
        503,
        "STORAGE_DELETE_RECEIPT_REQUIRED",
        "Synthetic empty deletion response",
      );
    }),
  });
  const env: BackendEnvironment = {
    url: "https://synthetic.test",
    publishableKey: "synthetic",
    serviceKey: "synthetic",
    workerSecret: "synthetic",
    allowedOrigins: [],
    models: modelEnvironments(() => undefined),
  };
  const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (let n = 0; n < 2; n++)
      await runWorkerMaintenance(
        d.t.backend as unknown as Backend,
        env,
        vi.fn(async () => {
          throw Error("No network expected");
        }),
      );
  } finally {
    quiet.mockRestore();
  }
  expect(calls).toBe(2);
  expect(d.t.objects.has(d.key)).toBe(false);
  expect(
    (
      await f.db.query<any>(
        "select status,error_code,estimated_size from public.storage_cleanup_queue where storage_key=$1",
        [d.key],
      )
    ).rows[0],
  ).toEqual({
    status: "blocked",
    error_code: "STORAGE_DELETE_SETTLEMENT_REQUIRED",
    estimated_size: Number(artifact.expected_size),
  });
  expect(
    (
      await f.db.query<any>(
        "select app_private.storage_reserved_bytes($1)::int bytes",
        [f.w],
      )
    ).rows[0].bytes,
  ).toBe(Number(artifact.expected_size));
});

it("permanently closes a never-sent key before cleanup and rejects later send authorization", async () => {
  const d = await prepared("ordinary"),
    { f } = fixture;
  await fixture.rpc("fail_export_package", {
    job_id: d.job.id,
    lease: d.job.lease_token,
    error_code: "EXPORT_PACKAGE_INVALID",
  });
  await f.db.query(
    "update public.storage_cleanup_queue set eligible_at=clock_timestamp()-interval '1 second' where storage_key=$1",
    [d.key],
  );
  const [cleanup] = await fixture.rpc("claim_storage_cleanup");
  expect(
    await fixture.rpc("storage_cleanup_context", {
      cleanup_id: cleanup.id,
      lease: cleanup.lease_token,
    }),
  ).toMatchObject({
    write_state: "unstarted",
    can_delete: true,
    delete_required: false,
  });
  expect(
    (
      await f.db.query<any>(
        "select send_closed_at from public.storage_write_intents where storage_key=$1",
        [d.key],
      )
    ).rows[0].send_closed_at,
  ).toBeTruthy();
  await fixture.rpc("complete_storage_cleanup", {
    cleanup_id: cleanup.id,
    lease: cleanup.lease_token,
    succeeded: true,
  });
  await expect(
    fixture.rpc("begin_render_storage_write", {
      job_id: d.job.id,
      lease: d.job.lease_token,
      storage_key: d.key,
      expected_hash: "a".repeat(64),
      expected_size: 10,
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='storage.write.authorized'",
      )
    ).rows[0].n,
  ).toBe(0);
});
