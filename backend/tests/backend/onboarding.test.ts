// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { databaseWithMigrations } from "./databaseFixture";
import { createApiHandler } from "../../supabase/functions/api/handler";
import { AppError, databaseError } from "../../supabase/functions/_shared/http";
import type { Backend } from "../../supabase/functions/_shared/backend";

let db: PGlite;
const owner = "11111111-1111-4111-8111-111111111111";
const outsider = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);
const digest = async (value: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
beforeAll(async () => {
  db = await databaseWithMigrations();
}, 30000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query(
    "insert into auth.users values($1,'owner@example.test',now()),($2,'outsider@example.test',now())",
    [owner, outsider],
  );
  await db.query(
    "insert into auth.identities values($1::uuid,'email',jsonb_build_object('sub',($1::uuid)::text)),($2::uuid,'email',jsonb_build_object('sub',($2::uuid)::text))",
    [owner, outsider],
  );
  await db.query(
    "select public.prepare_owner_setup('owner@example.test',$1,'Synthetic onboarding')",
    [await digest(token)],
  );
});
afterEach(async () => {
  await db.exec("rollback;reset role");
});

async function asUser(id: string, sql: string, params: unknown[] = []) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("savepoint request;set local role authenticated");
  try {
    const result = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("reset role;release savepoint request");
    return result;
  } catch (error) {
    await db.exec(
      "rollback to savepoint request;reset role;release savepoint request",
    );
    throw error;
  }
}
function api(id = owner) {
  const backend = {
    authenticate: async () => ({ id }), // Synthetic identity; real Auth is a separate live check.
    checkInvitation: async (secret: string) => {
      const hash = await digest(secret);
      await db.exec("savepoint inspect");
      try {
        const result = await db.query<{ data: unknown }>(
          "select public.inspect_invitation($1) as data",
          [hash],
        );
        await db.exec("release savepoint inspect");
        return result.rows[0].data;
      } catch (error) {
        await db.exec(
          "rollback to savepoint inspect;release savepoint inspect",
        );
        throw databaseError(error as Error);
      }
    },
    acceptInvitation: async (_jwt: string, secret: string) => {
      try {
        return (
          await asUser(id, "select public.accept_invitation($1) as data", [
            secret,
          ])
        ).rows[0].data;
      } catch (error) {
        throw databaseError(error as Error);
      }
    },
    membership: async () => {
      const row = (
        await asUser(id, "select * from public.current_membership()")
      ).rows[0];
      if (!row)
        throw new AppError(403, "ACCESS_PENDING", "An invitation is required.");
      return row;
    },
    invitationCommand: async (
      _jwt: string,
      operation: string,
      input: unknown,
      key: string,
    ) => {
      try {
        return (
          await asUser(
            id,
            "select public.invitation_command($1,$2::jsonb,$3) as data",
            [operation, JSON.stringify(input), key],
          )
        ).rows[0].data;
      } catch (error) {
        throw databaseError(error as Error);
      }
    },
  };
  const handler = createApiHandler(
    {
      url: "https://example.supabase.co",
      publishableKey: "fixture",
      serviceKey: "fixture",
      allowedOrigins: ["https://app.example.test"],
      workerSecret: "",
    },
    () => backend as unknown as Backend,
  );
  return (path: string, body: unknown, authenticated = true) =>
    handler(
      new Request(`https://example.supabase.co/functions/v1/api/v1/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
          "Idempotency-Key": crypto.randomUUID(),
          ...(authenticated ? { Authorization: `Bearer ${id}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
}

describe("HTTP invitation onboarding with real PostgreSQL authorization", () => {
  it("does not let browser roles designate the first Owner or inspect private setup records", async () => {
    await expect(
      asUser(
        outsider,
        "select public.prepare_owner_setup('outsider@example.test',$1,'Hijack')",
        [await digest("b".repeat(64))],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(outsider, "select * from app_private.owner_setup"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(outsider, "select public.inspect_invitation($1)", [
        await digest(token),
      ]),
    ).rejects.toThrow(/permission denied/);
    expect(
      (await api(outsider)("invitations/accept", { token }, false)).status,
    ).toBe(401);
  });
  it("opens the workspace when the designated Owner sets a password, without an invitation click", async () => {
    await expect(
      asUser(outsider, "select public.claim_designated_owner()"),
    ).rejects.toThrow("ACCESS_PENDING");
    expect(
      (await db.query("select * from public.workspaces")).rows,
    ).toHaveLength(0);
    const claimed = await asUser(
      owner,
      "select public.claim_designated_owner() as data",
    );
    expect(claimed.rows[0].data).toMatchObject({ role: "Owner" });
    const again = await asUser(
      owner,
      "select public.claim_designated_owner() as data",
    );
    expect(again.rows[0].data).toMatchObject({
      role: "Owner",
      workspace_id: (claimed.rows[0].data as { workspace_id: string })
        .workspace_id,
    });
    expect(
      (await db.query("select * from public.workspaces")).rows,
    ).toHaveLength(1);
    expect(
      (await asUser(owner, "select role from public.current_membership()"))
        .rows[0].role,
    ).toBe("Owner");
  });
  it("keeps access locked until the designated email is confirmed, then bootstraps once", async () => {
    const preview = await api()("invitations/check", { token }, false);
    expect(preview.status).toBe(200);
    expect((await preview.json()).data).toMatchObject({
      email: "owner@example.test",
      role: "Owner",
    });
    expect((await api(outsider)("invitations/accept", { token })).status).toBe(
      422,
    );
    await db.query(
      "update auth.users set email_confirmed_at=null where id=$1",
      [owner],
    );
    const unverified = await api()("invitations/accept", { token });
    expect((await unverified.json()).error.code).toBe("VERIFIED_USER_REQUIRED");
    expect(
      (await db.query("select * from public.workspaces")).rows,
    ).toHaveLength(0);
    await db.query(
      "update auth.users set email_confirmed_at=now() where id=$1",
      [owner],
    );
    const first = await api()("invitations/accept", { token });
    expect(first.status).toBe(200);
    expect((await first.json()).data.role).toBe("Owner");
    expect((await api()("invitations/accept", { token })).status).toBe(200);
    expect(
      (await db.query("select * from public.workspaces")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.memberships")).rows,
    ).toHaveLength(1);
    expect((await api()("invitations/check", { token }, false)).status).toBe(
      422,
    );
  });
  it("rejects expired and replaced first-Owner links", async () => {
    await db.exec(
      "update app_private.owner_setup set expires_at=now()-interval '1 second'",
    );
    expect((await api()("invitations/accept", { token })).status).toBe(422);
    const replacement = "b".repeat(64);
    await db.query(
      "select public.prepare_owner_setup('owner@example.test',$1,'Synthetic onboarding')",
      [await digest(replacement)],
    );
    expect((await api()("invitations/check", { token }, false)).status).toBe(
      422,
    );
    expect((await api()("invitations/accept", { token })).status).toBe(422);
    expect(
      (await api()("invitations/accept", { token: replacement })).status,
    ).toBe(200);
  });
  it("issues a role-scoped invitation through the API and denies elevated member actions", async () => {
    expect((await api()("invitations/accept", { token })).status).toBe(200);
    const invitedToken = "c".repeat(64);
    const issued = await api()("invitations", {
      email: "outsider@example.test",
      role: "Reviewer",
      token_hash: await digest(invitedToken),
    });
    expect(issued.status).toBe(201);
    const body = await issued.json();
    expect(body.data).not.toHaveProperty("token_hash");
    const accepted = await api(outsider)("invitations/accept", {
      token: invitedToken,
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data.role).toBe("Reviewer");
    const denied = await api(outsider)("invitations", {
      email: "extra@example.test",
      role: "Owner",
      token_hash: await digest("d".repeat(64)),
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await asUser(
          outsider,
          "select * from public.audit_events where action like 'invitation.%'",
        )
      ).rows,
    ).toEqual([]);
  });
  it("enforces five active users on acceptance and reactivation without consuming rejected invitations", async () => {
    expect((await api()("invitations/accept", { token })).status).toBe(200);
    const members: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = crypto.randomUUID();
      const email = `member${index}@example.test`;
      const invite = String(index + 1).repeat(64);
      members.push(id);
      await db.query("insert into auth.users values($1,$2,now())", [id, email]);
      await db.query(
        "insert into auth.identities values($1::uuid,'email',jsonb_build_object('sub',($1::uuid)::text))",
        [id],
      );
      expect(
        (
          await api()("invitations", {
            email,
            role: "Editor",
            token_hash: await digest(invite),
          })
        ).status,
      ).toBe(201);
      expect(
        (await api(id)("invitations/accept", { token: invite })).status,
      ).toBe(200);
    }
    const invite = "f".repeat(64);
    expect(
      (
        await api()("invitations", {
          email: "outsider@example.test",
          role: "Reviewer",
          token_hash: await digest(invite),
        })
      ).status,
    ).toBe(201);
    const rejected = await api(outsider)("invitations/accept", {
      token: invite,
    });
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error.code).toBe("USER_CAP_REACHED");
    expect(
      (
        await db.query(
          "select status from public.workspace_invitations where email='outsider@example.test'",
        )
      ).rows,
    ).toEqual([{ status: "pending" }]);
    const change = (active: boolean, expected_revision: number) =>
      asUser(
        owner,
        "select public.app_command('membership.set',$1::jsonb,$2)",
        [
          JSON.stringify({
            user_id: members[0],
            role: "Editor",
            active,
            expected_revision,
            reason: "Synthetic cap test",
          }),
          crypto.randomUUID(),
        ],
      );
    await change(false, 1);
    expect(
      (await api(outsider)("invitations/accept", { token: invite })).status,
    ).toBe(200);
    expect(
      (await api(outsider)("invitations/accept", { token: invite })).status,
    ).toBe(200);
    await expect(change(true, 2)).rejects.toThrow(/USER_CAP_REACHED/);
    expect(
      (
        await db.query(
          "select count(*)::int as count from public.memberships where active",
        )
      ).rows,
    ).toEqual([{ count: 5 }]);
    expect(
      (
        await db.query(
          "select active from public.memberships where user_id=$1",
          [members[0]],
        )
      ).rows,
    ).toEqual([{ active: false }]);
  });
});
