// @vitest-environment node
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  deliveryPipelineFixture,
  type DeliveryPipelineFixture,
} from "./deliveryPipelineFixture";
import type { Backend } from "../../supabase/functions/_shared/backend";
import {
  buildDeliveryExport,
  DOCX_MIME,
} from "../../supabase/functions/_shared/deliveryExport";
import {
  deliveryBytes,
  processDeliveryExport,
} from "../../supabase/functions/_shared/deliveryWorker";
import { verifyExportDocx } from "../../supabase/functions/_shared/export";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";

let h: DeliveryPipelineFixture;
beforeAll(async () => {
  h = await deliveryPipelineFixture();
}, 30000);
afterAll(async () => h?.f.db.close());
beforeEach(async () => h.f.db.exec("begin"));
afterEach(async () => h.f.db.exec("rollback"));
async function emptyOpportunity(language: "en" | "ar" = "en") {
  const source = await h.f.command("source.create", {
    name: "Synthetic insufficient input",
    kind: "manual",
  });
  return h.f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic empty intake",
    reference: "SYNTHETIC-T02",
    description: "",
    language,
    decision: "shortlisted",
  });
}
async function prepare(
  t: ReturnType<DeliveryPipelineFixture["transport"]>,
  opportunity: any,
  intake_failure?: string,
) {
  const response = await t.request("commands", {
    commands: [
      {
        operation: "delivery.snapshot.prepare",
        input: {
          opportunity_id: opportunity.id,
          expected_revision: opportunity.revision,
          ...(intake_failure ? { intake_failure } : {}),
        },
      },
    ],
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  return (await response.json()).data[0];
}
async function renderAndDownload(
  t: ReturnType<DeliveryPipelineFixture["transport"]>,
  snapshot: any,
  template = true,
) {
  const job = await h.rpc("claim_backend_job_v5");
  expect(job).toMatchObject({
    type: "render_delivery",
    entity_id: snapshot.id,
    status: "running",
  });
  expect(job.checkpoint).not.toHaveProperty("issuance_request_id");
  const result = await processDeliveryExport(
    t.backend as unknown as Backend,
    job,
    async (model) =>
      new Uint8Array(await (await renderDocx(model, h.fonts)).arrayBuffer()),
  );
  expect(result).toMatchObject({ status: "succeeded" });
  const response = await t.request(`delivery-snapshots/${snapshot.id}/package`);
  expect(response.status).toBe(200);
  const saved = (await response.json()).data;
  expect(saved.status).toBe("ready");
  expect(saved.snapshot).toMatchObject({
    content_state: template ? "template" : "source_draft",
    input_state: template ? "insufficient" : "available",
  });
  expect(saved.artifacts).toHaveLength(1);
  const artifact = saved.artifacts[0];
  const downloaded = await t.request(
    `delivery-artifacts/${artifact.id}/download`,
  );
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-type")).toBe(DOCX_MIME);
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  const model = buildDeliveryExport(snapshot, "combined");
  expect(verifyExportDocx(bytes, model)).toBe(true);
  expect(await deliveryBytes(bytes, model)).toMatchObject({
    hash: artifact.content_hash,
    size: artifact.expected_size,
  });
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
  expect(xml).toContain('w:highlight w:val="yellow"');
  if (template) {
    expect(xml).toContain(
      snapshot.payload.language === "ar"
        ? "لا توجد معلومات نطاق كافية قابلة للاستخدام"
        : "Insufficient usable scope information is available.",
    );
    expect(snapshot.payload).toMatchObject({
      substantive_complete: false,
      assurance_state: "unreviewed",
      approval_state: "draft",
    });
    expect(
      snapshot.payload.sections.every(
        (s: any) =>
          s.kind === "response" &&
          s.content_blocks.every((b: any) => b.type === "placeholder"),
      ),
    ).toBe(true);
  }
  expect(
    (
      await h.f.db.query<any>(
        "select count(*)::int n from public.provider_usage",
      )
    ).rows[0].n,
  ).toBe(0);
  return { saved, job };
}

it.each([
  { language: "en", failure: undefined },
  { language: "ar", failure: undefined },
  { language: "en", failure: "EMPTY_FILE" },
  { language: "ar", failure: "INVALID_FILE" },
  { language: "en", failure: "EXTRACTION_FAILED" },
] as const)(
  "downloads a yellow-placeholder $language template through the actual API, SQL claim and renderer for $failure without persisted documents or AI",
  async ({ language, failure }) => {
    const t = h.transport();
    const opportunity = await emptyOpportunity(language);
    const snapshot = await prepare(t, opportunity, failure);
    expect(snapshot.plan_id).toBeNull();
    if (failure) {
      expect(snapshot.payload.input_materials).toMatchObject({
        intake_failure: failure,
        intake_failure_source: "client_reported",
      });
      expect(snapshot.payload.gaps).toContainEqual(
        expect.objectContaining({
          id: "intake-failure",
          reason: "UNREAD_INPUT",
        }),
      );
    }
    await renderAndDownload(t, snapshot);
    for (const table of [
      "documents",
      "generation_plans",
      "proposal_issuance_requests",
    ]) {
      expect(
        (await h.f.db.query<any>(`select count(*)::int n from public.${table}`))
          .rows[0].n,
      ).toBe(0);
    }
  },
  30000,
);

async function unreadPdf(opportunity: any) {
  const prepared = await h.f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic-scan.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await h.f.rpc("verify_document_pages", [prepared.id, 1]);
  return h.f.rpc("accept_uploaded_document_with_coverage", [
    prepared.id,
    h.f.owner,
    "a".repeat(64),
    100,
    "[Page 1]\n",
    "needs_ocr",
    crypto.randomUUID(),
    JSON.stringify({
      version: 1,
      kind: "pdf_pages",
      complete: false,
      pages: [{ page: 1, status: "needs_ocr", characters: 0 }],
    }),
  ]);
}
it("retains an unresolved scanned source as OCR-pending, never invalid, while the independent file honestly describes insufficient currently-readable information", async () => {
  const t = h.transport(),
    opportunity = await emptyOpportunity();
  const document = await unreadPdf(opportunity);
  const snapshot = await prepare(t, opportunity);
  expect(snapshot.payload.input_materials).not.toHaveProperty("intake_failure");
  expect(snapshot.payload.input_materials.documents).toContainEqual(
    expect.objectContaining({
      document_id: document.id,
      status: "needs_ocr",
      used_for_draft: false,
    }),
  );
  expect(snapshot.payload.gaps).toContainEqual(
    expect.objectContaining({
      reason: "UNREAD_INPUT",
      source_ids: [document.id],
    }),
  );
  await renderAndDownload(t, snapshot);
  expect(
    (
      await h.f.db.query<any>(
        "select status,ocr_status,original_hash,extraction_hash from public.documents where id=$1",
        [document.id],
      )
    ).rows[0],
  ).toMatchObject({
    status: "needs_ocr",
    ocr_status: "queued",
    original_hash: document.original_hash,
    extraction_hash: document.extraction_hash,
  });
}, 30000);

async function reviewedBlankPdf(opportunity: any) {
  const document = await unreadPdf(opportunity);
  await h.f.command("document.extraction.correct", {
    id: document.id,
    expected_revision: document.revision,
    expected_original_hash: document.original_hash,
    expected_extraction_hash: document.extraction_hash,
    review_confirmed: true,
    pages: [
      {
        page: 1,
        expected_page_text_hash: createHash("sha256").update("").digest("hex"),
        text: "",
        blank_confirmed: true,
      },
    ],
  });
  const task = await h.f.rpc("claim_uploaded_document_ocr");
  expect(task.action).toBe("publish");
  const reservation = await h.f.rpc(
    "prepare_uploaded_document_ocr_publication",
    [task.request_id, task.lease],
  );
  // The OCR transport/copy is independently covered by uploadedDocumentOcr;
  // this test begins with its real SQL verified-publication receipt.
  const child = await h.f.rpc("complete_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
    reservation.original_hash,
    reservation.expected_size,
  ]);
  expect(child).toMatchObject({
    status: "needs_processing",
    extraction_confirmed_by: h.f.owner,
  });
  return child;
}

it("renders an explicitly page-reviewed all-blank successor independently without claiming readable scope or substantive completion", async () => {
  const t = h.transport(),
    opportunity = await emptyOpportunity();
  const child = await reviewedBlankPdf(opportunity);
  const snapshot = await prepare(t, opportunity);
  expect(
    snapshot.payload.input_materials.documents.map((d: any) => d.document_id),
  ).toEqual([child.id]);
  expect(snapshot.payload.input_materials.documents[0]).toMatchObject({
    extraction_confirmed: true,
    used_for_draft: false,
  });
  expect(snapshot.payload.gaps).toContainEqual(
    expect.objectContaining({
      reason: "INSUFFICIENT_INPUT",
      source_ids: [child.id],
      label: expect.stringContaining(
        "reviewed and contain no usable scope text",
      ),
    }),
  );
  expect(snapshot.payload.gaps).not.toContainEqual(
    expect.objectContaining({ reason: "UNREAD_INPUT", source_ids: [child.id] }),
  );
  await renderAndDownload(t, snapshot);
}, 30000);

it.each([false, true])(
  "retries a saved v1 draft after all agents fail without extending the failed issuance or needing a model call (reviewed blank=%s)",
  async (blank) => {
    const t = h.transport(),
      opportunity = await emptyOpportunity();
    if (blank) await reviewedBlankPdf(opportunity);
    else {
      const prepared = await h.f.command("document.prepare", {
        eligibility_attested: true,
        kind: "rfp",
        opportunity_id: opportunity.id,
        original_name: "synthetic.txt",
        mime_type: "text/plain",
        size: 100,
        hash: "b".repeat(64),
      });
      await h.f.rpc("accept_uploaded_document", [
        prepared.id,
        h.f.owner,
        "b".repeat(64),
        100,
        "Provide an operating manual and demonstrate it in thirty days.",
        "ready",
        crypto.randomUUID(),
      ]);
    }
    const plan = await h.f.command("proposal.generate", {
      id: opportunity.id,
      expected_revision: opportunity.revision,
    });
    const p = (
      await h.f.db.query<any>(
        "select * from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0];
    const snapshot = (
      await h.f.db.query<any>(
        "select * from public.proposal_delivery_snapshots where plan_id=$1 order by ordinal limit 1",
        [plan.id],
      )
    ).rows[0];
    const sourceJob = (
      await h.f.db.query<any>(
        "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=(select job_id from public.generation_steps where plan_id=$1 order by ordinal limit 1) returning *",
        [plan.id],
      )
    ).rows[0];
    await h.f.rpc("fail_generation", [
      sourceJob.id,
      sourceJob.lease_token,
      "AI_AGENTS_UNAVAILABLE",
      null,
      null,
    ]);
    const failedIssuance = (
      await h.f.db.query<any>(
        "select * from public.proposal_issuance_requests where id=$1",
        [p.issuance_request_id],
      )
    ).rows[0];
    expect(failedIssuance).toMatchObject({
      outcome: "failed",
      error_code: "AI_AGENTS_UNAVAILABLE",
    });
    const blocked = (
      await (
        await t.request(`delivery-snapshots/${snapshot.id}/package`)
      ).json()
    ).data;
    expect(blocked.status).toBe("blocked");
    const retry = await t.request("commands", {
      commands: [
        {
          operation: "delivery.snapshot.retry",
          input: {
            snapshot_id: snapshot.id,
            expected_delivery_revision: blocked.snapshot.delivery_revision,
          },
        },
      ],
    });
    expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(200);
    const { job } = await renderAndDownload(t, snapshot, blank);
    expect(job.checkpoint.independent_delivery_authorization).toMatchObject({
      version: 1,
      snapshot_id: snapshot.id,
      actor_id: h.f.owner,
      operation: "delivery.snapshot.retry",
    });
    expect(
      (
        await h.f.db.query<any>(
          "select * from public.proposal_issuance_requests where id=$1",
          [p.issuance_request_id],
        )
      ).rows[0],
    ).toEqual(failedIssuance);
    expect(
      (
        await h.f.db.query<any>(
          "select count(*)::int n from public.proposal_issuance_requests",
        )
      ).rows[0].n,
    ).toBe(1);
  },
  30000,
);
