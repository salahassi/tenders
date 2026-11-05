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
import { readFile } from "node:fs/promises";
import { workflowFixture } from "./workflowFixture";
import { currentIssuanceObservation } from "./currentIssuanceObserverFixture";
import { generatedDeliveryFixture } from "./generatedDeliveryFixture";
import { assessGeneratedDelivery } from "../../supabase/functions/_shared/generatedProposalConsistency";
import {
  buildGeneratedPayload,
  processGeneratedDelivery,
} from "../../supabase/functions/_shared/generatedDeliveryWorker";
import {
  processDeliveryExport,
  deliveryBytes,
} from "../../supabase/functions/_shared/deliveryWorker";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport";
import { verifyExportDocx } from "../../supabase/functions/_shared/export";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";
import type { Backend } from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";
import { createApiHandler } from "../../supabase/functions/api/handler";
import { modelEnvironments } from "../../supabase/functions/_shared/backend";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";
import {
  candidateContent,
  validateGroundingReport,
  groundingOptions,
} from "../../supabase/functions/_shared/modelGrounding";
let f: Awaited<ReturnType<typeof workflowFixture>>, fonts: FontData;
beforeAll(async () => {
  f = await workflowFixture();
  fonts = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function row(sql: string, args: unknown[] = []) {
  return (await f.db.query<any>(sql, args)).rows[0];
}
async function rpc(name: string, args: Record<string, any> = {}) {
  await f.db.exec("savepoint rpc_attempt");
  try {
    return (
      await row(
        `select public.${name}(${Object.keys(args)
          .map((key, i) => `${key}=>$${i + 1}`)
          .join(",")}) data`,
        Object.values(args).map((v) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).data;
  } catch (e) {
    await f.db.exec("rollback to savepoint rpc_attempt");
    throw databaseError(e as Error);
  } finally {
    await f.db.exec("release savepoint rpc_attempt");
  }
}
async function separateFixture(body?: string) {
  const data = await generatedDeliveryFixture(body);
  data.plan.frozen_context.template.volume_mode = "separate";
  const section = {
    key: "commercial-approach",
    title: "Commercial approach",
    volume: "financial",
    requirement_ids: [data.requirements[0].id],
  };
  data.steps
    .find((s) => s.task === "plan_proposal")!
    .output.sections.push(section);
  const draft = structuredClone(
    data.steps.find((s) => s.task === "draft_section")!,
  );
  draft.id = crypto.randomUUID();
  draft.input.section = section;
  draft.output = {
    ...draft.output,
    key: section.key,
    title: section.title,
    content_blocks: [
      {
        type: "paragraph",
        text: "We will align the workflow deliverables with the commercial schedule, record authorized amounts against accepted milestones, and obtain the commercial owner’s review before external release.",
      },
    ],
  };
  data.steps.splice(2, 0, draft);
  data.steps.forEach((step, index) => (step.ordinal = index));
  data.steps
    .find((s) => s.task === "review_proposal")!
    .output.responses[0].section_ids.push(section.key);
  const ctx: any = {
    plan: { ...data.plan, stage: "review" },
    step: { task: "advance_plan", input: {} },
    steps: data.steps,
    requirements: data.requirements,
  };
  const final = (await nextStage(ctx)).final_result!;
  data.sections = final.sections;
  data.section_outline = final.section_outline;
  data.accepted_receipts = [];
  for (const step of data.steps) {
    const candidate = step.output,
      units = candidateContent(candidate),
      scope = taskInput({
        ...ctx,
        plan: { ...data.plan, stage: step.stage },
        step,
      });
    const hash = await qualifierHash(JSON.stringify(candidate)),
      quote =
        step.task === "draft_section"
          ? candidate.content_blocks[0].text
          : units[0]?.text || "";
    data.accepted_receipts.push({
      step_id: step.id,
      receipt_id: crypto.randomUUID(),
      verification_receipt_id: crypto.randomUUID(),
      candidate_hash: hash,
      candidate,
      accepted: true,
      verification: {
        checked_candidate_hash: hash,
        reviewed_all_content: true,
        processed_content_ids: units.map((u) => u.id),
        claims: units.length
          ? [
              {
                id: "claim",
                claim: quote,
                candidate_quote: quote,
                kind: "proposed_solution",
                status: "supported",
                source_refs: [],
                finding:
                  "Proposed commercial work is represented in the candidate.",
              },
            ]
          : [],
        processed_requirement_ids: scope.requiredIds,
        requirement_checks: scope.requiredIds.map((id) => ({
          requirement_id: id,
          status: "supported",
          candidate_quote: quote,
          source_refs: [],
          finding: "The response covers the requirement.",
        })),
        findings: [],
      },
    });
  }
  return data;
}
async function setup(
  body?: string,
  acceptedAgoSeconds = 0,
  attachPdf = false,
  separate = false,
) {
  const src = await f.command("source.create", {
    name: "Synthetic generated output",
    kind: "manual",
  });
  const o = await f.command("opportunity.create", {
    source_id: src.id,
    title: "Synthetic workflow",
    reference: "SYNTHETIC",
    description: "Provide a workflow in 30 days.",
    language: "en",
    decision: "shortlisted",
  });
  let parent: any = null;
  if (attachPdf) {
    const prepared = await f.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: o.id,
      original_name: "synthetic.pdf",
      mime_type: "application/pdf",
      size: 100,
      hash: "a".repeat(64),
    });
    await f.rpc("verify_document_pages", [prepared.id, 1]);
    const text = "[Page 1]\nProvide a workflow in 30 days.";
    parent = await f.rpc("accept_uploaded_document_with_coverage", [
      prepared.id,
      f.owner,
      "a".repeat(64),
      100,
      text,
      "ready",
      "synthetic-pdf",
      JSON.stringify({
        version: 1,
        kind: "pdf_pages",
        complete: true,
        pages: [
          {
            page: 1,
            status: "readable",
            characters: "Provide a workflow in 30 days.".length,
          },
        ],
      }),
    ]);
  }
  const base = await f.command("delivery.snapshot.prepare", {
    opportunity_id: o.id,
    expected_revision: o.revision,
  });
  await f.db.query(
    "update public.jobs set status='canceled' where type='render_delivery'",
  );
  const fixture = separate
    ? await separateFixture(body)
    : await generatedDeliveryFixture(body);
  const current = (
    await row(
      "select app_private.draft_generation_snapshot($1,$2,$3,null,null) value",
      [f.w, o.id, base.proposal_id],
    )
  ).value;
  const catalog = current.source_evidence;
  const span = catalog.spans[0];
  const tuple = {
    modality: "required",
    actor: "supplier",
    negated: false,
    conditions: [],
    exceptions: [],
    consequences: [],
    quantities: [{ value: "30", unit: "days", currency: null }],
    dates: [],
  };
  const semantics = (
    await row(
      'select app_private.source_semantics_for_review(jsonb_populate_record(null::public.source_obligation_reviews,$1::jsonb))||\'{"review_status":"pending"}\'::jsonb value',
      [JSON.stringify({ spans: [span], semantics: tuple, review_id: null })],
    )
  ).value;
  fixture.plan.frozen_context = {
    ...fixture.plan.frozen_context,
    ...current,
    template: fixture.plan.frozen_context.template,
    generated_delivery_version: 3,
    source_contract_version: 1,
    source_evidence: catalog,
  };
  fixture.requirements[0] = {
    ...fixture.requirements[0],
    text: span.quote,
    source_refs: [{ id: span.id, quote: span.quote }],
    source_semantics: semantics,
  };
  for (const step of fixture.steps) {
    const scope = taskInput({
      plan: { ...fixture.plan, stage: step.stage },
      step,
      steps: fixture.steps,
      requirements: fixture.requirements,
    });
    const receipt = fixture.accepted_receipts.find(
      (r) => r.step_id === step.id,
    )!;
    validateGroundingReport(
      receipt.verification,
      receipt.candidate,
      receipt.candidate_hash,
      scope.evidence,
      scope.requiredIds,
      undefined,
      groundingOptions(scope.context, true),
    );
  }
  const p = await row(
    "insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,workflow_version) values($1,$2,$3,$4,'proposal','completed','completed',1,$5,$6::jsonb,$7,1) returning *",
    [
      fixture.plan.id,
      f.w,
      o.id,
      base.proposal_id,
      fixture.plan.input_hash,
      JSON.stringify(fixture.plan.frozen_context),
      f.owner,
    ],
  );
  const r = fixture.requirements[0];
  await f.db.query(
    "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by) values($1,$2,$3,$4,$5,'functional',true,$6::jsonb,$7::jsonb,'Workflow response','Signed workflow test',$8)",
    [
      r.id,
      f.w,
      p.id,
      o.id,
      r.text,
      JSON.stringify(r.source_refs),
      JSON.stringify(r.source_semantics),
      f.owner,
    ],
  );
  for (const step of fixture.steps) {
    const j = await row(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,$2,$3,$4,'succeeded',$5) returning *",
      [f.w, step.task, p.id, p.input_hash, f.owner],
    );
    const saved = await row(
      "insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'completed',$10) returning *",
      [
        step.id,
        f.w,
        p.id,
        j.id,
        step.task,
        step.stage,
        step.ordinal,
        JSON.stringify(step.input),
        JSON.stringify(step.output),
        f.owner,
      ],
    );
    const receipt = fixture.accepted_receipts.find(
      (x) => x.step_id === step.id,
    )!;
    receipt.candidate = saved.output;
    receipt.candidate_hash = await qualifierHash(JSON.stringify(saved.output));
    receipt.verification.checked_candidate_hash = receipt.candidate_hash;
    const thread = await qualifierHash(j.id);
    await f.db.query(
      "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values($1,$2,$3,$4,$5,'committed')",
      [thread, f.w, j.id, p.input_hash, step.task],
    );
    await f.db.query(
      "insert into app_private.model_graph_results(id,thread_id,result_key,value,content_hash) values($1,$2,'accepted',$3::jsonb,$4),($5,$2,'chosen-verification',$6::jsonb,$7)",
      [
        receipt.receipt_id,
        thread,
        JSON.stringify(saved.output),
        receipt.candidate_hash,
        receipt.verification_receipt_id,
        JSON.stringify({ result: receipt.verification, coverage: "aggregate" }),
        await qualifierHash(JSON.stringify(receipt.verification)),
      ],
    );
    await f.db.query(
      "update app_private.model_graph_threads set result_id=$1 where id=$2",
      [receipt.receipt_id, thread],
    );
    await f.db.query(
      "insert into app_private.model_graph_checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values($1,'0001',$2::jsonb,'{}')",
      [
        thread,
        JSON.stringify({
          channel_values: { reportRef: receipt.verification_receipt_id },
        }),
      ],
    );
    await f.db.query(
      "update public.jobs set checkpoint=jsonb_build_object('graph_thread',$1::text,'model_executor',2) where id=$2",
      [thread, j.id],
    );
  }
  const v = await row(
    "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by,plan_id,evidence_revision,section_outline,separate_volumes) values($1,$2,1,repeat('c',64),$3,$4,1,$5::jsonb,$6) returning *",
    [
      f.w,
      base.proposal_id,
      f.owner,
      p.id,
      JSON.stringify(fixture.section_outline),
      separate,
    ],
  );
  for (const [i, s] of fixture.sections.entries())
    await f.db.query(
      "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,evidence_refs,created_by,content_blocks,requirement_ids,volume,fixed,company_claims) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb)",
      [
        f.w,
        v.id,
        s.key,
        s.title,
        s.body,
        i,
        JSON.stringify(s.evidence_refs),
        f.owner,
        JSON.stringify(s.content_blocks),
        JSON.stringify(s.requirement_ids),
        s.volume,
        s.fixed === true,
        JSON.stringify(s.company_claims || []),
      ],
    );
  await f.db.query(
    "update public.proposals set active_version_id=$1,state='draft' where id=$2",
    [v.id, base.proposal_id],
  );
  const issuance = await row(
    "insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at) select $1,$2,$3,'proposal.generate',$4,accepted_at,accepted_at+interval '600 seconds' from (select clock_timestamp()-make_interval(secs=>$5) accepted_at) x returning *",
    [f.w, p.id, f.owner, crypto.randomUUID(), acceptedAgoSeconds],
  );
  await f.db.query(
    "update public.generation_plans set issuance_request_id=$1 where id=$2",
    [issuance.id, p.id],
  );
  const j = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values($1,'prepare_generated_delivery',$2,$3,'queued',$4,$5::jsonb) returning *",
    [
      f.w,
      p.id,
      p.input_hash,
      f.owner,
      JSON.stringify({
        model_executor: 4,
        minimum_worker_executor: 4,
        generated_version_id: v.id,
        generated_version_hash: v.content_hash,
      }),
    ],
  );
  return { o, base, p, v, j, issuance, parent };
}
async function claim(id: string) {
  const j = await rpc("claim_backend_local_job_v5");
  expect(j?.id).toBe(id);
  return j;
}
function transport() {
  const objects = new Map<string, Blob>();
  const backend = {
    authenticate: async () => ({ id: f.owner }),
    membership: async () => ({
      workspace_id: f.w,
      user_id: f.owner,
      role: "Owner",
      active: true,
    }),
    internal: vi.fn(rpc),
    deliveryObject: async (key: string) => objects.get(key) || null,
    storeDeliveryObject: async (key: string, bytes: Uint8Array) => {
      if (objects.has(key)) throw Error("immutable");
      objects.set(key, new Blob([new Uint8Array(bytes)]));
    },
  };
  return { backend: backend as unknown as Backend, objects };
}
it("projects actual accepted responses, renders verified DOCX, and keeps human approval pending", async () => {
  const { j, v, issuance } = await setup();
  expect(await rpc("claim_backend_local_job_v3")).toBeNull();
  const job = await claim(j.id);
  const t = transport();
  const checkedContext = await rpc("generated_delivery_context", {
    job_id: job.id,
    lease: job.lease_token,
  });
  expect((await assessGeneratedDelivery(checkedContext)).blockers).toEqual([]);
  const result = await processGeneratedDelivery(t.backend, job);
  expect(result).toMatchObject({ projected: true });
  const snapshot = await row(
    "select * from public.proposal_delivery_snapshots where id=$1",
    [(result as any).snapshot_id],
  );
  expect(snapshot.payload).toMatchObject({
    version: 3,
    substantive_complete: false,
    approval_state: "draft",
    assurance_state: "source_review_required",
    generation: {
      proposal_version_id: v.id,
      machine_validation: { passed: true },
    },
  });
  const rendered = await rpc("claim_backend_local_job_v5");
  expect(rendered.type).toBe("render_delivery");
  const output = await processDeliveryExport(
    t.backend,
    rendered,
    async (model) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
  );
  expect(output.error_code).toBeFalsy();
  const pkg = await rpc("delivery_package", { snapshot_id: snapshot.id });
  expect(pkg.status).toBe("ready");
  expect(
    await row(
      "select outcome,issued_snapshot_id from public.proposal_issuance_requests where id=$1",
      [issuance.id],
    ),
  ).toMatchObject({ outcome: "issued", issued_snapshot_id: snapshot.id });
  expect(t.objects.size).toBe(1);
  const artifact = pkg.artifacts[0];
  const auth = await rpc("delivery_artifact_context", {
    artifact_id: artifact.id,
    actor_id: f.owner,
  });
  const bytes = new Uint8Array(
    await t.objects.get(auth.artifact.storage_key)!.arrayBuffer(),
  );
  verifyExportDocx(bytes, buildDeliveryExport(snapshot, "combined"));
  const handle = createApiHandler(
    {
      url: "https://synthetic.supabase.co",
      publishableKey: "synthetic-public",
      serviceKey: "synthetic-secret",
      workerSecret: "synthetic-worker-secret",
      allowedOrigins: ["https://app.example.test"],
      models: modelEnvironments(() => undefined),
    },
    () => t.backend,
  );
  const downloaded = await handle(
    new Request(
      `https://edge.example.test/functions/v1/api/v1/delivery-artifacts/${artifact.id}/download`,
      {
        headers: {
          authorization: "Bearer synthetic-owner",
          origin: "https://app.example.test",
        },
      },
    ),
  );
  expect(downloaded.status).toBe(200);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(strFromU8(unzipSync(bytes)["word/document.xml"])).toContain(
    "Configure the workflow in 30 days.",
  );
  expect((await row("select count(*)::int n from public.approvals")).n).toBe(0);
  expect(
    (await row("select count(*)::int n from public.provider_usage")).n,
  ).toBe(0);
});
it("blocks source restatement without publishing a completed-response snapshot", async () => {
  const { j } = await setup("Provide a workflow in 30 days.");
  const result = await processGeneratedDelivery(
    transport().backend,
    await claim(j.id),
  );
  expect(result).toMatchObject({
    error_code: "GENERATED_DELIVERY_VALIDATION_FAILED",
  });
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_delivery_snapshots where payload->>'version'='3'",
      )
    ).n,
  ).toBe(0);
});
it("rejects changed sources and membership between assessment and publication", async () => {
  const { j, o } = await setup();
  const job = await claim(j.id);
  const ctx = await rpc("generated_delivery_context", {
    job_id: j.id,
    lease: job.lease_token,
  });
  const checked = await assessGeneratedDelivery(ctx);
  expect(checked.blockers).toEqual([]);
  const payload = await buildGeneratedPayload(ctx, checked);
  await f.db.query(
    "update public.opportunities set description='Changed source',revision=revision+1 where id=$1",
    [o.id],
  );
  await expect(
    rpc("publish_generated_delivery", {
      job_id: j.id,
      lease: job.lease_token,
      expected_context_hash: ctx.context_hash,
      payload,
    }),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
});
it("uses the chosen whole-candidate verifier and refuses a missing or repair-only report", async () => {
  const { j } = await setup();
  const job = await claim(j.id);
  await f.db.exec(
    "update app_private.model_graph_results set value=value||'{\"coverage\":\"repair_only\"}'::jsonb where result_key='chosen-verification'",
  );
  const ctx = await rpc("generated_delivery_context", {
    job_id: j.id,
    lease: job.lease_token,
  });
  expect(ctx.accepted_receipts).toEqual([]);
  expect((await assessGeneratedDelivery(ctx)).machine_eligible).toBe(false);
});
it.each(["en", "ar"])(
  "preserves explicit inline placeholders in actual paragraph/table OOXML with renderer3 policy: %s",
  async (language) => {
    const data = await generatedDeliveryFixture();
    const context: any = {
      ...data,
      version: {
        id: crypto.randomUUID(),
        content_hash: "c".repeat(64),
        separate_volumes: false,
      },
      source_manifest: [],
      plan: {
        ...data.plan,
        frozen_context: { ...data.plan.frozen_context, language },
      },
    };
    const report = await assessGeneratedDelivery(data);
    const payload = await buildGeneratedPayload(context, report);
    const marker =
      language === "ar"
        ? "[مطلوب: تأكيد المدخل]"
        : "[INPUT REQUIRED: confirm input]";
    payload.sections[0].content_blocks.push(
      { type: "paragraph", text: marker },
      { type: "table", headers: ["Input"], rows: [[marker]] },
    );
    const snapshot = { id: crypto.randomUUID(), payload };
    const model = buildDeliveryExport(snapshot, "combined");
    const bytes = new Uint8Array(
      await (await renderDocx(model, fonts)).arrayBuffer(),
    );
    verifyExportDocx(bytes, model);
    const entries = unzipSync(bytes);
    let xml = strFromU8(entries["word/document.xml"]);
    expect(xml).toContain("w:highlight");
    xml = xml.replaceAll(/<w:highlight[^>]*\/>/g, "");
    entries["word/document.xml"] = strToU8(xml);
    expect(() => verifyExportDocx(zipSync(entries), model)).toThrow();
  },
);

it("fails at the request deadline during rendering, then explicitly retries the same accepted version with a new deadline and unchanged unknown usage", async () => {
  const { j, p, issuance } = await setup(undefined, 598);
  const unknown = crypto.randomUUID();
  const priorModelJob = (
    await row(
      "select job_id from public.generation_steps where plan_id=$1 limit 1",
      [p.id],
    )
  ).job_id;
  await f.db.query(
    "insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1::uuid,$2,$3,$4,$1::text,'openai','synthetic-model',$5,current_date,1,100,1000,'unknown',$6)",
    [unknown, f.w, priorModelJob, crypto.randomUUID(), p.input_hash, f.owner],
  );
  const usageBefore = await row(
    "select to_jsonb(u) data from public.provider_usage u where id=$1",
    [unknown],
  );
  const t = transport();
  const projected = await processGeneratedDelivery(
    t.backend,
    await claim(j.id),
  );
  expect(projected).toMatchObject({ projected: true });
  const snapshotId = (projected as any).snapshot_id;
  const renderJob = await rpc("claim_backend_local_job_v5");
  expect(renderJob.type).toBe("render_delivery");
  const failed = await processDeliveryExport(
    t.backend,
    renderJob,
    async (model) => {
      const bytes = new Uint8Array(
        await (await renderDocx(model, fonts)).arrayBuffer(),
      );
      const deadline = new Date(issuance.deadline_at).getTime();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, deadline - Date.now() + 30)),
      );
      // Observe the database clock, including engines whose timestamp bridge
      // has lower precision than JavaScript, before testing the side-effect gate.
      for (let attempt = 0; attempt < 20; attempt++) {
        const now = await row(
          "select clock_timestamp()>=deadline_at expired from public.proposal_issuance_requests where id=$1",
          [issuance.id],
        );
        if (now.expired) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        (
          await row(
            "select clock_timestamp()>=deadline_at expired from public.proposal_issuance_requests where id=$1",
            [issuance.id],
          )
        ).expired,
      ).toBe(true);
      return bytes;
    },
  );
  expect(failed).toMatchObject({ error_code: "PROPOSAL_ISSUANCE_TIMEOUT" });
  expect(t.objects.size).toBe(0);
  expect(
    await row(
      "select outcome,error_code,issued_snapshot_id from public.proposal_issuance_requests where id=$1",
      [issuance.id],
    ),
  ).toEqual({
    outcome: "failed",
    error_code: "PROPOSAL_ISSUANCE_TIMEOUT",
    issued_snapshot_id: null,
  });
  const revision = (
    await row("select delivery_revision from public.proposals where id=$1", [
      p.proposal_id,
    ])
  ).delivery_revision;
  const input = {
    snapshot_id: snapshotId,
    expected_delivery_revision: revision,
  };
  const key = crypto.randomUUID();
  await f.command("delivery.snapshot.retry", input, key);
  const fresh = await row(
    "select * from public.proposal_issuance_requests where id=(select issuance_request_id from public.generation_plans where id=$1)",
    [p.id],
  );
  expect(fresh.id).not.toBe(issuance.id);
  expect(fresh.outcome).toBe("active");
  expect(Date.parse(fresh.deadline_at) - Date.parse(fresh.accepted_at)).toBe(
    600000,
  );
  await f.command("delivery.snapshot.retry", input, key);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_issuance_requests where plan_id=$1",
        [p.id],
      )
    ).n,
  ).toBe(2);
  await expect(f.command("delivery.snapshot.retry", input)).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  const next = await rpc("claim_backend_local_job_v5");
  expect(next.checkpoint.issuance_request_id).toBe(fresh.id);
  expect(next.entity_id).toBe(snapshotId);
  const rendered = await processDeliveryExport(
    t.backend,
    next,
    async (model) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
  );
  expect(rendered.error_code).toBeFalsy();
  expect(
    (
      await row(
        "select outcome from public.proposal_issuance_requests where id=$1",
        [fresh.id],
      )
    ).outcome,
  ).toBe("issued");
  expect(
    await row(
      "select to_jsonb(u) data from public.provider_usage u where id=$1",
      [unknown],
    ),
  ).toEqual(usageBefore);
});
it("recovers a crashed projection with a new exclusive lease under the original request and rejects the old publisher", async () => {
  const { j, issuance } = await setup();
  const old = await claim(j.id);
  const ctx = await rpc("generated_delivery_context", {
    job_id: j.id,
    lease: old.lease_token,
  });
  const payload = await buildGeneratedPayload(
    ctx,
    await assessGeneratedDelivery(ctx),
  );
  await f.db.query(
    "update public.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",
    [j.id],
  );
  const recovered = await claim(j.id);
  expect(recovered.lease_token).not.toBe(old.lease_token);
  expect(recovered.checkpoint.issuance_request_id).toBe(issuance.id);
  await expect(
    rpc("publish_generated_delivery", {
      job_id: j.id,
      lease: old.lease_token,
      expected_context_hash: ctx.context_hash,
      payload,
    }),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  expect(
    await processGeneratedDelivery(transport().backend, recovered),
  ).toMatchObject({ projected: true });
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_delivery_snapshots where payload->>'version'='3'",
      )
    ).n,
  ).toBe(1);
});
it("does not permit an authenticated browser to publish or a revoked actor to publish a previously valid report", async () => {
  const { j } = await setup();
  const job = await claim(j.id);
  const ctx = await rpc("generated_delivery_context", {
    job_id: j.id,
    lease: job.lease_token,
  });
  const payload = await buildGeneratedPayload(
    ctx,
    await assessGeneratedDelivery(ctx),
  );
  await f.db.exec("set local role authenticated");
  await expect(
    rpc("publish_generated_delivery", {
      job_id: j.id,
      lease: job.lease_token,
      expected_context_hash: ctx.context_hash,
      payload,
    }),
  ).rejects.toThrow();
  await f.db.exec("reset role");
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    rpc("publish_generated_delivery", {
      job_id: j.id,
      lease: job.lease_token,
      expected_context_hash: ctx.context_hash,
      payload,
    }),
  ).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
});

