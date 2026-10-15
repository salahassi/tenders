import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  prepareSplit,
  evaluateHoldout,
} from "../../packages/evaluation/index.ts";
const [mode, input, out, seed = "pilot-v1"] = process.argv.slice(2);
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function write(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
if (mode === "split" && input && out) {
  const dataset = await read(input);
  const split = prepareSplit(
    dataset.examples,
    seed,
    dataset.kind === "synthetic",
  );
  await mkdir(resolve(out), { recursive: true, mode: 0o700 });
  await write(join(out, "split.private.json"), split);
  await write(join(out, "development.json"), split.development);
  await write(join(out, "holdout-inputs.json"), split.holdoutInputs);
  await write(join(out, "split-manifest.json"), split.manifest);
  process.stdout.write(
    "Frozen split saved. Keep split.private.json and labels private; do not tune on held-out inputs.\n",
  );
} else if (mode === "score" && input && out) {
  const split = await read(input),
    predictions = await read(out),
    report = evaluateHoldout(split, predictions);
  const path = process.argv[5];
  if (!path) throw Error("Provide the output report path.");
  await write(path, report);
  process.stdout.write(
    "Held-out report saved; Owner acceptance and citation review remain explicit.\n",
  );
} else
  throw Error(
    "Usage: npm run evaluate -- split dataset.json output-directory seed | score split.private.json predictions.json report.json",
  );
