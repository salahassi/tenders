import { createServer } from "../../../frontend/node_modules/vite/dist/node/index.js";
import react from "../../../frontend/node_modules/@vitejs/plugin-react/dist/index.js";
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = await mkdtemp(resolve(tmpdir(), "tenderdesk-ocr-review-"));
const output = resolve(
  process.argv[2] || resolve(tmpdir(), "tenderdesk-ocr-review-results"),
);
await mkdir(output, { recursive: true });
const pdf = await readFile(
  root + "/backend/tests/backend/fixtures/uploaded-ocr/scanned-ar.pdf",
);
const hash = createHash("sha256").update(pdf).digest("hex");
await writeFile(
  dir + "/index.html",
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
await writeFile(
  dir + "/main.tsx",
  `import React from 'react';import{createRoot}from'react-dom/client';import Review from '${root}/frontend/src/components/DocumentExtractionReview.tsx';import '${root}/frontend/src/styles.css';
const ar=new URL(location.href).searchParams.get('lang')==='ar';const client={documentExtraction:async()=>({document_id:'fixture',document_revision:1,original_hash:'${hash}',extraction_hash:'${"e".repeat(64)}',original_name:'Synthetic Arabic scan.pdf',pdf_pages:1,original_download_url:'https://fixture.invalid/original.pdf',original_download_expires_at:new Date(Date.now()+300000).toISOString(),pages:[{page:1,status:'needs_ocr',text:'',text_hash:'${createHash("sha256").update("").digest("hex")}',candidate_text:'يجب على المورد تسليم 12 تقريرا خلال 30 يوما.\\nالدفع بقيمة 12500 ريال بعد القبول.\\nالموعد النهائي للتسليم هو 15 ديسمبر 2026.\\nيحظر التعاقد من الباطن دون موافقة خطية.',requires_review:true}],ocr:{completed_pages:1,total_pages:1,status:'needs_review',review_pages:[1]}}),correctDocumentExtraction:async(input,key)=>{window.__saved={input,key};return{}}};createRoot(document.getElementById('root')).render(<main style={{padding:'24px',maxWidth:1100,margin:'auto'}}><Review client={client} documentId='fixture' canEdit language={ar?'ar':'en'}/></main>);`,
);
const server = await createServer({
  root: dir,
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: {
      react: root + "/frontend/node_modules/react",
      "react-dom": root + "/frontend/node_modules/react-dom",
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4198,
    strictPort: true,
    fs: { allow: [root, dir] },
  },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.TENDERDESK_CHROMIUM_PATH || undefined,
  headless: true,
  args: ["--no-sandbox"],
});
const receipts = [];
try {
  for (const lang of ["ar", "en"])
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("https://fixture.invalid/original.pdf", (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: pdf,
          headers: { "Access-Control-Allow-Origin": "*" },
        }),
      );
      await page.goto("http://127.0.0.1:4198/?lang=" + lang);
      await page.locator("canvas:not([hidden])").waitFor();
      const painted = await page.locator("canvas").evaluate((c) => {
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let dark = 0,
          light = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
          if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) light++;
        }
        return dark > 100 && light > 1000;
      });
      if (!painted) throw new Error("Original PDF page not painted");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      if (overflow || errors.length)
        throw new Error(JSON.stringify({ lang, width, overflow, errors }));
      await page.screenshot({
        path: output + "/" + lang + "-" + width + ".png",
        fullPage: true,
      });
      const check = page.locator("input[type=checkbox]").last();
      await check.check();
      await page.locator("button.btn-primary").click();
      await page.waitForFunction(() => !!window.__saved);
      receipts.push({
        lang,
        width,
        overflow,
        errors,
        source_hash_verified: true,
        explicit_review_save: true,
      });
      await page.close();
    }
  await writeFile(output + "/receipt.json", JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipts));
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
