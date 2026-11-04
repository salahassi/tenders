// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  deliveryPipelineFixture,
  type DeliveryPipelineFixture,
} from "./deliveryPipelineFixture";
import { generatedDeliveryFixture } from "./generatedDeliveryFixture";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
import { nextStage } from "../../supabase/functions/_shared/generation";
import { primaryModelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { complianceMatrixSections } from "../../supabase/functions/_shared/proposalBlueprint";
import { buildExportModel } from "../../supabase/functions/_shared/export";
import { authoringBodySchema } from "../../supabase/functions/_shared/proposalAuthoring";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Synthetic local SQL/API regression only. No external models, Auth, Storage
// or human review is claimed by these automated structural fixtures.
let h: DeliveryPipelineFixture,
  f: DeliveryPipelineFixture["f"],
  transport: DeliveryPipelineFixture["transport"];
beforeAll(async () => {
  h = await deliveryPipelineFixture();
  ({ f, transport } = h);
}, 30000);
const measurements: Record<string, unknown>[] = [];
afterAll(async () => {
  await f?.db.close();
  if (process.env.SECTION_BODY_RECEIPT) {
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const migrations = Object.fromEntries(
      await Promise.all(
        (await readdir(directory))
          .filter((name) => /^\d+_.+\.sql$/.test(name))
          .sort()
          .map(async (name) => [
            name,
            digest(await readFile(new URL(name, directory), "utf8")),
          ]),
      ),
    );
    const path = process.env.SECTION_BODY_RECEIPT;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          version: 1,
          fixture: "synthetic-only",
          scope:
            "local migrated SQL and actual API/assembly/export projection; Auth and transport are local test adapters",
          model_calls: 0,
          hosted_acceptance: false,
          measured_at: new Date().toISOString(),
          migrations,
          test_sha256: digest(await readFile(new URL(import.meta.url), "utf8")),
          measurements,
        },
        null,
        2,
      ) + "\n",
    );
  }
});
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function row(query: string, args: unknown[] = []) {
  return (await f.db.query<any>(query, args)).rows[0];
}
async function measure(name: string, section: any, request?: any, model?: any) {
  const sizes = await row(
    "select length(body) body_characters,octet_length(body) body_bytes,length(content_blocks::text) structured_characters,octet_length(content_blocks::text) structured_jsonb_text_bytes,pg_column_size(content_blocks) stored_structured_bytes from public.proposal_sections where id=$1",
    [section.id],
  );
  measurements.push({
    name,
    ...sizes,
    body_sha256: digest(section.body),
    structured_sha256: digest(JSON.stringify(section.content_blocks)),
    ...(request
      ? {
          snapshot_json_bytes: Buffer.byteLength(
            JSON.stringify(request.snapshot),
          ),
        }
      : {}),
    ...(model
      ? {
          render_model_json_bytes: Buffer.byteLength(JSON.stringify(model)),
          render_model_sha256: digest(JSON.stringify(model)),
        }
      : {}),
  });
  if (model && process.env.SECTION_BODY_MODELS) {
    await mkdir(process.env.SECTION_BODY_MODELS, { recursive: true });
    await writeFile(
      join(process.env.SECTION_BODY_MODELS, `${name}.json`),
      JSON.stringify(model),
    );
    await writeFile(
      join(process.env.SECTION_BODY_MODELS, `${name}.request.json`),
      JSON.stringify(request),
    );
  }
}
async function authoredFixture(t: ReturnType<typeof transport>) {
  const source = await f.command("source.create", {
    name: "Synthetic human authoring",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic operating manual",
    reference: "SYNTHETIC-AUTHORING",
    description:
      "Provide an operating manual validated by a witnessed walkthrough.",
    language: "en",
    decision: "shortlisted",
  });
  let sources = await f.rpc("source_review_context", [opportunity.id]);
  const initial = sources.source_evidence.spans[0];
  await f.command("source.authority.review", {
    opportunity_id: opportunity.id,
    entity_kind: "notice",
    entity_id: opportunity.id,
    content_hash: initial.content_hash,
    expected_revision: 0,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic fixture is explicitly issued by the buyer.",
  });
  sources = await f.rpc("source_review_context", [opportunity.id]);
  const reviewed = await f.command("source.obligation.review", {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [sources.source_evidence.spans[0]],
    semantics: {
      modality: "required",
      actor: "Supplier",
      negated: false,
      conditions: [],
      exceptions: [],
      consequences: [],
      quantities: [],
      dates: [],
    },
    status: "confirmed",
    reason: "Supplier must deliver the manual and demonstrate it.",
  });
  const requirements = (
    await f.db.query<{ data: any }>(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[]) data",
      [f.w, opportunity.id, [reviewed.review_id]],
    )
  ).rows[0].data;
  const prepared = await f.command("delivery.snapshot.prepare", {
    opportunity_id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const proposal = (
    await f.db.query<{ delivery_revision: number }>(
      "select delivery_revision from public.proposals where id=$1",
      [prepared.proposal_id],
    )
  ).rows[0];
  const opened = await t.request("proposal-authoring/open", {
    snapshot_id: prepared.id,
    expected_delivery_revision: proposal.delivery_revision,
  });
  expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(200);
  const context = (await opened.json()).data;
  const response =
    "We will map each operational step through a facilitated process walkthrough and record the responsible role and exception path. We will deliver a versioned operating manual containing process maps, escalation instructions, and a change register. Acceptance will use a witnessed walkthrough of the manual against the agreed process map, recording each discrepancy and its resolution in an acceptance log.";
  const body = {
    ...context.revision.body,
    requirements,
    sections: [
      {
        key: "operating-manual",
        title: "Operating manual delivery",
        volume: "technical",
        content_blocks: [{ type: "paragraph", text: response }],
        requirement_ids: [requirements[0].id],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      },
    ],
    fulfillment: [
      {
        requirement_id: requirements[0].id,
        response_section_key: "operating-manual",
        response_excerpt: response,
        method: "facilitated process walkthrough",
        deliverable: "versioned operating manual",
        acceptance_evidence:
          "recording each discrepancy and its resolution in an acceptance log",
        conditions_preserved: [],
        exceptions_preserved: [],
        consequences_preserved: [],
        facts: [],
      },
    ],
  };
  return { opportunity, prepared, context, body, reviewed, response };
}
function reviewInput(context: any, body: any) {
  return {
    expected_revision: context.session.revision,
    reason:
      "I reviewed implementation, deliverable and acceptance demonstration against the current buyer obligation.",
    inventory_review: {
      source_ids: [
        ...new Set(context.source_manifest.map((s: any) => s.entity_id)),
      ],
      coverage_statement:
        "Complete synthetic notice reviewed; the manual obligation is bound to its exact passage and current authority.",
    },
    responses: body.fulfillment.map((item: any) => ({
      requirement_id: item.requirement_id,
      response_excerpt: item.response_excerpt,
      rationale:
        "Response defines an actual walkthrough method, versioned deliverable and discrepancy-based acceptance demonstration.",
    })),
  };
}

async function persistedGeneration(contentBlocks: any[], separate = false) {
  const source = await f.command("source.create", {
    name: "Synthetic large section",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic structured response",
    reference: "SYNTHETIC-SECTION",
    description: "Supply the specified operating response.",
    language: "en",
    decision: "shortlisted",
  });
  const doc = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 80,
    hash: "a".repeat(64),
  });
  await f.rpc("accept_uploaded_document", [
    doc.id,
    f.owner,
    "a".repeat(64),
    80,
    "Supply the specified operating response.",
    "ready",
    crypto.randomUUID(),
  ]);
  const proposal = await row(
    "insert into public.proposals(workspace_id,opportunity_id,title,created_by) values($1,$2,'Synthetic structured response',$3) returning *",
    [f.w, opportunity.id, f.owner],
  );
  const pkg = (
    await row(
      "select to_jsonb(app_private.seal_draft_package($1,$2,$3)) value",
      [f.w, opportunity.id, f.owner],
    )
  ).value;
  const frozen = (
    await row(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,null) value",
      [f.w, opportunity.id, proposal.id, pkg.id],
    )
  ).value;
  frozen.template = {
    required_sections: [],
    fixed_blocks: [],
    volume_mode: separate ? "separate" : "combined",
  };
  const fixture: any = await generatedDeliveryFixture();
  fixture.plan.frozen_context = frozen;
  fixture.requirements = [];
  for (const step of fixture.steps) {
    step.input.requirement_ids = [];
    if (step.task === "draft_section") {
      step.output.content_blocks = contentBlocks;
      step.output.requirement_ids = [];
      primaryModelSchemas.draft_section.parse(step.output);
    }
    if (step.task === "review_proposal") step.output.responses = [];
    if (step.task === "plan_proposal")
      step.output.sections[0].requirement_ids = [];
  }
  const plan = await row(
    "insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,package_id,kind,stage,status,evidence_revision,input_hash,frozen_context,workflow_version,created_by) select $1,$2,$3,$4,'proposal','review','running',evidence_revision,$5,$6::jsonb,1,$7 from public.workspaces where id=$1 returning *",
    [
      f.w,
      opportunity.id,
      proposal.id,
      pkg.id,
      digest(JSON.stringify(frozen)),
      JSON.stringify(frozen),
      f.owner,
    ],
  );
  for (const step of fixture.steps) {
    const job = await row(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,$2,$3,$4,'succeeded',$5) returning *",
      [f.w, step.task, plan.id, plan.input_hash, f.owner],
    );
    await f.db.query(
      "insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'completed',$9)",
      [
        f.w,
        plan.id,
        job.id,
        step.task,
        step.stage,
        step.ordinal,
        JSON.stringify(step.input),
        JSON.stringify(step.output),
        f.owner,
      ],
    );
  }
  const lease = crypto.randomUUID();
  const job = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,lease_token,lease_until,created_by) values($1,'advance_plan',$2,$3,'running',$4,clock_timestamp()+interval '180 seconds',$5) returning *",
    [f.w, plan.id, plan.input_hash, lease, f.owner],
  );
  await f.db.query(
    "insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,status,created_by) values($1,$2,$3,'advance_plan','review',10,'{}','queued',$4)",
    [f.w, plan.id, job.id, f.owner],
  );
  const context = await f.rpc("generation_context", [job.id, lease]);
  const assembled = await nextStage(context);
  expect(assembled.next_stage).toBe("completed");
  const final = assembled.final_result!;
  expect(final.sections[0].body.length).toBeGreaterThan(100000);
  await f.rpc("advance_generation", [
    job.id,
    lease,
    assembled.next_stage,
    JSON.stringify(assembled.requirements),
    JSON.stringify(assembled.steps),
    JSON.stringify(final),
  ]);
  const version = await row(
    "select * from public.proposal_versions where plan_id=$1",
    [plan.id],
  );
  const section = await row(
    "select * from public.proposal_sections where proposal_version_id=$1 and section_key='approach'",
    [version.id],
  );
  return { plan, proposal, version, section, final };
}

