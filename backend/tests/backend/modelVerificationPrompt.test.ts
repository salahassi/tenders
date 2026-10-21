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
import { pinVerificationPrompt } from "../../supabase/functions/_shared/modelVerificationPrompt";
import {
  VERIFICATION_INSTRUCTIONS_V2,
  VERIFICATION_PROMPT_V2,
} from "../../supabase/functions/_shared/modelVerificationInstructions";
import {
  FreeModelProvider,
  modelPrompt,
  sha256,
  taskSystemInstructions,
  writingGuide,
} from "../../supabase/functions/_shared/model";
import { taskJsonSchema } from "../../supabase/functions/_shared/modelContract";

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
  await f.db.exec("savepoint prompt_rpc; set local role service_role");
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
    await f.db.exec("rollback to savepoint prompt_rpc");
    throw error;
  } finally {
    await f.db.exec("reset role; release savepoint prompt_rpc");
  }
}
const context = {
  candidate_hash: "c".repeat(64),
  verification_scope: "content_batch",
  content_units: [
    { id: "content-0", text: "A software platform is required." },
  ],
};
const evidence = [
  {
    id: "source-1",
    kind: "rfp" as const,
    text: "A software platform is required.",
    verified: true,
  },
];
async function setup() {
  await f.db.query(
    `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
     values($1,'analyze_chunk',$1,'synthetic-phase-pin','queued',$2,'{"model_executor":2}')`,
    [f.w, f.owner],
  );
  const job = await rpc("claim_backend_job_v2", {});
  const backend = { internal: rpc };
  const store = new ModelGraphStore(backend, job, "a".repeat(64));
  await store.action("init", {
    input_hash: "b".repeat(64),
    task: "analyze_chunk",
    graph_version: 1,
  });
  const options = {
    backend,
    store,
    job,
    requestPrefix: "analysis:verification-v3:normal",
    context,
    evidence,
    requiredIds: [],
    language: "en" as const,
    repair: false,
  };
  const legacyHash = await sha256(
    modelPrompt("verify_grounding", context, evidence, [], "en"),
  );
  return { ...options, options, legacyHash };
}
async function addUsage(
  job: any,
  prefix: string,
  hash: string,
  state: string,
  remote: boolean,
) {
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
     application_day,settings_revision,reserved_input,reserved_output,state,created_by,remote_request_id,remote_deadline)
     values($1,$2,$3,$4,'gemini_free','synthetic-model',$5,current_date,1,100,100,$6,$7,$8,
     case when $8::text is null then null else now()+interval '1 hour' end)`,
    [
      f.w,
      job.id,
      job.lease_token,
      `${prefix}:${hash.slice(0, 16)}:1:00000000-0000-4000-8000-000000000099`,
      hash,
      state,
      f.owner,
      remote ? "synthetic-accepted" : null,
    ],
  );
}

it.each([
  ["reserved", true],
  ["unknown", true],
  ["unknown", false],
  ["settled", true],
  ["settled", false],
] as const)(
  "keeps a legacy %s phase (remote=%s) byte-identical across the prompt upgrade",
  async (state, remote) => {
    const x = await setup();
    await addUsage(x.job, x.requestPrefix, x.legacyHash, state, remote);
    expect(await pinVerificationPrompt(x.options)).toBe(1);
    const oldEnvelope = JSON.stringify({
      task: "verify_grounding",
      prompt_version: "tenderdesk-grounding-v1",
      writing_guide: writingGuide.en,
      repair_instruction: null,
      required_ids: [],
      untrusted_data: context,
      evidence,
    });
    expect(
      modelPrompt("verify_grounding", context, evidence, [], "en", false, 1),
    ).toBe(oldEnvelope);
    expect(await sha256(taskSystemInstructions("verify_grounding", 1))).toBe(
      "d26eeba5c33e50aebb03baeb00639e6ac4738c876bc48fd1a8f2dc4aa401473e",
    );
    expect(
      await pinVerificationPrompt({
        ...x.options,
        requestPrefix: `${x.requestPrefix}-correction`,
      }),
    ).toBe(2);
  },
);

it("pins a saved legacy round without usage and preserves the pin after that round clears", async () => {
  const x = await setup();
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_round',jsonb_build_object('input_hash',$2::text)) where id=$1",
    [x.job.id, x.legacyHash],
  );
  expect(await pinVerificationPrompt(x.options)).toBe(1);
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint-'model_round' where id=$1",
    [x.job.id],
  );
  expect(await pinVerificationPrompt(x.options)).toBe(1);
});

it("pins new initial and corrective phases before dispatch and never changes their identity on a poll", async () => {
  const x = await setup();
  expect(await pinVerificationPrompt(x.options)).toBe(2);
  const prompt = modelPrompt(
    "verify_grounding",
    context,
    evidence,
    [],
    "en",
    false,
    2,
  );
  expect(JSON.parse(prompt)).toMatchObject({
    prompt_version: VERIFICATION_PROMPT_V2,
    verification_policy: VERIFICATION_INSTRUCTIONS_V2,
  });
  expect(JSON.parse(prompt).untrusted_data).toEqual(context);
  await addUsage(
    x.job,
    x.requestPrefix,
    await sha256(prompt),
    "reserved",
    true,
  );
  expect(await pinVerificationPrompt(x.options)).toBe(2);
  expect(
    await pinVerificationPrompt({
      ...x.options,
      requestPrefix: "analysis:verification-v3:correction",
    }),
  ).toBe(2);
  await expect(
    pinVerificationPrompt({
      ...x.options,
      context: { ...context, candidate_hash: "d".repeat(64) },
    }),
  ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
});

it("keeps phase history private and rejects stale leases", async () => {
  const x = await setup();
  const privileges = (
    await f.db.query<any>(`select
    has_function_privilege('anon','public.model_phase_started(uuid,uuid,text,text)','execute') anon,
    has_function_privilege('authenticated','public.model_phase_started(uuid,uuid,text,text)','execute') authenticated,
    has_function_privilege('service_role','public.model_phase_started(uuid,uuid,text,text)','execute') service`)
  ).rows[0];
  expect(privileges).toEqual({
    anon: false,
    authenticated: false,
    service: true,
  });
  await expect(
    rpc("model_phase_started", {
      job_id: x.job.id,
      lease: crypto.randomUUID(),
      request_prefix: x.requestPrefix,
      legacy_input_hash: x.legacyHash,
    }),
  ).rejects.toThrow("STALE_LEASE");
});

it.each([false, true])(
  "sends the pinned policy as trusted Gemini system instructions (background=%s)",
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
    for (const revision of [1, 2] as const) {
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
        revision,
      );
      const prompt = modelPrompt(
        "verify_grounding",
        context,
        evidence,
        [],
        "en",
        false,
        revision,
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
    expect(await sha256(system(bodies[0]))).toBe(
      "d26eeba5c33e50aebb03baeb00639e6ac4738c876bc48fd1a8f2dc4aa401473e",
    );
    expect(system(bodies[1])).toBe(
      system(bodies[0]) + "\n" + VERIFICATION_INSTRUCTIONS_V2,
    );
    expect(system(bodies[1])).toContain("two source_refs entries");
    expect(system(bodies[1])).toContain(
      "not an abbreviated span with words omitted",
    );
  },
);
