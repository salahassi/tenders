/** A single predeclared model substitution, never imported by production.
 * Run only inside the pinned OCR image with network disabled and the frozen
 * plan, candidate models and fixtures mounted read-only. No parameter search.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { parseTesseractTsv } from "../backend/public-notice-ocr-worker.ts";
import { matchesOcrPageGold } from "./ocrQualityOracle.ts";

const [planPath, modelDirectory, output] = process.argv.slice(2);
const deadline = Date.now() + 120000;
if (!planPath || !modelDirectory || !output)
  throw Error(
    "Explicit frozen plan, model directory and output directory required",
  );
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const planBytes = await readFile(planPath);
const plan = JSON.parse(planBytes.toString());
if (
  plan.version !== 1 ||
  plan.recognition_started !== false ||
  plan.configuration.scale !== 2000 ||
  plan.configuration.languages !== "ara+eng" ||
  plan.configuration.segmentation !== 3 ||
  plan.expected_cases !== 7 ||
  plan.parameter_search !== false ||
  plan.mandatory_review_changed !== false
)
  throw Error("Unrecognized predeclared alternative qualification");
for (const name of ["ara.traineddata", "eng.traineddata"]) {
  if (
    hash(await readFile(join(modelDirectory, name))) !==
    plan.candidate.files[name].sha256
  )
    throw Error("Candidate traineddata differs from frozen plan");
  if (
    hash(await readFile(`/usr/share/tesseract-ocr/5/tessdata/${name}`)) !==
    plan.baseline.files[name].sha256
  )
    throw Error("Pinned baseline image traineddata changed");
}
const root = new URL(
  "../../tests/backend/fixtures/uploaded-ocr/",
  import.meta.url,
);
const holdouts = new URL(
  "../../tests/backend/fixtures/uploaded-ocr-holdout/",
  import.meta.url,
);
const source = async (path: URL, expected: string) => {
  const bytes = await readFile(path);
  if (hash(bytes) !== expected)
    throw Error(`Frozen source changed: ${basename(path.pathname)}`);
  return bytes;
};
const manifest = JSON.parse(
  (
    await source(new URL("manifest.json", root), plan.original_manifest_sha256)
  ).toString(),
);
const freeze = JSON.parse(
  (
    await source(new URL("freeze.json", holdouts), plan.holdout_freeze_sha256)
  ).toString(),
);
const gold = JSON.parse(
  (
    await source(
      new URL("gold-manifest.json", holdouts),
      freeze.files["gold-manifest.json"].sha256,
    )
  ).toString(),
);
if (freeze.files["gold-manifest.json"].sha256 !== plan.holdout_gold_sha256)
  throw Error("Frozen holdout oracle changed");
for (const [name, expected] of Object.entries(plan.harness_sha256) as [
  string,
  string,
][]) {
  if (hash(await readFile(new URL(name, import.meta.url))) !== expected)
    throw Error("Frozen qualification harness changed");
}
type Case = {
  id: string;
  path: URL;
  page: number;
  sha256: string;
  gold: string[];
};
const cases: Case[] = [
  {
    id: "known-arabic-failure",
    path: new URL("scanned-ar.pdf", root),
    page: 1,
    sha256: manifest.files["scanned-ar.pdf"],
    gold: manifest.recognition_oracle.ar,
  },
  ...gold.cases.map(
    (row: {
      id: string;
      filename: string;
      heading: string;
      lines: string[];
    }) => ({
      id: row.id,
      path: new URL(row.filename, holdouts),
      page: 1,
      sha256: freeze.files[row.filename].sha256,
      gold: [row.heading, ...row.lines],
    }),
  ),
  {
    id: "english-existing-control",
    path: new URL("scanned-en.pdf", root),
    page: 1,
    sha256: manifest.files["scanned-en.pdf"],
    gold: manifest.recognition_oracle.en,
  },
  {
    id: "mixed-exact-scan-page",
    path: new URL("mixed-five-pages.pdf", root),
    page: manifest.mixed.scan_page,
    sha256: manifest.files["mixed-five-pages.pdf"],
    gold: manifest.recognition_oracle.en,
  },
  {
    id: "mixed-blank-page",
    path: new URL("mixed-five-pages.pdf", root),
    page: manifest.mixed.blank_page,
    sha256: manifest.files["mixed-five-pages.pdf"],
    gold: [],
  },
];
if (
  JSON.stringify(cases.map((item) => item.id)) !== JSON.stringify(plan.case_ids)
)
  throw Error("Predeclared case inventory changed");
const run = promisify(execFile);
const invoke = async (name: string, args: string[]) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw Error("Alternative qualification deadline exceeded");
  return await run(name, args, {
    timeout: Math.min(30000, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1" },
  });
};
const directory = await mkdtemp("/tmp/ocr-best-qualification-");
const results: Record<string, unknown>[] = cases.map((item) => ({
  case: item.id,
  page: item.page,
  fixture_sha256: item.sha256,
  outcome: "not_run",
}));
let state = "running",
  engine: string | null = null;
let active: Record<string, unknown> | undefined;
let stage = "engine_identity";
const receipt = () => ({
  version: 1,
  scope:
    "Single official model substitution on frozen synthetic controls; not automatic Arabic semantic acceptance",
  state,
  plan_sha256: hash(planBytes),
  engine,
  candidate: plan.candidate,
  configuration: plan.configuration,
  oracle: "full_normalized_page_v2",
  expected_cases: cases.length,
  recognized_cases: results.filter((item) => item.outcome === "recognized")
    .length,
  candidate_frozen_case_gate_passed:
    state === "completed" &&
    results.every(
      (item) =>
        item.outcome === "recognized" &&
        item.full_normalized_page_exact === true &&
        item.blank_control_valid !== false,
    ),
  automatic_arabic_qualified: false,
  mandatory_review_changed: false,
  runtime_recognition_changed: false,
  provider_calls: 0,
  results,
});
const persist = async (initial = false) => {
  const value = JSON.stringify(receipt(), null, 2) + "\n";
  const path = join(output, "alternative.json");
  if (initial) await writeFile(path, value, { flag: "wx" });
  else {
    await writeFile(path + ".pending", value);
    await rename(path + ".pending", path);
  }
};
// Refuse reused output directories instead of leaving a prior success receipt.
await persist(true);
try {
  engine = (await invoke("tesseract", ["--version"])).stdout.split("\n")[0];
  if (engine !== plan.engine) throw Error("Pinned OCR engine changed");
  for (const item of cases) {
    active = results.find((result) => result.case === item.id)!;
    active.outcome = "running";
    stage = "source_and_raster";
    await persist();
    await source(item.path, item.sha256);
    const prefix = join(directory, item.id);
    await invoke("pdftoppm", [
      "-f",
      String(item.page),
      "-l",
      String(item.page),
      "-scale-to",
      "2000",
      "-png",
      "-singlefile",
      item.path.pathname,
      prefix,
    ]);
    const image = await readFile(prefix + ".png"),
      started = performance.now();
    stage = "recognition";
    const recognized = await invoke("tesseract", [
      prefix + ".png",
      "stdout",
      "--tessdata-dir",
      modelDirectory,
      "-l",
      "ara+eng",
      "--psm",
      "3",
      "-c",
      "tessedit_create_tsv=1",
    ]);
    const page = parseTesseractTsv(recognized.stdout, item.page);
    const result = {
      outcome: "recognized",
      case: item.id,
      page: item.page,
      fixture_sha256: item.sha256,
      image_sha256: hash(image),
      tsv_sha256: hash(recognized.stdout),
      text_sha256: hash(page.text),
      text: page.text,
      confidence: page.confidence,
      elapsed_ms: Math.round(performance.now() - started),
      full_normalized_page_exact: matchesOcrPageGold(page.text, item.gold),
      blank_control_valid: item.gold.length
        ? null
        : page.text === "" && page.confidence === 0,
    };
    await writeFile(join(output, `${item.id}.tsv`), recognized.stdout);
    Object.assign(active, result);
    await persist();
    console.log(JSON.stringify(result));
  }
  state = "completed";
  await persist();
  if (!receipt().candidate_frozen_case_gate_passed) process.exitCode = 1;
} catch {
  if (active?.outcome === "running")
    Object.assign(active, { outcome: "infrastructure_error", stage });
  state = "failed";
  await persist();
  console.error(JSON.stringify({ code: "OCR_ALTERNATIVE_INCOMPLETE", stage }));
  process.exitCode = 2;
} finally {
  await rm(directory, { recursive: true, force: true });
}
