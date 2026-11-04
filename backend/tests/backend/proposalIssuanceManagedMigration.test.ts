// @vitest-environment node
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { databaseWithMigrations } from "./databaseFixture";
it("installs deadline guards with only the actual managed role family, grants public RPCs and keeps private helpers private", async () => {
  const db = await databaseWithMigrations(
    "20261104122333_durable_delivery_artifacts.sql",
  );
  try {
    await db.exec(
      "alter role anon rename to tdp_app_anon;alter role authenticated rename to tdp_app_authenticated;alter role service_role rename to tdp_app_service",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/20261104142525_proposal_issuance_deadline.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const result = (
      await db.query<any>(`select has_function_privilege('tdp_app_service','public.proposal_issuance_job_state(uuid,uuid)','execute') worker,
   has_function_privilege('tdp_app_authenticated','public.proposal_issuance_job_state(uuid,uuid)','execute') browser,
   has_function_privilege('tdp_app_service','app_private.fail_proposal_issuance(uuid,text)','execute') helper,
   has_function_privilege('tdp_app_service','public.reserve_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,text)','execute') bypass,
   has_table_privilege('tdp_app_authenticated','public.proposal_issuance_status','select') status,
   has_table_privilege('tdp_app_authenticated','public.proposal_issuance_requests','update') tamper`)
    ).rows[0];
    expect(result).toEqual({
      worker: true,
      browser: false,
      helper: false,
      bypass: false,
      status: true,
      tamper: false,
    });
  } finally {
    await db.close();
  }
}, 30000);
