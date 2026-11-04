// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport";
import { deliveryBytes } from "../../supabase/functions/_shared/deliveryWorker";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  deliveryPipelineFixture,
  type DeliveryPipelineFixture,
} from "./deliveryPipelineFixture";
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import { taskInput } from "../../supabase/functions/_shared/generation";
import { processDeliveryExport } from "../../supabase/functions/_shared/deliveryWorker";
import type { Backend } from "../../supabase/functions/_shared/backend";
async function capacitySourceHashes() {
  const frontendFiles = await readdir(
    new URL("../../../frontend/src/lib/", import.meta.url),
  );
  const backendFiles = await readdir(
    new URL("../../supabase/functions/_shared/", import.meta.url),
  );
  return Object.fromEntries(
    await Promise.all(
      [
        "tests/backend/proposalCapacity.integration.test.ts",
        "tests/backend/deliveryPipelineFixture.ts",
        "supabase/functions/api/handler.ts",
        "supabase/functions/_shared/deliveryWorker.ts",
        "supabase/functions/_shared/deliveryExport.ts",
        "supabase/functions/_shared/export.ts",
        ...["boundedDocx.ts", "boundedDocxArchive.ts", "boundedXml.ts"]
          .filter((name) => backendFiles.includes(name))
          .map((name) => `supabase/functions/_shared/${name}`),
        "package-lock.json",
        "../frontend/package-lock.json",
        "../frontend/src/lib/renderDocx.ts",
        ...(frontendFiles.includes("docxTableStream.ts")
          ? ["../frontend/src/lib/docxTableStream.ts"]
          : []),
        ...[
          "Amiri-Regular",
          "Amiri-Bold",
          "Carlito-Regular",
          "Carlito-Bold",
        ].map((name) => `../frontend/public/fonts/${name}.ttf`),
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(`../../${name}`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
}
let sourceHashesBefore: Record<string, string> | undefined;
let h: DeliveryPipelineFixture;
const capacityChecks: Record<string, unknown>[] = [];
beforeAll(async () => {
  h = await deliveryPipelineFixture();
  if (process.env.TENDERDESK_CAPACITY_RECEIPT)
    sourceHashesBefore = await capacitySourceHashes();
}, 30000);
afterAll(async () => h?.f.db.close());
beforeEach(async () => h.f.db.exec("begin"));
afterEach(async () => h.f.db.exec("rollback"));
async function opportunity(language = "en") {
  const source = await h.f.command("source.create", {
    name: "Synthetic capacity test",
    kind: "manual",
  });
  return h.f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic capacity envelope",
    reference: "SYNTHETIC-G10",
    description: "",
    language,
    decision: "shortlisted",
  });
}
async function upload(o: any, text: string) {
  const hash = createHash("sha256").update(text).digest("hex"),
    size = Buffer.byteLength(text);
  const document = await h.f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: o.id,
    original_name: "synthetic-capacity.txt",
    mime_type: "text/plain",
    size,
    hash,
  });
  return h.rpc("accept_uploaded_document", {
    document_id: document.id,
    actor_id: h.f.owner,
    actual_hash: hash,
    actual_size: size,
    extraction_text: text,
    extraction_status: "ready",
    command_key: crypto.randomUUID(),
  });
}
async function configuredModel() {
  await h.f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await h.f.command("model.connection.save", {
    provider: "qwencloud",
    label: "Synthetic capacity route",
    credential_alias: "APP_MODEL_QWEN_KEY",
    project_ref: "ap-southeast-1",
    enabled: true,
    expected_revision: 0,
  });
  const model = await h.f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic capacity model",
    model: "fixture-model",
    enabled: true,
    capabilities: defaultCapabilities("qwencloud"),
    expected_revision: 0,
  });
  await h.f.command("model.task_route.save", {
    task: "default",
    model_ids: [model.id],
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await h.f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
  });
  return { connection, model };
}

