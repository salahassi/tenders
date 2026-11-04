// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { workflowFixture } from "./workflowFixture";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport";
import { verifyExportDocx } from "../../supabase/functions/_shared/export";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";

it("records a genuine missing-yellow verifier failure as blocked without losing the draft or inventing ready bytes", async () => {
  const f = await workflowFixture();
  try {
    await f.db.exec("begin");
    const source = await f.command("source.create", {
      name: "Synthetic yellow receipt integration",
      kind: "manual",
    });
    const opportunity = await f.command("opportunity.create", {
      source_id: source.id,
      title: "Synthetic documented approval workflow",
      reference: "SYNTHETIC-YELLOW",
      description:
        "Deliver an operating manual with two approval stages within thirty days.",
      language: "en",
      decision: "shortlisted",
    });
    const snapshot = await f.command("delivery.snapshot.prepare", {
      opportunity_id: opportunity.id,
      expected_revision: opportunity.revision,
    });
    const job = await f.rpc("claim_backend_job_v3");
    expect(job.entity_id).toBe(snapshot.id);
    const context = await f.rpc("delivery_export_context", [
      job.id,
      job.lease_token,
    ]);
    const model = buildDeliveryExport(context.snapshot, "combined");
    const fonts = Object.fromEntries(
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
    const bytes = new Uint8Array(
      await (await renderDocx(model, fonts)).arrayBuffer(),
    );
    expect(verifyExportDocx(bytes, model)).toBe(true);
    const archive = unzipSync(bytes);
    const xml = strFromU8(archive["word/document.xml"]);
    expect(xml).toContain('w:highlight w:val="yellow"');
    const changed = zipSync({
      ...archive,
      "word/document.xml": strToU8(
        xml.replace(/<w:highlight w:val="yellow"\/>/g, ""),
      ),
    });
    let failure: unknown;
    try {
      verifyExportDocx(changed, model);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "EXPORT_PLACEHOLDER_MISMATCH" });
    await f.rpc("fail_delivery_export", [
      job.id,
      job.lease_token,
      (failure as { code: string }).code,
    ]);
    const saved = (
      await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
    ).rows[0];
    expect(saved).toMatchObject({
      status: "blocked",
      error_code: "EXPORT_PLACEHOLDER_MISMATCH",
      lease_token: null,
      lease_until: null,
    });
    const artifacts = (
      await f.db.query<any>(
        "select * from public.proposal_delivery_artifacts where snapshot_id=$1",
        [snapshot.id],
      )
    ).rows;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      status: "pending",
      content_hash: null,
      expected_size: null,
      reserved_bytes: 10485760,
    });
    const pack = await f.rpc("delivery_package", [snapshot.id]);
    expect(pack).toMatchObject({
      status: "blocked",
      snapshot: { input_state: "available", content_state: "source_draft" },
    });
    const preserved = (
      await f.db.query<any>(
        "select payload,content_hash from public.proposal_delivery_snapshots where id=$1",
        [snapshot.id],
      )
    ).rows[0];
    expect(preserved).toEqual({
      payload: snapshot.payload,
      content_hash: snapshot.content_hash,
    });
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.provider_usage",
        )
      ).rows[0].n,
    ).toBe(0);
    await f.db.exec("rollback");
  } finally {
    await f.db.close();
  }
}, 30000);