it.each(["projection", "render"])(
  "rejects %s after the actual OCR/correction successor becomes current while preserving immutable parent source",
  async (boundary) => {
    const { j, parent } = await setup(undefined, 0, true);
    const job = await claim(j.id);
    const ctx = await rpc("generated_delivery_context", {
      job_id: j.id,
      lease: job.lease_token,
    });
    const payload = await buildGeneratedPayload(
      ctx,
      await assessGeneratedDelivery(ctx),
    );
    expect(ctx.input_review_complete).toBe(false);
    expect(payload.gaps.some((g) => g.reason === "UNREAD_INPUT")).toBe(true);
    let rendering: any = null;
    if (boundary === "render") {
      await rpc("publish_generated_delivery", {
        job_id: j.id,
        lease: job.lease_token,
        expected_context_hash: ctx.context_hash,
        payload,
      });
      const renderJob = await rpc("claim_backend_local_job_v5");
      const renderContext = await rpc("delivery_export_context", {
        job_id: renderJob.id,
        lease: renderJob.lease_token,
      });
      const artifact = renderContext.artifacts[0],
        model = buildDeliveryExport(renderContext.snapshot, artifact.volume);
      const bytes = await deliveryBytes(
        new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
        model,
      );
      rendering = {
        job_id: renderJob.id,
        lease: renderJob.lease_token,
        artifact_id: artifact.id,
        actual_hash: bytes.hash,
        actual_size: bytes.size,
      };
    }
    const old = await row("select * from public.documents where id=$1", [
      parent.id,
    ]);
    await f.command("document.extraction.correct", {
      id: old.id,
      expected_revision: old.revision,
      expected_original_hash: old.original_hash,
      expected_extraction_hash: old.extraction_hash,
      pages: [
        {
          page: 1,
          expected_page_text_hash: await qualifierHash(
            "Provide a workflow in 30 days.",
          ),
          text: "Provide a workflow in 30 days. Include the exception procedure.",
          blank_confirmed: false,
        },
      ],
      review_confirmed: true,
    });
    const task = await f.rpc("claim_uploaded_document_ocr");
    expect(task.action).toBe("publish");
    await rpc("prepare_uploaded_document_ocr_publication", {
      request_id: task.request_id,
      lease: task.lease,
    });
    const child = await rpc("complete_uploaded_document_ocr_publication", {
      request_id: task.request_id,
      lease: task.lease,
      actual_hash: old.original_hash,
      actual_size: 100,
    });
    expect(child.ocr_parent_document_id).toBe(old.id);
    expect(
      (
        await row("select app_private.current_document_extraction($1,$2) id", [
          f.w,
          old.id,
        ])
      ).id,
    ).toBe(child.id);
    await expect(
      boundary === "render"
        ? rpc("complete_delivery_artifact", rendering)
        : rpc("publish_generated_delivery", {
            job_id: j.id,
            lease: job.lease_token,
            expected_context_hash: ctx.context_hash,
            payload,
          }),
    ).rejects.toMatchObject({ code: "STALE_INPUT" });
    expect(
      (
        await row("select extraction_hash from public.documents where id=$1", [
          old.id,
        ])
      ).extraction_hash,
    ).toBe(old.extraction_hash);
  },
);
it("rejects a source-obligation revocation after the completed machine report was assessed", async () => {
  const { j, o, p } = await setup();
  const source = (await rpc("source_review_context", { opportunity_id: o.id }))
    .sources[0];
  await f.command("source.authority.review", {
    opportunity_id: o.id,
    entity_kind: source.reference.entity_kind,
    entity_id: source.reference.entity_id,
    content_hash: source.reference.content_hash,
    expected_revision: 0,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic buyer authorship checked against the source.",
  });
  const catalog = (await rpc("source_review_context", { opportunity_id: o.id }))
    .source_evidence;
  const spans = [catalog.spans[0]];
  const tuple = {
    modality: "required",
    actor: "supplier",
    negated: false,
    conditions: [],
    exceptions: [],
    consequences: [],
    quantities: [{ value: "30", unit: "days", currency: null }],
    dates: [],
  };
  const reviewed = await f.command("source.obligation.review", {
    opportunity_id: o.id,
    review_id: null,
    expected_revision: 0,
    spans,
    semantics: tuple,
    status: "confirmed",
    reason: "Synthetic meaning reviewed with current buyer source.",
  });
  const requirement = (
    await row(
      "select app_private.source_obligation_inventory($1,$2,array[$3::uuid])->0 value",
      [f.w, o.id, reviewed.review_id],
    )
  ).value;
  const currentCatalog = (
    await rpc("source_review_context", { opportunity_id: o.id })
  ).source_evidence;
  await f.db.query(
    "update public.generation_plans set frozen_context=jsonb_set(frozen_context,'{source_evidence}',$2::jsonb) where id=$1",
    [p.id, JSON.stringify(currentCatalog)],
  );
  await f.db.query(
    "update public.requirements set text=$2,source_refs=$3::jsonb,source_semantics=$4::jsonb where plan_id=$1",
    [
      p.id,
      requirement.text,
      JSON.stringify(requirement.source_refs),
      JSON.stringify(requirement.source_semantics),
    ],
  );
  const job = await claim(j.id);
  const ctx = await rpc("generated_delivery_context", {
    job_id: j.id,
    lease: job.lease_token,
  });
  const payload = await buildGeneratedPayload(
    ctx,
    await assessGeneratedDelivery(ctx),
  );
  await f.command("source.obligation.review", {
    opportunity_id: o.id,
    review_id: reviewed.review_id,
    expected_revision: 1,
    spans,
    semantics: tuple,
    status: "revoked",
    reason: "Synthetic later review revoked the previous meaning decision.",
  });
  await expect(
    rpc("publish_generated_delivery", {
      job_id: j.id,
      lease: job.lease_token,
      expected_context_hash: ctx.context_hash,
      payload,
    }),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
});

it("issues two genuine volumes only after both byte-verified files are ready; one ready volume remains unavailable", async () => {
  const { j, issuance } = await setup(undefined, 0, false, true);
  const t = transport();
  const projected = await processGeneratedDelivery(
    t.backend,
    await claim(j.id),
  );
  expect(projected).toMatchObject({ projected: true });
  const snapshotId = (projected as any).snapshot_id;
  const renderJob = await rpc("claim_backend_local_job_v5");
  const identity = { job_id: renderJob.id, lease: renderJob.lease_token };
  const context = await rpc("delivery_export_context", identity);
  expect(context.artifacts).toHaveLength(2);
  const first = context.artifacts[0];
  const model = buildDeliveryExport(context.snapshot, first.volume);
  const bytes = await deliveryBytes(
    new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
    model,
  );
  await t.backend.storeDeliveryObject(
    first.storage_key,
    bytes.bytes,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  await rpc("complete_delivery_artifact", {
    ...identity,
    artifact_id: first.id,
    actual_hash: bytes.hash,
    actual_size: bytes.size,
  });
  await expect(rpc("finish_delivery_export", identity)).rejects.toThrow();
  await expect(
    rpc("delivery_artifact_context", {
      artifact_id: first.id,
      actor_id: f.owner,
    }),
  ).rejects.toThrow();
  expect(
    (
      await row(
        "select outcome from public.proposal_issuance_requests where id=$1",
        [issuance.id],
      )
    ).outcome,
  ).toBe("active");
  const rendered = vi.fn(
    async (model: any) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
  );
  expect(
    (await processDeliveryExport(t.backend, renderJob, rendered)).error_code,
  ).toBeFalsy();
  expect(rendered).toHaveBeenCalledTimes(1);
  expect(t.objects.size).toBe(2);
  const pkg = await rpc("delivery_package", { snapshot_id: snapshotId });
  expect(pkg.status).toBe("ready");
  expect(
    (
      await row(
        "select outcome from public.proposal_issuance_requests where id=$1",
        [issuance.id],
      )
    ).outcome,
  ).toBe("issued");
  for (const artifact of context.artifacts) {
    const finalModel = buildDeliveryExport(context.snapshot, artifact.volume);
    verifyExportDocx(
      new Uint8Array(await t.objects.get(artifact.storage_key)!.arrayBuffer()),
      finalModel,
    );
  }
});

it.each([false, true])(
  "transfers the pre-model complete-file allowance into the actual %s volume package without double counting",
  async (separate) => {
    const { j, issuance } = await setup(undefined, 0, false, separate);
    const job = await claim(j.id);
    const t = transport();
    const baseline = Number(
      (await row("select app_private.storage_reserved_bytes($1) bytes", [f.w]))
        .bytes,
    );
    // Call the canonical pre-billable allowance helper directly. Model-reservation
    // admission itself is covered by proposalIssuanceCapacity's real RPC tests;
    // these completed candidate/verifier records remain synthetic fixtures.
    await f.db.query(
      "select app_private.ensure_issuance_file_capacity($1,$2)",
      [job.id, job.lease_token],
    );
    expect(
      Number(
        (
          await row(
            "select reserved_file_bytes bytes from public.proposal_issuance_requests where id=$1",
            [issuance.id],
          )
        ).bytes,
      ),
    ).toBe(20971520);
    const projected = await processGeneratedDelivery(t.backend, job);
    expect(projected).toMatchObject({ projected: true });
    const rendering = await rpc("claim_backend_local_job_v5");
    expect(rendering.type).toBe("render_delivery");
    const context = await rpc("delivery_export_context", {
      job_id: rendering.id,
      lease: rendering.lease_token,
    });
    const expectedVolumes = separate ? 2 : 1;
    expect(context.artifacts).toHaveLength(expectedVolumes);
    expect(
      context.artifacts.every(
        (a: any) => Number(a.reserved_bytes) === 10485760,
      ),
    ).toBe(true);
    expect(
      Number(
        (
          await row(
            "select reserved_file_bytes bytes from public.proposal_issuance_requests where id=$1",
            [issuance.id],
          )
        ).bytes,
      ),
    ).toBe(20971520 - expectedVolumes * 10485760);
    expect(
      Number(
        (
          await row("select app_private.storage_reserved_bytes($1) bytes", [
            f.w,
          ])
        ).bytes,
      ),
    ).toBe(baseline + 20971520);
    const output = await processDeliveryExport(
      t.backend,
      rendering,
      async (model) =>
        new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
    );
    expect(output.error_code).toBeFalsy();
    const finished = await row(
      "select outcome,reserved_file_bytes,accepted_at,deadline_at from public.proposal_issuance_requests where id=$1",
      [issuance.id],
    );
    expect(finished.outcome).toBe("issued");
    expect(Number(finished.reserved_file_bytes)).toBe(0);
    expect(finished.accepted_at).toEqual(issuance.accepted_at);
    expect(finished.deadline_at).toEqual(issuance.deadline_at);
    const actual = Number(
      (
        await row(
          "select sum(expected_size) bytes from public.proposal_delivery_artifacts where job_id=$1 and status='ready'",
          [rendering.id],
        )
      ).bytes,
    );
    expect(
      Number(
        (
          await row("select app_private.storage_reserved_bytes($1) bytes", [
            f.w,
          ])
        ).bytes,
      ),
    ).toBe(baseline + actual);
    expect(t.objects.size).toBe(expectedVolumes);
    expect(
      (await row("select count(*)::int n from public.provider_usage")).n,
    ).toBe(0);
  },
);
it("does not consume the file allowance on a stale-source render context and releases it on the terminal failure receipt", async () => {
  const { j, issuance, o, v } = await setup();
  const job = await claim(j.id);
  const t = transport();
  await f.db.query("select app_private.ensure_issuance_file_capacity($1,$2)", [
    job.id,
    job.lease_token,
  ]);
  await processGeneratedDelivery(t.backend, job);
  const rendering = await rpc("claim_backend_local_job_v5");
  await f.db.query(
    "update public.opportunities set title='Changed source before capacity transfer' where id=$1",
    [o.id],
  );
  await expect(
    rpc("delivery_export_context", {
      job_id: rendering.id,
      lease: rendering.lease_token,
    }),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
  expect(
    Number(
      (
        await row(
          "select reserved_file_bytes bytes from public.proposal_issuance_requests where id=$1",
          [issuance.id],
        )
      ).bytes,
    ),
  ).toBe(20971520);
  expect(
    Number(
      (
        await row(
          "select coalesce(sum(reserved_bytes),0) bytes from public.proposal_delivery_artifacts where job_id=$1",
          [rendering.id],
        )
      ).bytes,
    ),
  ).toBe(0);
  const render = vi.fn(async () => new Uint8Array());
  const failed = await processDeliveryExport(t.backend, rendering, render);
  expect(failed.error_code).toBe("STALE_INPUT");
  expect(render).not.toHaveBeenCalled();
  expect(t.objects.size).toBe(0);
  const outcome = await row(
    "select outcome,reserved_file_bytes from public.proposal_issuance_requests where id=$1",
    [issuance.id],
  );
  expect(outcome.outcome).toBe("failed");
  expect(Number(outcome.reserved_file_bytes)).toBe(0);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_versions where id=$1",
        [v.id],
      )
    ).n,
  ).toBe(1);
});
it("rolls back an allowance transfer when the delegated artifact reservation fails", async () => {
  const { j, issuance } = await setup(undefined, 0, false, true);
  const job = await claim(j.id);
  await f.db.query("select app_private.ensure_issuance_file_capacity($1,$2)", [
    job.id,
    job.lease_token,
  ]);
  await processGeneratedDelivery(transport().backend, job);
  const rendering = await rpc("claim_backend_local_job_v5");
  // Fault injection after admission: bypass canonical writers to force the
  // delegated capacity check to fail after the allowance-decrease statement.
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/transfer-rollback',262144000,'Synthetic injected delegate failure')",
    [f.w],
  );
  await expect(
    rpc("delivery_export_context", {
      job_id: rendering.id,
      lease: rendering.lease_token,
    }),
  ).rejects.toMatchObject({ code: "STORAGE_CAP_REACHED" });
  expect(
    Number(
      (
        await row(
          "select reserved_file_bytes bytes from public.proposal_issuance_requests where id=$1",
          [issuance.id],
        )
      ).bytes,
    ),
  ).toBe(20971520);
  expect(
    Number(
      (
        await row(
          "select coalesce(sum(reserved_bytes),0) bytes from public.proposal_delivery_artifacts where job_id=$1",
          [rendering.id],
        )
      ).bytes,
    ),
  ).toBe(0);
  expect(
    (await row("select count(*)::int n from public.provider_usage")).n,
  ).toBe(0);
});