it.each([false, true])(
  "persists the actual 100-table generated section with all late markers (price=%s)",
  async (price) => {
    const tables = Array.from({ length: 100 }, (_, i) => ({
      type: "table",
      headers: Array.from({ length: 10 }, (_, c) => `H${c}`),
      rows: Array.from({ length: 50 }, (_, r) =>
        Array.from({ length: 10 }, (_, c) =>
          i === 99 && r === 49 && c === 9
            ? "[INPUT REQUIRED: Confirm late value]" + (price ? " SAR 123" : "")
            : "X",
        ),
      ),
    }));
    const { version, section, final } = await persistedGeneration(tables, true);
    expect(section.body).toBe(final.sections[0].body);
    expect(section.content_blocks).toEqual(tables);
    expect(section.body.indexOf("[INPUT REQUIRED")).toBeGreaterThan(100000);
    const gate = (
      await row("select app_private.approval_gate($1,$2) value", [
        f.w,
        version.id,
      ])
    ).value;
    expect(gate.blockers).toContain(
      "Resolve all missing-input markers through a new version.",
    );
    if (price)
      expect(gate.blockers).toContain(
        "Remove prices from the technical volume.",
      );
    else
      expect(gate.blockers).not.toContain(
        "Remove prices from the technical volume.",
      );
    const request = await f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "draft",
      volume: "technical",
    });
    if (price) {
      expect(() => buildExportModel(request)).toThrow(
        "Review pricing separation before export.",
      );
      await measure("generated-100-tables-late-price-blocked", section);
      return;
    }
    const model = buildExportModel(request);
    expect(
      model.blocks.filter((b) => b.type === "table" && b.headers[0] === "H0"),
    ).toEqual(tables);
    expect(Buffer.byteLength(JSON.stringify(model))).toBeLessThan(
      10 * 1024 * 1024,
    );
    expect(
      (
        await row(
          "select length(body) body_characters,length(content_blocks::text) structured_characters from public.proposal_sections where id=$1",
          [section.id],
        )
      ).body_characters,
    ).toBeLessThanOrEqual(
      (
        await row(
          "select length(content_blocks::text) n from public.proposal_sections where id=$1",
          [section.id],
        )
      ).n,
    );
    await measure("generated-100-tables", section, request, model);
  },
  30000,
);