it("refuses a new billable reservation when a saved request has no complete-file storage headroom, retaining its source and snapshot", async () => {
  const target = await configuredModel(),
    o = await opportunity(),
    t = h.transport();
  const document = await upload(
    o,
    "The supplier must deliver a documented approval workflow and its acceptance test.",
  );
  const plan = await h.f.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
  const snapshot = (
    await h.f.db.query<any>(
      "select * from public.proposal_delivery_snapshots where plan_id=$1 order by ordinal limit 1",
      [plan.id],
    )
  ).rows[0];
  const before = (
    await h.f.db.query<any>(
      "select to_jsonb(d) value from public.documents d where id=$1",
      [document.id],
    )
  ).rows[0].value;
  const used = Number(
    (
      await h.f.db.query<any>(
        "select app_private.storage_reserved_bytes($1) n",
        [h.f.w],
      )
    ).rows[0].n,
  );
  await h.f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic-g10-ambiguous-bytes',$2,'Unconfirmed deletion must retain capacity')",
    [h.f.w, 262144000 - used],
  );
  // The optional early draft can fail locally; it must not let later model work
  // cross the billable boundary without capacity for the required file package.
  let job = await h.rpc("claim_backend_job_v4");
  if (job.type === "render_delivery") {
    const render = vi.fn();
    expect(
      await processDeliveryExport(t.backend as unknown as Backend, job, render),
    ).toEqual({ error_code: "STORAGE_CAP_REACHED" });
    expect(render).not.toHaveBeenCalled();
    expect(t.backend.storeDeliveryObject).not.toHaveBeenCalled();
    job = await h.rpc("claim_backend_job_v4");
  }
  expect(job).toMatchObject({
    type: "analyze_chunk",
    entity_id: plan.id,
    status: "running",
  });
  const context = await h.rpc("generation_context", {
    job_id: job.id,
    lease: job.lease_token,
  });
  const input = taskInput(context);
  await h.rpc("prepare_task_model_route", {
    job_id: job.id,
    lease: job.lease_token,
    task_name: input.task,
    default_profile: taskRegistry.analyze_chunk.profile,
  });
  await expect(
    h.rpc("reserve_task_model_call", {
      job_id: job.id,
      lease: job.lease_token,
      call_key: "synthetic-capacity-before-send",
      input_hash: "c".repeat(64),
      input_tokens: 100,
      output_tokens: 100,
      manifest: input.manifest,
      target_model: target.model.id,
      target_connection: target.connection.id,
    }),
  ).rejects.toMatchObject({ code: "STORAGE_CAP_REACHED" });
  expect(
    (
      await h.f.db.query<any>(
        "select count(*)::int n from public.provider_usage",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await h.f.db.query<any>(
        "select to_jsonb(d) value from public.documents d where id=$1",
        [document.id],
      )
    ).rows[0].value,
  ).toEqual(before);
  expect(
    (
      await h.f.db.query<any>(
        "select content_hash,payload from public.proposal_delivery_snapshots where id=$1",
        [snapshot.id],
      )
    ).rows[0],
  ).toEqual({ content_hash: snapshot.content_hash, payload: snapshot.payload });
  capacityChecks.push({
    name: "storage_full_before_first_billable_reservation",
    passed: true,
    model_reservations: 0,
    source_and_snapshot_unchanged: true,
  });
}, 30000);

it.each([999999, 1000000, 1000001])(
  "enforces the existing one-million-character extraction ceiling at %s without truncation or loss of an earlier accepted source",
  async (characters) => {
    const o = await opportunity();
    const accepted = await upload(
      o,
      "Previously accepted synthetic operating scope.",
    );
    // A different opportunity isolates the per-file boundary from the equally
    // sized per-package boundary; the accepted control remains in the workspace.
    const target = await opportunity();
    const text = "S".repeat(characters);
    if (characters > 1000000) {
      await expect(upload(target, text)).rejects.toMatchObject({
        code: "EXTRACTION_CAP_REACHED",
      });
      expect(
        (
          await h.f.db.query<any>(
            "select status,extracted_text from public.documents where opportunity_id=$1",
            [target.id],
          )
        ).rows,
      ).toEqual([{ status: "pending", extracted_text: "" }]);
    } else {
      const document = await upload(target, text);
      expect(document.extracted_text.length).toBe(characters);
      expect(document.extraction_hash).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
      const blocks = (
        await h.f.db.query<any>(
          "select locator,text,text_hash from public.document_blocks where document_id=$1 order by ordinal",
          [document.id],
        )
      ).rows;
      let frontier = 0;
      for (const block of blocks) {
        expect(block.locator.start).toBeLessThanOrEqual(frontier + 1);
        expect(block.text).toBe(
          text.slice(block.locator.start - 1, block.locator.end),
        );
        expect(block.text_hash).toBe(
          createHash("sha256").update(block.text).digest("hex"),
        );
        frontier = Math.max(frontier, block.locator.end);
      }
      expect(frontier).toBe(characters);
    }
    expect(
      (
        await h.f.db.query<any>(
          "select extracted_text,extraction_hash,status from public.documents where id=$1",
          [accepted.id],
        )
      ).rows[0],
    ).toEqual({
      extracted_text: accepted.extracted_text,
      extraction_hash: accepted.extraction_hash,
      status: "ready",
    });
    expect(
      (
        await h.f.db.query<any>(
          "select count(*)::int n from public.provider_usage",
        )
      ).rows[0].n,
    ).toBe(0);
    capacityChecks.push({
      name: `extraction_characters_${characters}`,
      passed: true,
      accepted: characters <= 1000000,
      earlier_source_preserved: true,
    });
  },
  30000,
);

