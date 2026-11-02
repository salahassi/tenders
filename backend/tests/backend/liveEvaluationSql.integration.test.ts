// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => {
  await f?.db.close();
});
const script = (s: string) =>
  s
    .replaceAll("__WORKSPACE__", f.w)
    .replaceAll(
      "current_database() <> 'tenderdesk_app'",
      "current_database() <> 'postgres'",
    )
    .replaceAll(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    )
    .replaceAll("SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres");
it.each(["core", "extended", "extended_recheck"])(
  "executes the %s catalog projection against every current migration in a read-only transaction",
  async (suite) => {
    const py = readFileSync(
      new URL("../../scripts/ops/live-model-evaluation.py", import.meta.url),
      "utf8",
    );
    const coreSql = py.split('CATALOG_SQL = """')[1].split('""".replace')[0];
    // Python guard tests verify these exact suite-specific substitutions.
    const sql =
      suite !== "core"
        ? coreSql
            .replace(
              "c.provider IN ('openai','qwencloud')",
              suite === "extended_recheck"
                ? "c.provider='qwencloud' AND m.model IN ('deepseek-v4-pro','qwen3.8-max')"
                : "c.provider='qwencloud'",
            )
            .replace("LIMIT 5", "LIMIT 3")
        : coreSql;
    const result = await f.db.exec(script(sql));
    expect(result.some((r) => r.rows.length === 1)).toBe(true);
  },
);
it("executes the exact expanded routing and frozen-pool diagnostic in a read-only transaction", async () => {
  const sql = readFileSync(
    new URL("../../scripts/ops/ai-routing-diagnostic.sql", import.meta.url),
    "utf8",
  );
  const result = await f.db.exec(script(sql));
  const report: any = result
    .flatMap((r) => r.rows)
    .find((r: any) => r.jsonb_build_object)?.jsonb_build_object;
  expect(report).toHaveProperty("frozen_pools");
  expect(report).toHaveProperty("current_routes");
  expect(report.provider_history).toEqual([]);
});

const permissionSql = () =>
  readFileSync(
    new URL(
      "../../scripts/ops/ai-content-permission-diagnostic.sql",
      import.meta.url,
    ),
    "utf8",
  );

it.each(["database", "workspace"])(
  "refuses content permission diagnosis against the wrong %s",
  async (mismatch) => {
    const sql = script(permissionSql());
    try {
      await expect(
        f.db.exec(
          mismatch === "database"
            ? sql.replace("<> 'postgres'", "<> 'wrong_database'")
            : sql.replaceAll(f.w, crypto.randomUUID()),
        ),
      ).rejects.toThrow("CONTENT_PERMISSION_DIAGNOSTIC_DATABASE_MISMATCH");
    } finally {
      await f.db.exec("rollback");
    }
  },
);

