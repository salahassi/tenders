/** Explicit offline diagnostics; never imported by the native worker.
 * Usage in the OCR image: node --experimental-transform-types
 * scripts/testing/uploadedOcrDiagnosis.ts matrix|holdouts OUTPUT_DIRECTORY
 * Use the same network-none, 768 MiB/one-CPU container limits as the receipt.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseTesseractTsv } from "../backend/public-notice-ocr-worker.ts";
import { matchesOcrPageGold } from "./ocrQualityOracle.ts";

const run = promisify(execFile);
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const mode = process.argv[2],
  output = process.argv[3];
if (!["matrix", "holdouts"].includes(mode) || !output)
  throw Error("Explicit matrix|holdouts mode and output directory required");
const root = new URL(
  "../../tests/backend/fixtures/uploaded-ocr/",
  import.meta.url,
);
const holdouts = new URL(
  "../../tests/backend/fixtures/uploaded-ocr-holdout/",
  import.meta.url,
);
const manifestBytes = await readFile(new URL("manifest.json", root));
const manifest = JSON.parse(manifestBytes.toString());
const freezeBytes = await readFile(new URL("freeze.json", holdouts));
const freeze = JSON.parse(freezeBytes.toString());
const goldBytes = await readFile(new URL("gold-manifest.json", holdouts));
if (hash(goldBytes) !== freeze.files["gold-manifest.json"].sha256)
  throw Error("Independent frozen gold changed");
const gold = JSON.parse(goldBytes.toString());
const baseline = { scale: 2000, languages: "ara+eng", segmentation: 3 };
// This is the diagnostic winner on the known red case, not a runtime policy.
// Independent holdouts already show it corrupts mixed identifiers and English.
const candidate = { scale: 1000, languages: "ara", segmentation: 6 };
const configurations =
  mode === "matrix"
    ? [1000, 1500, 2000].flatMap((scale) =>
        ["ara+eng", "ara"].flatMap((languages) =>
          [3, 6, 11].map((segmentation) => ({
            scale,
            languages,
            segmentation,
          })),
        ),
      )
    : [baseline, candidate];
const cases: { id: string; path: URL; sha256: string; gold: string[] }[] =
  mode === "matrix"
    ? [
        {
          id: "known-arabic-failure",
          path: new URL("scanned-ar.pdf", root),
          sha256: manifest.files["scanned-ar.pdf"],
          gold: manifest.recognition_oracle.ar,
        },
      ]
    : [
        ...gold.cases.map(
          (item: {
            id: string;
            filename: string;
            heading: string;
            lines: string[];
          }) => ({
            id: item.id,
            path: new URL(item.filename, holdouts),
            sha256: freeze.files[item.filename].sha256,
            gold: [item.heading, ...item.lines],
          }),
        ),
        {
          id: "english-existing-control",
          path: new URL("scanned-en.pdf", root),
          sha256: manifest.files["scanned-en.pdf"],
          gold: manifest.recognition_oracle.en,
        },
      ];
const deadline = Date.now() + 120000;
const directory = await mkdtemp("/tmp/ocr-quality-diagnostic-");
const invoke = async (name: string, args: string[]) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Error("Diagnostic deadline exceeded");
  return await run(name, args, {
    timeout: Math.min(30000, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1" },
  });
};
const results: unknown[] = [];
try {
  const engine = (await invoke("tesseract", ["--version"])).stdout.split(
    "\n",
  )[0];
  for (const item of cases) {
    if (hash(await readFile(item.path)) !== item.sha256)
      throw Error("Frozen PDF changed");
    for (const configuration of configurations) {
      const prefix = join(directory, `${item.id}-${configuration.scale}`);
      await invoke("pdftoppm", [
        "-f",
        "1",
        "-l",
        "1",
        "-scale-to",
        String(configuration.scale),
        "-png",
        "-singlefile",
        item.path.pathname,
        prefix,
      ]);
      const image = await readFile(prefix + ".png");
      const started = performance.now();
      const result = await invoke("tesseract", [
        prefix + ".png",
        "stdout",
        "-l",
        configuration.languages,
        "--psm",
        String(configuration.segmentation),
        "-c",
        "tessedit_create_tsv=1",
      ]);
      const page = parseTesseractTsv(result.stdout, 1);
      const record = {
        case: item.id,
        fixture_sha256: item.sha256,
        ...configuration,
        elapsed_ms: Math.round(performance.now() - started),
        image_sha256: hash(image),
        tsv_sha256: hash(result.stdout),
        text: page.text,
        confidence: page.confidence,
        full_normalized_page_exact: matchesOcrPageGold(page.text, item.gold),
      };
      results.push(record);
      await writeFile(
        join(
          output,
          `${item.id}-${configuration.scale}-${configuration.languages}-${configuration.segmentation}.tsv`,
        ),
        result.stdout,
      );
      console.log(JSON.stringify(record));
    }
  }
  await writeFile(
    join(output, "diagnosis.json"),
    JSON.stringify(
      {
        scope:
          "Offline synthetic OCR diagnostic; no runtime selection or automatic semantic qualification",
        mode,
        engine,
        original_manifest_sha256: hash(manifestBytes),
        holdout_freeze_sha256: hash(freezeBytes),
        holdout_gold_sha256: hash(goldBytes),
        oracle: "full_normalized_page_v2",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
