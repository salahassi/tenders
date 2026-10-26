// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { modelEnvironments } from "../../supabase/functions/_shared/backend";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";
import {
  defaultCapabilities,
  resolveProfile,
  taskJsonSchema,
} from "../../supabase/functions/_shared/modelContract";
import { modelAdapters } from "../../supabase/functions/_shared/modelAdapters";
import { ROUND_ROBIN_PROVIDERS } from "../../supabase/functions/_shared/modelProviders";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});
it("isolates QwenCloud Singapore from the existing Alibaba workspace endpoint and credential", () => {
  const keys: Record<string, string> = {
    APP_MODEL_QWENCLOUD_KEY: "fixture-cloud-key",
    APP_MODEL_QWENCLOUD_NAME: "owner-qwencloud-model",
    APP_MODEL_QWEN_KEY: "fixture-alibaba-key",
    APP_MODEL_QWEN_NAME: "owner-alibaba-model",
    APP_MODEL_QWEN_PROJECT: "fixture-workspace",
  };
  const slots = modelEnvironments((n) => keys[n]);
  expect(slots.qwencloud.projectRef).toBe("ap-southeast-1");
  const capabilities = defaultCapabilities("qwencloud");
  expect(capabilities).toMatchObject({
    output: "validated_json",
    reasoning: "qwen_toggle",
    reasoning_values: ["none"],
    background: false,
  });
  const input = {
    task: "connection_probe",
    prompt: "Return JSON",
    system: "System",
    schema: taskJsonSchema("connection_probe"),
    profile: resolveProfile("connection_probe", capabilities),
    capabilities,
    stream: false,
  };
  const request = modelAdapters.qwencloud.prepare(
    slots.qwencloud,
    input,
    false,
  );
  expect(request.url).toBe(
    "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
  );
  expect(request.url).not.toContain(
    slots.qwencloud.projectRef + ".ap-southeast-1",
  );
  expect(request.headers.Authorization).toBe("Bearer fixture-cloud-key");
  expect(request.body).toMatchObject({
    model: "owner-qwencloud-model",
    response_format: { type: "json_object" },
    enable_thinking: false,
  });
  expect(JSON.stringify(request.body)).not.toContain("fixture-cloud-key");
  const alibaba = modelAdapters.qwen_free.prepare(
    slots.qwen_free,
    input,
    false,
  );
  expect(alibaba.url).toBe(
    "https://fixture-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  expect(alibaba.headers.Authorization).toBe("Bearer fixture-alibaba-key");
});
it("keeps a missing QwenCloud key missing even when Alibaba is configured", () => {
  const slots = modelEnvironments((n) =>
    n === "APP_MODEL_QWEN_KEY" ? "fixture-alibaba-key" : undefined,
  );
  expect(slots.qwencloud.key).toBe("");
});
it("accepts the previous nine-provider client and configures QwenCloud without copying content authorization", async () => {
  const previous = ROUND_ROBIN_PROVIDERS.filter((p) => p !== "qwencloud");
  expect(
    commandSchemas["model.routing"].safeParse({
      enabled: false,
      expected_revision: 0,
      provider_order: previous,
    }).success,
  ).toBe(true);
  const routing = await f.command("model.routing", {
    enabled: false,
    expected_revision: 0,
    provider_order: previous,
    strategy: "round_robin",
  });
  expect(routing.provider_order).toEqual(ROUND_ROBIN_PROVIDERS);
  const connection = await f.command("model.connection.save", {
    provider: "qwencloud",
    label: "Fixture QwenCloud",
    credential_alias: "APP_MODEL_QWENCLOUD_KEY",
    project_ref: "ap-southeast-1",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Chosen QwenCloud model",
    model: "owner-qwencloud-model",
    capabilities: defaultCapabilities("qwencloud"),
    enabled: true,
    expected_revision: 0,
  });
  expect(model.capabilities.reasoning).toBe("qwen_toggle");
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.content_authorizations where provider='qwencloud'",
      )
    ).rows[0].n,
  ).toBe(0);
  const workspace = (
    await f.db.query<any>(
      "select discovery_policy from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0];
  expect(workspace.discovery_policy.providers || []).not.toContain("qwencloud");
});
