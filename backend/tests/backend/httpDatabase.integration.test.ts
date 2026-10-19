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
import { seedExtraction } from "./sourceExtractionFixture";
import { workflowFixture } from "./workflowFixture";
import { createApiHandler } from "../../supabase/functions/api/handler";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { AppError, databaseError } from "../../supabase/functions/_shared/http";

// The production HTTP handlers, worker, migrations, commands and RLS run together.
// Auth-token verification, object transport and feed HTTP are local test doubles;
// this suite is not hosted Supabase Auth/Storage or browser acceptance evidence.
let f: Awaited<ReturnType<typeof workflowFixture>>;
const reviewer = "00000000-0000-4000-8000-000000000002";
const outsider = "00000000-0000-4000-8000-000000000003";
const objects = new Map<string, Blob>();
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public-key",
  serviceKey: "synthetic-server-key",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic-worker-secret",
  collectionHosts: ["feed.example.test"],
  models: modelEnvironments(() => undefined),
};
const actors = () => ({ owner: f.owner, reviewer, outsider });
const identifier = (value: string) => {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid fixture identifier");
  return `"${value}"`;
};
async function sql(
  role: "authenticated" | "service_role",
  actor: string,
  query: string,
  params: unknown[] = [],
) {
  await f.db.exec("savepoint transport_call");
  try {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      actor,
    ]);
    await f.db.exec(`set local role ${role}`);
    return (await f.db.query<Record<string, any>>(query, params)).rows;
  } catch (error) {
    await f.db.exec("rollback to savepoint transport_call");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role; release savepoint transport_call");
  }
}
function actorFor(token: string) {
  const actor = actors()[token as keyof ReturnType<typeof actors>];
  if (!actor)
    throw new AppError(401, "UNAUTHENTICATED", "Synthetic invalid session");
  return actor;
}
async function rpc(
  name: string,
  args: Record<string, unknown> = {},
  token?: string,
) {
  const entries = Object.entries(args);
  const parameters = entries
    .map(([key], i) => `${identifier(key)} => $${i + 1}`)
    .join(",");
  const rows = await sql(
    token ? "authenticated" : "service_role",
    token ? actorFor(token) : "",
    `select public.${identifier(name)}(${parameters}) data`,
    entries.map(([, value]) =>
      value && typeof value === "object" ? JSON.stringify(value) : value,
    ),
  );
  return rows[0]?.data;
}
const transport = {
  authenticate: async (token: string) => ({ id: actorFor(token) }),
  membership: async (token: string) => {
    const membership = (
      await sql(
        "authenticated",
        actorFor(token),
        "select * from public.current_membership()",
      )
    )[0];
    if (!membership)
      throw new AppError(403, "ACCESS_PENDING", "No active membership");
    return membership;
  },
  command: (token: string, operation: string, input: unknown, key: string) =>
    rpc("app_command", { operation, input, idempotency_key: key }, token),
  batch: (token: string, commands: unknown[], key: string) =>
    rpc("app_batch", { commands, idempotency_key: key }, token),
  one: async (token: string, table: string, id: string) => {
    const rows = await sql(
      "authenticated",
      actorFor(token),
      `select * from public.${identifier(table)} where id=$1`,
      [id],
    );
    if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Record unavailable");
    return rows[0];
  },
  list: async (
    token: string,
    table: string,
    filters: Record<string, string>,
    limit: number,
    cursor?: string,
  ) => {
    const values: unknown[] = [];
    const conditions = Object.entries(filters).map(([key, value]) => {
      values.push(value);
      return `${identifier(key)}=$${values.length}`;
    });
    if (cursor) {
      values.push(cursor);
      conditions.push(`id>$${values.length}`);
    }
    values.push(limit + 1);
    const rows = await sql(
      "authenticated",
      actorFor(token),
      `select * from public.${identifier(table)}${conditions.length ? ` where ${conditions.join(" and ")}` : ""} order by id limit $${values.length}`,
      values,
    );
    return {
      records: rows.slice(0, limit),
      next_cursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  },
  operations: async (token: string) =>
    (
      await sql(
        "authenticated",
        actorFor(token),
        "select * from public.operations",
      )
    )[0],
  internal: (name: string, args?: Record<string, unknown>) => rpc(name, args),
  claim: () => rpc("claim_backend_job"),
  object: async (path: string) => {
    const object = objects.get(path);
    if (!object)
      throw new AppError(422, "UPLOAD_NOT_FOUND", "No fixture bytes");
    return object;
  },
  verifyPages: (document_id: string, actual_pages: number) =>
    rpc("verify_document_pages", { document_id, actual_pages }),
  accept: (
    document_id: string,
    actor_id: string,
    actual_hash: string,
    actual_size: number,
    extraction_text: string,
    extraction_status: string,
    command_key: string,
  ) =>
    rpc("accept_uploaded_document", {
      document_id,
      actor_id,
      actual_hash,
      actual_size,
      extraction_text,
      extraction_status,
      command_key,
    }),
};
const factory = () => transport as unknown as Backend;
const handle = createApiHandler(env, factory);
const feed = vi.fn<typeof fetch>(
  async () =>
    new Response(
      `<rss version="2.0"><channel><title>Synthetic feed</title><item><guid>T1</guid><title>Synthetic approval workflow</title><link>https://feed.example.test/T1</link><description>Implement an approval workflow.</description></item></channel></rss>`,
      { headers: { "content-type": "application/rss+xml" } },
    ),
);
const worker = createWorkerHandler(env, async () => ["8.8.8.8"], factory, feed);
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = "owner",
  key = crypto.randomUUID(),
) {
  const response = await handle(
    new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
      method,
      headers: {
        origin: env.allowedOrigins[0],
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, ...(await response.json()) };
}
const command = (
  operation: string,
  input: unknown,
  token = "owner",
  key = crypto.randomUUID(),
) =>
  request("commands", "POST", { commands: [{ operation, input }] }, token, key);
async function runWorker() {
  const response = await worker(
    new Request("https://edge.example.test/worker", {
      method: "POST",
      headers: { "x-worker-secret": env.workerSecret },
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  f = await workflowFixture();
  for (const [id, email] of [
    [reviewer, "reviewer@example.test"],
    [outsider, "outsider@example.test"],
  ]) {
    await f.db.query("insert into auth.users values($1,$2,now())", [id, email]);
    await f.db.query(
      "insert into auth.identities values($1,'email',$2::jsonb)",
      [id, JSON.stringify({ sub: id })],
    );
  }
  await f.db.query(
    "insert into public.memberships(workspace_id,user_id,role,created_by) values($1,$2,'Reviewer',$3)",
    [f.w, reviewer, f.owner],
  );
  await f.db.query(
    "insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values($1,'email',$2::uuid::text,'reviewer@example.test',$2::uuid,'Reviewer',$3)",
    [f.w, reviewer, f.owner],
  );
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  objects.clear();
  feed.mockClear();
});
afterEach(async () => f.db.exec("rollback"));

it("connects a manual source through HTTP and SQL, enables it, collects with the worker and deduplicates opportunities", async () => {
  const input = {
    name: "Synthetic feed",
    kind: "manual",
    url: "https://feed.example.test/rss",
    approved_hosts: ["feed.example.test"],
    policy_note: "Synthetic fixture permission",
  };
  const key = crypto.randomUUID();
  const created = await request("sources", "POST", input, "owner", key);
  expect(created.status).toBe(201);
  expect((await request("sources", "POST", input, "owner", key)).data).toEqual(
    created.data,
  );
  expect(
    (
      await request(
        "sources",
        "POST",
        { ...input, name: "Changed replay" },
        "owner",
        key,
      )
    ).status,
  ).toBe(409);
  const premature = await request(
    `sources/${created.data.id}/actions`,
    "POST",
    {
      expected_revision: created.data.revision,
      action: "approve",
      reason: "Synthetic fixture permission",
    },
  );
  expect(premature.error.code).toBe("ADAPTER_REQUIRED");
  const configured = await command("source.configure", {
    id: created.data.id,
    expected_revision: created.data.revision,
    kind: "rss",
    url: input.url,
    approved_hosts: input.approved_hosts,
    policy_note: input.policy_note,
    poll_interval_hours: 6,
    adapter_config: {},
  });
  expect(configured.status).toBe(200);
  const saved = (await request("sources")).data.records.find(
    (s: any) => s.id === created.data.id,
  );
  expect(saved).toMatchObject({
    kind: "rss",
    approval: "paused",
    adapter_required: false,
  });
  const approved = await request(`sources/${created.data.id}/actions`, "POST", {
    expected_revision: saved.revision,
    action: "approve",
    reason: "Synthetic fixture permission",
  });
  expect(approved.status).toBe(200);
  expect((await runWorker()).data.processed).toBe(1);
  const first = await request("opportunities");
  expect(first.status).toBe(200);
  expect(first.data.records).toHaveLength(1);
  const opportunity = first.data.records[0];
  expect(opportunity.title).toBe("Synthetic approval workflow");
  expect(
    (
      await request(`opportunities/${opportunity.id}/decision`, "POST", {
        expected_revision: opportunity.revision,
        target_state: "declined",
        reason: "Synthetic human decision",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await command("source.collect", {
        id: created.data.id,
        expected_revision: approved.data.revision,
      })
    ).status,
  ).toBe(200);
  expect((await runWorker()).data.processed).toBe(1);
  const reloaded = await request("opportunities");
  expect(reloaded.data.records).toHaveLength(1);
  expect(reloaded.data.records[0].decision).toBe("declined");
  expect((await request("snapshots")).data.records).toHaveLength(1);
  expect((await request("source-runs")).data.records).toHaveLength(2);
  expect(feed).toHaveBeenCalledTimes(2);
});

it("persists combined collection and keeps discovered sources proposed through the real worker", async () => {
  const created = await request("sources", "POST", {
    name: "Synthetic combined listing",
    kind: "manual",
    url: "https://feed.example.test/listing",
  });
  const extraction = {
    ...seedExtraction("ps-najah"),
    url: "https://feed.example.test/listing",
    buyer: "Synthetic buyer",
  };
  const input = {
    id: created.data.id,
    expected_revision: created.data.revision,
    kind: "link_directory",
    url: extraction.url,
    approved_hosts: ["feed.example.test"],
    policy_note: "Synthetic permission",
    poll_interval_hours: 6,
    adapter_config: {
      official_listing: "configured",
      extraction,
      discover_source_links: true,
    },
  };
  expect(
    (
      await command("source.configure", {
        ...input,
        adapter_config: {
          ...input.adapter_config,
          discover_source_links: "true",
        },
      })
    ).status,
  ).toBe(400);
  expect((await command("source.configure", input)).status).toBe(200);
  const saved = (await request("sources")).data.records.find(
    (s: any) => s.id === created.data.id,
  );
  expect(saved.adapter_config.discover_source_links).toBe(true);
  const approved = await request(`sources/${saved.id}/actions`, "POST", {
    expected_revision: saved.revision,
    action: "approve",
    reason: "Synthetic permission",
  });
  expect(approved.status).toBe(200);
  const html = `<table class="table-bordered"><thead><tr><th>رقم العطاء</th></tr></thead><tbody><tr><td>SYN-1</td><td><a href="/notice/1">Synthetic software procurement</a></td><td>2026-10-19</td><td>2026-11-10</td><td>11:00</td></tr></tbody></table><a href="https://other.example.test/tenders">Other tender source</a>`;
  for (let i = 0; i < 2; i++) {
    if (i)
      await command("source.collect", {
        id: saved.id,
        expected_revision: approved.data.revision,
      });
    feed.mockResolvedValueOnce(new Response(html));
    const result = await runWorker();
    expect(result.data).toMatchObject({ processed: 1, candidates: i ? 0 : 1 });
  }
  expect((await request("opportunities")).data.records).toHaveLength(1);
  const sources = (await request("sources")).data.records;
  expect(sources).toHaveLength(2);
  const candidate = sources.find((s: any) => s.id !== saved.id);
  expect(candidate).toMatchObject({
    kind: "manual",
    approval: "proposed",
    adapter_required: true,
    next_due: null,
    approved_hosts: [],
  });
  expect(
    (
      await request(`sources/${candidate.id}/actions`, "POST", {
        expected_revision: candidate.revision,
        action: "approve",
        reason: "Synthetic attempted activation",
      })
    ).error.code,
  ).toBe("ADAPTER_REQUIRED");
});

it("persists a Gemini-only policy through the UI command route and enforces real SQL roles and revisions", async () => {
  const input = {
    expected_revision: 0,
    enabled: true,
    provider: "gemini_free",
    model: "synthetic-model",
    project_ref: "synthetic-project",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
    quota_remaining_tokens: 100000,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  };
  expect((await command("model.configure", input, "reviewer")).status).toBe(
    403,
  );
  expect((await command("model.configure", input, "outsider")).status).toBe(
    403,
  );
  expect((await command("model.configure", input, "invalid")).status).toBe(401);
  expect((await request("model-settings")).data.records).toHaveLength(0);
  expect((await command("model.configure", input)).status).toBe(200);
  const bootstrap = await request("bootstrap");
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.data.model.enabled).toBe(true);
  expect(bootstrap.data.model.providers).toHaveLength(1);
  const saved = bootstrap.data.model.providers[0];
  expect(saved.provider).toBe("gemini_free");
  expect(saved.failover_rank).toBe(1);
  expect(
    (await command("model.configure", { ...input, enabled: false })).status,
  ).toBe(409);
  expect(
    (
      await command("model.configure", {
        ...input,
        expected_revision: saved.revision,
        enabled: false,
      })
    ).status,
  ).toBe(200);
  expect((await request("bootstrap")).data.model.enabled).toBe(false);
});

it("verifies original bytes through HTTP completion before committing extraction and preventing changed replays", async () => {
  const source = await request("sources", "POST", {
    name: "Synthetic manual",
    kind: "manual",
  });
  const opportunity = await request("opportunities", "POST", {
    source_id: source.data.id,
    title: "Synthetic upload workflow",
    reference: "UPLOAD-1",
  });
  expect(opportunity.status).toBe(201);
  const text = "Implement a synthetic approval workflow.";
  const original = new Blob([text], { type: "text/plain" });
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", await original.arrayBuffer()),
  ).toString("hex");
  const prepared = await request("documents/prepare-upload", "POST", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.data.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: original.size,
    hash,
  });
  expect(prepared.status).toBe(201);
  const path = `documents/${prepared.data.id}/complete-upload`;
  const input = { status: "ready", extracted_text: text };
  objects.set(prepared.data.upload_path, new Blob(["Wrong bytes"]));
  expect((await request(path, "POST", input)).status).toBe(422);
  expect((await request("documents")).data.records[0].status).toBe("pending");
  objects.set(prepared.data.upload_path, original);
  expect((await request(path, "POST", input, "reviewer")).status).toBe(403);
  const key = crypto.randomUUID();
  const accepted = await request(path, "POST", input, "owner", key);
  expect(accepted.status).toBe(200);
  expect((await request(path, "POST", input, "owner", key)).data).toEqual(
    accepted.data,
  );
  expect(
    (
      await request(
        path,
        "POST",
        { ...input, extracted_text: "Changed replay" },
        "owner",
        key,
      )
    ).status,
  ).toBe(409);
  const reloaded = (await request("documents")).data.records[0];
  expect(reloaded.status).toBe("ready");
  expect(reloaded.original_hash).toBe(hash);
  expect(reloaded.extracted_text).toBe(text);
  expect((await request("document-blocks")).data.records).toHaveLength(1);
});
