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
import { workflowFixture, claimModelWorker4 } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import {
  FreeModelProvider,
  ModelDeferred,
} from "../../supabase/functions/_shared/model";
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
afterEach(async () => {
  vi.restoreAllMocks();
  await f.db.exec("rollback");
});

type Mode = "valid" | "semantic_defect" | "malformed" | "correct_report";
async function setup(mode: Mode = "valid") {
  const s = await createRecheckFixture(f);
  const child = await s.createChild();
  let job = await claimModelWorker4(f, s.rpc);
  expect(job.id).toBe(child.id);
  const phases: string[] = [],
    prompts: any[] = [],
    operations: any[] = [];
  const environments = modelEnvironments((name) =>
    name === "APP_MODEL_QWENCLOUD_KEY" ? "synthetic-only-key" : undefined,
  );
  const internal = vi.fn(async (name: string, args: any) => {
    operations.push({ name, args });
    return s.rpc(name, args).catch((error) => {
      throw databaseError(error);
    });
  });
  const backend = {
    internal,
    resolveModelEnvironment: (config: any) => ({
      ...environments.qwencloud,
      model: config.model,
      projectRef: config.project_ref,
    }),
  } as unknown as Backend;
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error("No external HTTP in synthetic runtime test");
  });
  const tokens = vi
    .spyOn(FreeModelProvider.prototype, "countTokens")
    .mockImplementation(async (prompt) => {
      expect(JSON.parse(prompt).task).toBe("verify_grounding");
      return 100;
    });
  const start = vi
    .spyOn(FreeModelProvider.prototype, "startBackground")
    .mockImplementation(async () => {
      throw new Error("No background request expected");
    });
  const poll = vi
    .spyOn(FreeModelProvider.prototype, "pollBackground")
    .mockImplementation(async () => {
      throw new Error("No background poll expected");
    });
  const generate = vi
    .spyOn(FreeModelProvider.prototype, "generate")
    .mockImplementation(async function (this: FreeModelProvider, task, prompt) {
      this.generationSent = true;
      phases.push(task);
      expect(task).toBe("verify_grounding");
      const p = JSON.parse(prompt),
        c = p.untrusted_data;
      prompts.push(p);
      expect(p.prompt_version).toContain(
        "tenderdesk-grounding-v4-analysis-boundary",
      );
      expect(p.verification_coverage_contract.kind).toBe(
        "source_block_extraction",
      );
      const source = p.evidence.find((e: any) => e.id === p.required_ids[0]);
      const result = {
        checked_candidate_hash: c.candidate_hash,
        reviewed_all_content: true,
        processed_content_ids: c.content_units.map((unit: any) => unit.id),
        claims: [
          {
            id: "summary",
            claim: "Faithful reference attribution.",
            candidate_quote: c.content_units[0].text,
            kind: "tender_fact",
            status: "supported",
            source_refs: [{ id: source.id, quote: source.text }],
            finding: "The source describes reference material.",
          },
        ],
        processed_requirement_ids: p.required_ids,
        requirement_checks: p.required_ids.map((id: string) => ({
          requirement_id: id,
          status: mode === "semantic_defect" ? "insufficient" : "supported",
          candidate_quote: c.content_units[0].text,
          source_refs: [{ id, quote: source.text }],
          finding:
            mode === "semantic_defect"
              ? "A buyer obligation was omitted from the extraction."
              : "Source processing is complete.",
        })),
        findings: [],
      };
      if (
        mode === "malformed" ||
        (mode === "correct_report" && !c.invalid_verification_result)
      )
        result.claims[0].source_refs[0].quote = "Invented source quotation.";
      return {
        text: JSON.stringify(result),
        usage: { input: 80, output: 40, thinking: 0 },
        complete: true,
      };
    });
  const validate = vi.fn();
  const options = {
    backend,
    prefix: `step:${child.step_id}`,
    task: "analyze_chunk" as const,
    context: s.input.context,
    evidence: s.input.evidence,
    requiredIds: s.input.requiredIds,
    manifest: s.input.manifest,
    environments,
    language: "en" as const,
    repair: false,
    fetcher,
    validate,
  };
  async function invoke() {
    return executeGuardedModel({ ...options, job });
  }
  async function resume() {
    job = await claimModelWorker4(f, s.rpc);
    expect(job.id).toBe(child.id);
  }
  async function run() {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        return await invoke();
      } catch (error) {
        if (!(error instanceof ModelDeferred)) throw error;
        await resume();
      }
    }
    throw new Error(
      "Verifier child failed to finish within bounded fixture leases",
    );
  }
  return {
    ...s,
    child,
    get job() {
      return job;
    },
    options,
    invoke,
    resume,
    run,
    phases,
    prompts,
    operations,
    tokens,
    start,
    poll,
    generate,
    fetcher,
    validate,
    internal,
  };
}