it("holds the complete existing two-file allowance once before billing, and a competing upload cannot consume it", async () => {
  const target = await configuredModel(),
    o = await opportunity();
  const document = await upload(
    o,
    "The supplier must preserve the complete delivery package.",
  );
  const plan = await h.f.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
  // This case isolates admission before the first billable call; the optional
  // source-draft rendering path is exercised above and in the pipeline suite.
  await h.f.db.query(
    "update public.jobs set status='canceled' where type='render_delivery' and status='queued' and checkpoint->>'issuance_request_id'=(select id::text from public.proposal_issuance_requests where plan_id=$1)",
    [plan.id],
  );
  const job = await h.rpc("claim_backend_job_v4");
  expect(job).toMatchObject({ type: "analyze_chunk", entity_id: plan.id });
  const context = await h.rpc("generation_context", {
    job_id: job.id,
    lease: job.lease_token,
  });
  const input = taskInput(context);
  await h.rpc("prepare_task_model_route", {
    job_id: job.id,
    lease: job.lease_token,
    task_name: input.task,
    default_profile: taskRegistry.analyze_chunk.profile,
  });
  const before = (
    await h.f.db.query<any>(
      "select to_jsonb(r) value from public.proposal_issuance_requests r where plan_id=$1",
      [plan.id],
    )
  ).rows[0].value;
  const usedBefore = Number(
    (
      await h.f.db.query<any>(
        "select app_private.storage_reserved_bytes($1) n",
        [h.f.w],
      )
    ).rows[0].n,
  );
  const args = {
    job_id: job.id,
    lease: job.lease_token,
    call_key: "synthetic-one-capacity-hold",
    input_hash: "e".repeat(64),
    input_tokens: 100,
    output_tokens: 100,
    manifest: input.manifest,
    target_model: target.model.id,
    target_connection: target.connection.id,
  };
  const first = await h.rpc("reserve_task_model_call", args);
  expect(first.state).toBe("reserved");
  const held = (
    await h.f.db.query<any>(
      "select to_jsonb(r) value from public.proposal_issuance_requests r where plan_id=$1",
      [plan.id],
    )
  ).rows[0].value;
  expect(held).toEqual({
    ...before,
    file_capacity_acquired: true,
    reserved_file_bytes: 20971520,
  });
  const used = Number(
    (
      await h.f.db.query<any>(
        "select app_private.storage_reserved_bytes($1) n",
        [h.f.w],
      )
    ).rows[0].n,
  );
  expect(used - usedBefore).toBe(20971520);
  await expect(h.rpc("reserve_task_model_call", args)).rejects.toMatchObject({
    code: "MODEL_CALL_ALREADY_RESERVED",
  });
  expect(
    Number(
      (
        await h.f.db.query<any>(
          "select app_private.storage_reserved_bytes($1) n",
          [h.f.w],
        )
      ).rows[0].n,
    ),
  ).toBe(used);
  // Only one MiB is now genuinely available. A 10 MiB upload would fit if the
  // new allowance were absent from the shared ledger, so this proves exclusion.
  await h.f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic-capacity-held-competition',$2,'Unconfirmed synthetic deletion')",
    [h.f.w, 262144000 - used - 1048576],
  );
  const uploadInput = {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: (await opportunity()).id,
    original_name: "competing-synthetic.txt",
    mime_type: "text/plain",
    size: 10485760,
    hash: "f".repeat(64),
  };
  await expect(h.f.command("document.prepare", uploadInput)).rejects.toThrow(
    "STORAGE_CAP_REACHED",
  );
  const fitting = await h.f.command("document.prepare", {
    ...uploadInput,
    size: 1048576,
  });
  expect(fitting.expected_size).toBe(1048576);
  expect(
    Number(
      (
        await h.f.db.query<any>(
          "select app_private.storage_reserved_bytes($1) n",
          [h.f.w],
        )
      ).rows[0].n,
    ),
  ).toBe(262144000);
  await expect(h.rpc("reserve_task_model_call", args)).rejects.toMatchObject({
    code: "MODEL_CALL_ALREADY_RESERVED",
  });
  expect(
    (
      await h.f.db.query<any>(
        "select count(*)::int n from public.provider_usage",
        [],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await h.f.db.query<any>(
        "select to_jsonb(r) value from public.proposal_issuance_requests r where plan_id=$1",
        [plan.id],
      )
    ).rows[0].value,
  ).toEqual(held);
  expect(
    (
      await h.f.db.query<any>(
        "select extraction_hash,extracted_text from public.documents where id=$1",
        [document.id],
      )
    ).rows[0],
  ).toEqual({
    extraction_hash: document.extraction_hash,
    extracted_text: document.extracted_text,
  });
  capacityChecks.push({
    name: "request_output_hold_excludes_competing_upload",
    passed: true,
    allowance_bytes: 20971520,
    duplicate_call_rejected_without_extra_hold: true,
    request_deadline_unchanged: true,
  });
}, 30000);

it.each([199, 200, 201])(
  "enforces the current PDF page ceiling at %s without calling an OCR engine or declaring valid oversized input corrupt",
  async (pages) => {
    const o = await opportunity();
    const document = await h.f.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: o.id,
      original_name: "synthetic-page-boundary.pdf",
      mime_type: "application/pdf",
      size: 100,
      hash: "d".repeat(64),
    });
    // This is the server page-count admission boundary, after the real PDF parser
    // supplies a count. Parser/native-engine quality is a separate frozen corpus.
    const result = h.rpc("verify_document_pages", {
      document_id: document.id,
      actual_pages: pages,
    });
    if (pages > 200) {
      await expect(result).rejects.toMatchObject({
        code: "PACKAGE_PAGE_CAP_REACHED",
      });
      expect(
        (
          await h.f.db.query<any>(
            "select pdf_pages from public.documents where id=$1",
            [document.id],
          )
        ).rows[0].pdf_pages,
      ).toBeNull();
    } else {
      await result;
      expect(
        (
          await h.f.db.query<any>(
            "select pdf_pages from public.documents where id=$1",
            [document.id],
          )
        ).rows[0].pdf_pages,
      ).toBe(pages);
    }
    expect(
      (
        await h.f.db.query<any>(
          "select count(*)::int n from public.document_ocr_requests",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await h.f.db.query<any>(
          "select count(*)::int n from public.provider_usage",
        )
      ).rows[0].n,
    ).toBe(0);
    capacityChecks.push({
      name: `pdf_page_admission_${pages}`,
      passed: true,
      accepted: pages <= 200,
      native_engine_exercised: false,
    });
  },
);

