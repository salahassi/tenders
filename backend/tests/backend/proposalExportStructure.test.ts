// @vitest-environment node
import { expect, it } from "vitest";
import {
  buildExportModel,
  exportParagraphs,
} from "../../supabase/functions/_shared/export";
import {
  createSectionOutline,
  exportSectionGroups,
  plannedDraftInputs,
} from "../../supabase/functions/_shared/proposalOutline";

function fixture() {
  const parents: any[] = [
    {
      key: "solution",
      title: "Proposed solution",
      volume: "technical",
      workflow_version: 2,
      mode: "narrative",
      requirement_ids: ["data", "security"],
      decisions: [],
      units: [
        {
          key: "data-unit",
          title: "Data integration",
          requirement_ids: ["data"],
          secondary_links: [],
          decision_ids: [],
          target_words: 100,
        },
        {
          key: "security-unit",
          title: "Access controls",
          requirement_ids: ["security"],
          secondary_links: [],
          decision_ids: [],
          target_words: 100,
        },
      ],
    },
    {
      key: "compliance",
      title: "Buyer compliance matrix",
      volume: "technical",
      workflow_version: 2,
      mode: "compliance_matrix",
      requirement_ids: [],
      units: [],
    },
  ];
  const steps = parents
    .flatMap(plannedDraftInputs)
    .map((input) => ({ input, status: "completed", depth: 0 }));
  const sections = steps.map(({ input }) => ({
    ...input.section,
    fixed: false,
    body: `Original prose for ${input.section.key}`,
    content_blocks: [
      { type: "paragraph", text: `Original prose for ${input.section.key}` },
    ],
  }));
  sections.push({
    key: "compliance",
    title: "Buyer compliance matrix",
    volume: "technical",
    generated_matrix: true,
    fixed: false,
    body: "Previously generated matrix projection",
    content_blocks: [
      { type: "paragraph", text: "Previously generated matrix projection" },
    ],
  });
  const outline = createSectionOutline(parents, steps, sections)!;
  const request: any = {
    id: "export",
    mode: "draft",
    volume: "combined",
    created_at: "2026-01-01T00:00:00Z",
    snapshot: {
      title: "Synthetic proposal",
      opportunity_title: "Synthetic tender",
      language: "en",
      ordinal: 1,
      section_outline: outline,
      sections: sections.map((s) => ({ ...s, section_key: s.key })),
      compliance: [],
      requirements: [
        { id: "data", text: "Connect the data source", category: "functional" },
        { id: "security", text: "Scope user access", category: "technical" },
        {
          id: "price",
          text: "State the commercial terms",
          category: "commercial",
        },
      ],
      review_result: {
        responses: [
          {
            requirement_id: "data",
            status: "answered",
            section_ids: ["data-unit"],
            rationale: "Proposed data response",
          },
          {
            requirement_id: "security",
            status: "partial",
            section_ids: ["security-unit"],
            rationale: "Confirm roles",
          },
          {
            requirement_id: "price",
            status: "missing",
            section_ids: [],
            rationale: "Await approved price",
          },
        ],
        findings: [],
      },
    },
  };
  return { outline, request };
}

it("preserves logical chapters and distinct subsection titles from exact saved lineage", () => {
  const { outline, request } = fixture();
  expect(outline).not.toBeNull();
  const groups = exportSectionGroups(
    request.snapshot.sections,
    JSON.parse(JSON.stringify(outline)),
  );
  expect(groups.map((g) => g.title)).toEqual([
    "Proposed solution",
    "Buyer compliance matrix",
  ]);
  expect(groups[0].sections.map((s) => s.title)).toEqual([
    "Data integration",
    "Access controls",
  ]);
  const model = buildExportModel(request);
  const text = exportParagraphs(model).join("\n");
  for (const value of [
    "Proposed solution",
    "Data integration",
    "Access controls",
    "Original prose for data-unit",
    "Original prose for security-unit",
  ])
    expect(text).toContain(value);
  expect(text).not.toContain("Previously generated matrix projection");
  expect(model.blocks.filter((b) => b.type === "table")).toHaveLength(1);
});

it("renders each requirement exactly once across separate compliance matrices without promoting model review", () => {
  const { request } = fixture();
  const technical = buildExportModel({ ...request, volume: "technical" });
  const financial = buildExportModel({ ...request, volume: "financial" });
  const rows = (model: ReturnType<typeof buildExportModel>) =>
    model.blocks.flatMap((b) => (b.type === "table" ? b.rows : []));
  expect(rows(technical).map((r) => r[0])).toEqual([
    "Connect the data source",
    "Scope user access",
  ]);
  expect(rows(financial).map((r) => r[0])).toEqual([
    "State the commercial terms",
  ]);
  expect(rows(technical)[0][1]).toContain("Model review (not confirmed)");
  expect(rows(financial)[0][1]).toContain("Await approved price");
  expect(exportParagraphs(technical).join("\n")).not.toContain(
    "State the commercial terms",
  );
});

it("preserves frozen legacy exports and falls back to every section after a title or volume changes", () => {
  const { request } = fixture();
  const legacy = structuredClone(request);
  for (const group of legacy.snapshot.section_outline.groups) {
    delete group.generated_matrix;
    for (const part of group.parts) delete part.title;
  }
  expect(exportParagraphs(buildExportModel(legacy)).join("\n")).toContain(
    "Previously generated matrix projection",
  );
  request.snapshot.sections[0].title = "Owner revised title";
  const changed = exportSectionGroups(
    request.snapshot.sections,
    request.snapshot.section_outline,
  );
  expect(changed).toHaveLength(3);
  expect(changed[0].title).toBe("Owner revised title");
  expect(changed.some((g) => g.generated_matrix)).toBe(false);
  request.snapshot.sections[0].volume = "financial";
  expect(
    exportSectionGroups(
      request.snapshot.sections,
      request.snapshot.section_outline,
    )[0].volume,
  ).toBe("financial");
});
