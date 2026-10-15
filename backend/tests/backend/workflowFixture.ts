import { databaseWithMigrations } from "./databaseFixture";
export async function workflowFixture() {
  const db = await databaseWithMigrations(),
    owner = "00000000-0000-4000-8000-000000000001";
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
