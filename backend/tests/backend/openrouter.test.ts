// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { workflowFixture } from "./workflowFixture";
import { modelEnvironments } from "../../supabase/functions/_shared/backend";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";
import {
  defaultCapabilities,
  taskJsonSchema,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import { modelAdapters } from "../../supabase/functions/_shared/modelAdapters";
import { ROUND_ROBIN_PROVIDERS } from "../../supabase/functions/_shared/modelProviders";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});
afterAll(async () => {
  await f?.db.close();
});
it("uses a fixed OpenRouter endpoint, exact model ID and server-only credential with conservative capabilities", () => {
  const slots = modelEnvironments(
    (n) =>
      ({
        APP_MODEL_OPENROUTER_KEY: "fixture-key",
        APP_MODEL_OPENROUTER_NAME: "vendor/chosen-model:free",
      })[n],
  );
  expect(slots.openrouter.projectRef).toBe("default");
  const capabilities = defaultCapabilities("openrouter");
  expect(capabilities).toMatchObject({
    output: "validated_json",
    background: false,
  });
  const request = modelAdapters.openrouter.prepare(
    slots.openrouter,
    {
      task: "connection_probe",
      prompt: "Return JSON",
      system: "System",
      schema: taskJsonSchema("connection_probe"),
      profile: taskRegistry.connection_probe.profile,
      capabilities,
      stream: false,
    },
    false,
  );
  expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(request.headers.Authorization).toBe("Bearer fixture-key");
  expect(request.body).toMatchObject({
    model: "vendor/chosen-model:free",
    response_format: { type: "json_object" },
    provider: { require_parameters: true },
  });
  expect(JSON.stringify(request.body)).not.toContain("fixture-key");
  expect(
    modelAdapters.openrouter.normalize(
      {
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
      },
      false,
    ),
  ).toMatchObject({ complete: false, usage: { input: null, output: null } });
});
it("accepts all ten providers and previous complete orders, but rejects duplicates", () => {
  const base = { enabled: true, expected_revision: 0 };
  for (const order of [
    ROUND_ROBIN_PROVIDERS,
    ROUND_ROBIN_PROVIDERS.filter(
      (p) => p !== "qwencloud" && p !== "openrouter",
    ),
  ])
    expect(
      commandSchemas["model.routing"].safeParse({
        ...base,
        provider_order: order,
      }).success,
    ).toBe(true);
  expect(
    commandSchemas["model.routing"].safeParse({
      ...base,
      provider_order: ROUND_ROBIN_PROVIDERS.map(() => "openrouter"),
    }).success,
  ).toBe(false);
});
it("configures OpenRouter in the real database without granting content permission and normalizes old routing clients", async () => {
  const routing = await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    provider_order: ROUND_ROBIN_PROVIDERS.filter(
      (p) => p !== "qwencloud" && p !== "openrouter",
    ),
    strategy: "round_robin",
  });
  expect(routing.provider_order).toEqual(ROUND_ROBIN_PROVIDERS);
  const connection = await f.command("model.connection.save", {
    provider: "openrouter",
    label: "Fixture OpenRouter",
    credential_alias: "APP_MODEL_OPENROUTER_KEY",
    project_ref: "default",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Chosen model",
    model: "vendor/chosen-model:free",
    capabilities: defaultCapabilities("openrouter"),
    enabled: true,
    expected_revision: 0,
  });
  expect(model.model).toBe("vendor/chosen-model:free");
  await f.command("model.task_route.save", {
    task: "default",
    model_ids: [model.id],
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  const workspace = (
    await f.db.query<any>(
      "select discovery_policy from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0];
  expect(workspace.discovery_policy.providers || []).not.toContain(
    "openrouter",
  );
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.content_authorizations where provider='openrouter'",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("replays the production extension at its migration boundary without changing the saved cursor, permissions or revisions", async () => {
  const historical = await workflowFixture(
    undefined,
    "20261026112011_openrouter_provider.sql",
  );
  try {
    await historical.db.exec("begin");
    const routing = await historical.command("model.routing", {
      enabled: false,
      expected_revision: 0,
      strategy: "round_robin",
    });
    await historical.db.exec("update public.model_routing set next_position=7");
    const migration = await readFile(
      new URL(
        "../../supabase/migrations/20261026112011_openrouter_provider.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await historical.db.exec(migration);
    const saved = (
      await historical.db.query<any>("select * from public.model_routing")
    ).rows[0];
    expect(saved.revision).toBe(routing.revision);
    expect(saved.next_position).toBe(7);
    expect(saved.enabled).toBe(false);
    expect(saved.provider_order).toEqual(ROUND_ROBIN_PROVIDERS);
  } finally {
    await historical.db.close();
  }
});

it("refuses the historical extension on a newer verifier-guarded schema without changing state or weakening guards", async () => {
  await f.command("model.routing", {
    enabled: false,
    expected_revision: 0,
    strategy: "round_robin",
  });
  await f.db.exec("update public.model_routing set next_position=7");
  const snapshot = async () => ({
    routing: (
      await f.db.query("select * from public.model_routing order by id")
    ).rows,
    permissions: (
      await f.db.query(
        "select * from public.content_authorizations order by id",
      )
    ).rows,
    functions: (
      await f.db.query(
        "select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('reserve_model_call','start_model_attempt','prepare_model_routing','resume_model_request') order by oid::regprocedure::text",
      )
    ).rows,
  });
  const before = await snapshot();
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20261026112011_openrouter_provider.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await f.db.exec("savepoint reject_historical_extension");
  await expect(f.db.exec(migration)).rejects.toThrow(
    "Unexpected provider function version",
  );
  await f.db.exec("rollback to savepoint reject_historical_extension");
  expect(await snapshot()).toEqual(before);
  expect(JSON.stringify(before.functions)).toContain(
    "guard_analysis_recheck_request",
  );
});

it("sends OpenRouter reasoning in its normalized reasoning object", () => {
  const request = modelAdapters.openrouter.prepare(
    {
      provider: "openrouter",
      model: "vendor/model",
      projectRef: "default",
      key: "fixture-key",
    },
    {
      task: "connection_probe",
      prompt: "Return JSON",
      system: "System",
      schema: taskJsonSchema("connection_probe"),
      profile: { ...taskRegistry.connection_probe.profile, reasoning: "low" },
      capabilities: {
        ...defaultCapabilities("openrouter"),
        reasoning: "effort",
        reasoning_values: ["low"],
      },
      stream: false,
    },
    false,
  );
  expect(request.body).toMatchObject({ reasoning: { effort: "low" } });
  expect(request.body).not.toHaveProperty("reasoning_effort");
});
