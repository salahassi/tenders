// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { typedVerificationFixtures } from "./typedVerificationFixtures";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint typed_phase;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) value`,
        entries.map(([, value]) =>
          value && typeof value === "object" ? JSON.stringify(value) : value,
        ),
      )
    ).rows[0]?.value;
  } catch (error) {
    await f.db.exec("rollback to savepoint typed_phase");
    throw error;
  } finally {
    await f.db.exec("reset role;release savepoint typed_phase");
  }
}
async function setup() {
  await f.db.query<any>(
    `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
    values($1,'draft_section',$1,'synthetic-typed-phase','queued',$2,'{"model_executor":2}')`,
    [f.w, f.owner],
  );
  const job = await rpc("claim_backend_job_v5");
  const store = new ModelGraphStore({ internal: rpc }, job, "c".repeat(64));
  await store.action("init", {
    input_hash: "d".repeat(64),
    task: "draft_section",
    graph_version: 1,
  });
  const candidate = typedVerificationFixtures.plan_commercial.candidate,
    units = candidateContent(candidate);
  const context = {
    original_task: "plan_commercial",
    original_context: {},
    candidate,
    candidate_hash: await sha256(JSON.stringify(candidate)),
    candidate_text: units.map((u) => u.text).join("\n"),
    content_units: units,
  };
  const phase = {
    backend: { internal: rpc },
    job,
    requestPrefix: "fixture:verification-0",
    evidence: [],
    requiredIds: [],
    language: "en" as const,
    repair: false,
  };
  const hash = await sha256(
    modelPrompt("verify_grounding", context, [], [], "en"),
  );
  return { job, store, context, phase, hash };
}
const ledger = () => ({
  preflight: async () => ({ providers: [] }),
  reserve: async () => {
    throw Error("Format selection must not reserve usage");
  },
  settle: async () => {
    throw Error("Format selection must not alter usage");
  },
});
it.each(["reserved", "unknown", "settled"])(
  "uses actual migrated phase receipts to preserve unpinned %s payload identity",
  async (state) => {
    const s = await setup();
    await f.db.query<any>(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
    application_day,settings_revision,reserved_input,reserved_output,state,created_by,remote_request_id,remote_deadline)
    values($1,$2,$3,$4,'openai','synthetic-model',$5,current_date,1,100,100,$6,$7,'synthetic-accepted',now()+interval '1 hour')`,
      [
        f.w,
        s.job.id,
        s.job.lease_token,
        `${s.phase.requestPrefix}:${s.hash.slice(0, 16)}:1:00000000-0000-4000-8000-000000000099`,
        s.hash,
        state,
        f.owner,
      ],
    );
    const before = (
      await f.db.query<any>(
        "select * from public.provider_usage where job_id=$1",
        [s.job.id],
      )
    ).rows;
    const wire = await verificationContext(s.store, ledger(), s.context, [], {
      phase: s.phase,
    });
    expect(wire).toEqual(s.context);
    expect(
      await sha256(modelPrompt("verify_grounding", wire, [], [], "en")),
    ).toBe(s.hash);
    expect(
      await s.store.action("result_get", {
        key: `verification-format-${s.context.candidate_hash}`,
      }),
    ).toBeNull();
    expect(
      (
        await f.db.query<any>(
          "select * from public.provider_usage where job_id=$1",
          [s.job.id],
        )
      ).rows,
    ).toEqual(before);
  },
);
it("preserves a saved legacy round without receipts or instruction pins", async () => {
  const s = await setup();
  await f.db.query<any>(
    "update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_round',jsonb_build_object('input_hash',$2::text)) where id=$1",
    [s.job.id, s.hash],
  );
  expect(
    await verificationContext(s.store, ledger(), s.context, [], {
      phase: s.phase,
    }),
  ).toEqual(s.context);
  expect(
    await s.store.action("result_get", {
      key: `verification-format-${s.context.candidate_hash}`,
    }),
  ).toBeNull();
});
it.each(["semantic-instructions", "verification-instructions"])(
  "preserves a prepared %s pin before any paid receipt exists",
  async (prefix) => {
    const s = await setup();
    await s.store.action("result_put", {
      key: `${prefix}-${await sha256(s.phase.requestPrefix)}`,
      value: { version: 2, legacy_input_hash: s.hash },
    });
    expect(
      await verificationContext(s.store, ledger(), s.context, [], {
        phase: s.phase,
      }),
    ).toEqual(s.context);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from public.provider_usage where job_id=$1",
          [s.job.id],
        )
      ).rows[0].count,
    ).toBe(0);
  },
);
it("pins and replays the new typed format without creating a provider reservation or candidate allowance", async () => {
  const s = await setup();
  const before = (
    await f.db.query<any>(
      "select * from app_private.model_graph_budgets where thread_id=$1",
      [s.store.thread],
    )
  ).rows;
  const wire = await verificationContext(s.store, ledger(), s.context, [], {
    phase: s.phase,
  });
  expect(wire.candidate.lines[0].included_in_base).toBe(false);
  expect(wire.candidate.lines[0].rate_id).toBeNull();
  expect(wire.response_style).toBe("compact-verification-v4");
  expect(
    await verificationContext(s.store, ledger(), s.context, [], {
      phase: s.phase,
    }),
  ).toEqual(wire);
  expect(
    (
      await f.db.query<any>(
        "select * from app_private.model_graph_budgets where thread_id=$1",
        [s.store.thread],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from public.provider_usage where job_id=$1",
        [s.job.id],
      )
    ).rows[0].count,
  ).toBe(0);
});
