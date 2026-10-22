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
import { workflowFixture } from "./workflowFixture";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import {
  pinSemanticPrompt,
  readSemanticPromptRevision,
} from "../../supabase/functions/_shared/modelSemanticPrompt";
import {
  SEMANTIC_INSTRUCTIONS_V1,
  SEMANTIC_PROMPT_V1,
} from "../../supabase/functions/_shared/modelSemanticInstructions";
import {
  FreeModelProvider,
  modelPrompt,
  sha256,
  taskSystemInstructions,
  type ModelTask,
} from "../../supabase/functions/_shared/model";
import { taskJsonSchema } from "../../supabase/functions/_shared/modelContract";
import { sourceReadingPrompt } from "../../supabase/functions/_shared/sourceModel";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.db.exec("rollback");
});
async function rpc(name: string, args: Record<string, unknown>) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint semantic_rpc;set local role service_role");
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
    await f.db.exec("rollback to savepoint semantic_rpc");
    throw error;
  } finally {
    await f.db.exec("reset role;release savepoint semantic_rpc");
  }
}
const context = {
  requirements: [
    {
      id: "req",
      text: "Missing mandatory information will disqualify a submission.",
    },
  ],
};
const evidence = [
  {
    id: "source",
    kind: "rfp" as const,
    verified: false,
    text: context.requirements[0].text,
  },
];
async function setup() {
  await f.db.query(
    `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
    values($1,'analyze_chunk',$1,'synthetic-semantic-pin','queued',$2,'{"model_executor":2}')`,
    [f.w, f.owner],
  );
  const job = await rpc("claim_backend_job_v2", {});
  const backend = { internal: rpc };
  const store = new ModelGraphStore(backend, job, "c".repeat(64));
  await store.action("init", {
    input_hash: "d".repeat(64),
    task: "analyze_chunk",
    graph_version: 1,
  });
  const options = {
    backend,
    store,
    job,
    requestPrefix: "analysis:candidate-0",
    task: "draft_section" as const,
    context,
    evidence,
    requiredIds: ["req"],
    language: "en" as const,
    repair: false,
    verificationRevision: 1 as const,
  };
  const legacy = modelPrompt(
    options.task,
    context,
    evidence,
    options.requiredIds,
    "en",
  );
  return { ...options, options, legacy, legacyHash: await sha256(legacy) };
}
async function usage(
  x: Awaited<ReturnType<typeof setup>>,
  state: string,
  hash = x.legacyHash,
) {
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
    application_day,settings_revision,reserved_input,reserved_output,state,created_by,remote_request_id,remote_deadline)
    values($1,$2,$3,$4,'openai','synthetic-model',$5,current_date,1,100,100,$6,$7,'synthetic-accepted',now()+interval '1 hour')`,
    [
      f.w,
      x.job.id,
      x.job.lease_token,
      `${x.requestPrefix}:${hash.slice(0, 16)}:1:00000000-0000-4000-8000-000000000099`,
      hash,
      state,
      f.owner,
    ],
  );
}

it.each(["reserved", "unknown", "settled"])(
  "preserves an already-started %s phase without needing execution metadata",
  async (state) => {
    const x = await setup();
    await usage(x, state);
    const before = (
      await f.db.query("select * from public.provider_usage where job_id=$1", [
        x.job.id,
      ])
    ).rows;
    expect(await pinSemanticPrompt(x.options)).toBe(0);
    expect(await readSemanticPromptRevision(x.store, x.requestPrefix)).toBe(0);
    expect(
      modelPrompt(x.task, context, evidence, ["req"], "en", false, 1, 0),
    ).toBe(x.legacy);
    expect(
      (
        await f.db.query(
          "select * from public.provider_usage where job_id=$1",
          [x.job.id],
        )
      ).rows,
    ).toEqual(before);
    expect(
      await pinSemanticPrompt({
        ...x.options,
        requestPrefix: "analysis:candidate-1",
        task: "repair_result",
      }),
    ).toBe(2);
  },
);

it("pins a legacy saved round before usage and preserves it after the round clears", async () => {
  const x = await setup();
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_round',jsonb_build_object('input_hash',$2::text)) where id=$1",
    [x.job.id, x.legacyHash],
  );
  expect(await pinSemanticPrompt(x.options)).toBe(0);
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint-'model_round' where id=$1",
    [x.job.id],
  );
  expect(await pinSemanticPrompt(x.options)).toBe(0);
});

it("pins new phases before dispatch, then keeps their wire input across polls and failover", async () => {
  const x = await setup();
  expect(await readSemanticPromptRevision(x.store, x.requestPrefix)).toBe(0);
  expect(await pinSemanticPrompt(x.options)).toBe(2);
  const prompt = modelPrompt(
    x.task,
    context,
    evidence,
    ["req"],
    "en",
    false,
    1,
    2,
  );
  const envelope = JSON.parse(prompt);
  expect(envelope.prompt_version).toContain(SEMANTIC_PROMPT_V1);
  expect(envelope.semantic_policy).toBe(SEMANTIC_INSTRUCTIONS_V1);
  expect(envelope.untrusted_data).toEqual(context);
  expect(envelope.evidence).toEqual(evidence);
  expect(await sha256(prompt)).not.toBe(x.legacyHash);
  await usage(x, "reserved", await sha256(prompt));
  expect(await pinSemanticPrompt(x.options)).toBe(2);
  expect(await readSemanticPromptRevision(x.store, x.requestPrefix)).toBe(2);
  expect(
    modelPrompt(x.task, context, evidence, ["req"], "en", false, 1, 2),
  ).toBe(prompt);
  await expect(
    pinSemanticPrompt({ ...x.options, context: { requirements: [] } }),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
  await expect(
    pinSemanticPrompt({ ...x.options, requiredIds: [] }),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
});

it("leaves historical reads unpinned and rejects corrupted policy and stale lease", async () => {
  const x = await setup();
  expect(await readSemanticPromptRevision(x.store, x.requestPrefix)).toBe(0);
  expect(
    (
      await f.db.query(
        "select count(*)::int n from app_private.model_graph_results where thread_id=$1",
        [x.store.thread],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  await expect(
    pinSemanticPrompt({
      ...x.options,
      job: { ...x.job, lease_token: crypto.randomUUID() },
    }),
  ).rejects.toThrow("STALE_LEASE");
  await pinSemanticPrompt(x.options);
  await f.db.query(
    "update app_private.model_graph_results set value=jsonb_set(value,'{instructions}','\"tampered\"') where thread_id=$1 and result_key like 'semantic-instructions-%'",
    [x.store.thread],
  );
  await expect(
    readSemanticPromptRevision(x.store, x.requestPrefix),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
});

it.each([
  "analyze_chunk",
  "plan_proposal",
  "draft_section",
  "plan_commercial",
  "review_proposal",
  "classify_opportunity",
  "summarize_review",
  "repair_result",
  "verify_grounding",
  "inspect_source_page",
] as ModelTask[])(
  "applies the same semantics to %s without changing its original evidence envelope",
  (task) => {
    const taskContext =
      task === "inspect_source_page"
        ? {
            mode: "collect_notices",
            url: "https://example.test",
            partial: false,
            links: [],
          }
        : context;
    const original = modelPrompt(
      task,
      taskContext,
      evidence,
      ["req"],
      "en",
      false,
      2,
      0,
    );
    const updated = JSON.parse(
      modelPrompt(task, taskContext, evidence, ["req"], "en", false, 2, 1),
    );
    const old = JSON.parse(original);
    expect(updated).toEqual({
      ...old,
      prompt_version: `${old.prompt_version}.${SEMANTIC_PROMPT_V1}`,
      semantic_policy: SEMANTIC_INSTRUCTIONS_V1,
    });
    expect(taskSystemInstructions(task, 2, 1)).toBe(
      `${taskSystemInstructions(task, 2, 0)}\n${SEMANTIC_INSTRUCTIONS_V1}`,
    );
    if (task === "inspect_source_page")
      expect(original).toBe(sourceReadingPrompt(taskContext, evidence, false));
  },
);

it("keeps original verifier system bytes and excludes content-free connection probes", async () => {
  expect(await sha256(taskSystemInstructions("verify_grounding", 1, 0))).toBe(
    "d26eeba5c33e50aebb03baeb00639e6ac4738c876bc48fd1a8f2dc4aa401473e",
  );
  const x = await setup();
  expect(
    await pinSemanticPrompt({ ...x.options, task: "connection_probe" }),
  ).toBe(0);
  expect(taskSystemInstructions("connection_probe", 1, 1)).toBe(
    taskSystemInstructions("connection_probe"),
  );
});

it.each([false, true])(
  "sends the frozen shared policy as trusted Gemini instructions (background=%s)",
  async (background) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const bodies: any[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        background
          ? { id: "synthetic-accepted", status: "in_progress" }
          : {
              candidates: [
                { finishReason: "STOP", content: { parts: [{ text: "{}" }] } },
              ],
            },
      );
    };
    for (const semanticRevision of [0, 1] as const) {
      const provider = new FreeModelProvider(
        {
          provider: "gemini_free",
          model: "synthetic-model",
          projectRef: "fixture",
          key: "fixture-key",
        },
        fetcher,
        90000,
        false,
        undefined,
        2,
        semanticRevision,
      );
      const prompt = modelPrompt(
        "verify_grounding",
        context,
        evidence,
        ["req"],
        "en",
        false,
        2,
        semanticRevision,
      );
      if (background)
        await provider.startBackground(
          "verify_grounding",
          prompt,
          taskJsonSchema("verify_grounding"),
        );
      else
        await provider.generate(
          "verify_grounding",
          prompt,
          taskJsonSchema("verify_grounding"),
        );
    }
    const system = (body: any) =>
      background
        ? body.system_instruction
        : body.systemInstruction.parts[0].text;
    expect(system(bodies[1])).toBe(
      `${system(bodies[0])}\n${SEMANTIC_INSTRUCTIONS_V1}`,
    );
  },
);
