import { readFileSync } from "node:fs";
import { sourceExtraction } from "../../supabase/functions/_shared/officialListings";
const catalog = JSON.parse(
  readFileSync(
    new URL("../../seeders/official-sources.json", import.meta.url),
    "utf8",
  ),
);
export const seedExtraction = (key: string) =>
  sourceExtraction(
    structuredClone(
      catalog.sources.find((s: { key: string }) => s.key === key)?.extraction,
    ),
  );