it("keeps derived compliance-matrix text within its complete structured source bound", async () => {
  const { version } = await persistedGeneration(
    Array.from({ length: 6 }, (_, i) => ({
      type: "paragraph",
      text: `${i}:` + "x".repeat(19998),
    })),
  );
  const requirements = Array.from({ length: 45 }, (_, i) => ({
    id: crypto.randomUUID(),
    text: `Synthetic obligation ${i}: ` + "x".repeat(2980),
  }));
  const responses = requirements.map((r) => ({
    requirement_id: r.id,
    status: "answered",
    section_ids: ["approach"],
    rationale: "A supplied response is linked for the synthetic matrix.",
  }));
  const [matrix] = complianceMatrixSections(
    {
      sections: [
        {
          key: "compliance",
          title: "Compliance",
          volume: "technical",
          mode: "compliance_matrix",
        },
      ],
    } as any,
    requirements,
    responses,
    [{ key: "approach", title: "Approach" }],
    "en",
  );
  expect(matrix.body.length).toBeGreaterThan(100000);
  const measured = await row(
    "select length($1::text) body_characters,length($2::jsonb::text) structured_characters",
    [matrix.body, JSON.stringify(matrix.content_blocks)],
  );
  expect(measured.body_characters).toBeLessThanOrEqual(
    measured.structured_characters,
  );
  const saved = await row(
    "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,content_blocks,created_by) values($1,$2,'compliance','Compliance',$3,1,$4::jsonb,$5) returning *",
    [
      f.w,
      version.id,
      matrix.body,
      JSON.stringify(matrix.content_blocks),
      f.owner,
    ],
  );
  expect(saved.body).toBe(matrix.body);
  expect(saved.content_blocks).toEqual(matrix.content_blocks);
  await measure("derived-compliance-matrix", saved);
}, 30000);

