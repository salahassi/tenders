import { it, expect } from "vitest";
import { structuredDocxText } from "./structuredDocx";
it("preserves headings, table cells, Arabic and inert link text in extraction order", () => {
  const p = (value: string) => ({
    type: "paragraph",
    children: [{ type: "text", value }],
  });
  const result = structuredDocxText({
    type: "document",
    children: [
      { ...p("المتطلبات"), styleName: "Heading 1" },
      {
        type: "table",
        children: [
          {
            type: "tableRow",
            children: [
              { type: "tableCell", children: [p("الشرط الأول")] },
              { type: "tableCell", children: [p("Required")] },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        children: [
          {
            type: "hyperlink",
            children: [{ type: "text", value: "Read public source" }],
          },
        ],
      },
    ],
  });
  expect(result).toContain("[Heading 1]\nالمتطلبات");
  expect(result).toContain(
    "[Table 1, row 1, cell 1; Paragraph 2]\nالشرط الأول",
  );
  expect(result).toContain("[Table 1, row 1, cell 2; Paragraph 3]\nRequired");
  expect(result).toContain("Read public source");
  expect(result.indexOf("الشرط الأول")).toBeLessThan(
    result.indexOf("Required"),
  );
});
