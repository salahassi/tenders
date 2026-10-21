// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { nextStage } from "../../supabase/functions/_shared/generation";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic context test",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic tender",
    description: "Build a platform.",
    language: "en",
  });
  const ids = {
    plan: crypto.randomUUID(),
    step: crypto.randomUUID(),
    job: crypto.randomUUID(),
    usage: crypto.randomUUID(),
  };
  const section = {
    key: "overview",
    title: "Overview",
    volume: "technical",
    requirement_ids: [],
  };
  const input = { section, requirement_ids: [] };
  const output = {
    key: "overview",
    content_blocks: [{ type: "paragraph", text: "No RFP supplied." }],
  };
  await f.db.query(
    `insert into public.generation_plans(id,workspace_id,opportunity_id,kind,stage,status,input_hash,frozen_context,created_by,evidence_revision)
    values($1,$2,$3,'proposal','drafting','running','fixture',$4::jsonb,$5,1)`,
    [
      ids.plan,
      f.w,
      opportunity.id,
      JSON.stringify({
        blocks: [{ id: "rfp", text: "Build a platform in twelve months." }],
      }),
      f.owner,
    ],
  );
  await f.db.query(
    `insert into public.jobs(id,workspace_id,type,entity_id,input_hash,status,checkpoint,created_by)
    values($1,$2,'draft_section',$3,'fixture','succeeded','{"model_executor":2,"candidate_count":2}', $4)`,
    [ids.job, f.w, ids.plan, f.owner],
  );
  await f.db.query(
    `insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by)
    values($1,$2,$3,$4,'draft_section','drafting',1,$5::jsonb,$6::jsonb,'completed',$7)`,
    [
      ids.step,
      f.w,
      ids.plan,
      ids.job,
      JSON.stringify(input),
      JSON.stringify(output),
      f.owner,
    ],
  );
  await f.db.query(
    `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,state,created_by)
    values($1,$2,$3,$4,'original','gemini_free','synthetic','fixture',current_date,1,1000,1000,321,123,'settled',$5)`,
    [ids.usage, f.w, ids.job, crypto.randomUUID(), f.owner],
  );
  return { ...ids, input, output };
}
const replace = (id: string, revision = 1) =>
  f.db.query<{ replacement: string }>(
    "select app_private.replace_unmapped_draft_context($1,$2) replacement",
    [id, revision],
  );

it("replaces only the unpublished section job and preserves paid output, usage, identity and old budget", async () => {
  const s = await setup();
  const replacement = (await replace(s.step)).rows[0].replacement;
  expect(replacement).not.toBe(s.job);
  const step = (
    await f.db.query<any>("select * from public.generation_steps where id=$1", [
      s.step,
    ])
  ).rows[0];
  expect(step).toMatchObject({
    id: s.step,
    job_id: replacement,
    ordinal: 1,
    status: "queued",
    output: null,
    revision: 2,
  });
  expect(step.input).toEqual({ ...s.input, rfp_context_version: 1 });
  const old = (
    await f.db.query<any>("select * from public.jobs where id=$1", [s.job])
  ).rows[0];
  expect(old.status).toBe("succeeded");
  expect(old.checkpoint.candidate_count).toBe(2);
  expect(old.checkpoint.rfp_context_replacement.step_snapshot).toMatchObject({
    output: s.output,
    input: s.input,
    job_id: s.job,
  });
  expect(old.checkpoint.rfp_context_replacement.job_id).toBe(replacement);
  expect(
    (
      await f.db.query<any>(
        "select job_id,state,actual_input,actual_output from public.provider_usage where id=$1",
        [s.usage],
      )
    ).rows[0],
  ).toEqual({
    job_id: s.job,
    state: "settled",
    actual_input: 321,
    actual_output: 123,
  });
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.generation_steps where plan_id=$1",
        [s.plan],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select status,checkpoint from public.jobs where id=$1",
        [replacement],
      )
    ).rows[0],
  ).toEqual({
    status: "queued",
    checkpoint: { rfp_context_replaces_job: s.job },
  });
});

it.each([
  "mapped",
  "in_progress",
  "unknown_usage",
  "late_stage",
  "already_versioned",
  "stale_revision",
])("refuses unsafe replacement: %s", async (reason) => {
  const s = await setup();
  if (reason === "mapped")
    await f.db.query(
      "update public.generation_steps set input=jsonb_set(input,'{requirement_ids}','[\"r\"]') where id=$1",
      [s.step],
    );
  if (reason === "in_progress")
    await f.db.query(
      "update public.jobs set status='running',lease_token=gen_random_uuid() where id=$1",
      [s.job],
    );
  if (reason === "unknown_usage")
    await f.db.query(
      "update public.provider_usage set state='unknown' where id=$1",
      [s.usage],
    );
  if (reason === "late_stage")
    await f.db.query(
      "update public.generation_plans set stage='commercial' where id=$1",
      [s.plan],
    );
  if (reason === "already_versioned")
    await f.db.query(
      "update public.generation_steps set input=input||'{\"rfp_context_version\":1}'::jsonb where id=$1",
      [s.step],
    );
  await expect(
    replace(s.step, reason === "stale_revision" ? 2 : 1),
  ).rejects.toThrow(
    reason === "stale_revision"
      ? "REVISION_CONFLICT"
      : "UNMAPPED_CONTEXT_REPLACEMENT_NOT_ALLOWED",
  );
});

it("keeps recovery unavailable to client and service roles", async () => {
  const rows = (
    await f.db
      .query<any>(`select role,has_function_privilege(role,'app_private.replace_unmapped_draft_context(uuid,integer)','execute') allowed
    from unnest(array['anon','authenticated','service_role']) role`)
  ).rows;
  expect(rows.every((r) => r.allowed === false)).toBe(true);
});

it("does not change a plan that already produced a proposal version", async () => {
  const s = await setup();
  const proposal = crypto.randomUUID();
  await f.db.query(
    `insert into public.proposals(id,workspace_id,opportunity_id,title,created_by)
    select $1,workspace_id,opportunity_id,'Synthetic published draft',created_by from public.generation_plans where id=$2`,
    [proposal, s.plan],
  );
  await f.db.query(
    `insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,plan_id,created_by)
    values($1,$2,1,repeat('a',64),$3,$4)`,
    [f.w, proposal, s.plan, f.owner],
  );
  await expect(replace(s.step)).rejects.toThrow(
    "UNMAPPED_CONTEXT_REPLACEMENT_NOT_ALLOWED",
  );
});

it("versions newly planned general sections without changing assigned section inputs", async () => {
  const result = await nextStage({
    plan: {
      stage: "planning",
      frozen_context: {
        template: {
          required_sections: [
            {
              key: "overview",
              title: "Overview",
              volume: "technical",
              applicable: true,
            },
          ],
        },
      },
    },
    step: {},
    steps: [
      {
        task: "plan_proposal",
        status: "completed",
        input: {},
        ordinal: 1,
        output: {
          sections: [
            {
              key: "solution",
              title: "Solution",
              volume: "technical",
              requirement_ids: ["r"],
            },
          ],
        },
      },
    ],
    requirements: [],
  } as any);
  expect(result.steps[0].input.rfp_context_version).toBe(1);
  expect(result.steps[1].input).not.toHaveProperty("rfp_context_version");
});
