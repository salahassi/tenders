// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
import {
  buildExportModel,
  exportParagraphs,
} from "../../supabase/functions/_shared/export";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function draft() {
  const fixture = commercialHelpers(f);
  const data = await fixture.setup();
  const commercial = {
    confirmed: false,
    lines: [
      {
        description: "Synthetic implementation",
        quantity: null,
        unit: "day",
        rate_id: null,
        period_count: "1",
        included_in_base: true,
        charge_group: "one_time",
        tax_category: "",
        requirement_ids: [data.requirement],
        section_ids: ["approach"],
        deliverable: "Demonstrated workflow",
        basis: "Subject to scope confirmation",
      },
    ],
    tasks: [
      {
        key: "discovery",
        title: "Synthetic discovery",
        predecessors: [],
        role: "Analyst",
        effort_days: "3",
        allocation: null,
        duration_days: null,
        basis: "Proposed workshop effort",
      },
      {
        key: "implementation",
        title: "Synthetic build",
        predecessors: ["discovery"],
        role: "Engineer",
        effort_days: null,
        allocation: null,
        duration_days: null,
        basis: "Requires reviewed sizing",
      },
    ],
  };
  const review = {
    responses: [
      {
        requirement_id: data.requirement,
        status: "answered",
        section_ids: ["approach"],
        evidence_refs: [],
        rationale: "The proposed workflow addresses the requested scope.",
      },
    ],
    findings: [
      {
        severity: "advisory",
        category: "delivery",
        detail: "Confirm the proposed team allocation.",
        section_ids: ["approach"],
        requirement_ids: [data.requirement],
      },
    ],
  };
  await f.db.query(
    "update public.proposal_versions set commercial_draft=$1,review_result=$2 where id=$3",
    [JSON.stringify(commercial), JSON.stringify(review), data.version],
  );
  for (const [question, status] of [
    ["Confirm approved pricing.", "open"],
    ["An already resolved question.", "resolved"],
  ])
    await f.db.query(
      `insert into public.questions(workspace_id,opportunity_id,proposal_version_id,question,status,blocking_level,created_by)
      select $1,opportunity_id,$2,$3,$4,'finalization',$5 from public.proposals where id=$6`,
      [f.w, data.version, question, status, f.owner, data.proposal],
    );
  const prepare = () =>
    f.command("export.prepare", {
      proposal_version_id: data.version,
      expected_revision: 1,
      mode: "draft",
      volume: "combined",
    });
  return { ...data, commercial, review, fixture, prepare };
}

it("freezes generated draft inputs and unresolved questions without granting final export", async () => {
  const d = await draft();
  const request = await d.prepare();
  expect(request.snapshot.commercial_draft).toEqual(d.commercial);
  expect(request.snapshot.review_result).toEqual(d.review);
  expect(request.snapshot.questions.map((q: any) => q.question)).toEqual([
    "Confirm approved pricing.",
  ]);
  await f.db.query(
    "update public.proposal_versions set commercial_draft='{}',review_result='{}' where id=$1",
    [d.version],
  );
  const saved = (
    await f.db.query<any>(
      "select snapshot from public.export_requests where id=$1",
      [request.id],
    )
  ).rows[0].snapshot;
  expect(saved.commercial_draft).toEqual(d.commercial);
  await expect(
    f.command("export.prepare", {
      proposal_version_id: d.version,
      expected_revision: 1,
      mode: "final",
      volume: "combined",
    }),
  ).rejects.toThrow("APPROVAL_REQUIRED");
});

it("exports proposed inputs with unknown prices and currency, review links and exact questions", async () => {
  const d = await draft();
  const request = await d.prepare();
  const text = exportParagraphs(buildExportModel(request)).join("\n");
  expect(text).toContain("Synthetic implementation");
  expect(text).toContain("Not supplied day");
  expect(text).toContain("[INPUT REQUIRED: confirm offer currency]");
  expect(text).toContain("Awaiting confirmed pricing");
  expect(text).toContain("Synthetic build — Dependencies: Synthetic discovery");
  expect(text).toContain("Proposed workshop effort");
  expect(text).toContain("Model review (not confirmed): Answered");
  expect(text).toContain(
    "The proposed workflow addresses the requested scope.",
  );
  expect(text).toContain("Proposed approach");
  expect(text).toContain("Confirm approved pricing.");
  expect(text).toContain("Confirm the proposed team allocation.");
  expect(text).not.toContain("An already resolved question.");
  expect(text).not.toContain("SAR");
  expect(text).not.toContain("1000");
  expect(text).not.toContain(d.rate.id);
});

it("uses recorded calculations and manual compliance ahead of model draft suggestions", async () => {
  const d = await draft();
  await d.fixture.calculate(d, "estimate");
  await d.fixture.calculate(d, "delivery");
  await f.db.query(
    `insert into public.compliance_responses(workspace_id,proposal_version_id,requirement_id,status,section_keys,evidence_refs,rationale,created_by)
    values($1,$2,$3,'partial','["approach"]','[]','Human review has remaining gaps.',$4)`,
    [f.w, d.version, d.requirement, f.owner],
  );
  const request = await d.prepare();
  const text = exportParagraphs(buildExportModel(request)).join("\n");
  expect(text).toContain("Currency: SAR");
  expect(text).toContain("15180.00");
  expect(text).toContain("Partially answered");
  expect(text).not.toContain("Model review (not confirmed): Answered");
  expect(text).not.toContain("Proposed delivery inputs");
  expect(text).not.toContain("Proposed commercial inputs");
  const final = exportParagraphs(
    buildExportModel({ ...request, mode: "final" }),
  ).join("\n");
  expect(final).not.toContain("Confirm approved pricing.");
  expect(final).not.toContain("Confirm the proposed team allocation.");
  expect(final).not.toContain("Open questions");
});

it("keeps financial proposed inputs and global pricing questions out of a technical volume", async () => {
  const d = await draft();
  const request = await d.prepare();
  request.snapshot.questions.push({
    question: "Confirm SAR 5000 pricing.",
    blocking_level: "finalization",
    target_section_key: null,
  });
  const technical = exportParagraphs(
    buildExportModel({ ...request, volume: "technical" }),
  ).join("\n");
  expect(technical).toContain("Synthetic discovery");
  expect(technical).not.toContain("Synthetic implementation");
  expect(technical).not.toContain("Confirm approved pricing.");
  expect(technical).not.toContain("SAR 5000");
  const financial = exportParagraphs(
    buildExportModel({ ...request, volume: "financial" }),
  ).join("\n");
  expect(financial).toContain("Synthetic implementation");
  expect(financial).toContain("Confirm SAR 5000 pricing.");
  expect(financial).not.toContain("Synthetic discovery");
});

it("renders Arabic draft labels without changing supplied content", async () => {
  const d = await draft();
  const request = await d.prepare();
  request.snapshot.language = "ar";
  const text = exportParagraphs(buildExportModel(request)).join("\n");
  expect(text).toContain("مدخلات تجارية مقترحة بانتظار المراجعة");
  expect(text).toContain("[INPUT REQUIRED: تأكيد عملة العرض]");
  expect(text).toContain("الأسئلة المفتوحة وملاحظات المراجعة");
  expect(text).toContain("غير محدد");
  expect(text).toContain("بانتظار تأكيد التسعير");
  expect(text).toContain("Confirm approved pricing.");
});