it("retains the legacy free-text ceiling and rejects a large body not bounded by its structured source", async () => {
  const { version } = await persistedGeneration(
    Array.from({ length: 6 }, (_, i) => ({
      type: "paragraph",
      text: `${i}:` + "x".repeat(19998),
    })),
  );
  async function insert(body: string, blocks: unknown) {
    return h.sql(
      "service_role",
      "",
      "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,content_blocks,created_by) values($1,$2,$3,'Legacy or invalid',$4,20,$5::jsonb,$6) returning id",
      [
        f.w,
        version.id,
        crypto.randomUUID(),
        body,
        JSON.stringify(blocks),
        f.owner,
      ],
    );
  }
  await expect(insert("x".repeat(100000), [])).resolves.toHaveLength(1);
  await expect(insert("x".repeat(100001), [])).rejects.toThrow();
  await expect(
    insert("x".repeat(100001), [{ type: "paragraph", text: "Short" }]),
  ).rejects.toThrow();
  await expect(
    insert("x".repeat(100001), { type: "paragraph", text: "x".repeat(100001) }),
  ).rejects.toThrow();
}, 30000);

it.each(["paragraphs", "tables"])(
  "adopts the API-accepted large %s response without losing its suffix or ordinary export projection",
  async (shape) => {
    const t = transport(),
      a = await authoredFixture(t);
    const paragraphs = Array.from({ length: 69 }, (_, index) => ({
      type: "paragraph",
      // Alphabetical labels keep this structural capacity case free of unbound
      // numeric assertions; the semantic review remains fully enforced.
      text: (
        `Direction ${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}: ` +
        "aب".repeat(10000)
      ).slice(0, 20000),
    }));
    const suffix = "SYNTHETIC-END-PRESERVED!!";
    paragraphs[68].text = paragraphs[68].text.slice(0, -suffix.length) + suffix;
    const tables = Array.from({ length: 100 }, () => ({
      type: "table",
      headers: Array.from({ length: 10 }, (_, c) =>
        String.fromCharCode(65 + c),
      ),
      rows: Array.from({ length: 50 }, () =>
        Array.from({ length: 10 }, () => "X"),
      ),
    }));
    tables[0].rows[0][0] = a.response;
    tables[99].rows[49][9] = suffix;
    if (shape === "paragraphs")
      a.body.sections[0].content_blocks.push(...paragraphs);
    else (a.body.sections[0] as any).content_blocks = tables;
    authoringBodySchema.parse(a.body);
    const saveInput = {
      expected_revision: a.context.session.revision,
      body: a.body,
    };
    expect(Buffer.byteLength(JSON.stringify(saveInput))).toBeLessThanOrEqual(
      2097152,
    );
    const saved = await t.request(
      `proposal-authoring/${a.context.session.id}/save`,
      saveInput,
    );
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const context = (await saved.json()).data;
    const reviewed = await t.request(
      `proposal-authoring/${context.session.id}/review`,
      reviewInput(context, a.body),
    );
    expect(reviewed.status, JSON.stringify(await reviewed.clone().json())).toBe(
      200,
    );
    const review = (await reviewed.json()).data;
    expect(
      review.report.substantive_complete,
      JSON.stringify(review.report),
    ).toBe(true);
    const proposal = await row(
      "select revision from public.proposals where id=$1",
      [a.prepared.proposal_id],
    );
    const adopted = await t.request(
      `proposal-authoring/${context.session.id}/adopt`,
      {
        expected_revision: context.session.revision,
        expected_proposal_revision: proposal.revision,
        review_id: review.snapshot.payload.authoring.review_id,
      },
    );
    expect(adopted.status, JSON.stringify(await adopted.clone().json())).toBe(
      200,
    );
    const result = (await adopted.json()).data;
    const section = await row(
      "select * from public.proposal_sections where proposal_version_id=$1",
      [result.proposal_version_id],
    );
    if (shape === "paragraphs") {
      const expectedBody = a.body.sections[0].content_blocks
        .map((b: { text: string }) => b.text)
        .join("\n");
      expect(section.body.length).toBeGreaterThan(1380000);
      expect(digest(section.body)).toBe(digest(expectedBody));
      expect(section.body.endsWith(suffix)).toBe(true);
    } else {
      expect(section.body.length).toBeGreaterThan(250000);
      expect(section.body.match(/"X"/g)).toHaveLength(49998);
      expect(section.body).toContain(a.response);
      expect(section.body.indexOf(suffix)).toBeGreaterThan(100000);
    }
    expect(section.content_blocks).toEqual(a.body.sections[0].content_blocks);
    const version = await row(
      "select * from public.proposal_versions where id=$1",
      [result.proposal_version_id],
    );
    const request = await f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "draft",
      volume: "combined",
    });
    const model = buildExportModel(request);
    if (shape === "paragraphs")
      expect(
        model.blocks.filter(
          (b) => b.type === "paragraph" && b.text.startsWith("Direction "),
        ),
      ).toEqual(paragraphs);
    else
      expect(
        model.blocks.filter((b) => b.type === "table" && b.headers[0] === "A"),
      ).toEqual(tables);
    expect(Buffer.byteLength(JSON.stringify(model))).toBeLessThan(
      10 * 1024 * 1024,
    );
    expect(version.status).toBe("draft");
    expect(version.consistency_report).toBeNull();
    const bound = await row(
      "select length(body) n,length(content_blocks::text) limit_n from public.proposal_sections where id=$1",
      [section.id],
    );
    expect(bound.n).toBeLessThanOrEqual(bound.limit_n);
    await measure(
      shape === "paragraphs"
        ? "authored-69-mixed-paragraphs"
        : "authored-100-json-tables",
      section,
      request,
      model,
    );
  },
  30000,
);

