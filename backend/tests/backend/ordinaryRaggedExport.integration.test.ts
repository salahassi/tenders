// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { deliveryPipelineFixture } from "./deliveryPipelineFixture";
import { commercialHelpers } from "./commercialFixture";
import { processOrdinaryExport } from "../../supabase/functions/_shared/ordinaryExportWorker";
import {
  buildExportModel,
  verifyExportDocx,
} from "../../supabase/functions/_shared/export";
import { renderDocx } from "../../../frontend/src/lib/renderDocx";
import type { Backend } from "../../supabase/functions/_shared/backend";

let fixture: Awaited<ReturnType<typeof deliveryPipelineFixture>>;
beforeAll(async () => {
  fixture = await deliveryPipelineFixture();
}, 30000);
afterAll(async () => fixture?.f.db.close());
beforeEach(async () => fixture.f.db.exec("begin"));
afterEach(async () => fixture.f.db.exec("rollback"));

it("preserves authorized overflow cells through ordinary export snapshot, worker, stored DOCX and authenticated download", async () => {
  // Synthetic local session/object transport: actual API, migrated SQL and Word
  // renderer. This proves neither hosted Auth nor cloud Storage availability.
  const data = await commercialHelpers(fixture.f).setup();
  const table = {
    type: "table",
    headers: ["Method"],
    rows: [["Alpha", "OVERFLOW_SOURCE_SENTINEL", "0"], ["Beta"]],
  };
  await fixture.f.db.query(
    "update public.proposal_sections set content_blocks=$1::jsonb where proposal_version_id=$2 and section_key='approach'",
    [JSON.stringify([table]), data.version],
  );
  await fixture.f.db.query(
    "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
    [data.plan],
  );
  const transport = fixture.transport();
  Object.assign(transport.backend, {
    object: async (key: string) => {
      const blob = await transport.backend.deliveryObject(key);
      if (!blob) throw Error("missing synthetic object");
      return blob;
    },
  });
  const prepared = await transport.request("commands", {
    commands: [
      {
        operation: "export.package.prepare",
        input: {
          proposal_version_id: data.version,
          expected_revision: 1,
          mode: "draft",
        },
      },
    ],
  });
  expect(prepared.status).toBe(200);
  const pending = (await prepared.json()).data[0];
  const request = await fixture.rpc(
    "export_context",
    {
      request_id: pending.artifacts[0].export_id,
    },
    "synthetic-owner",
  );
  expect(
    request.snapshot.sections.find(
      (section: any) => section.section_key === "approach",
    ).content_blocks,
  ).toEqual([table]);
  const model = buildExportModel(request);
  const projected = model.blocks.find(
    (block) => block.type === "table" && block.headers[0] === "Method",
  );
  // Independent exact source oracle, before any renderer normalizes blank cells.
  expect(projected).toEqual(table);
  const job = await fixture.rpc("claim_backend_job_v5");
  expect(job?.type).toBe("render_export");
  const ready = await processOrdinaryExport(
    transport.backend as unknown as Backend,
    job,
    async (currentModel) =>
      new Uint8Array(
        await (await renderDocx(currentModel, fixture.fonts)).arrayBuffer(),
      ),
  );
  expect(ready.status).toBe("ready");
  const response = await transport.request(
    `export-artifacts/${ready.artifacts[0].id}/download`,
  );
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyExportDocx(bytes, model);
  const xml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"]);
  const nativeTable = [...xml.matchAll(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)]
    .map((match) => match[0])
    .find((value) => value.includes("OVERFLOW_SOURCE_SENTINEL"));
  expect(nativeTable).toBeDefined();
  // The renderer honestly pads to the widest authorized row: no invented heading.
  const rows = [...nativeTable!.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(
    (row) =>
      [...row[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((cell) =>
        [...cell[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map((text) => text[1])
          .join(""),
      ),
  );
  expect(rows).toEqual([
    ["Method", "", ""],
    ["Alpha", "OVERFLOW_SOURCE_SENTINEL", "0"],
    ["Beta", "", ""],
  ]);
  const persisted = (
    await fixture.f.db.query<any>(
      "select content_blocks from public.proposal_sections where proposal_version_id=$1 and section_key='approach'",
      [data.version],
    )
  ).rows[0];
  expect(persisted.content_blocks).toEqual([table]);
  expect(transport.objects.size).toBe(1);
}, 15000);
