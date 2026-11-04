import { databaseWithMigrations } from "./databaseFixture";
export async function workflowFixture(
  owner = "00000000-0000-4000-8000-000000000001",
  throughMigration?: string,
) {
  const db = await databaseWithMigrations(throughMigration);
  await db.query(
    "insert into auth.users values($1,'owner@example.test',now())",
    [owner],
  );
  await db.query("insert into auth.identities values($1,'email',$2::jsonb)", [
    owner,
    JSON.stringify({ sub: owner }),
  ]);
  const w = (
    await db.query<{ id: string }>(
      "select public.bootstrap_workspace($1,'Synthetic workflow fixture') id",
      [owner],
    )
  ).rows[0].id;
  async function command(
    operation: string,
    input: unknown,
    key = crypto.randomUUID(),
  ): Promise<any> {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      owner,
    ]);
    await db.exec("set role authenticated");
    await db.exec("savepoint command_attempt");
    try {
      return (
        await db.query<{ result: any }>(
          "select public.app_command($1,$2::jsonb,$3) result",
          [operation, JSON.stringify(input), key],
        )
      ).rows[0].result;
    } catch (e) {
      await db.exec("rollback to savepoint command_attempt");
      throw e;
    } finally {
      await db.exec("release savepoint command_attempt; reset role");
    }
  }
  async function rpc(name: string, args: unknown[] = []): Promise<any> {
    return (
      await db.query<{ data: any }>(
        `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) data`,
        args,
      )
    ).rows[0]?.data;
  }
  return { db, owner, w, command, rpc };
}

/** Existing model-only integration fixtures do not execute local DOCX rendering.
 * Their synthetic initial/partial draft render jobs are explicitly canceled;
 * dedicated delivery tests exercise the real queue order and renderer. The
 * model jobs themselves use the canonical current-worker capability (4), with
 * unchanged SQL eligibility, provider accounting and historical wire pins.
 */
export async function claimModelWorker4(
  fixture: Pick<Awaited<ReturnType<typeof workflowFixture>>, "db">,
  rpc: (name: string) => Promise<any>,
) {
  const previous = (
    await fixture.db.query<{ value: string | null }>(
      "select current_setting('app.worker_executor',true) value",
    )
  ).rows[0]?.value;
  await fixture.db.query(
    "update public.jobs set status='canceled',lease_token=null,lease_until=null where type='render_delivery' and checkpoint->>'delivery_renderer_version'='1' and status in ('queued','retry_wait','quota_wait')",
  );
  await fixture.db.query("select set_config('app.worker_executor','4',true)");
  try {
    return await rpc("claim_backend_job");
  } finally {
    await fixture.db.query("select set_config('app.worker_executor',$1,true)", [
      previous || "",
    ]);
  }
}

/** Seed an explicitly historical proposal before the new admission policy.
 * Only this fixture's creation transaction disables the new admission trigger;
 * it is re-enabled before any worker, retry or recovery operation under test.
 * This preserves legacy paid-history tests without a production bypass flag.
 */
export async function historicalGenerationCommand(
  fixture: Awaited<ReturnType<typeof workflowFixture>>,
  operation: "proposal.generate" | "proposal.regenerate",
  input: unknown,
  key = crypto.randomUUID(),
) {
  const installed = (
    await fixture.db.query<{ installed: boolean }>(
      "select exists(select 1 from pg_trigger where tgrelid='app_private.generation_processing_requests'::regclass and tgname='admit_proposal_issuance' and tgenabled<>'D') installed",
    )
  ).rows[0].installed;
  if (!installed) return fixture.command(operation, input, key);
  await fixture.db.exec(
    "alter table app_private.generation_processing_requests disable trigger admit_proposal_issuance",
  );
  try {
    return await fixture.command(operation, input, key);
  } finally {
    await fixture.db.exec(
      "alter table app_private.generation_processing_requests enable trigger admit_proposal_issuance",
    );
  }
}