it("seeds the exact paid writer, makes only a fresh verifier call, and replays accepted output without another provider operation", async () => {
  const s = await setup();
  const parentReceipts = (
    await f.db.query<any>(
      "select to_jsonb(u) value from public.provider_usage u where job_id=$1 order by id",
      [s.parent.id],
    )
  ).rows;
  const parentBudgets = (
    await f.db.query<any>(
      "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
      [s.threadId],
    )
  ).rows;
  const original = await f.db.query<any>(
    "select result_key,value,content_hash from app_private.model_graph_results where thread_id=$1 order by result_key",
    [s.threadId],
  );
  const outcome = await s.run();
  expect(outcome.result).toEqual(s.candidate.value.result);
  expect(outcome.threadId).not.toBe(s.threadId);
  expect(s.phases).toEqual(["verify_grounding"]);
  expect(
    s.operations
      .filter((x) => x.name === "prepare_task_model_route")
      .map((x) => x.args.task_name),
  ).toEqual(expect.arrayContaining(["verify_grounding"]));
  expect(
    s.operations
      .filter((x) => x.name === "prepare_task_model_route")
      .every((x) => x.args.task_name === "verify_grounding"),
  ).toBe(true);
  const budgets = (
    await f.db.query<any>(
      "select unit,candidates from app_private.model_graph_budgets where thread_id=$1",
      [outcome.threadId],
    )
  ).rows;
  expect(budgets).toEqual([
    { unit: `verifier-${s.candidateHash}`, candidates: 1 },
  ]);
  const tokens = s.tokens.mock.calls.length;
  expect((await s.invoke()).result).toEqual(outcome.result);
  expect(s.phases).toEqual(["verify_grounding"]);
  expect(s.tokens).toHaveBeenCalledTimes(tokens);
  expect(s.fetcher).not.toHaveBeenCalled();
  expect(s.start).not.toHaveBeenCalled();
  expect(s.poll).not.toHaveBeenCalled();
  expect(
    (
      await f.db.query<any>(
        "select result_key,value,content_hash from app_private.model_graph_results where thread_id=$1 order by result_key",
        [s.threadId],
      )
    ).rows,
  ).toEqual(original.rows);
  expect(s.validate).toHaveBeenCalledWith(s.candidate.value.result, {
    independentGrounding: true,
  });
  expect(
    (
      await f.db.query<any>(
        "select to_jsonb(u) value from public.provider_usage u where job_id=$1 order by id",
        [s.parent.id],
      )
    ).rows,
  ).toEqual(parentReceipts);
  expect(
    (
      await f.db.query<any>(
        "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
        [s.threadId],
      )
    ).rows,
  ).toEqual(parentBudgets);
  await s.rpc("complete_generation_graph", {
    job_id: s.job.id,
    lease: s.job.lease_token,
    result: outcome.result,
    thread_id: outcome.threadId,
  });
  expect((await s.row("public.generation_steps", s.child.step_id)).status).toBe(
    "completed",
  );
});

it("resumes after the exact seed is saved before any graph checkpoint without a writer call", async () => {
  const s = await setup();
  const original = s.internal.getMockImplementation()!;
  let interrupted = false;
  s.internal.mockImplementation(async (name, args) => {
    const value = await original(name, args);
    if (
      !interrupted &&
      name === "model_graph_store" &&
      args.action === "result_put" &&
      args.payload.key === "candidate-0"
    ) {
      interrupted = true;
      throw new Error("Synthetic process interruption after seed save");
    }
    return value;
  });
  await expect(s.invoke()).rejects.toThrow("Synthetic process interruption");
  expect(s.generate).not.toHaveBeenCalled();
  expect(s.tokens).not.toHaveBeenCalled();
  expect((await s.run()).result).toEqual(s.candidate.value.result);
  expect(s.phases).toEqual(["verify_grounding"]);
});

it("revalidates a cached accepted report and refuses corrupted quotations without another model call", async () => {
  const s = await setup();
  await s.run();
  const original = s.internal.getMockImplementation()!;
  s.internal.mockImplementation(async (name, args) => {
    const value = await original(name, args);
    if (
      name === "model_graph_store" &&
      args.action === "result_get" &&
      args.payload.key === `verification-${s.candidateHash}`
    ) {
      const changed = structuredClone(value);
      changed.value.result.claims[0].source_refs[0].quote =
        "Synthetic corrupted source quotation.";
      return changed;
    }
    return value;
  });
  const calls = s.generate.mock.calls.length,
    counts = s.tokens.mock.calls.length;
  await expect(s.invoke()).rejects.toMatchObject({
    code: "EVIDENCE_REFERENCE_INVALID",
  });
  expect(s.generate).toHaveBeenCalledTimes(calls);
  expect(s.tokens).toHaveBeenCalledTimes(counts);
});

