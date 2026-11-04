import { renderDeliveryIsolated } from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import {
  verifyExportDocx,
  type RenderModel,
} from "../../supabase/functions/_shared/export.ts";
const runtime = (
  globalThis as unknown as {
    Deno: {
      args: string[];
      writeFile(path: string, bytes: Uint8Array): Promise<void>;
      Command: new (
        path: string,
        options: unknown,
      ) => {
        spawn(): import("../../supabase/functions/_shared/deliveryRenderIsolation.ts").RendererProcess;
      };
    };
  }
).Deno;
const before = performance.now();
try {
  await renderDeliveryIsolated(
    {} as RenderModel,
    () =>
      new runtime.Command("/bin/deno", {
        args: ["eval", "while(true){}"],
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn(),
    150,
  );
  throw new Error("Expected renderer timeout");
} catch (error) {
  if ((error as { code?: string }).code !== "DELIVERY_RENDER_TIMEOUT")
    throw error;
  console.log(
    JSON.stringify({
      cpu_bound_process_killed_and_reaped: true,
      elapsed_ms: Math.round(performance.now() - before),
    }),
  );
}
try {
  await renderDeliveryIsolated(
    {} as RenderModel,
    () =>
      new runtime.Command("/bin/deno", {
        args: [
          "eval",
          "--v8-flags=--max-old-space-size=16",
          "const rows=[];for(;;)rows.push(new Array(100000).fill('synthetic'))",
        ],
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn(),
    10_000,
  );
  throw new Error("Expected heap exhaustion");
} catch (error) {
  if ((error as { code?: string }).code !== "DELIVERY_RENDER_FAILED")
    throw error;
  console.log(
    JSON.stringify({
      child_heap_exhaustion_reaped: true,
      parent_survived: true,
    }),
  );
}
for (const language of ["en", "ar"]) {
  const ar = language === "ar";
  const model: RenderModel = {
    placeholder_version: 1 as const,
    id: "synthetic-renderer-proof",
    version: 1,
    mode: "draft",
    volume: "combined",
    language,
    created_at: "2026-11-04T00:00:00Z",
    footer: ar ? "مسودة للمراجعة" : "Review draft",
    blocks: [
      {
        type: "title" as const,
        text: ar
          ? "مسودة عرض إجراءات التشغيل"
          : "Operating procedure proposal draft",
      },
      {
        type: "paragraph" as const,
        text: ar
          ? "هذا ملف اختبار اصطناعي. الاستجابة غير مكتملة."
          : "Synthetic test document. Response incomplete.",
      },
      { type: "toc" as const, text: ar ? "المحتويات" : "Contents" },
      { type: "heading" as const, text: ar ? "نطاق العمل" : "Scope" },
      {
        type: "paragraph" as const,
        text: ar
          ? "يطلب المصدر إعداد دليل تشغيل خلال ثلاثين يومًا."
          : "The source requires an operating manual within thirty days.",
      },
      {
        type: "placeholder" as const,
        gap_id: "approach",
        text: ar
          ? "مطلوب: منهجية التنفيذ وأدلة القبول"
          : "Required: implementation approach and acceptance evidence",
      },
      {
        type: "table" as const,
        headers: ar ? ["البند", "الحالة"] : ["Item", "State"],
        rows: ar
          ? [
              ["سعر المورد", "غير مؤكد"],
              ["عدد ورش العمل", "0"],
            ]
          : [
              ["Supplier price", "Unconfirmed"],
              ["Workshop count", "0"],
            ],
      },
    ],
  };
  const start = performance.now();
  const bytes = await renderDeliveryIsolated(model);
  verifyExportDocx(bytes, model);
  if (runtime.args[0])
    await runtime.writeFile(
      `${runtime.args[0]}/${language}-delivery.docx`,
      bytes,
    );
  console.log(
    JSON.stringify({
      language,
      bytes: bytes.length,
      milliseconds: Math.round(performance.now() - start),
      content_verified: true,
      typed_yellow_verified: true,
    }),
  );
}
const stress: RenderModel = {
  placeholder_version: 1,
  id: "synthetic-stress",
  version: 1,
  mode: "draft",
  volume: "combined",
  language: "ar",
  created_at: "2026-11-04T00:00:00Z",
  footer: "مسودة اختبار",
  blocks: [
    { type: "title", text: "اختبار حجم المسودة" },
    { type: "toc", text: "المحتويات" },
    { type: "heading", text: "نطاق الاختبار" },
    ...Array.from({ length: 1000 }, (_, i) => ({
      type: "paragraph" as const,
      text:
        `${i}: ` +
        "هذه فقرة اصطناعية لاختبار أداء إنشاء المسودات وحفظ النص العربي دون حذف. ".repeat(
          3,
        ),
    })),
    ...Array.from({ length: 20 }, () => ({
      type: "table" as const,
      headers: ["البند", "الحالة"],
      rows: Array.from({ length: 20 }, (_, i) => [String(i), "قيمة اصطناعية"]),
    })),
    { type: "placeholder", gap_id: "stress", text: "مطلوب: مراجعة النص" },
  ],
};
const start = performance.now();
const bytes = await renderDeliveryIsolated(stress);
verifyExportDocx(bytes, stress);
console.log(
  JSON.stringify({
    synthetic_stress_verified: true,
    paragraphs: 1000,
    table_rows: 400,
    input_bytes: new TextEncoder().encode(JSON.stringify(stress)).length,
    output_bytes: bytes.length,
    elapsed_ms: Math.round(performance.now() - start),
  }),
);
