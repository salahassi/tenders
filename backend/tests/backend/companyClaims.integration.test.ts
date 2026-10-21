// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import {
  ModelDeferred,
  modelPrompt,
  sha256,
  validateModelResult,
  type Evidence,
} from "../../supabase/functions/_shared/model";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { modelLedger } from "../../supabase/functions/_shared/modelLedger";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint claim_rpc;set local role service_role");
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
    await f.db.exec("rollback to savepoint claim_rpc");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role;release savepoint claim_rpc");
  }
}
async function configure(modelNames = ["fixture-writer", "fixture-verifier"]) {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
  });
  const connection = await f.command("model.connection.save", {
    provider: "groq_free",
    label: "Synthetic claim account",
    credential_alias: "APP_MODEL_GROQ_KEY",
    project_ref: "fixture-account",
    enabled: true,
    expected_revision: 0,
  });
  const models = [];
  for (const model of modelNames)
    models.push(
      await f.command("model.configuration.save", {
        connection_id: connection.id,
        label: model,
        model,
        enabled: true,
        capabilities: defaultCapabilities("groq_free"),
        expected_revision: 0,
      }),
    );
  await f.command("model.task_route.save", {
    task: "default",
    model_ids: models.map((m) => m.id),
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
  });
  const queued = await f.command("model.probe", {});
  const job = await rpc("claim_backend_job_v2");
  expect(job.id).toBe(queued.id);
  const environments = modelEnvironments((name) =>
    name.endsWith("_KEY")
      ? "fixture-key"
      : name.endsWith("_PROJECT")
        ? "fixture-account"
        : undefined,
  );
  return {
    job,
    environments,
    backend: { internal: rpc } as unknown as Backend,
  };
}