it("changes only the section bound across the actual migration boundary, preserving old rows and authority", async () => {
  const old = await workflowFixture(
    undefined,
    "20261104172700_storage_write_retirement_proofs.sql",
  );
  try {
    await old.db.exec("begin");
    const fixture = await commercialHelpers(old).setup();
    const capture = async () => ({
      rows: (
        await old.db.query(
          "select to_jsonb(s) value from public.proposal_sections s order by id",
        )
      ).rows,
      authority: (
        await old.db.query(
          "select relowner,relacl,relrowsecurity,relforcerowsecurity from pg_class where oid='public.proposal_sections'::regclass",
        )
      ).rows,
      columns: (
        await old.db.query(
          "select attname,atttypid,attnotnull,attacl from pg_attribute where attrelid='public.proposal_sections'::regclass and attnum>0 order by attnum",
        )
      ).rows,
      policies: (
        await old.db.query(
          "select * from pg_policies where schemaname='public' and tablename='proposal_sections' order by policyname",
        )
      ).rows,
    });
    const before = await capture();
    expect(before.rows).toHaveLength(1);
    await old.db.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/20261104212300_structured_section_body_bound.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(await capture()).toEqual(before);
    expect(
      (
        await old.db.query(
          "select status from public.proposal_versions where id=$1",
          [fixture.version],
        )
      ).rows[0],
    ).toEqual({ status: "draft" });
    await old.db.exec("rollback");
  } finally {
    await old.db.close();
  }
}, 30000);
