import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { buildSourceSeedSql, readSourceCatalog } from "./sourceCatalog.ts";

const { values } = parseArgs({
  options: {
    "workspace-id": { type: "string" },
    "actor-id": { type: "string" },
    output: { type: "string" },
    country: { type: "string" },
    "backfill-extraction": { type: "boolean", default: false },
  },
});
if (!values["workspace-id"] || !values["actor-id"]) {
  throw new Error(
    "Usage: npm run seed:sources -- --workspace-id UUID --actor-id OWNER_UUID [--country ISO_CODE] [--backfill-extraction] [--output FILE.sql]. Generates SQL for administrator execution; does not connect or apply it.",
  );
}
const catalog = await readSourceCatalog();
if (values.country) {
  if (!/^[A-Z]{2}$/.test(values.country))
    throw new Error("country must be a two-letter uppercase country code");
  catalog.sources = catalog.sources.filter(
    (source) => source.country === values.country,
  );
  if (!catalog.sources.length)
    throw new Error("No seed sources match this country");
}
const sql = buildSourceSeedSql(
  catalog,
  values["workspace-id"],
  values["actor-id"],
  values["backfill-extraction"],
);
if (values.output) {
  await writeFile(values.output, sql, { flag: "wx" });
  process.stdout.write(
    `Prepared ${catalog.sources.length} official sources in ${values.output}. No database write performed.\n`,
  );
} else process.stdout.write(sql);
