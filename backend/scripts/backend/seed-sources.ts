import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { buildSourceSeedSql, readSourceCatalog } from "./sourceCatalog.ts";

const { values } = parseArgs({
  options: {
    "workspace-id": { type: "string" },
    "actor-id": { type: "string" },
    output: { type: "string" },
    country: { type: "string" },
  },
});
if (!values["workspace-id"] || !values["actor-id"]) {
  throw new Error(
    "Usage: npm run seed:sources -- --workspace-id UUID --actor-id OWNER_UUID [--country SA|JO|PS] [--output FILE.sql]. Generates SQL for administrator execution; does not connect or apply it.",
  );
}
const catalog = await readSourceCatalog();
if (values.country) {
  if (!["SA", "JO", "PS"].includes(values.country))
    throw new Error("country must be SA, JO, or PS");
  catalog.sources = catalog.sources.filter(
    (source) => source.country === values.country,
  );
}
const sql = buildSourceSeedSql(
  catalog,
  values["workspace-id"],
  values["actor-id"],
);
if (values.output) {
  await writeFile(values.output, sql, { flag: "wx" });
  process.stdout.write(
    `Prepared ${catalog.sources.length} official sources in ${values.output}. No database write performed.\n`,
  );
} else process.stdout.write(sql);
