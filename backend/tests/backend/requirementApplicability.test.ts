import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback;reset role"));
async function setup(confirmAuthority = true) {
  const s = await commercialHelpers(f).setup();
  const opp = (
    await f.db.query<any>(
      "select opportunity_id from public.proposals where id=$1",
      [s.proposal],
    )
  ).rows[0].opportunity_id;
  let context = await f.rpc("source_review_context", [opp]);
  const source = context.sources[0];
  if (confirmAuthority)
    await f.command("source.authority.review", {
      opportunity_id: opp,
      ...source.reference,
      expected_revision: 0,
      role: "buyer_rfp",
      status: "confirmed",
      supersedes: null,
      precedence: 0,
      reason: "Synthetic confirmed buyer authority.",
    });
  context = await f.rpc("source_review_context", [opp]);
  const span = context.source_evidence.spans[0];
  const review = await f.command("source.obligation.review", {
    opportunity_id: opp,
    review_id: null,
    expected_revision: 0,
    spans: [span],
    semantics: {
      modality: "required",
      actor: "supplier",
      negated: false,
      conditions: [],
      exceptions: [],
      consequences: [],
      quantities: [],
      dates: [],
    },
    status: "confirmed",
    reason: "Synthetic explicitly reviewed original clause.",
  });
  const req = (
    await f.db.query<any>(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[])->0 value",
      [f.w, opp, [review.review_id]],
    )
  ).rows[0].value;
  await f.db.query(
    "update public.generation_plans set frozen_context=$2::jsonb where id=$1",
    [
      s.plan,
      JSON.stringify({
        source_contract_version: 1,
        proposal_consistency_version: 1,
        source_evidence: { version: 1, spans: [span], reviews: [] },
        notice: context.sources[0],
        blocks: [],
        knowledge: [],
        reviews: [],
        rates: [],
        input_materials: { documents: [] },
      }),
    ],
  );
  await f.db.query(
    "update public.requirements set text=$2,source_refs=$3::jsonb,source_semantics=$4::jsonb,mandatory=$5 where id=$1",
    [
      s.requirement,
      req.text,
      JSON.stringify(req.source_refs),
      JSON.stringify(req.source_semantics),
      req.mandatory,
    ],
  );
  await f.db.query(
    "update public.proposal_versions set evidence_revision=(select evidence_revision from public.workspaces where id=$2) where id=$1",
    [s.version, f.w],
  );
  return { ...s, opp, context, review };
}
async function save(
  s: any,
  expected_revision = 0,
  key = crypto.randomUUID(),
  expectedBinding?: string | null,
) {
  const binding =
    expectedBinding === undefined
      ? (
          await f.db.query<any>(
            "select app_private.requirement_applicability_binding($1,$2,$3) value",
            [f.w, s.version, s.requirement],
          )
        ).rows[0].value
      : expectedBinding;
  return f.command(
    "compliance.save",
    {
      proposal_version_id: s.version,
      requirement_id: s.requirement,
      expected_revision,
      ...(binding ? { expected_applicability_binding: binding } : {}),
      status: "not_applicable_approved",
      section_keys: [],
      evidence_refs: [],
      rationale:
        "Owner reviewed the exact requirement and excludes it for this scoped proposal.",
    },
    key,
  );
}
async function exclusions(s: any) {
  return (
    await f.db.query<any>(
      "select app_private.approved_requirement_exclusions($1,$2) value",
      [f.w, s.version],
    )
  ).rows[0].value;
}
async function attempt<T>(fn: () => Promise<T>) {
  await f.db.exec("savepoint expected");
  try {
    return await fn();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected");
  }
}
it("binds existing Owner decision to current actual sections and exposes the exact opaque binding", async () => {
  const s = await setup();
  const saved = await save(s);
  expect(saved.applicability_binding_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(await exclusions(s)).toEqual([
    {
      requirement_id: s.requirement,
      approval_id: saved.id,
      actor_id: f.owner,
      approved_by_role: "Owner",
      binding_hash: saved.applicability_binding_hash,
      reason: saved.rationale,
    },
  ]);
  const ctx = await f.rpc("proposal_consistency_context", [s.version]);
  expect(ctx.input.requirements[0].applicability_binding).toBe(
    saved.applicability_binding_hash,
  );
  expect(ctx.input.requirements[0].source_review_reason).toBe(
    "Synthetic explicitly reviewed original clause.",
  );
  expect(ctx.input.approved_exclusions).toEqual(await exclusions(s));
});
it("does not invalidate content approval on a version revision-only change, but catches actual section edits with unchanged summary hash", async () => {
  const s = await setup();
  const saved = await save(s);
  await f.db.query(
    "update public.proposal_versions set revision=revision+1 where id=$1",
    [s.version],
  );
  expect(await exclusions(s)).toHaveLength(1);
  await f.db.query(
    "update public.proposal_sections set body=body||' Changed delivery obligation.' where proposal_version_id=$1",
    [s.version],
  );
  expect(await exclusions(s)).toEqual([]);
  expect(
    (
      await f.db.query<any>(
        "select applicability_binding_hash from public.compliance_responses where id=$1",
        [saved.id],
      )
    ).rows[0].applicability_binding_hash,
  ).toBe(saved.applicability_binding_hash);
  const renewed = await save(s, saved.revision);
  expect(renewed.applicability_binding_hash).not.toBe(
    saved.applicability_binding_hash,
  );
  expect(await exclusions(s)).toHaveLength(1);
});
it("drops an exclusion when its Owner loses current membership or allowlist authorization", async () => {
  const s = await setup();
  await save(s);
  await f.db.query(
    "update public.memberships set role='Editor' where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  expect(await exclusions(s)).toEqual([]);
  await expect(save(s, 1)).rejects.toThrow("ROLE_FORBIDDEN");
});
it("does not allow source revocation, package changes, another active version or arbitrary NULL bindings to pass", async () => {
  const s = await setup();
  const saved = await save(s);
  await f.db.query(
    "update public.proposal_versions set package_hash=repeat('c',64) where id=$1",
    [s.version],
  );
  expect(await exclusions(s)).toEqual([]);
  await save(s, saved.revision);
  const source = s.context.sources[0];
  await f.command("source.authority.review", {
    opportunity_id: s.opp,
    ...source.reference,
    expected_revision: 1,
    role: "buyer_rfp",
    status: "revoked",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic source authority revoked.",
  });
  expect(await exclusions(s)).toEqual([]);
  await expect(save(s, 2)).rejects.toThrow("STALE_SOURCE_APPLICABILITY");
});
it("keeps restored unconfirmed N/A historical and requires the actual current Owner for a new binding", async () => {
  const s = await setup();
  const saved = await save(s);
  await f.db.query(
    "update public.compliance_responses set confirmed_by=null,confirmed_at=null,applicability_binding_hash=$2 where id=$1",
    [saved.id, "f".repeat(64)],
  );
  expect(await exclusions(s)).toEqual([]);
  expect(
    (
      await f.db.query<any>(
        "select applicability_binding_hash from public.compliance_responses where id=$1",
        [saved.id],
      )
    ).rows[0].applicability_binding_hash,
  ).toBeNull();
  await f.db.query("select set_config('request.jwt.claim.sub','',true)");
  await expect(
    attempt(() =>
      f.db.query(
        "update public.compliance_responses set confirmed_by=$2,confirmed_at=now() where id=$1",
        [saved.id, f.owner],
      ),
    ),
  ).rejects.toThrow("ROLE_FORBIDDEN");
});
it("does not upgrade old N/A records into v1 approval and preserves mandatory eligibility restrictions", async () => {
  const s = await commercialHelpers(f).setup();
  const saved = await save(s);
  expect(saved.applicability_binding_hash).toBeNull();
  expect(await exclusions(s)).toEqual([]);
  await f.db.query(
    "update public.requirements set category='eligibility' where id=$1",
    [s.requirement],
  );
  await expect(save(s, saved.revision)).rejects.toThrow(
    "MANDATORY_CREDENTIAL_CANNOT_BE_WAIVED",
  );
});

it("rejects a late edit between Owner viewing the binding and saving the decision", async () => {
  const s = await setup();
  const old = (
    await f.db.query<any>(
      "select app_private.requirement_applicability_binding($1,$2,$3) value",
      [f.w, s.version, s.requirement],
    )
  ).rows[0].value;
  await f.db.query(
    "update public.proposal_sections set body=body||' Late unreviewed scope change.' where proposal_version_id=$1",
    [s.version],
  );
  await expect(save(s, 0, crypto.randomUUID(), old)).rejects.toThrow(
    "STALE_SOURCE_APPLICABILITY",
  );
  expect(await exclusions(s)).toEqual([]);
  await expect(save(s, 0, crypto.randomUUID(), null)).rejects.toThrow(
    "STALE_SOURCE_APPLICABILITY",
  );
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.compliance_responses",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("cannot use an Owner exclusion to turn unknown source authority into completed coverage", async () => {
  const s = await setup(false);
  expect(
    (
      await f.db.query<any>(
        "select app_private.requirement_applicability_binding($1,$2,$3) value",
        [f.w, s.version, s.requirement],
      )
    ).rows[0].value,
  ).toBeNull();
  await expect(save(s)).rejects.toThrow("STALE_SOURCE_APPLICABILITY");
  expect(await exclusions(s)).toEqual([]);
});