// A separate fully migrated database lets the exact operations SQL retain its
// own READ ONLY transaction/ROLLBACK, independently of this suite's fixture txn.
it("observes canonical whole-package issuance and preserves timestamps after source drift", async () => {
  const previousFixture = f;
  const isolated = await workflowFixture();
  f = isolated;
  try {
    await f.db.exec("begin");
    const { j, p, o, issuance } = await setup(undefined, 0, false, true);
    const t = transport();
    const generated = await processGeneratedDelivery(t.backend, await claim(j.id));
    expect(generated).toMatchObject({ projected: true });
    const render = await rpc("claim_backend_local_job_v5");
    expect(render.type).toBe("render_delivery");
    const rendered = await processDeliveryExport(t.backend, render, async (model) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()));
    expect(rendered.error_code).toBeFalsy();
    await f.db.exec("commit");
    const target = { opportunity_id: o.id, proposal_id: p.proposal_id, plan_id: p.id, issuance_request_id: issuance.id };
    const observed = await currentIssuanceObservation(f, target);
    expect(Object.values(observed.guards)).toEqual(Array(Object.keys(observed.guards).length).fill(true));
    expect(observed.artifact_check).toBe("passed");
    expect(observed.issuance).toMatchObject({ outcome: "issued", effective_outcome: "issued", error_code: null });
    expect(observed.issuance.completed_at).toBe(observed.issuance.effective_completed_at);
    expect(new Date(observed.issuance.completed_at).getTime()).toBeLessThan(new Date(observed.issuance.deadline_at).getTime());
    expect(observed.package).toMatchObject({ current_version: true, current_snapshot: true,
      validated_generated_draft: true, approval_state: "draft", required_volumes: ["technical", "financial"],
      render_job: { status: "succeeded" } });
    expect(observed.package.artifacts).toHaveLength(2);
    expect(observed.package.artifacts.every((a: any) => a.status === "ready" && a.renderer_version === "3" && a.expected_size > 0)).toBe(true);
    // Test-only fixture edit, never a production operation. The immutable
    // issuance times remain visible even when the source guards reject it.
    await f.db.query("update public.opportunities set description='Changed synthetic source' where id=$1", [o.id]);
    const stale = await currentIssuanceObservation(f, target);
    expect(stale.guards.sources).toBe(false);
    expect(stale.source_check).toBe("STALE_INPUT");
    expect(stale.issuance).toEqual(observed.issuance);
  } finally {
    await isolated.db.close();
    f = previousFixture;
  }
}, 30000);