it("reports exact frozen reference permissions without authorizing content or exporting text, hashes, or identities", async () => {
  await f.db.exec("begin");
  const source = await f.command("source.create", {
    name: "Synthetic diagnostic source",
    kind: "manual",
  });
  for (const provider of ["openai", "qwencloud"]) {
    await f.command("model.connection.save", {
      provider,
      label: "Synthetic diagnostic account",
      credential_alias: `APP_MODEL_${provider.toUpperCase()}_KEY`,
      project_ref: "synthetic-account",
      enabled: true,
      expected_revision: 0,
    });
  }
  const approvedAt = "2026-10-30T12:00:00Z";
  await f.db.query(
    "update public.workspaces set discovery_policy=$1::jsonb where id=$2",
    [
      JSON.stringify({
        scope: "company_knowledge",
        include_keywords: [],
        exclude_keywords: [],
        auto_public_notices: true,
        auto_company_knowledge: true,
        providers: ["openai"],
        approved_by: f.owner,
        approved_at: approvedAt,
      }),
      f.w,
    ],
  );
  const hidden = "SYNTHETIC_CONTENT_MUST_NOT_BE_EXPORTED";
  const companyId = crypto.randomUUID();
  const companyHash = "c".repeat(64);
  const noticeHash = "d".repeat(64);
  const entityIds: string[] = [companyId];
  for (const requested of [false, true]) {
    const opportunity = await f.command("opportunity.create", {
      source_id: source.id,
      title: "Synthetic diagnostic opportunity",
      description: hidden,
      language: "en",
    });
    const planId = crypto.randomUUID();
    entityIds.push(opportunity.id, planId);
    await f.db.query(
      `insert into public.generation_plans(id,workspace_id,opportunity_id,kind,stage,status,
        input_hash,frozen_context,created_by,evidence_revision)
       values($1,$2,$3,'assessment','assessment','running','synthetic',$4::jsonb,$5,1)`,
      [
        planId,
        f.w,
        opportunity.id,
        JSON.stringify({
          notice: {
            text: hidden,
            reference: {
              entity_kind: "notice",
              entity_id: opportunity.id,
              content_hash: noticeHash,
            },
          },
          knowledge: [
            {
              kind: "company",
              verified: true,
              text: hidden,
              reference: {
                entity_kind: "knowledge",
                entity_id: companyId,
                content_hash: companyHash,
              },
            },
            {
              kind: "style",
              verified: true,
              reference: {
                entity_kind: "knowledge",
                entity_id: crypto.randomUUID(),
                content_hash: "e".repeat(64),
              },
            },
          ],
        }),
        f.owner,
      ],
    );
    await f.db.query(
      `insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,
        provider,attestation,created_by,revoked_at)
       values($1,'notice',$2,$3,'openai','nonconfidential_nonpersonal',$4,null),
        ($1,'notice',$2,$3,'qwencloud','nonconfidential_nonpersonal',$4,'2026-11-01T12:00:00Z')`,
      [f.w, opportunity.id, noticeHash, f.owner],
    );
    if (requested) {
      await f.db.query(
        `insert into app_private.generation_processing_requests(plan_id,workspace_id,requested_by,
          operation,idempotency_key,requested_at)
         values($1,$2,$3,'opportunity.assess','synthetic-request','2026-10-31T12:00:00Z')`,
        [planId, f.w, f.owner],
      );
    }
  }
  await f.db.query(
    `insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,
      provider,attestation,created_by,authorization_basis)
     values($1,'knowledge',$2,$3,'openai','nonconfidential_nonpersonal',$4,'company_knowledge_policy')`,
    [f.w, companyId, companyHash, f.owner],
  );
  await f.db.exec("commit");
  const rowsBefore = await f.db.query(
    "select id,revoked_at,revision from public.content_authorizations order by id",
  );
  const result = await f.db.exec(script(permissionSql()));
  const report: any = result
    .flatMap((r) => r.rows)
    .find((r: any) => r.jsonb_build_object)?.jsonb_build_object;
  expect(report.plans_examined).toBe(2);
  expect(report.scope).toMatchObject({
    authorization_decision: false,
    plan_limit: 200,
    plan_selection: "latest_updated_active_status_assessments",
  });
  expect(report.policies).toEqual([
    {
      provider: "openai",
      provider_in_policy: true,
      auto_public_notices: true,
      auto_company_knowledge: true,
      approval_current: true,
      policy_approved_at: approvedAt,
    },
    {
      provider: "qwencloud",
      provider_in_policy: false,
      auto_public_notices: true,
      auto_company_knowledge: true,
      approval_current: true,
      policy_approved_at: approvedAt,
    },
  ]);
  expect(report.frozen_classification_reference_permissions).toHaveLength(8);
  for (const row of report.frozen_classification_reference_permissions) {
    expect(row.plans).toBe(1);
    expect(row.reference_count).toBe(1);
    expect(row.explicit_authorized_references).toBe(
      row.provider === "openai" && row.entity_kind === "notice" ? 1 : 0,
    );
    expect(row.company_policy_references).toBe(
      row.provider === "openai" && row.entity_kind === "knowledge" ? 1 : 0,
    );
    expect(row.revoked_references).toBe(
      row.provider === "qwencloud" && row.entity_kind === "notice" ? 1 : 0,
    );
    expect(row.revoked_since_request_references).toBe(
      row.provider === "qwencloud" &&
        row.entity_kind === "notice" &&
        row.valid_request_receipt
        ? 1
        : 0,
    );
  }
  expect(
    (
      await f.db.query(
        "select id,revoked_at,revision from public.content_authorizations order by id",
      )
    ).rows,
  ).toEqual(rowsBefore.rows);
  for (const value of [
    hidden,
    f.owner,
    f.w,
    companyHash,
    noticeHash,
    ...entityIds,
  ])
    expect(JSON.stringify(report)).not.toContain(value);
});
