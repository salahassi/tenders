import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { workflowFixture } from "./workflowFixture";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
it("restores v1 source history without carrying live authority or reviewer assurance and safely replays restore", async () => {
  const source = await workflowFixture(),
    target = await workflowFixture("00000000-0000-4000-8000-000000000088");
  async function rpc(f: typeof source, name: string, args: unknown[] = []) {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      f.owner,
    ]);
    await f.db.exec("set role authenticated;savepoint request");
    try {
      return await f.rpc(name, args);
    } catch (error) {
      await f.db.exec("rollback to savepoint request");
      throw error;
    } finally {
      await f.db.exec("release savepoint request;reset role");
    }
  }
  try {
    await source.db.exec("begin");
    await target.db.exec("begin");
    const src = await source.command("source.create", {
      name: "Synthetic review restore source",
      kind: "manual",
    });
    const opp = await source.command("opportunity.create", {
      source_id: src.id,
      title: "Synthetic original scope",
      reference: "SYNTHETIC",
      description: "Review original buyer requirements.",
      language: "en",
      decision: "shortlisted",
    });
    const bytes = "Supplier shall deliver 3 units after buyer acceptance.";
    const reservation = await source.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: opp.id,
      original_name: "synthetic.txt",
      mime_type: "text/plain",
      size: bytes.length,
      hash: digest(bytes),
    });
    await source.rpc("accept_uploaded_document", [
      reservation.id,
      source.owner,
      digest(bytes),
      bytes.length,
      bytes,
      "ready",
      crypto.randomUUID(),
    ]);
    let ctx = await rpc(source, "source_review_context", [opp.id]);
    let block = ctx.sources.find(
      (s: any) => s.reference.entity_id === reservation.id,
    );
    const authority = await source.command("source.authority.review", {
      opportunity_id: opp.id,
      ...block.reference,
      expected_revision: 0,
      role: "buyer_rfp",
      status: "confirmed",
      supersedes: null,
      precedence: 0,
      reason: "Synthetic Owner reviewed original buyer identity.",
    });
    ctx = await rpc(source, "source_review_context", [opp.id]);
    const span = ctx.source_evidence.spans.find(
      (s: any) => s.entity_id === reservation.id,
    );
    const review = await source.command("source.obligation.review", {
      opportunity_id: opp.id,
      review_id: null,
      expected_revision: 0,
      spans: [span],
      semantics: {
        modality: "required",
        actor: "supplier",
        negated: false,
        conditions: ["after buyer acceptance"],
        exceptions: [],
        consequences: [],
        quantities: [{ value: "3", unit: "units", currency: null }],
        dates: [],
      },
      status: "confirmed",
      reason: "Synthetic Owner reviewed original conditional obligation.",
    });
    const inventory = (
      await source.db.query<any>(
        "select app_private.source_obligation_inventory($1,$2,$3::uuid[])->0 value",
        [source.w, opp.id, [review.review_id]],
      )
    ).rows[0].value;
    const plan = await source.command("proposal.generate", {
      id: opp.id,
      expected_revision: opp.revision,
    });
    const requirement = crypto.randomUUID();
    await source.db.query(
      "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by) values($1,$2,$3,$4,$5,'functional',true,$6::jsonb,$7::jsonb,'Original reviewed obligation','Acceptance test',$8)",
      [
        requirement,
        source.w,
        plan.id,
        opp.id,
        inventory.text,
        JSON.stringify(inventory.source_refs),
        JSON.stringify(inventory.source_semantics),
        source.owner,
      ],
    );
    const manifest = await rpc(source, "workspace_backup_manifest");
    const rows: any[] = [];
    for (let i = 0; i < manifest.rows.length; i += 15)
      rows.push(
        ...(await rpc(source, "workspace_backup_rows", [
          JSON.stringify(manifest.rows.slice(i, i + 15).map((r: any) => r.key)),
        ])),
      );
    const started = await rpc(target, "begin_workspace_restore", [
      JSON.stringify(manifest),
      true,
    ]);
    for (let i = 0; i < rows.length; i += 10)
      await rpc(target, "stage_restore_rows", [
        started.id,
        JSON.stringify(rows.slice(i, i + 10)),
      ]);
    const files = (
      await target.db.query<any>(
        "select * from public.restore_files where session_id=$1",
        [started.id],
      )
    ).rows;
    expect(files).toHaveLength(1);
    await target.db.query(
      "select set_config('app.source_review_restore','prior-untrusted-value',true)",
    );
    await expect(
      rpc(target, "commit_workspace_restore", [started.id]),
    ).rejects.toThrow("RESTORE_INCOMPLETE");
    expect(
      (
        await target.db.query<any>(
          "select current_setting('app.source_review_restore',true) value",
        )
      ).rows[0].value,
    ).toBe("prior-untrusted-value");
    await target.rpc("complete_restore_file", [
      files[0].id,
      target.owner,
      digest(bytes),
      bytes.length,
    ]);
    await target.db.query(
      "select set_config('app.source_review_restore','prior-untrusted-value',true)",
    );
    expect(
      (await rpc(target, "commit_workspace_restore", [started.id])).state,
    ).toBe("committed");
    expect(
      (
        await target.db.query<any>(
          "select current_setting('app.source_review_restore',true) value",
        )
      ).rows[0].value,
    ).toBe("prior-untrusted-value");
    const authorities = (
      await target.db.query<any>(
        "select to_jsonb(a) value from public.source_authority_decisions a order by revision",
      )
    ).rows.map((row) => row.value);
    expect(authorities).toHaveLength(2);
    expect({ ...authorities[0], workspace_id: source.w }).toMatchObject(
      authority,
    );
    expect(authorities[0].status).toBe("confirmed");
    expect(authorities[1]).toMatchObject({
      status: "revoked",
      created_by: target.owner,
      revision: 2,
    });
    const reviews = (
      await target.db.query<any>(
        "select to_jsonb(r) value from public.source_obligation_reviews r order by revision",
      )
    ).rows.map((row) => row.value);
    expect(reviews).toHaveLength(2);
    expect({ ...reviews[0], workspace_id: source.w }).toMatchObject(review);
    expect(reviews[1]).toMatchObject({
      status: "revoked",
      created_by: target.owner,
      review_id: review.review_id,
      revision: 2,
    });
    const restored = (
      await target.db.query<any>(
        "select * from public.requirements where id=$1",
        [requirement],
      )
    ).rows[0];
    expect(restored.source_refs).toEqual(inventory.source_refs);
    expect(restored.source_semantics).toMatchObject({
      modality: "required",
      conditions: ["after buyer acceptance"],
      review_status: "pending",
      review_id: null,
      authority_role: "unknown",
      authority_status: "unconfirmed",
    });
    expect(
      (await rpc(target, "source_review_context", [opp.id])).source_evidence
        .reviews,
    ).toEqual([]);
    expect(
      (await rpc(target, "commit_workspace_restore", [started.id])).state,
    ).toBe("committed");
    expect(
      (
        await target.db.query<any>(
          "select count(*)::int n from public.source_authority_decisions",
        )
      ).rows[0].n,
    ).toBe(2);
    await target.db.query(
      "select set_config('app.source_review_restore',$1,true)",
      [started.id],
    );
    await target.db.exec("savepoint forged_scope");
    await expect(
      target.db.query(
        "update public.requirements set text='Unreviewed replacement' where id=$1",
        [requirement],
      ),
    ).rejects.toThrow("SOURCE_SPAN_STALE");
    await target.db.exec(
      "rollback to savepoint forged_scope;release savepoint forged_scope",
    );
    expect(
      (
        await target.db.query<any>(
          "select text from public.requirements where id=$1",
          [requirement],
        )
      ).rows[0].text,
    ).toBe(inventory.text);
    expect(
      (
        await target.db.query<any>(
          "select has_function_privilege('authenticated','app_private.restoring_source_history(uuid,public.generation_plans)','EXECUTE') allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    const current = await rpc(target, "source_review_context", [opp.id]);
    const currentBlock = current.sources.find(
      (s: any) => s.reference.entity_id === reservation.id,
    );
    await target.command("source.authority.review", {
      opportunity_id: opp.id,
      ...currentBlock.reference,
      expected_revision: 2,
      role: "buyer_rfp",
      status: "confirmed",
      supersedes: null,
      precedence: 0,
      reason: "Current Owner explicitly re-reviewed restored source.",
    });
    await rpc(target, "commit_workspace_restore", [started.id]);
    expect(
      (
        await target.db.query<any>(
          "select status from public.source_authority_decisions order by revision desc limit 1",
        )
      ).rows[0].status,
    ).toBe("confirmed");
  } finally {
    await source.db.exec("rollback");
    await target.db.exec("rollback");
    await source.db.close();
    await target.db.close();
  }
}, 30000);