const capacityMeasurements: Record<string, unknown>[] = [];
it.each([
  {
    name: "dense-authored",
    tables: 20,
    short: false,
    empty: false,
    ragged: false,
    sparse: false,
    minimal: false,
  },
  {
    name: "dense-short-authored",
    tables: 100,
    short: true,
    empty: false,
    ragged: false,
    sparse: false,
    minimal: false,
  },
  {
    name: "dense-body-limit-authored",
    tables: 0,
    short: true,
    empty: false,
    ragged: false,
    sparse: false,
    minimal: false,
  },
  {
    name: "dense-empty-body-limit-authored",
    tables: 0,
    short: true,
    empty: true,
    ragged: false,
    sparse: false,
    minimal: false,
  },
  {
    name: "dense-ragged-authored",
    tables: 1,
    short: false,
    empty: false,
    ragged: true,
    sparse: false,
    minimal: false,
  },
  {
    name: "dense-sparse-body-limit-authored",
    tables: 0,
    short: true,
    empty: true,
    ragged: false,
    sparse: true,
    minimal: false,
  },
  {
    name: "dense-minimal-sparse-body-limit-authored",
    tables: 0,
    short: true,
    empty: true,
    ragged: false,
    sparse: true,
    minimal: true,
  },
])(
  "admits and preserves every cell of $name through the actual authorized authoring API and immutable delivery payload",
  async ({
    name,
    tables: targetTables,
    short,
    empty,
    ragged,
    sparse,
    minimal,
  }) => {
    const o = await opportunity(),
      t = h.transport();
    await upload(
      o,
      "The supplier must supply the complete acceptance evidence matrix.",
    );
    const prepared = await h.f.command("delivery.snapshot.prepare", {
      opportunity_id: o.id,
      expected_revision: o.revision,
    });
    const proposal = (
      await h.f.db.query<any>(
        "select delivery_revision from public.proposals where id=$1",
        [prepared.proposal_id],
      )
    ).rows[0];
    const opened = await t.request("proposal-authoring/open", {
      snapshot_id: prepared.id,
      expected_delivery_revision: proposal.delivery_revision,
    });
    expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(
      200,
    );
    const context = (await opened.json()).data;
    const table = (index: number) => ({
      type: "table" as const,
      headers: Array.from({ length: ragged ? 1 : 10 }, (_, col) =>
        minimal ? "" : `Column ${col}`,
      ),
      rows: Array.from({ length: 50 }, (_, row) =>
        sparse
          ? []
          : Array.from({ length: 10 }, (_, col) =>
              empty
                ? ""
                : short
                  ? "S"
                  : `Cell ${index}/${row}/${col}: required acceptance evidence remains pending. مراجعة المصدر مطلوبة.`,
            ),
      ),
    });
    const makeBody = (count: number) => ({
      ...context.revision.body,
      sections: Array.from({ length: Math.ceil(count / 100) }, (_, index) => ({
        key: minimal
          ? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[
              index
            ] || `s${index}`
          : index
            ? `dense-table-${index}`
            : "dense-table",
        title: minimal ? "S" : "Synthetic dense table capacity case",
        volume: minimal ? "shared" : "technical",
        content_blocks: Array.from(
          { length: Math.min(count - index * 100, 100) },
          (_, j) => table(index * 100 + j),
        ),
        requirement_ids: [],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      })),
    });
    const requestSize = (body: ReturnType<typeof makeBody>) =>
      Buffer.byteLength(
        JSON.stringify({ expected_revision: context.session.revision, body }),
      );
    const databaseSize = async (body: ReturnType<typeof makeBody>) =>
      Number(
        (
          await h.f.db.query<any>("select pg_column_size($1::jsonb) bytes", [
            JSON.stringify({
              expected_revision: context.session.revision,
              body,
              session_id: context.session.id,
            }),
          ])
        ).rows[0].bytes,
      );
    let count = targetTables;
    if (count === 0) {
      // Both actual HTTP and JSONB ceilings bound this short-cell fixture family.
      // This is not a claim about every encoding or the global cell maximum.
      let lo = 1,
        hi = 10000;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (
          requestSize(makeBody(mid)) <= 2097152 &&
          (await databaseSize(makeBody(mid))) <= 2097152
        )
          lo = mid;
        else hi = mid - 1;
      }
      count = lo;
      const rejected = await t.request(
        `proposal-authoring/${context.session.id}/save`,
        {
          expected_revision: context.session.revision,
          body: makeBody(count + 1),
        },
      );
      expect(rejected.status).toBe(
        requestSize(makeBody(count + 1)) > 2097152 ? 413 : 422,
      );
      expect(
        Math.max(
          requestSize(makeBody(count + 1)),
          await databaseSize(makeBody(count + 1)),
        ),
      ).toBeGreaterThan(2097152);
    }
    const body = makeBody(count);
    let densityBound: Record<string, unknown> | undefined;
    if (minimal) {
      // For a chosen rendered width, the cheapest legal table either establishes
      // it in empty headers or in one empty-string row. Every other row can be
      // empty; nonempty strings or extra supplied cells only add JSONB bytes.
      const candidates: {
        width: number;
        headerCount: number;
        rowCount: number;
        cells: number;
        table: { type: string; headers: string[]; rows: string[][] };
      }[] = [];
      for (let width = 1; width <= 10; width++)
        for (let rowCount = 0; rowCount <= 50; rowCount++)
          for (let headerCount = 1; headerCount <= width; headerCount++) {
            if (rowCount === 0 && headerCount < width) continue;
            candidates.push({
              width,
              headerCount,
              rowCount,
              cells: width * (rowCount + 1),
              table: {
                type: "table",
                headers: Array(headerCount).fill(""),
                rows: Array.from({ length: rowCount }, (_, row) =>
                  row === 0 && headerCount < width ? Array(width).fill("") : [],
                ),
              },
            });
          }
      const costs = (
        await h.f.db.query<{ ordinal: number; bytes: number }>(
          "select ordinality::int ordinal,pg_column_size(value)::int bytes from jsonb_array_elements($1::jsonb) with ordinality",
          [JSON.stringify(candidates.map((candidate) => candidate.table))],
        )
      ).rows;
      const best = costs.reduce((best, entry) =>
        candidates[entry.ordinal - 1].cells * best.bytes >
        candidates[best.ordinal - 1].cells * entry.bytes
          ? entry
          : best,
      );
      const winner = candidates[best.ordinal - 1];
      expect(winner).toMatchObject({
        width: 10,
        headerCount: 10,
        rowCount: 50,
        cells: 510,
      });
      // A JSONB array's four-byte entry replaces the standalone datum's four-byte
      // length header. Confirm additivity/alignment in an actual body before
      // using the best single-table ratio as a conservative whole-input bound.
      expect(
        (await databaseSize(makeBody(100))) -
          (await databaseSize(makeBody(99))),
      ).toBe(best.bytes);
      expect(await databaseSize(body)).toBeGreaterThanOrEqual(
        count * best.bytes,
      );
      const upper = Math.floor((2097152 * winner.cells) / best.bytes);
      expect(count * 510).toBeLessThanOrEqual(upper);
      expect(Object.keys(context.revision.body).sort()).toEqual([
        "confirmed_shared_decisions",
        "fulfillment",
        "pending_inputs",
        "requirements",
        "reuse",
        "sections",
        "version",
      ]);
      const fixedBytes = await databaseSize(makeBody(0));
      const sectionBytes =
        (await databaseSize(makeBody(1))) - fixedBytes - best.bytes;
      expect(
        (await databaseSize(makeBody(101))) -
          (await databaseSize(makeBody(100))),
      ).toBe(sectionBytes + best.bytes);
      let low = 0,
        high = 100 * 100 * 51 * 10;
      while (low < high) {
        const cells = Math.ceil((low + high) / 2);
        const minimumBytes =
          fixedBytes +
          sectionBytes * Math.ceil(cells / (100 * winner.cells)) +
          Math.ceil((cells * best.bytes) / winner.cells);
        if (minimumBytes <= 2097152) low = cells;
        else high = cells - 1;
      }
      expect(count * 510).toBeLessThanOrEqual(low);
      densityBound = {
        candidate_shapes_measured: candidates.length,
        best_width: winner.width,
        best_header_count: winner.headerCount,
        best_rows: winner.rowCount,
        best_table_jsonb_bytes: best.bytes,
        best_table_normalized_cells: winner.cells,
        conservative_normalized_cell_upper_bound: upper,
        minimum_fixed_input_bytes: fixedBytes,
        minimum_section_overhead_bytes: sectionBytes,
        conservative_cell_bound_with_required_wrappers: low,
        accepted_full_table_fixture_gap_to_bound: low - count * 510,
        full_table_fixture_normalized_cells: count * 510,
        schema_only_normalized_cell_bound: 100 * 100 * 51 * 10,
        scope:
          "normalized table cells under current authoring JSONB/schema limits; excludes prose bytes and does not prove runtime latency",
      };
    }
    const tables = body.sections.flatMap(
      (section: { content_blocks: ReturnType<typeof table>[] }) =>
        section.content_blocks,
    );
    const saved = await t.request(
      `proposal-authoring/${context.session.id}/save`,
      {
        expected_revision: context.session.revision,
        body,
      },
    );
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const value = (await saved.json()).data;
    expect(
      value.revision.body.sections.flatMap(
        (section: any) => section.content_blocks,
      ),
    ).toEqual(tables);
    const snapshot = value.published_snapshot;
    expect(snapshot.payload).toMatchObject({
      version: 2,
      substantive_complete: false,
      assurance_state: "unreviewed",
    });
    const persisted = (
      await h.f.db.query<any>(
        "select payload from public.proposal_delivery_snapshots where id=$1",
        [snapshot.id],
      )
    ).rows[0];
    expect(
      persisted.payload.sections
        .filter((section: any) =>
          body.sections.some(
            (candidate: any) => candidate.key === section.section_key,
          ),
        )
        .flatMap((section: any) => section.content_blocks),
    ).toEqual(tables);
    const model = buildDeliveryExport(snapshot, "combined");
    const projected = model.blocks.filter((block) => block.type === "table");
    expect(projected).toEqual(tables);
    expect(projected.flatMap((block) => block.rows.flat())).toHaveLength(
      sparse ? 0 : count * 500,
    );
    expect(t.backend.storeDeliveryObject).not.toHaveBeenCalled();
    const encoded = JSON.stringify(model);
    const measurement = {
      name,
      tables: count,
      http_request_bytes: requestSize(body),
      http_request_limit_bytes: 2097152,
      database_input_bytes: await databaseSize(body),
      database_input_limit_bytes: 2097152,
      one_more_table_rejected: targetTables === 0,
      rows_per_table: 50,
      columns: 10,
      cells: sparse ? 0 : count * 500,
      implicit_data_cell_positions: sparse ? count * 500 : 0,
      explicit_rows: count * 50,
      expected_normalized_cells_including_headers: count * 510,
      authored_row_arrays_preserved: true,
      sparse_rows: sparse,
      minimal_section_and_header_text: minimal,
      ...(densityBound ? { density_bound: densityBound } : {}),
      cell_text: empty ? "empty" : short ? "one-character" : "mixed-language",
      authored_cells_preserved: true,
      accepted_by_actual_api: true,
      persisted_delivery_version: 2,
      model_input_bytes: Buffer.byteLength(encoded),
      model_input_hash: createHash("sha256").update(encoded).digest("hex"),
      rendering_proven_by_this_case: ragged,
      ragged_input: ragged,
    };
    const directory = process.env.TENDERDESK_CAPACITY_MODELS;
    if (directory) {
      if (!directory.startsWith("/workspace/output/"))
        throw Error("Synthetic model path must be under /workspace/output");
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/${name}.json`, encoded);
      await writeFile(
        `${directory}/${name}.snapshot.json`,
        JSON.stringify(snapshot),
      );
    }
    if (ragged) {
      const bytes = new Uint8Array(
        await (await renderDocx(model, h.fonts)).arrayBuffer(),
      );
      await deliveryBytes(bytes, model);
    }
    capacityMeasurements.push(measurement);
  },
  30000,
);
it.each([
  { name: "dense-paragraph-authored", directional: false },
  { name: "dense-direction-runs-authored", directional: true },
])(
  "admits and preserves $name through the actual API and immutable render projection",
  async ({ name, directional }) => {
    const o = await opportunity(),
      t = h.transport();
    await upload(
      o,
      "The supplier must preserve every supplied implementation paragraph.",
    );
    const prepared = await h.f.command("delivery.snapshot.prepare", {
      opportunity_id: o.id,
      expected_revision: o.revision,
    });
    const proposal = (
      await h.f.db.query<any>(
        "select delivery_revision from public.proposals where id=$1",
        [prepared.proposal_id],
      )
    ).rows[0];
    const opened = await t.request("proposal-authoring/open", {
      snapshot_id: prepared.id,
      expected_delivery_revision: proposal.delivery_revision,
    });
    expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(
      200,
    );
    const context = (await opened.json()).data;
    let sections = Array.from({ length: 100 }, (_, section) => ({
      key: `density-paragraph-${section}`,
      title: `Synthetic paragraph section ${section}`,
      volume: "technical",
      content_blocks: Array.from({ length: 100 }, (_, paragraph) => ({
        type: "paragraph",
        text: `Synthetic capacity paragraph ${section}/${paragraph}.`,
      })),
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    }));
    let directionalParagraphs = 0;
    if (directional) {
      const directionSections = (count: number) => [
        {
          key: "density-paragraph-direction",
          title: "Alternating Arabic and Latin text",
          volume: "technical",
          content_blocks: Array.from({ length: count }, (_, paragraph) => {
            const prefix = `Direction ${paragraph}: `;
            return {
              type: "paragraph",
              text: (prefix + "aب".repeat(10000)).slice(0, 20000),
            };
          }),
          requirement_ids: [],
          evidence_refs: [],
          company_claims: [],
          assumptions: [],
          questions: [],
        },
      ];
      const directionInput = (count: number) => ({
        expected_revision: context.session.revision,
        body: { ...context.revision.body, sections: directionSections(count) },
      });
      const directionBytes = async (count: number) =>
        Number(
          (
            await h.f.db.query<any>("select pg_column_size($1::jsonb) bytes", [
              JSON.stringify({
                ...directionInput(count),
                session_id: context.session.id,
              }),
            ])
          ).rows[0].bytes,
        );
      let low = 1,
        high = 100;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          Buffer.byteLength(JSON.stringify(directionInput(middle))) <=
            2097152 &&
          (await directionBytes(middle)) <= 2097152
        )
          low = middle;
        else high = middle - 1;
      }
      directionalParagraphs = low;
      expect(low).toBeLessThan(100);
      const rejected = await t.request(
        `proposal-authoring/${context.session.id}/save`,
        directionInput(low + 1),
      );
      expect(rejected.status).toBe(
        Buffer.byteLength(JSON.stringify(directionInput(low + 1))) > 2097152
          ? 413
          : 422,
      );
      sections = directionSections(low);
      expect(
        sections[0].content_blocks.every(
          (paragraph) => Array.from(paragraph.text).length === 20000,
        ),
      ).toBe(true);
    }
    const input = {
      expected_revision: context.session.revision,
      body: { ...context.revision.body, sections },
    };
    const saved = await t.request(
      `proposal-authoring/${context.session.id}/save`,
      input,
    );
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const value = (await saved.json()).data;
    expect(value.revision.body.sections).toEqual(sections);
    const snapshot = value.published_snapshot;
    expect(snapshot.payload).toMatchObject({
      version: 2,
      substantive_complete: false,
      assurance_state: "unreviewed",
    });
    const expected = sections.flatMap((section) => section.content_blocks);
    if (directional)
      expect(new Set(expected.map((paragraph) => paragraph.text)).size).toBe(
        expected.length,
      );
    const persisted = (
      await h.f.db.query<any>(
        "select payload from public.proposal_delivery_snapshots where id=$1",
        [snapshot.id],
      )
    ).rows[0].payload;
    expect(
      persisted.sections
        .filter((section: any) =>
          section.section_key.startsWith("density-paragraph-"),
        )
        .flatMap((section: any) => section.content_blocks),
    ).toEqual(expected);
    const model = buildDeliveryExport(snapshot, "combined");
    const paragraphs = model.blocks.filter(
      (block) =>
        block.type === "paragraph" &&
        block.text.startsWith(
          directional ? "Direction " : "Synthetic capacity paragraph ",
        ),
    );
    expect(paragraphs).toEqual(expected);
    expect(paragraphs).toHaveLength(
      directional ? directionalParagraphs : 10000,
    );
    expect(t.backend.storeDeliveryObject).not.toHaveBeenCalled();
    const encoded = JSON.stringify(model);
    capacityMeasurements.push({
      name,
      sections: sections.length,
      paragraphs_per_section: directional ? directionalParagraphs : 100,
      paragraphs: directional ? directionalParagraphs : 10000,
      directional_text: directional,
      ...(directional
        ? {
            characters_per_paragraph: 20000,
            total_characters: directionalParagraphs * 20000,
            paragraphs_are_distinct: true,
            next_paragraph_rejected: true,
          }
        : {}),
      http_request_bytes: Buffer.byteLength(JSON.stringify(input)),
      http_request_limit_bytes: 2097152,
      database_input_bytes: Number(
        (
          await h.f.db.query<any>("select pg_column_size($1::jsonb) bytes", [
            JSON.stringify({ ...input, session_id: context.session.id }),
          ])
        ).rows[0].bytes,
      ),
      database_input_limit_bytes: 2097152,
      authored_paragraphs_preserved: true,
      accepted_by_actual_api: true,
      persisted_delivery_version: 2,
      model_input_bytes: Buffer.byteLength(encoded),
      model_input_hash: createHash("sha256").update(encoded).digest("hex"),
      rendering_proven_by_this_case: false,
    });
    const directory = process.env.TENDERDESK_CAPACITY_MODELS;
    if (directory) {
      if (!directory.startsWith("/workspace/output/"))
        throw Error("Synthetic model path must be under /workspace/output");
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/${name}.json`, encoded);
      await writeFile(
        `${directory}/${name}.snapshot.json`,
        JSON.stringify(snapshot),
      );
    }
  },
  30000,
);
afterAll(async () => {
  const destination = process.env.TENDERDESK_CAPACITY_RECEIPT;
  if (!destination) return;
  if (!destination.startsWith("/workspace/output/"))
    throw Error("Synthetic receipt path must be under /workspace/output");
  await mkdir(dirname(destination), { recursive: true });
  const migrationDirectory = new URL(
    "../../supabase/migrations/",
    import.meta.url,
  );
  const migrationHashes = await Promise.all(
    (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map(async (name) => ({
        name,
        sha256: createHash("sha256")
          .update(await readFile(new URL(name, migrationDirectory)))
          .digest("hex"),
      })),
  );
  const sourceHashes = await capacitySourceHashes();
  expect(sourceHashes).toEqual(sourceHashesBefore);
  await writeFile(
    destination,
    JSON.stringify(
      {
        fixture: "synthetic-only",
        intended_cases: 20,
        completed_cases: capacityChecks.length + capacityMeasurements.length,
        all_cases_passed:
          capacityChecks.length + capacityMeasurements.length === 20,
        scope:
          "local migrated PGlite SQL, actual API handlers, real DOCX renderer; synthetic token and Map-storage adapters",
        model_calls: 0,
        hosted_acceptance: false,
        production_slo_qualified: false,
        measured_at: new Date().toISOString(),
        runtime: process.version,
        load: {
          driver_concurrency: 1,
          model_latency_included: false,
          real_network_storage_latency_included: false,
        },
        configured_limits: {
          extracted_characters_per_document_and_package: 1000000,
          pdf_pages_per_package: 200,
          original_bytes: 10485760,
          artifact_bytes: 10485760,
          shared_storage_bytes: 262144000,
          issuance_seconds_including_queue: 600,
        },
        measurements: capacityMeasurements,
        checks: capacityChecks,
        migrations: migrationHashes,
        source_sha256: sourceHashes,
        source_hashes_stable_through_test_run: true,
      },
      null,
      2,
    ) + "\n",
  );
});
it.each([
  { language: "en", characters: 4000 },
  { language: "en", characters: 100000, mixed: true },
  { language: "ar", characters: 1000000 },
])(
  "measures the local actual source-draft API/DB/render/download path at $characters characters ($language, mixed=$mixed)",
  async ({ language, characters, mixed }) => {
    const t = h.transport(),
      o = await opportunity(language);
    const sentence =
      language === "ar"
        ? "يلتزم المورد بإعداد دليل إجراءات التشغيل؛ ويبقى الاعتماد معلقًا حتى مراجعة النتيجة. "
        : mixed
          ? "Synthetic source: يجب إعداد دليل التشغيل؛ approval remains pending. "
          : "Synthetic scope: prepare an operating manual; approval remains pending. ";
    const text = sentence
      .repeat(Math.ceil(characters / sentence.length))
      .slice(0, characters);
    expect(Array.from(text)).toHaveLength(characters);
    const start = performance.now();
    const document = await upload(o, text);
    const uploadEnd = performance.now();
    const prepared = await t.request("commands", {
      commands: [
        {
          operation: "delivery.snapshot.prepare",
          input: { opportunity_id: o.id, expected_revision: o.revision },
        },
      ],
    });
    expect(prepared.status, JSON.stringify(await prepared.clone().json())).toBe(
      200,
    );
    const snapshot = (await prepared.json()).data[0];
    const prepareEnd = performance.now();
    expect(snapshot.payload.content_state).toBe("source_draft");
    const sourceBlocks = (
      await h.f.db.query<any>(
        "select id,text,locator from public.document_blocks where document_id=$1 order by ordinal",
        [document.id],
      )
    ).rows;
    let frontier = 0;
    for (const block of sourceBlocks) {
      expect(block.locator.start).toBeLessThanOrEqual(frontier + 1);
      expect(snapshot.payload.sections).toContainEqual(
        expect.objectContaining({
          section_key: "source-" + block.id,
          content_blocks: [{ type: "paragraph", text: block.text }],
        }),
      );
      frontier = Math.max(frontier, block.locator.end);
    }
    expect(frontier).toBe(characters);
    const job = await h.rpc("claim_backend_job_v4");
    expect(job).toMatchObject({
      type: "render_delivery",
      entity_id: snapshot.id,
    });
    const claimed = performance.now();
    let renderMs = 0;
    const rendered = await processDeliveryExport(
      t.backend as unknown as Backend,
      job,
      async (model) => {
        const renderStart = performance.now();
        const bytes = new Uint8Array(
          await (await renderDocx(model, h.fonts)).arrayBuffer(),
        );
        renderMs += performance.now() - renderStart;
        return bytes;
      },
    );
    expect(rendered).toMatchObject({ status: "succeeded" });
    const renderEnd = performance.now();
    const saved = (
      await (
        await t.request(`delivery-snapshots/${snapshot.id}/package`)
      ).json()
    ).data;
    expect(saved.status).toBe("ready");
    expect(saved.artifacts).toHaveLength(1);
    const artifact = saved.artifacts[0];
    const downloaded = await t.request(
      `delivery-artifacts/${artifact.id}/download`,
    );
    expect(downloaded.status).toBe(200);
    const model = buildDeliveryExport(snapshot, "combined");
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    expect(await deliveryBytes(bytes, model)).toMatchObject({
      hash: artifact.content_hash,
      size: artifact.expected_size,
    });
    const finished = performance.now();
    expect(
      (
        await h.f.db.query<any>(
          "select count(*)::int n from public.provider_usage",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await h.f.db.query<any>(
          "select extraction_hash from public.documents where id=$1",
          [document.id],
        )
      ).rows[0].extraction_hash,
    ).toBe(document.extraction_hash);
    const measurement = {
      language,
      mixed: mixed ?? false,
      source_characters: characters,
      original_utf8_bytes: Buffer.byteLength(text),
      selected_blocks: sourceBlocks.length,
      source_hash: document.extraction_hash,
      model_input_bytes: Buffer.byteLength(JSON.stringify(model)),
      artifact_bytes: bytes.length,
      artifact_hash: artifact.content_hash,
      upload_ms: Math.round(uploadEnd - start),
      prepare_ms: Math.round(prepareEnd - uploadEnd),
      claim_and_oracle_ms: Math.round(claimed - prepareEnd),
      render_ms: Math.round(renderMs),
      render_store_and_receipt_ms: Math.round(renderEnd - claimed),
      download_and_verify_ms: Math.round(finished - renderEnd),
      total_local_ms: Math.round(finished - start),
      source_inventory_complete: true,
      verified_download: true,
    };
    capacityMeasurements.push(measurement);
    const directory = process.env.TENDERDESK_CAPACITY_MODELS;
    if (directory) {
      if (!directory.startsWith("/workspace/output/"))
        throw Error("Synthetic model path must be under /workspace/output");
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/${language}-${characters}.json`,
        JSON.stringify(model),
      );
    }
  },
  120000,
);
