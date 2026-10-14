import { describe, expect, it } from "vitest";
import {
  fromImportRow,
  opportunitiesToCsv,
  parseOpportunityCsv,
} from "./import";
import { createSeedState } from "../test/fixtures/workspace";
describe("manual CSV boundary", () => {
  it("previews valid rows, duplicates, and unsafe URLs without guessing deadlines", () => {
    const existing = createSeedState().opportunities;
    const data = parseOpportunityCsv(
      "title,external_id,canonical_url\nFirst,DEMO-X,https://example.com/x\nDuplicate,DEMO-X,\nUnsafe,,javascript:alert(1)\nNo identifier,,",
      existing,
    );
    expect(data[0].error).toBeNull();
    expect(fromImportRow(data[0]).deadline).toBe("");
    expect(fromImportRow(data[0]).score).toBeNull();
    expect(data[1].duplicate).toBe(true);
    expect(data[2].error).toMatch(/HTTPS/);
    expect(data[3].error).toMatch(/required/);
  });
  it("rejects missing headers and a batch above the trial bound", () => {
    expect(() => parseOpportunityCsv("buyer\nX", [])).toThrow(/title/);
    expect(() =>
      parseOpportunityCsv(
        "title,external_id\n" +
          Array.from({ length: 101 }, (_, i) => `RFP ${i},${i}`).join("\n"),
        [],
      ),
    ).toThrow(/100 rows/);
  });
  it("escapes spreadsheet formulas on export", () => {
    const opportunity = createSeedState().opportunities[0];
    const result = opportunitiesToCsv([
      { ...opportunity, title: "=1+1", buyer: "@SUM(A1)" },
    ]);
    expect(result).toContain("'=1+1");
    expect(result).toContain("'@SUM(A1)");
  });
});