it.each([
  "supported_paraphrase",
  "unsupported_declared",
  "unsupported_undeclared",
])(
  "requires actual independent grounding before accepting company language: %s",
  async (mode) => {
    const { job, environments, backend } = await configure();
    const source: Evidence = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "company",
      verified: true,
      text: "Example Studio delivered workflow software for a public organization.",
    };
    const supported = mode === "supported_paraphrase";
    const text = supported
      ? "We have delivered workflow software for a public organization."
      : "We are certified to deliver regulated banking systems.";
    const summary = supported
      ? "Example Studio has delivered workflow software."
      : "Example Studio holds banking certifications.";
    const candidate = {
      key: "experience",
      title: "Experience",
      content_blocks: [{ type: "paragraph", text }],
      requirement_ids: [],
      evidence_refs: [{ id: source.id, quote: source.text }],
      company_claims:
        mode === "unsupported_undeclared"
          ? []
          : [{ claim: summary, source_id: source.id, quote: source.text }],
      assumptions: [],
      questions: [],
    };
    const calls: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content.split(
          "\nJSON schema: ",
        )[0],
      );
      calls.push(request.task);
      let result: any;
      if (request.task === "draft_section") result = candidate;
      else if (request.task === "repair_result")
        result = {
          target_task: "draft_section",
          result: candidate,
          changes: ["Synthetic unchanged repair must not bypass verification."],
        };
      else {
        expect(request.task).toBe("verify_grounding");
        const c = request.untrusted_data;
        expect(c.content_units.some((u: any) => u.text === text)).toBe(true);
        if (candidate.company_claims.length)
          expect(c.content_units.some((u: any) => u.text === summary)).toBe(
            true,
          );
        result = {
          checked_candidate_hash: c.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: c.content_units.map((u: any) => u.id),
          claims: [
            {
              id: "claim",
              claim: candidate.company_claims.length ? summary : text,
              candidate_quote: text,
              kind: "company_fact",
              status: supported ? "supported" : "insufficient",
              source_refs: [{ id: source.id, quote: source.text }],
              finding: supported
                ? "The exact verified company quotation supports the paraphrase."
                : "The cited software-delivery evidence does not establish certification.",
            },
          ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        };
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    const options = {
      backend,
      job,
      prefix: `claims:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [source],
      requiredIds: [],
      manifest: [],
      environments,
      language: "en" as const,
      repair: false,
      fetcher,
      validate: (result: any, policy?: { independentGrounding?: boolean }) => {
        expect(policy).toEqual({ independentGrounding: true });
        validateModelResult("draft_section", result, [source], [], policy);
      },
    };
    let current = job,
      outcome: Awaited<ReturnType<typeof executeGuardedModel>> | undefined,
      terminal: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        outcome = await executeGuardedModel({ ...options, job: current });
        break;
      } catch (error) {
        if ((error as any).code === "MODEL_CORRECTION_EXHAUSTED") {
          terminal = error;
          break;
        }
        expect(error).toBeInstanceOf(ModelDeferred);
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    if (supported) {
      expect(outcome?.result).toEqual(candidate);
      expect(outcome?.threadId).toBeTruthy();
      expect(calls).toEqual(["draft_section", "verify_grounding"]);
    } else {
      expect(outcome).toBeUndefined();
      expect(terminal).toBeTruthy();
      expect(calls).toEqual([
        "draft_section",
        "verify_grounding",
        "repair_result",
      ]);
    }
    const threads = (
      await f.db.query<any>(
        "select status from app_private.model_graph_threads where job_id=$1",
        [job.id],
      )
    ).rows;
    expect(threads).toEqual([
      { status: supported ? "accepted" : "needs_review" },
    ]);
  },
);

it("recovers a paid rejected writer through the existing produce checkpoint and mandatory verification without another writer request", async () => {
  const { job, environments, backend } = await configure([
    "fixture-writer-a",
    "fixture-writer-b",
    "fixture-writer-c",
    "fixture-verifier",
  ]);
  const source: Evidence = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "company",
    verified: true,
    text: "Example Studio delivered workflow software for a public organization.",
  };
  const candidate = {
    key: "experience",
    title: "Experience",
    content_blocks: [
      {
        type: "paragraph",
        text: "We have delivered workflow software for a public organization.",
      },
    ],
    requirement_ids: [],
    evidence_refs: [{ id: source.id, quote: source.text }],
    company_claims: [
      {
        claim: "Example Studio has delivered workflow software.",
        source_id: source.id,
        quote: source.text,
      },
    ],
    assumptions: [],
    questions: [],
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(
      JSON.parse(String(init?.body)).messages[1].content.split(
        "\nJSON schema: ",
      )[0],
    );
    calls.push(request.task);
    let result: any = candidate;
    if (request.task !== "draft_section") {
      expect(request.task).toBe("verify_grounding");
      const c = request.untrusted_data;
      expect(
        c.content_units.some(
          (u: any) => u.text === candidate.content_blocks[0].text,
        ),
      ).toBe(true);
      expect(
        c.content_units.some(
          (u: any) => u.text === candidate.company_claims[0].claim,
        ),
      ).toBe(true);
      result = {
        checked_candidate_hash: c.candidate_hash,
        reviewed_all_content: true,
        processed_content_ids: c.content_units.map((u: any) => u.id),
        claims: [
          {
            id: "claim",
            claim: candidate.company_claims[0].claim,
            candidate_quote: candidate.content_blocks[0].text,
            kind: "company_fact",
            status: "supported",
            source_refs: [{ id: source.id, quote: source.text }],
            finding:
              "Verified software-delivery evidence supports the paraphrase.",
          },
        ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [],
      };
    }
    return Response.json({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(result) } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    });
  };
  let corrected = false;
  const options = {
    backend,
    job,
    prefix: `paid-claims:${job.id}`,
    task: "draft_section" as const,
    context: {},
    evidence: [source],
    requiredIds: [],
    manifest: [],
    environments,
    language: "en" as const,
    repair: false,
    fetcher,
    validate: (result: any, policy?: { independentGrounding?: boolean }) => {
      expect(policy).toEqual({ independentGrounding: true });
      // Reproduce the old domain callback: verified paraphrases were rejected
      // after the paid response had already been counted and settled.
      validateModelResult(
        "draft_section",
        result,
        [source],
        [],
        corrected ? policy : undefined,
      );
    },
  };
  // This fixture reproduces a previously paid legacy writer round, not a new
  // V1 content-correction run. Preserve its original phase identity explicitly.
  await modelLedger(backend, job, options.prefix, environments).preflight(
    [],
    "draft_section",
  );
  Object.assign(
    job,
    (await f.db.query<any>("select * from public.jobs where id=$1", [job.id]))
      .rows[0],
  );
  const graphInputHash = await sha256(
    JSON.stringify({
      version: 1,
      task: options.task,
      context: options.context,
      evidence: options.evidence,
      requiredIds: options.requiredIds,
      manifest: options.manifest,
      language: options.language,
    }),
  );
  const threadId = await sha256(
    `${job.id}:${options.prefix}:${graphInputHash}`,
  );
  const store = new ModelGraphStore(backend, job, threadId);
  await store.action("init", {
    input_hash: graphInputHash,
    task: options.task,
    graph_version: 1,
  });
  await store.action("result_put", {
    key: `semantic-instructions-${await sha256(`${options.prefix}:candidate-0`)}`,
    value: {
      version: 0,
      legacy_input_hash: await sha256(
        modelPrompt(
          options.task,
          options.context,
          options.evidence,
          [],
          "en",
          false,
        ),
      ),
    },
  });
  await expect(executeGuardedModel(options)).rejects.toMatchObject({
    code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(calls).toEqual(["draft_section", "draft_section", "draft_section"]);
  const blocked = (
    await f.db.query<any>(
      "select id,status,candidate_count,result_id from app_private.model_graph_threads where job_id=$1",
      [job.id],
    )
  ).rows[0];
  expect(blocked).toMatchObject({
    status: "needs_review",
    candidate_count: 3,
    result_id: null,
  });
  const before = (
    await f.db.query<any>(
      "select id,state,actual_input,actual_output,graph_candidate_recorded from public.provider_usage where job_id=$1 order by id",
      [job.id],
    )
  ).rows;
  expect(before).toHaveLength(3);
  expect(
    before.every(
      (row: any) => row.state === "settled" && row.graph_candidate_recorded,
    ),
  ).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key like 'invalid-writer-%'",
        [blocked.id],
      )
    ).rows[0].count,
  ).toBe(3);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='candidate-0'",
        [blocked.id],
      )
    ).rows[0].count,
  ).toBe(0);
  corrected = true;
  let current = (
    await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
  ).rows[0];
  // Recovery replays the saved produce node from its immutable candidate cache.
  await expect(
    executeGuardedModel({ ...options, job: current }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  expect(calls).toHaveLength(3);
  const recovered = (
    await f.db.query<any>(
      "select status,candidate_count,result_id from app_private.model_graph_threads where id=$1",
      [blocked.id],
    )
  ).rows[0];
  expect(recovered).toEqual({
    status: "running",
    candidate_count: 3,
    result_id: null,
  });
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
        [blocked.id],
      )
    ).rows[0].count,
  ).toBe(0);
  current = await rpc("claim_backend_job_v2");
  expect(current.id).toBe(job.id);
  const outcome = await executeGuardedModel({ ...options, job: current });
  expect(outcome.result).toEqual(candidate);
  expect(calls).toEqual([
    "draft_section",
    "draft_section",
    "draft_section",
    "verify_grounding",
  ]);
  expect(
    (
      await f.db.query<any>(
        "select status,candidate_count from app_private.model_graph_threads where id=$1",
        [blocked.id],
      )
    ).rows[0],
  ).toEqual({ status: "accepted", candidate_count: 3 });
  expect(
    (
      await f.db.query<any>(
        "select id,state,actual_input,actual_output,graph_candidate_recorded from public.provider_usage where id=any($1::uuid[]) order by id",
        [before.map((row: any) => row.id)],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
        [blocked.id],
      )
    ).rows[0].candidates,
  ).toBe(3);
});