it("rechecks current content authorization before returning an accepted cache", async () => {
  const s = await setup();
  await s.run();
  const document = s.input.manifest.find(
    (ref) => ref.entity_kind === "document",
  )!;
  const authorization = await f.command("content.authorize", {
    ...document,
    provider: "qwencloud",
    attestation: "nonconfidential_nonpersonal",
  });
  await f.command("content.revoke", {
    id: authorization.id,
    expected_revision: authorization.revision,
  });
  // The isolated fixture shares one transaction; now() precedes the child's
  // clock_timestamp() receipt. Represent a subsequent production request.
  await f.db.query(
    "update public.content_authorizations set revoked_at=clock_timestamp() where id=$1",
    [authorization.id],
  );
  const calls = s.generate.mock.calls.length,
    counts = s.tokens.mock.calls.length;
  await expect(s.invoke()).rejects.toThrow(
    /authorization|required|permission/i,
  );
  expect(s.generate).toHaveBeenCalledTimes(calls);
  expect(s.tokens).toHaveBeenCalledTimes(counts);
});

it("refuses accepted-cache replay when all currently authorized verifier targets are disabled", async () => {
  const s = await setup();
  await s.run();
  await f.command("model.configuration.save", {
    id: s.model.id,
    connection_id: s.connection.id,
    label: s.model.label,
    model: s.model.model,
    enabled: false,
    capabilities: s.model.capabilities,
    expected_revision: s.model.revision,
  });
  const calls = s.generate.mock.calls.length,
    counts = s.tokens.mock.calls.length;
  await expect(s.invoke()).rejects.toMatchObject({
    code: "MODEL_NOT_CONFIGURED",
  });
  expect(s.generate).toHaveBeenCalledTimes(calls);
  expect(s.tokens).toHaveBeenCalledTimes(counts);
});

it("keeps a real verifier defect in needs_review without a writer repair or recovery fallback", async () => {
  const s = await setup("semantic_defect");
  await expect(s.run()).rejects.toMatchObject({
    code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(s.phases).toEqual(["verify_grounding"]);
  await expect(s.invoke()).rejects.toMatchObject({
    code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(s.phases).toEqual(["verify_grounding"]);
  const thread = (
    await f.db.query<any>(
      "select status from app_private.model_graph_threads where job_id=$1",
      [s.child.id],
    )
  ).rows[0];
  expect(thread.status).toBe("needs_review");
  expect(
    s.operations.some(
      (x) =>
        x.args?.action?.includes("recovery") ||
        x.args?.action === "writer_handoff",
    ),
  ).toBe(false);
});

it("rejects stale runtime context before token counting or any provider generation", async () => {
  const s = await setup();
  await expect(
    executeGuardedModel({
      ...s.options,
      job: s.job,
      context: {
        ...s.input.context,
        instruction: "Changed frozen instruction",
      },
    }),
  ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
  expect(s.tokens).not.toHaveBeenCalled();
  expect(s.generate).not.toHaveBeenCalled();
  expect(s.fetcher).not.toHaveBeenCalled();
});

it("rejects malformed lineage without falling through to a legacy writer", async () => {
  const s = await setup();
  await expect(
    executeGuardedModel({
      ...s.options,
      job: {
        ...s.job,
        checkpoint: { ...s.job.checkpoint, verifier_recheck: null },
      },
    }),
  ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
  expect(s.internal).not.toHaveBeenCalled();
  expect(s.tokens).not.toHaveBeenCalled();
  expect(s.generate).not.toHaveBeenCalled();
});

it("allows one fresh report correction while preserving the original candidate and invalid report", async () => {
  const s = await setup("correct_report");
  expect((await s.run()).result).toEqual(s.candidate.value.result);
  expect(s.phases.length).toBeGreaterThan(1);
  expect(s.phases.every((task) => task === "verify_grounding")).toBe(true);
  expect(
    s.prompts.filter((p) => p.untrusted_data.invalid_verification_result),
  ).toHaveLength(1);
  const rows = (
    await f.db.query<any>(
      "select result_key,value from app_private.model_graph_results where thread_id<>$1 and result_key like 'invalid-report-%'",
      [s.threadId],
    )
  ).rows;
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].value.code).toBe("EVIDENCE_REFERENCE_INVALID");
});

it("never accepts a malformed corrective report or uses it to repair the writer", async () => {
  const s = await setup("malformed");
  await expect(s.run()).rejects.toMatchObject({
    code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(s.phases.length).toBeLessThanOrEqual(4);
  expect(s.phases.every((task) => task === "verify_grounding")).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select id from app_private.model_graph_results where thread_id<>$1 and result_key='accepted'",
        [s.threadId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.query<any>(
        "select status from app_private.model_graph_threads where job_id=$1",
        [s.child.id],
      )
    ).rows[0].status,
  ).toBe("needs_review");
  const calls = s.generate.mock.calls.length;
  await expect(s.invoke()).rejects.toMatchObject({
    code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(s.generate).toHaveBeenCalledTimes(calls);
});
