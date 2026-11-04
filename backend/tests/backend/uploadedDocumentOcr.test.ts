// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  publishUploadedOcr,
  uploadedOcrInput,
} from "../../supabase/functions/_shared/uploadedDocumentOcrGateway.ts";
import { type Backend } from "../../supabase/functions/_shared/backend.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
import { readFile } from "node:fs/promises";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const known = "The buyer requires the handover manual within thirty days.";
const originalText = `[Page 1]\n${known}\n\n[Page 2]\n\n\n[Page 3]\n`;
const coverage = {
  version: 1,
  kind: "pdf_pages",
  complete: false,
  pages: [
    { page: 1, status: "readable", characters: known.length },
    { page: 2, status: "needs_ocr", characters: 0 },
    { page: 3, status: "blank", characters: 0 },
  ],
};
async function setup(originalHash = "a".repeat(64), expectedSize = 100) {
  const source = await f.command("source.create", {
    name: "Synthetic durable uploaded OCR",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic scanned requirements",
    reference: "SYNTHETIC-OCR",
    description: "Implement the attached operating requirements.",
    language: "en",
    decision: "shortlisted",
  });
  const document = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic-mixed.pdf",
    mime_type: "application/pdf",
    size: expectedSize,
    hash: originalHash,
  });
  await f.rpc("verify_document_pages", [document.id, 3]);
  const accepted = await f.rpc("accept_uploaded_document_with_coverage", [
    document.id,
    f.owner,
    originalHash,
    expectedSize,
    originalText,
    "partial",
    "ocr-synthetic-upload",
    JSON.stringify(coverage),
  ]);
  return { opportunity, document: accepted };
}
it("automatically queues only unresolved PDF pages after accepted upload without changing its readable source", async () => {
  const { document } = await setup();
  const task = await f.rpc("claim_uploaded_document_ocr");
  expect(task).toMatchObject({
    action: "page",
    document_id: document.id,
    original_hash: document.original_hash,
    total_pages: 3,
    page: 2,
  });
  const current = (
    await f.db.query<any>(
      "select extracted_text,extraction_hash,extraction_coverage from public.documents where id=$1",
      [document.id],
    )
  ).rows[0];
  expect(current).toEqual({
    extracted_text: originalText,
    extraction_hash: document.extraction_hash,
    extraction_coverage: coverage,
  });
  expect(await f.rpc("claim_uploaded_document_ocr")).toBeNull();
});
async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_failure");
  try {
    return await run();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected_failure");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected_failure;reset role");
  }
}
async function pageResult(
  text = "Submit twelve signed reports within thirty days.",
  confidence = 95,
  numeric_uncertainty = false,
) {
  const text_hash = (
    await f.db.query<any>(
      "select encode(sha256(convert_to($1,'UTF8')),'hex') hash",
      [text],
    )
  ).rows[0].hash;
  return {
    page: 2,
    text,
    confidence,
    image_hash: "b".repeat(64),
    text_hash,
    engine: "tesseract",
    engine_version: "5.3.0",
    languages: ["ara", "eng"],
    numeric_uncertainty,
  };
}
it("persists receipts once, reserves bytes and publishes an immutable successor preserving pages and paid pins", async () => {
  const { document, opportunity } = await setup();
  const oldPlan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const task = await f.rpc("claim_uploaded_document_ocr");
  const receipt = await pageResult();
  const saved = await f.rpc("complete_uploaded_document_ocr_page", [
    task.request_id,
    task.lease,
    JSON.stringify(receipt),
    null,
  ]);
  expect(saved.status).toBe("ready");
  expect(
    await f.rpc("complete_uploaded_document_ocr_page", [
      task.request_id,
      task.lease,
      JSON.stringify(receipt),
      null,
    ]),
  ).toEqual(saved);
  await expect(
    attempt(() =>
      f.rpc("complete_uploaded_document_ocr_page", [
        task.request_id,
        task.lease,
        JSON.stringify({ ...receipt, text: "Changed" }),
        null,
      ]),
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  const publish = await f.rpc("claim_uploaded_document_ocr");
  expect(publish.action).toBe("publish");
  const reservation = await f.rpc("prepare_uploaded_document_ocr_publication", [
    publish.request_id,
    publish.lease,
  ]);
  expect(reservation).toMatchObject({
    original_hash: document.original_hash,
    expected_size: 100,
  });
  expect(
    (
      await f.db.query<any>("select app_private.storage_reserved_bytes($1) n", [
        f.w,
      ])
    ).rows[0].n,
  ).toBe(200);
  expect(
    (
      await f.db.query<any>(
        "select app_private.current_document_extraction($1,$2) id",
        [f.w, document.id],
      )
    ).rows[0].id,
  ).toBe(document.id);
  expect(
    await f.rpc("prepare_uploaded_document_ocr_publication", [
      publish.request_id,
      publish.lease,
    ]),
  ).toEqual(reservation);
  const child = await f.rpc("complete_uploaded_document_ocr_publication", [
    publish.request_id,
    publish.lease,
    document.original_hash,
    100,
  ]);
  expect(child).toMatchObject({
    status: "ready",
    ocr_parent_document_id: document.id,
    original_hash: document.original_hash,
    extraction_confirmed_at: null,
  });
  expect(child.extracted_text).toContain(known);
  expect(child.extracted_text).toContain(receipt.text);
  expect(child.extracted_text.indexOf(known)).toBeLessThan(
    child.extracted_text.indexOf(receipt.text),
  );
  expect(child.extraction_coverage).toMatchObject({
    complete: true,
    pages: [
      coverage.pages[0],
      { page: 2, status: "readable", characters: receipt.text.length },
      coverage.pages[2],
    ],
  });
  expect(child.ocr_provenance.pages[1]).toMatchObject({
    image_hash: receipt.image_hash,
    text_hash: receipt.text_hash,
    requires_human_review: true,
  });
  expect(
    (
      await f.db.query<any>(
        "select app_private.current_document_extraction($1,$2) id",
        [f.w, document.id],
      )
    ).rows[0].id,
  ).toBe(child.id);
  const parent = (
    await f.db.query<any>("select * from public.documents where id=$1", [
      document.id,
    ])
  ).rows[0];
  expect(parent.revision).toBeGreaterThan(document.revision);
  expect(parent).toMatchObject({
    extracted_text: document.extracted_text,
    extraction_hash: document.extraction_hash,
    ocr_successor_id: child.id,
  });
  expect(
    await f.rpc("complete_uploaded_document_ocr_publication", [
      publish.request_id,
      publish.lease,
      document.original_hash,
      100,
    ]),
  ).toEqual(child);
  await assertPriorPinned(opportunity.id, oldPlan);
  const current = (
    await f.db.query<any>(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,null) data",
      [f.w, opportunity.id, oldPlan.proposal_id, oldPlan.package_id],
    )
  ).rows[0].data;
  expect(current.blocks.some((b: any) => b.document_id === child.id)).toBe(
    true,
  );
  expect(current.blocks.some((b: any) => b.document_id === document.id)).toBe(
    false,
  );
  const hasAuthority = (
    await f.db.query<any>(
      "select to_regprocedure('public.source_review_context(uuid)') is not null present",
    )
  ).rows[0].present;
  if (hasAuthority) {
    const sourceReview = await f.rpc("source_review_context", [opportunity.id]);
    expect(
      sourceReview.sources.some((s: any) => s.reference.entity_id === child.id),
    ).toBe(true);
    expect(
      sourceReview.sources.some(
        (s: any) => s.reference.entity_id === document.id,
      ),
    ).toBe(false);
    expect(
      sourceReview.sources.find((s: any) => s.reference.entity_id === child.id)
        .authority,
    ).not.toMatchObject({ role: "buyer_requirement", confirmed: true });
  }

  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
});
it.each([
  [45, false],
  [95, true],
])(
  "keeps uncertain OCR out of readable evidence (confidence %s numeric uncertainty %s)",
  async (confidence, numeric) => {
    const { document } = await setup();
    const task = await f.rpc("claim_uploaded_document_ocr");
    const result = await pageResult(
      "Supply 12 reports.",
      Number(confidence),
      Boolean(numeric),
    );
    expect(
      (
        await f.rpc("complete_uploaded_document_ocr_page", [
          task.request_id,
          task.lease,
          JSON.stringify(result),
          null,
        ])
      ).status,
    ).toBe("needs_review");
    expect(await f.rpc("claim_uploaded_document_ocr")).toBeNull();
    expect(
      (
        await f.db.query<any>(
          "select ocr_status,ocr_successor_id,extracted_text from public.documents where id=$1",
          [document.id],
        )
      ).rows[0],
    ).toEqual({
      ocr_status: "needs_review",
      ocr_successor_id: null,
      extracted_text: document.extracted_text,
    });
  },
);
async function assertPriorPinned(opportunityId: string, plan: any) {
  const evaluate = () =>
    f.db.query<any>(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,$5::jsonb) data",
      [
        f.w,
        opportunityId,
        plan.proposal_id,
        plan.package_id,
        JSON.stringify(plan.frozen_context),
      ],
    );
  if (plan.frozen_context.source_contract_version === 1) {
    // W05 adds a stricter current-source admission contract. Stale paid pins
    // must remain immutable and refuse continuation, never adopt the successor.
    await expect(attempt(evaluate)).rejects.toThrow("SOURCE_SPAN_STALE");
    expect(
      (
        await f.db.query<any>(
          "select frozen_context from public.generation_plans where id=$1",
          [plan.id],
        )
      ).rows[0].frozen_context,
    ).toEqual(plan.frozen_context);
  } else expect((await evaluate()).rows[0].data).toEqual(plan.frozen_context);
}
async function sha(text: string) {
  return (
    await f.db.query<any>(
      "select encode(sha256(convert_to($1,'UTF8')),'hex') hash",
      [text],
    )
  ).rows[0].hash;
}
async function reviewed(
  document: any,
  text = "Corrected full source paragraph.",
) {
  return {
    id: document.id,
    expected_revision: document.revision,
    expected_original_hash: document.original_hash,
    expected_extraction_hash: document.extraction_hash,
    review_confirmed: true,
    pages: await Promise.all(
      [
        { page: 1, old: known, text: known },
        { page: 2, old: "", text },
        { page: 3, old: "", text: "" },
      ].map(async (p) => ({
        page: p.page,
        expected_page_text_hash: await sha(p.old),
        text: p.text,
        blank_confirmed: !p.text,
      })),
    ),
  };
}
async function publish() {
  const task = await f.rpc("claim_uploaded_document_ocr");
  expect(task.action).toBe("publish");
  const reservation = await f.rpc("prepare_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
  ]);
  const child = await f.rpc("complete_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
    reservation.original_hash,
    reservation.expected_size,
  ]);
  return { task, reservation, child };
}
it("publishes corrected full-page text plus explicitly reviewed blank as an immutable confirmed successor; cancels old lease", async () => {
  const { document } = await setup();
  const old = await f.rpc("claim_uploaded_document_ocr");
  const input = await reviewed(document);
  const key = crypto.randomUUID();
  const accepted = await f.command("document.extraction.correct", input, key);
  expect(await f.command("document.extraction.correct", input, key)).toEqual(
    accepted,
  );
  await expect(
    attempt(async () =>
      f.rpc("complete_uploaded_document_ocr_page", [
        old.request_id,
        old.lease,
        JSON.stringify(await pageResult()),
        null,
      ]),
    ),
  ).rejects.toThrow("STALE_LEASE");
  const { child } = await publish();
  expect(child).toMatchObject({
    extraction_version: "human-v1",
    ocr_parent_document_id: document.id,
    extraction_confirmed_by: f.owner,
    status: "ready",
  });
  expect(child.extraction_confirmed_at).toBeTruthy();
  expect(child.extracted_text).toContain("Corrected full source paragraph.");
  expect(child.ocr_provenance).toMatchObject({
    requires_human_review: false,
    pages: [
      { page: 1, engine: "human", confidence: null, reviewed_by: f.owner },
      { page: 2, engine: "human", confidence: null, reviewed_by: f.owner },
      { page: 3, blank_confirmed: true, reviewed_by: f.owner },
    ],
  });
  const parent = (
    await f.db.query<any>(
      "select extracted_text,extraction_hash from public.documents where id=$1",
      [document.id],
    )
  ).rows[0];
  expect(parent).toEqual({
    extracted_text: document.extracted_text,
    extraction_hash: document.extraction_hash,
  });
  const view = await f.rpc("uploaded_document_extraction", [child.id]);
  expect(view.pages.every((p: any) => p.requires_review === false)).toBe(true);
  expect(await f.command("document.extraction.correct", input, key)).toEqual(
    accepted,
  );
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='document.extraction.correct'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("partial human review keeps remaining OCR/native/blank pages unconfirmed and old confirmation command cannot bypass", async () => {
  const { document } = await setup();
  const input = await reviewed(document);
  input.pages = input.pages.filter((p) => p.page === 2);
  await f.command("document.extraction.correct", input);
  const { child } = await publish();
  expect(child.extraction_confirmed_at).toBeNull();
  expect(child.ocr_provenance.requires_human_review).toBe(true);
  expect(child.ocr_provenance.pages[2]).toMatchObject({
    page: 3,
    origin: "blank",
    requires_human_review: true,
  });
  await expect(
    f.command("document.confirm", {
      id: child.id,
      expected_revision: child.revision,
    }),
  ).rejects.toThrow("DOCUMENT_PAGE_REVIEW_REQUIRED");
});
it.each(["revision", "original", "extraction", "page", "duplicate", "blank"])(
  "rejects stale or ambiguous human correction binding: %s",
  async (kind) => {
    const { document } = await setup();
    const input = await reviewed(document);
    if (kind === "revision") input.expected_revision++;
    if (kind === "original") input.expected_original_hash = "b".repeat(64);
    if (kind === "extraction") input.expected_extraction_hash = "b".repeat(64);
    if (kind === "page")
      input.pages[0].expected_page_text_hash = "b".repeat(64);
    if (kind === "duplicate") input.pages.push(input.pages[0]);
    if (kind === "blank") input.pages[2].blank_confirmed = false;
    await expect(
      f.command("document.extraction.correct", input),
    ).rejects.toThrow(/REVISION_CONFLICT|STALE_INPUT|INVALID_INPUT/);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.document_ocr_requests where engine_policy=2",
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
it("never qualifies Arabic from mean confidence or numeric certainty; preserves candidate for source correction", async () => {
  const { document } = await setup();
  const task = await f.rpc("claim_uploaded_document_ocr");
  // Regression signal from frozen actual scan: confidence 82/numeric false
  // coexisted with omitted obligation and damaged prohibition. Confidence cannot
  // certify Arabic semantics, regardless of worker-supplied classification.
  const actual = JSON.parse(
    await readFile(
      new URL("./fixtures/uploaded-ocr-ar-failure.json", import.meta.url),
      "utf8",
    ),
  );
  const candidate = await pageResult(
    actual.text,
    actual.confidence,
    actual.numeric_uncertainty,
  );
  expect(candidate.text_hash).toBe(actual.text_sha256);
  expect(
    (
      await f.rpc("complete_uploaded_document_ocr_page", [
        task.request_id,
        task.lease,
        JSON.stringify(candidate),
        null,
      ])
    ).status,
  ).toBe("needs_review");
  expect(await f.rpc("claim_uploaded_document_ocr")).toBeNull();
  const view = await f.rpc("uploaded_document_extraction", [document.id]);
  expect(view.pages[1]).toMatchObject({
    text: "",
    candidate_text: candidate.text,
    requires_review: true,
  });
  expect(view.ocr.status).toBe("needs_review");
});
it("restart reclaims only expired page lease and rejects late completion without discarding saved readable text", async () => {
  const { document } = await setup();
  const old = await f.rpc("claim_uploaded_document_ocr");
  await f.db.query(
    "update public.document_ocr_requests set lease_until=now()-interval '1 second' where id=$1",
    [old.request_id],
  );
  const next = await f.rpc("claim_uploaded_document_ocr");
  expect(next.page).toBe(2);
  expect(next.lease).not.toBe(old.lease);
  await expect(
    attempt(async () =>
      f.rpc("complete_uploaded_document_ocr_page", [
        old.request_id,
        old.lease,
        JSON.stringify(await pageResult()),
        null,
      ]),
    ),
  ).rejects.toThrow("STALE_LEASE");
  expect(
    (
      await f.db.query<any>(
        "select extracted_text from public.documents where id=$1",
        [document.id],
      )
    ).rows[0].extracted_text,
  ).toBe(originalText);
});
it("membership revocation between reservation and publication retains parent and pending bytes, never publishes", async () => {
  const { document } = await setup();
  await f.command("document.extraction.correct", await reviewed(document));
  const task = await f.rpc("claim_uploaded_document_ocr");
  const reservation = await f.rpc("prepare_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
  ]);
  await f.db.query(
    "update public.memberships set active=false where user_id=$1",
    [f.owner],
  );
  await expect(
    attempt(() =>
      f.rpc("complete_uploaded_document_ocr_publication", [
        task.request_id,
        task.lease,
        document.original_hash,
        100,
      ]),
    ),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  expect(
    (
      await f.db.query<any>(
        "select ocr_successor_id from public.documents where id=$1",
        [document.id],
      )
    ).rows[0].ocr_successor_id,
  ).toBeNull();
  expect(
    (
      await f.db.query<any>("select status from public.documents where id=$1", [
        reservation.successor_id,
      ])
    ).rows[0].status,
  ).toBe("pending");
  expect(
    (
      await f.db.query<any>("select app_private.storage_reserved_bytes($1) n", [
        f.w,
      ])
    ).rows[0].n,
  ).toBe(200);
});
it("expiry cleans only unpublished child reservation; retried publication reserves a fresh immutable key", async () => {
  const { document } = await setup();
  await f.command("document.extraction.correct", await reviewed(document));
  const task = await f.rpc("claim_uploaded_document_ocr");
  const old = await f.rpc("prepare_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
  ]);
  await f.db.query(
    "update public.documents set created_at=now()-interval '25 hours' where id=$1",
    [old.successor_id],
  );
  await f.rpc("maintenance_tick");
  expect(
    (
      await f.db.query<any>(
        "select archived from public.documents where id=$1",
        [document.id],
      )
    ).rows[0].archived,
  ).toBe(false);
  const current = await f.rpc("prepare_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
  ]);
  expect(current.successor_id).not.toBe(old.successor_id);
  expect(current.destination_key).not.toBe(old.destination_key);
  expect(
    (
      await f.db.query<any>("select app_private.storage_reserved_bytes($1) n", [
        f.w,
      ])
    ).rows[0].n,
  ).toBe(300);
});
it("archiving published child removes its source family, while parent-only purge cannot orphan child history", async () => {
  const { document } = await setup();
  await f.command("document.extraction.correct", await reviewed(document));
  const { child } = await publish();
  await expect(
    attempt(() =>
      f.db.query("delete from public.documents where id=$1", [document.id]),
    ),
  ).rejects.toThrow(/foreign key/);
  await f.command("document.archive", {
    id: child.id,
    expected_revision: child.revision,
    reason: "Synthetic archive family",
  });
  expect(
    (
      await f.db.query<any>(
        "select bool_and(archived) all_archived from public.documents",
      )
    ).rows[0].all_archived,
  ).toBe(true);
});
it("SQL-backed gateway rechecks original bytes and current access, resolves lost copy reply and duplicate publication without overwrite", async () => {
  const bytes = new Blob(["%PDF-synthetic isolated storage transport"]);
  const hash = await sha(await bytes.text());
  const { document } = await setup(hash, bytes.size);
  const stored = new Map<string, Blob>([[document.storage_key, bytes]]);
  let copies = 0;
  let revokeAfterRead = false;
  const backend = {
    internal: async (name: string, args: Record<string, unknown>) => {
      try {
        return (
          await f.db.query<any>(
            `select public.${name}(${Object.keys(args)
              .map((key, i) => `${key}=>$${i + 1}`)
              .join(",")}) data`,
            Object.values(args),
          )
        ).rows[0].data;
      } catch (e) {
        throw new AppError(
          409,
          e instanceof Error ? e.message : "FAILED",
          "Synthetic SQL rejected operation",
        );
      }
    },
    deliveryObject: async (key: string) => {
      const result = stored.get(key) ?? null;
      if (revokeAfterRead)
        await f.db.query(
          "update public.memberships set active=false where user_id=$1",
          [f.owner],
        );
      return result;
    },
    copyOriginalForOcr: async (source: string, destination: string) => {
      copies++;
      expect(stored.has(destination)).toBe(false);
      stored.set(destination, stored.get(source)!);
      throw Error("Synthetic lost copy reply");
    },
  } as unknown as Backend;
  const task = await f.rpc("claim_uploaded_document_ocr");
  const input = await uploadedOcrInput(backend, task.request_id, task.lease);
  expect(Buffer.from(input.bytes, "base64").toString()).toBe(
    await bytes.text(),
  );
  await f.rpc("complete_uploaded_document_ocr_page", [
    task.request_id,
    task.lease,
    JSON.stringify(await pageResult()),
    null,
  ]);
  const publication = await f.rpc("claim_uploaded_document_ocr");
  const child = await publishUploadedOcr(
    backend,
    publication.request_id,
    publication.lease,
  );
  expect(child.status).toBe("ready");
  expect(copies).toBe(1);
  expect(
    await publishUploadedOcr(
      backend,
      publication.request_id,
      publication.lease,
    ),
  ).toEqual(child);
  expect(copies).toBe(1);
  // A fresh source read is denied after the storage-read boundary, not returned
  // to a native worker on the strength of the first authorization alone.
  const next = await setup(hash, bytes.size);
  stored.set(next.document.storage_key, bytes);
  const read = await f.rpc("claim_uploaded_document_ocr");
  revokeAfterRead = true;
  await expect(
    attempt(() => uploadedOcrInput(backend, read.request_id, read.lease)),
  ).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
});
it("reserved successor stays hidden and cannot be finalized by the ordinary upload path", async () => {
  const { document, opportunity } = await setup();
  await f.command("document.extraction.correct", await reviewed(document));
  const task = await f.rpc("claim_uploaded_document_ocr");
  const pending = await f.rpc("prepare_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
  ]);
  const input = (
    await f.db.query<any>("select app_private.delivery_input($1,$2) data", [
      f.w,
      opportunity.id,
    ])
  ).rows[0].data;
  expect(
    input.input_materials.documents.map((d: any) => d.document_id),
  ).toEqual([document.id]);
  await expect(
    attempt(() =>
      f.rpc("accept_uploaded_document", [
        pending.successor_id,
        f.owner,
        document.original_hash,
        100,
        originalText,
        "partial",
        "synthetic-forged-child",
      ]),
    ),
  ).rejects.toThrow("OCR_PUBLICATION_REQUIRED");
});
it("combined physical capacity is reserved atomically before copying; failure keeps parent and recoverable request", async () => {
  const { document } = await setup();
  await f.command("document.extraction.correct", await reviewed(document));
  const task = await f.rpc("claim_uploaded_document_ocr");
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic/capacity',262143850,'Synthetic OCR cap test')",
    [f.w],
  );
  await expect(
    attempt(() =>
      f.rpc("prepare_uploaded_document_ocr_publication", [
        task.request_id,
        task.lease,
      ]),
    ),
  ).rejects.toThrow("STORAGE_CAP_REACHED");
  expect(
    (await f.db.query<any>("select count(*)::int n from public.documents"))
      .rows[0].n,
  ).toBe(1);
  await f.rpc("fail_uploaded_document_ocr_publication", [
    task.request_id,
    task.lease,
    "STORAGE_CAP_REACHED",
  ]);
  expect(
    (
      await f.db.query<any>(
        "select status,error_code from public.document_ocr_requests where id=$1",
        [task.request_id],
      )
    ).rows[0],
  ).toEqual({ status: "retry_wait", error_code: "STORAGE_CAP_REACHED" });
  expect(
    (
      await f.db.query<any>(
        "select ocr_successor_id,extracted_text from public.documents where id=$1",
        [document.id],
      )
    ).rows[0],
  ).toEqual({ ocr_successor_id: null, extracted_text: originalText });
});
it("page status is authenticated metadata and service claim/completion remain inaccessible to browser roles", async () => {
  const { document } = await setup();
  await f.db.exec("set role authenticated");
  expect(
    (await f.rpc("uploaded_document_ocr_status", [document.id])).document_id,
  ).toBe(document.id);
  await expect(
    attempt(() => f.rpc("claim_uploaded_document_ocr")),
  ).rejects.toThrow("permission denied");
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    crypto.randomUUID(),
  ]);
  await expect(
    attempt(() => f.rpc("uploaded_document_extraction", [document.id])),
  ).rejects.toThrow(/ROLE_FORBIDDEN|MEMBERSHIP_REQUIRED/);
});
it("explicit retry recovers legacy image-only PDF without coverage by deriving unresolved pages, never rewriting the old blank hash", async () => {
  const source = await f.command("source.create", {
    name: "Synthetic legacy scan",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic old scan",
    reference: "SYNTHETIC-OLD",
    language: "en",
  });
  const pending = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "old.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("verify_document_pages", [pending.id, 2]);
  const document = await f.rpc("accept_uploaded_document", [
    pending.id,
    f.owner,
    "a".repeat(64),
    100,
    "",
    "needs_ocr",
    "legacy-scan",
  ]);
  await f.command("document.ocr.retry", {
    id: document.id,
    expected_revision: document.revision,
  });
  const task = await f.rpc("claim_uploaded_document_ocr");
  expect(task).toMatchObject({ page: 1, total_pages: 2 });
  const view = await f.rpc("uploaded_document_extraction", [document.id]);
  expect(view.pages.map((p: any) => [p.page, p.status, p.text])).toEqual([
    [1, "needs_ocr", ""],
    [2, "needs_ocr", ""],
  ]);
  expect(
    (
      await f.db.query<any>(
        "select extracted_text,extraction_hash,extraction_coverage from public.documents where id=$1",
        [document.id],
      )
    ).rows[0],
  ).toEqual({
    extracted_text: "",
    extraction_hash: await sha(""),
    extraction_coverage: null,
  });
});
it("filters retained extraction families before context caps while preserving the exact earlier paid source selection", async () => {
  const source = await f.command("source.create", {
    name: "Synthetic retained family capacity",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic large source",
    reference: "SYNTHETIC-LARGE",
    language: "en",
    decision: "shortlisted",
  });
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "large.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("verify_document_pages", [prepared.id, 2]);
  const pageOne = "Source statement. ".repeat(50000);
  let pageTwo = "Initial source page.";
  const text = `[Page 1]\n${pageOne}\n\n[Page 2]\n${pageTwo}\n`;
  const largeCoverage = {
    version: 1,
    kind: "pdf_pages",
    complete: true,
    pages: [
      { page: 1, status: "readable", characters: pageOne.trim().length },
      { page: 2, status: "readable", characters: pageTwo.length },
    ],
  };
  let current = await f.rpc("accept_uploaded_document_with_coverage", [
    prepared.id,
    f.owner,
    "a".repeat(64),
    100,
    text,
    "ready",
    "large-upload",
    JSON.stringify(largeCoverage),
  ]);
  const initial = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  for (let i = 0; i < 10; i++) {
    const replacement = `Reviewed second source page revision ${i}.`;
    await f.command("document.extraction.correct", {
      id: current.id,
      expected_revision: current.revision,
      expected_original_hash: current.original_hash,
      expected_extraction_hash: current.extraction_hash,
      review_confirmed: true,
      pages: [
        {
          page: 2,
          expected_page_text_hash: await sha(pageTwo),
          text: replacement,
          blank_confirmed: false,
        },
      ],
    });
    current = (await publish()).child;
    pageTwo = replacement;
  }
  const result = (
    await f.db.query<any>(
      `select app_private.draft_generation_snapshot($1,$2,$3,$4,null) fresh`,
      [f.w, opportunity.id, initial.proposal_id, initial.package_id],
    )
  ).rows[0];
  await assertPriorPinned(opportunity.id, initial);
  expect(new Set(result.fresh.blocks.map((b: any) => b.document_id))).toEqual(
    new Set([current.id]),
  );
}, 30000);
it.each(["native", "human"])(
  "restores %s receipts without active leases or inherited review authority and requires a current actor",
  async (kind) => {
    const { document } = await setup();
    if (kind === "human")
      await f.command("document.extraction.correct", await reviewed(document));
    else {
      const page = await f.rpc("claim_uploaded_document_ocr");
      await f.rpc("complete_uploaded_document_ocr_page", [
        page.request_id,
        page.lease,
        JSON.stringify(await pageResult()),
        null,
      ]);
    }
    const running = await f.rpc("claim_uploaded_document_ocr");
    expect(running.action).toBe("publish");
    const manifest = await f.rpc("workspace_backup_manifest");
    const all: any[] = [];
    for (let i = 0; i < manifest.rows.length; i += 15)
      all.push(
        ...(await f.rpc("workspace_backup_rows", [
          JSON.stringify(manifest.rows.slice(i, i + 15).map((r: any) => r.key)),
        ])),
      );
    const target = await workflowFixture(
      "00000000-0000-4000-8000-000000000088",
    );
    const rpc = async (name: string, args: unknown[] = []) => {
      await target.db.query(
        "select set_config('request.jwt.claim.sub',$1,false)",
        [target.owner],
      );
      await target.db.exec("set role authenticated");
      try {
        return await target.rpc(name, args);
      } finally {
        await target.db.exec("reset role");
      }
    };
    try {
      await target.db.exec("begin");
      const session = await rpc("begin_workspace_restore", [
        JSON.stringify(manifest),
        true,
      ]);
      for (let i = 0; i < all.length; i += 10)
        await rpc("stage_restore_rows", [
          session.id,
          JSON.stringify(all.slice(i, i + 10)),
        ]);
      for (const file of session.files)
        await target.rpc("complete_restore_file", [
          file.id,
          target.owner,
          file.content_hash,
          file.expected_size,
        ]);
      await rpc("commit_workspace_restore", [session.id]);
      const restored = (
        await target.db.query<any>(
          "select * from public.document_ocr_requests where id=$1",
          [running.request_id],
        )
      ).rows[0];
      expect(restored).toMatchObject({
        status: "blocked",
        lease_token: null,
        lease_until: null,
        error_code: "RESTORED_REVIEW_REQUIRED",
      });
      expect(await target.rpc("claim_uploaded_document_ocr")).toBeNull();
      const doc = (
        await target.db.query<any>(
          "select * from public.documents where id=$1",
          [document.id],
        )
      ).rows[0];
      if (kind === "human") {
        await expect(
          target.command("document.ocr.retry", {
            id: doc.id,
            expected_revision: doc.revision,
          }),
        ).rejects.toThrow("DOCUMENT_PAGE_REVIEW_REQUIRED");
        await target.command(
          "document.extraction.correct",
          await reviewed(doc),
        );
        expect(
          (
            await target.db.query<any>(
              "select status from public.document_ocr_requests where id=$1",
              [running.request_id],
            )
          ).rows[0].status,
        ).toBe("superseded");
      } else
        await target.command("document.ocr.retry", {
          id: doc.id,
          expected_revision: doc.revision,
        });
      const fresh = await target.rpc("claim_uploaded_document_ocr");
      expect(fresh.action).toBe("publish");
      expect(fresh.lease).not.toBe(running.lease);
      const reservation = await target.rpc(
        "prepare_uploaded_document_ocr_publication",
        [fresh.request_id, fresh.lease],
      );
      const child = await target.rpc(
        "complete_uploaded_document_ocr_publication",
        [
          fresh.request_id,
          fresh.lease,
          reservation.original_hash,
          reservation.expected_size,
        ],
      );
      expect(child.extraction_confirmed_by).toBe(
        kind === "human" ? target.owner : null,
      );
      expect(child.extracted_text).toContain(known);
    } finally {
      await target.db.close();
    }
  },
  30000,
);
it("company verification cannot bypass OCR visual page review and only reviewed current child becomes company evidence", async () => {
  const item = await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic scanned company evidence",
    content: "",
    enabled: true,
    evidence: "",
  });
  const pending = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "company",
    knowledge_item_id: item.id,
    original_name: "company.pdf",
    mime_type: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("verify_document_pages", [pending.id, 3]);
  const doc = await f.rpc("accept_uploaded_document_with_coverage", [
    pending.id,
    f.owner,
    "a".repeat(64),
    100,
    originalText,
    "partial",
    "company-ocr",
    JSON.stringify(coverage),
  ]);
  const page = await f.rpc("claim_uploaded_document_ocr");
  const recognized = await pageResult();
  await f.rpc("complete_uploaded_document_ocr_page", [
    page.request_id,
    page.lease,
    JSON.stringify(recognized),
    null,
  ]);
  const first = (await publish()).child;
  let knowledge = (
    await f.db.query<any>("select * from public.knowledge_items where id=$1", [
      item.id,
    ])
  ).rows[0];
  await expect(
    f.command("knowledge.verify", {
      id: item.id,
      expected_revision: knowledge.revision,
    }),
  ).rejects.toThrow("DOCUMENT_PAGE_REVIEW_REQUIRED");
  const correction = await reviewed(first, recognized.text);
  correction.pages[1].expected_page_text_hash = await sha(recognized.text);
  await f.command("document.extraction.correct", correction);
  const current = (await publish()).child;
  knowledge = (
    await f.db.query<any>("select * from public.knowledge_items where id=$1", [
      item.id,
    ])
  ).rows[0];
  expect(
    (
      await f.command("knowledge.verify", {
        id: item.id,
        expected_revision: knowledge.revision,
      })
    ).verified,
  ).toBe(true);
  expect(current.extraction_confirmed_by).toBe(f.owner);
  expect(doc.extraction_confirmed_at).toBeNull();
});
it("a new explicit correction supersedes unfinished work and its lease while preserving old receipts for recovery", async () => {
  const { document } = await setup();
  const old = await f.command(
    "document.extraction.correct",
    await reviewed(document, "First reviewed paragraph."),
  );
  const lease = await f.rpc("claim_uploaded_document_ocr");
  const reservation = await f.rpc("prepare_uploaded_document_ocr_publication", [
    lease.request_id,
    lease.lease,
  ]);
  await f.command(
    "document.extraction.correct",
    await reviewed(
      old,
      "Corrected complete paragraph after further visual review.",
    ),
  );
  await expect(
    attempt(() =>
      f.rpc("complete_uploaded_document_ocr_publication", [
        lease.request_id,
        lease.lease,
        reservation.original_hash,
        reservation.expected_size,
      ]),
    ),
  ).rejects.toThrow("STALE_LEASE");
  expect(
    (
      await f.db.query<any>(
        "select status from public.document_ocr_requests where id=$1",
        [lease.request_id],
      )
    ).rows[0].status,
  ).toBe("superseded");
  expect(
    (
      await f.db.query<any>(
        "select receipt from public.document_ocr_pages where request_id=$1 and page=2",
        [lease.request_id],
      )
    ).rows[0].receipt.text,
  ).toBe("First reviewed paragraph.");
  expect((await publish()).child.extracted_text).toContain(
    "Corrected complete paragraph after further visual review.",
  );
});
it("accumulates pending human corrections across reload/page saves and only overrides an explicitly edited page", async () => {
  const { document } = await setup();
  const first = await reviewed(document);
  first.pages = first.pages.filter((p) => p.page === 1);
  first.pages[0].text = "First saved corrected page.";
  const saved = await f.command("document.extraction.correct", first);
  const view = await f.rpc("uploaded_document_extraction", [document.id]);
  expect(view.pages[0]).toMatchObject({
    candidate_text: "First saved corrected page.",
    candidate_origin: "human",
    candidate_reviewed_by: f.owner,
    candidate_requires_review: false,
  });
  const next = await reviewed(saved, "Second saved corrected page.");
  next.pages = next.pages.filter((p) => p.page !== 1);
  const second = await f.command("document.extraction.correct", next);
  const override = await reviewed(second);
  override.pages = override.pages.filter((p) => p.page === 1);
  override.pages[0].text = "First page corrected again.";
  await f.command("document.extraction.correct", override);
  const { child } = await publish();
  expect(child.extracted_text).toContain("First page corrected again.");
  expect(child.extracted_text).toContain("Second saved corrected page.");
  expect(child.extracted_text).not.toContain("First saved corrected page.");
  expect(child.extraction_confirmed_by).toBe(f.owner);
  expect(
    child.ocr_provenance.pages.every((p: any) => p.reviewed_by === f.owner),
  ).toBe(true);
});
async function editorActor() {
  const editor = "00000000-0000-4000-8000-000000000099";
  await f.db.query(
    "insert into auth.users values($1,'editor@example.test',now())",
    [editor],
  );
  await f.db.query("insert into auth.identities values($1,'email',$2::jsonb)", [
    editor,
    JSON.stringify({ sub: editor }),
  ]);
  await f.db.query(
    "insert into public.memberships(workspace_id,user_id,role,created_by) values($1,$2,'Editor',$3)",
    [f.w, editor, f.owner],
  );
  await f.db.query(
    "insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values($1,'email',$2::uuid::text,'editor@example.test',$2::uuid,'Editor',$3)",
    [f.w, editor, f.owner],
  );
  return editor;
}
async function commandAs(actor: string, operation: string, input: unknown) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    actor,
  ]);
  await f.db.exec("set role authenticated");
  return attempt(() =>
    f.rpc("app_command", [
      operation,
      JSON.stringify(input),
      crypto.randomUUID(),
    ]),
  );
}
it.each([false, true])(
  "preserves mixed reviewer text/attribution and requires fresh whole confirmation (first reviewer revoked=%s)",
  async (revoked) => {
    const { document } = await setup();
    const editor = await editorActor();
    const first = await reviewed(document);
    first.pages = first.pages.filter((p) => p.page === 1);
    first.pages[0].text = "Saved by first reviewer.";
    const saved = await f.command("document.extraction.correct", first);
    const firstView = await f.rpc("uploaded_document_extraction", [
      document.id,
    ]);
    if (revoked)
      await f.db.query(
        "update public.memberships set active=false where user_id=$1",
        [f.owner],
      );
    const second = await reviewed(saved, "Saved by second reviewer.");
    second.pages = second.pages.filter((p) => p.page !== 1);
    await commandAs(editor, "document.extraction.correct", second);
    const pending = await f.rpc("uploaded_document_extraction", [document.id]);
    expect(pending.pages[0]).toMatchObject({
      candidate_text: "Saved by first reviewer.",
      candidate_reviewed_by: f.owner,
      candidate_reviewed_at: firstView.pages[0].candidate_reviewed_at,
      candidate_requires_review: true,
    });
    const { child } = await publish();
    expect(child.extracted_text).toContain("Saved by first reviewer.");
    expect(child.extracted_text).toContain("Saved by second reviewer.");
    expect(child.extraction_confirmed_at).toBeNull();
    expect(child.extraction_confirmed_by).toBeNull();
    expect(child.ocr_provenance.pages[0]).toMatchObject({
      reviewed_by: f.owner,
      reviewed_at: firstView.pages[0].candidate_reviewed_at,
      requires_human_review: true,
      review_authority_current: !revoked,
    });
    expect(child.ocr_provenance.pages[1].reviewed_by).toBe(editor);
    const current = await f.rpc("uploaded_document_extraction", [child.id]);
    await commandAs(editor, "document.extraction.correct", {
      id: child.id,
      expected_revision: child.revision,
      expected_original_hash: child.original_hash,
      expected_extraction_hash: child.extraction_hash,
      review_confirmed: true,
      pages: current.pages.map((p: any) => ({
        page: p.page,
        expected_page_text_hash: p.text_hash,
        text: p.text,
        blank_confirmed: p.text.length === 0,
      })),
    });
    const confirmed = (await publish()).child;
    expect(confirmed.extraction_confirmed_by).toBe(editor);
    expect(
      confirmed.ocr_provenance.pages.every(
        (p: any) => p.reviewed_by === editor && !p.requires_human_review,
      ),
    ).toBe(true);
  },
);
it("refuses NULL persisted/service-supplied leases and nullable admitted source fields", async () => {
  const { document } = await setup();
  const task = await f.rpc("claim_uploaded_document_ocr");
  await f.db.query(
    "update public.document_ocr_requests set lease_token=null,lease_until=null,active_page=null where id=$1",
    [task.request_id],
  );
  await expect(
    attempt(() =>
      f.rpc("uploaded_document_ocr_context", [task.request_id, null]),
    ),
  ).rejects.toThrow("STALE_LEASE");
  await expect(
    attempt(() =>
      f.rpc("fail_uploaded_document_ocr_publication", [
        task.request_id,
        null,
        "DOCUMENT_OCR_FAILED",
      ]),
    ),
  ).rejects.toThrow("STALE_LEASE");
  await f.db.query(
    "update public.document_ocr_requests set lease_token=$2,lease_until=now()+interval '5 minutes' where id=$1",
    [task.request_id, task.lease],
  );
  for (const field of ["pdf_pages", "uploaded_size", "extraction_hash"]) {
    await f.db.exec("savepoint corrupt_source");
    await f.db.query(
      `update public.documents set ${field}=null,extraction_coverage=null,status='needs_ocr' where id=$1`,
      [document.id],
    );
    await expect(
      attempt(() =>
        f.rpc("uploaded_document_ocr_context", [task.request_id, task.lease]),
      ),
    ).rejects.toThrow("STALE_INPUT");
    await f.db.exec(
      "rollback to savepoint corrupt_source;release savepoint corrupt_source",
    );
  }
});
it("resolves a long retained correction lineage without the unrelated 200-page traversal cutoff", async () => {
  const { document } = await setup();
  await f.db
    .query(`do $test$ declare parent public.documents;child public.documents;begin
 select * into parent from public.documents where id='${document.id}'::uuid;
 for n in 1..202 loop
 child:=jsonb_populate_record(null::public.documents,to_jsonb(parent)||jsonb_build_object('id',gen_random_uuid(),'storage_key','synthetic/history/'||gen_random_uuid()::text,'ocr_parent_document_id',parent.id,'ocr_successor_id',null));
 insert into public.documents select(child).*;update public.documents set ocr_successor_id=child.id where id=parent.id;parent:=child;
 end loop;end $test$`);
  const current = (
    await f.db.query<any>(
      "select app_private.current_document_extraction($1,$2) id",
      [f.w, document.id],
    )
  ).rows[0].id;
  expect(current).not.toBe(document.id);
  expect(
    (
      await f.db.query<any>(
        "select ocr_successor_id from public.documents where id=$1",
        [current],
      )
    ).rows[0].ocr_successor_id,
  ).toBeNull();
}, 30000);
it.each([true, false])(
  "publishes explicit blank review without inventing readable source text (all blank=%s)",
  async (allBlank) => {
    const source = await f.command("source.create", {
      name: "Synthetic blank review",
      kind: "manual",
    });
    const opportunity = await f.command("opportunity.create", {
      source_id: source.id,
      title: "Synthetic blank source",
      reference: "SYNTHETIC-BLANK",
      language: "en",
    });
    const prepared = await f.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: opportunity.id,
      original_name: "blank.pdf",
      mime_type: "application/pdf",
      size: 100,
      hash: "a".repeat(64),
    });
    await f.rpc("verify_document_pages", [prepared.id, 2]);
    const text = "[Page 1]\n\n\n[Page 2]\n";
    const initial = {
      version: 1,
      kind: "pdf_pages",
      complete: false,
      pages: [
        { page: 1, status: "needs_ocr", characters: 0 },
        { page: 2, status: "needs_ocr", characters: 0 },
      ],
    };
    const document = await f.rpc("accept_uploaded_document_with_coverage", [
      prepared.id,
      f.owner,
      "a".repeat(64),
      100,
      text,
      "needs_ocr",
      "blank-upload",
      JSON.stringify(initial),
    ]);
    await f.command("document.extraction.correct", {
      id: document.id,
      expected_revision: document.revision,
      expected_original_hash: document.original_hash,
      expected_extraction_hash: document.extraction_hash,
      review_confirmed: true,
      pages: await Promise.all(
        (allBlank ? [1, 2] : [1]).map(async (page) => ({
          page,
          expected_page_text_hash: await sha(""),
          text: "\n\t ",
          blank_confirmed: true,
        })),
      ),
    });
    const { child } = await publish();
    expect(child.status).toBe(allBlank ? "needs_processing" : "needs_ocr");
    expect(child.extraction_confirmed_by).toBe(allBlank ? f.owner : null);
    expect(child.extraction_coverage.pages[0]).toEqual({
      page: 1,
      status: "blank",
      characters: 0,
    });
    expect(
      (
        await f.db.query<any>(
          "select app_private.current_document_extraction($1,$2) id",
          [f.w, document.id],
        )
      ).rows[0].id,
    ).toBe(child.id);
    const context = (
      await f.db.query<any>("select app_private.delivery_input($1,$2) data", [
        f.w,
        opportunity.id,
      ])
    ).rows[0].data;
    expect(context.blocks).toEqual([]);
    expect(
      context.input_materials.documents.map((d: any) => d.document_id),
    ).toEqual([child.id]);
    expect(context.input_materials.documents[0].used_for_draft).toBe(false);
  },
);
