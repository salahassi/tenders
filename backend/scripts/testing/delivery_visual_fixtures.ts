/** Synthetic layout qualification only. No database, model or network calls.
 * Run with Node --experimental-transform-types and an explicit source checkout.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const [repositoryArg, outputArg] = process.argv.slice(2);
if (!repositoryArg || !outputArg) throw new Error("Repository and output paths required");
const repository = resolve(repositoryArg), output = resolve(outputArg);
await mkdir(output, { recursive: true, mode: 0o700 });
if (await access(join(output, "render-receipt.json")).then(() => true, () => false)) throw new Error("Choose a fresh output directory; existing qualification evidence is immutable");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const moduleFrom = (path: string) => import(pathToFileURL(join(repository, path)).href);
// Bind every local renderer helper (including streaming table allocation) and
// dependency declaration. Include untracked source during qualification so a
// newly imported helper can never silently escape the before/after hash check.
const tracked = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "backend/supabase/functions/_shared", "frontend/src/lib", "frontend/public/fonts", "frontend/package.json", "frontend/package-lock.json", "backend/package.json", "backend/package-lock.json"], { cwd: repository, encoding: "utf8" }).trim().split("\n"))].sort();
const sources = Object.fromEntries(await Promise.all(tracked.map(async path => [path, hash(await readFile(join(repository, path)))])));
const { renderDocx } = await moduleFrom("frontend/src/lib/renderDocx.ts");
const { verifyExportDocx } = await moduleFrom("backend/supabase/functions/_shared/export.ts");
const { buildDeliveryExport, deliveryRendererVersion, deliveryRenderingGapSummary } = await moduleFrom("backend/supabase/functions/_shared/deliveryExport.ts");
const { deliveryPayloadSchema } = await moduleFrom("backend/supabase/functions/_shared/deliveryContract.ts");
const fonts = Object.fromEntries(await Promise.all(["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(async name => [name, new Uint8Array(await readFile(join(repository, "frontend/public/fonts", name + ".ttf")))])));
const sourceId = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reasons = ["RESPONSE_NOT_PREPARED", "INSUFFICIENT_INPUT", "UNREAD_INPUT", "COMPANY_EVIDENCE_REQUIRED", "COMMERCIAL_CONFIRMATION_REQUIRED", "LEGACY_ASSURANCE_REVIEW_REQUIRED", "MODEL_INPUT_REQUIRED"];
const receipts: Record<string, unknown>[] = [];
let sequence = 10;
for (const version of [1, 2, 3]) for (const language of ["en", "ar"]) for (const separate of [false, true]) {
  const ar = language === "ar", l = (en: string, arabic: string) => ar ? arabic : en;
  const name = `v${version}-${language}-${separate ? "separate" : "combined"}`;
  const reviewed = version === 2 && language === "en" && !separate;
  const titles = {
    shared: l("Scope, evidence and acceptance", "النطاق والأدلة والقبول"),
    technical: l("Implementation and assurance", "التنفيذ والتحقق"),
    financial: l("Commercial schedule", "الجدول المالي"),
  };
  const gaps = reasons.map((reason, index) => ({
    id: `${name}:gap:${index + 1}`,
    section_key: index === 4 ? "financial" : index === 0 || index === 6 ? "technical" : "shared",
    field_path: `$.synthetic.inputs[${index}]`, reason,
    label: l(
      `G${index + 1} — Required input: ${["detailed response method", "buyer confirmation of the delivery environment", "review of the unread appendix", "current company evidence", "approved rate and tax assumptions", "current review of retained evidence", "named acceptance witness"][index]}.`,
      `G${index + 1} — مدخل مطلوب: ${["منهجية الاستجابة التفصيلية", "تأكيد المشتري لبيئة التسليم", "مراجعة الملحق غير المقروء", "أدلة الشركة الحالية", "اعتماد السعر وافتراضات الضريبة", "مراجعة الأدلة المحفوظة وفق الوضع الحالي", "تحديد ممثل القبول"][index]}.`,
    ),
    required_for: reviewed ? "final_approval" : "substantive_completion", source_ids: [sourceId],
  }));
  const longTechnical = version === 3 && language === "en" && !separate;
  const longFinancial = version === 3 && language === "ar" && separate;
  const technicalRows = Array.from({ length: longTechnical ? 40 : 4 }, (_, i) => [
    `REQ-${String(i + 1).padStart(3, "0")}`,
    l("Demonstrate the configured workflow and retain the approved test record for buyer review.", "اعرض سير العمل المُعدّ واحتفظ بسجل الاختبار المعتمد ليتمكن المشتري من مراجعته."),
    l(`Stage ${i % 4 + 1}; preserve the stated conditions and exceptions.`, `المرحلة ${i % 4 + 1}؛ تُحفظ الشروط والاستثناءات المذكورة.`),
    version === 3 && i === 2 ? l("[INPUT REQUIRED: acceptance witness]", "[مطلوب: ممثل القبول]") : l("Signed test record", "سجل اختبار موقّع"),
  ]);
  const financialRows = Array.from({ length: longFinancial ? 32 : 4 }, (_, i) => [
    l(`Work package ${i + 1}`, `حزمة العمل ${i + 1}`),
    l("Synthetic professional services; scope and approvals must be confirmed before commitment.", "خدمات مهنية اصطناعية للاختبار؛ يجب تأكيد النطاق والاعتماد قبل الالتزام."),
    i === 0 ? "0" : String(i + 1),
    version === 3 && i === 2 ? l("[INPUT REQUIRED: approved rate]", "[مطلوب: السعر المعتمد]") : l("Unconfirmed", "غير مؤكد"),
  ]);
  const sections: any[] = [
    { section_key: "shared", title: titles.shared, volume: "shared", kind: version === 1 ? "source_extract" : "response", source_ids: [sourceId], provenance: null,
      content_blocks: [
        { type: "paragraph", text: l("SYNTHETIC LAYOUT FIXTURE. The supplier shall demonstrate the workflow within 30 days after the buyer grants access, unless the buyer changes the approved scope. This example is not a customer proposal.", "ملف اصطناعي لفحص التنسيق. يلتزم المورد بعرض سير العمل خلال 30 يومًا بعد منح المشتري صلاحية الوصول، ما لم يغيّر المشتري النطاق المعتمد. هذا المثال ليس عرضًا لعميل.") },
        { type: "bullet", text: l("Retain the condition, deadline, exception and acceptance evidence together.", "تُحفظ الشروط والموعد والاستثناء وأدلة القبول معًا.") },
        { type: "bullet", text: l("Mixed-direction identifiers: API v2, REQ-101, 2026-11-04 and zero value 0.", "معرّفات باتجاه كتابة مختلف: API v2، وREQ-101، والتاريخ 2026-11-04، والقيمة الصفرية 0.") },
      ] },
    { section_key: "technical", title: titles.technical, volume: "technical", kind: "response", source_ids: [sourceId], provenance: null,
      content_blocks: [
        { type: "paragraph", text: l("Configure the workflow, execute acceptance tests, document the operating procedure and record the buyer decision. The following table deliberately wraps long text across lines.", "أعدّ سير العمل، ونفّذ اختبارات القبول، ووثّق إجراءات التشغيل وسجّل قرار المشتري. صُمّم الجدول التالي لاختبار التفاف النصوص الطويلة داخل الخلايا.") },
        ...(version === 3 ? [{ type: "paragraph", text: l("Acceptance scheduling remains open: [INPUT REQUIRED: buyer review date]. Confirm it before final approval.", "يبقى موعد القبول قيد الاستكمال: [مطلوب: تاريخ مراجعة المشتري]. يُؤكد قبل الاعتماد النهائي.") }] : []),
        { type: "table", headers: l("Identifier|Required response|Condition|Acceptance evidence", "المعرّف|الاستجابة المطلوبة|الشرط|دليل القبول").split("|"), rows: technicalRows },
      ] },
    { section_key: "financial", title: titles.financial, volume: "financial", kind: "response", source_ids: [sourceId], provenance: null,
      content_blocks: [
        { type: "paragraph", text: l("All monetary terms in this fixture are unconfirmed. No approved company rate or tax treatment is implied.", "جميع الشروط المالية في هذا الملف غير مؤكدة. لا يتضمن الملف سعرًا معتمدًا للشركة أو معالجة ضريبية معتمدة.") },
        { type: "table", headers: l("Package|Description|Quantity|Rate status", "الحزمة|الوصف|الكمية|حالة السعر").split("|"), rows: financialRows },
      ] },
  ];
  for (const section of sections) for (const gap of gaps.filter(x => x.section_key === section.section_key)) section.content_blocks.push({ type: "placeholder", gap_id: gap.id });
  const payload: any = {
    version, title: l("Workflow delivery proposal — synthetic layout qualification", "عرض تسليم سير العمل — فحص اصطناعي لتنسيق المستند"), language,
    template: { volume_mode: separate ? "separate" : "combined" }, separate_volumes: separate,
    input_state: "partial", content_state: version === 1 ? "source_draft" : version === 2 ? reviewed ? "substantive_draft" : "authored_draft" : "generated_review_draft",
    assurance_state: version === 1 ? "unreviewed" : version === 2 ? reviewed ? "human_reviewed" : "unreviewed" : "source_review_required",
    substantive_complete: reviewed, approval_state: "draft",
    notice: l("This file tests layout and visible missing inputs only. It is not evidence of model accuracy, commercial approval or production delivery.", "يختبر هذا الملف التنسيق ووضوح المدخلات الناقصة فقط. ولا يُعد دليلًا على دقة النموذج أو الاعتماد التجاري أو تسليم ملف في بيئة الإنتاج."),
    source_manifest: [{ entity_kind: "notice", entity_id: sourceId, content_hash: "a".repeat(64) }],
    input_materials: { documents: [] }, sections, gaps,
  };
  if (version === 2) payload.authoring = { session_id: id(2), revision_id: id(3), body_hash: hash(json(sections)), review_id: reviewed ? id(4) : null, report: reviewed ? { synthetic_layout_only: true } : null };
  if (version === 3) payload.generation = { proposal_version_id: id(5), plan_id: id(6), version_content_hash: hash(json(sections)), plan_input_hash: "b".repeat(64), machine_validation: { version: 1, policy: "generated-delivery-v1", passed: true, synthetic_layout_only: true }, machine_validation_hash: "c".repeat(64), receipt_pins: [{ step_id: id(7), receipt_id: id(8), verification_receipt_id: id(9), candidate_hash: "d".repeat(64) }] };
  deliveryPayloadSchema.parse(payload);
  const snapshot = { id: id(++sequence), ordinal: sequence, created_at: "2026-11-04T00:00:00.000Z", payload };
  const payloadText = json(snapshot);
  await writeFile(join(output, name + ".payload.json"), payloadText, { mode: 0o600 });
  for (const volume of separate ? ["technical", "financial"] : ["combined"]) {
    const model = buildDeliveryExport(snapshot, volume), summary = deliveryRenderingGapSummary(snapshot, volume);
    const expectedIds = gaps.filter(g => sections.some(s => s.section_key === g.section_key && (volume === "combined" || s.volume === volume || s.volume === "shared"))).map(g => g.id).sort();
    const actualIds = model.blocks.filter((b: any) => b.type === "placeholder").map((b: any) => b.gap_id).sort();
    if (json(expectedIds) !== json(actualIds) || summary.rendering_gap_count !== 0) throw new Error("Synthetic fixture gap projection changed");
    const modelText = json(model), bytes = new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
    verifyExportDocx(bytes, model);
    const file = name + "-" + volume;
    await writeFile(join(output, file + ".render-model.json"), modelText, { mode: 0o600 });
    await writeFile(join(output, file + ".docx"), bytes, { mode: 0o600 });
    receipts.push({ file, version, language, volume, renderer_version: deliveryRendererVersion(snapshot), payload_file: name + ".payload.json", payload_sha256: hash(payloadText), render_model_sha256: hash(modelText), docx_sha256: hash(bytes), docx_bytes: bytes.length, verify_export_docx: true, expected_gap_ids: expectedIds, typed_yellow_gap_count: expectedIds.length, inline_table_placeholder_policy: model.placeholder_version, long_table: longTechnical && volume !== "financial" || longFinancial && volume === "financial" });
  }
}
for (const [path, expected] of Object.entries(sources)) if (hash(await readFile(join(repository, path))) !== expected) throw new Error("Rendering source changed during qualification");
await writeFile(join(output, "render-receipt.json"), json({ version: 1, synthetic_layout_only: true, model_calls: 0, database_calls: 0, node: process.version, repository_revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), source_hash: hash(json(sources)), sources, snapshots: 12, documents: receipts }), { mode: 0o600 });
console.log(JSON.stringify({ snapshots: 12, documents: receipts.length, verified: true, output, source_hash: hash(json(sources)) }));
