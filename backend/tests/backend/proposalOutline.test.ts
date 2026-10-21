// @vitest-environment node
import { expect, it } from "vitest";
import {
  createSectionOutline,
  exportSectionGroups,
  plannedDraftInputs,
} from "../../supabase/functions/_shared/proposalOutline";
import {
  nextStage,
  splitStep,
} from "../../supabase/functions/_shared/generation";

type Row = Record<string, any>;
function fixture(counts = [3, 1]) {
  const parents = counts.map((parts, i) => ({
    key: `section-${i + 1}`,
    title: `Synthetic section ${i + 1}`,
    volume: i === 1 ? "financial" : "technical",
    requirement_ids: Array.from(
      { length: (parts - 1) * 8 + 1 },
      (_, j) => `r-${(i * 13 + j) % 145}`,
    ),
  }));
  const steps: Row[] = parents.flatMap((parent) =>
    plannedDraftInputs(parent).map((input) => ({
      task: "draft_section",
      status: "completed",
      depth: 0,
      input,
    })),
  );
  const sections: Row[] = steps.map(({ input }, ordinal) => ({
    key: input.section.key,
    title: input.section.title,
    volume: input.section.volume,
    requirement_ids: input.requirement_ids,
    body: `Synthetic body ${ordinal}`,
    content_blocks: [
      { type: "paragraph", text: `Exact paragraph ${ordinal}` },
      {
        type: "table",
        headers: ["Item", "Answer"],
        rows: [[`Synthetic ${ordinal}`, "Preserved cell"]],
      },
    ],
    evidence_refs: [
      { id: `source-${ordinal}`, quote: `Exact citation ${ordinal}` },
    ],
    company_claims: [],
    questions: [],
    assumptions: [],
  }));
  return { parents, steps, sections };
}
const stored = (sections: Row[]): Row[] =>
  sections.map((s) => ({ ...s, section_key: s.key }));

it("groups 67 saved parts into 17 parent sections while preserving every part key, block, citation and requirement link", () => {
  const f = fixture([12, 5, 3, 12, 1, 1, 3, 3, 4, 2, 3, 4, 6, 3, 1, 1, 3]);
  const before = structuredClone(f);
  const outline = createSectionOutline(f.parents, f.steps, f.sections)!;
  expect(f.sections).toHaveLength(67);
  expect(outline.groups).toHaveLength(17);
  const groups = exportSectionGroups(stored(f.sections), outline);
  expect(groups).toHaveLength(17);
  expect(groups.flatMap((g) => g.sections)).toEqual(stored(f.sections));
  expect(
    new Set(outline.groups.flatMap((g) => g.parts.map((p) => p.section_key)))
      .size,
  ).toBe(67);
  expect(f).toEqual(before);
});

it("uses the exact current planning chunk protocol without changing the saved draft inputs", async () => {
  const f = fixture();
  const result = await nextStage({
    plan: {
      stage: "planning",
      frozen_context: { template: { required_sections: [] } },
    },
    step: {},
    requirements: [],
    steps: [
      {
        task: "plan_proposal",
        status: "completed",
        input: {},
        output: { sections: f.parents },
      },
    ],
  });
  expect(result.steps.map((s) => s.input)).toEqual(f.steps.map((s) => s.input));
});

it("resolves nested split descendants from their exact saved inputs, even when appended out of logical order", () => {
  const root = {
    key: "legitimate-part1",
    title: "Synthetic root",
    volume: "technical",
    requirement_ids: ["r1", "r2", "r3"],
  };
  const rootInput = plannedDraftInputs(root)[0];
  const parent: Row = {
    task: "draft_section",
    status: "split",
    depth: 0,
    input: rootInput,
  };
  const children = splitStep({
    plan: {},
    requirements: [],
    steps: [],
    step: parent,
  })!;
  const split: Row = {
    task: "draft_section",
    status: "split",
    depth: 1,
    input: children[0],
  };
  const grandchildren = splitStep({
    plan: {},
    requirements: [],
    steps: [],
    step: split,
  })!;
  const leaves = [
    {
      task: "draft_section",
      status: "completed",
      depth: 1,
      input: children[1],
    },
    ...grandchildren.map((input) => ({
      task: "draft_section",
      status: "completed",
      depth: 2,
      input,
    })),
  ];
  const sections = leaves.map(({ input }) => ({ ...input.section }));
  const outline = createSectionOutline(
    [root],
    [parent, ...leaves, split],
    sections,
  )!;
  expect(outline.groups[0].parent_section_key).toBe("legitimate-part1");
  expect(outline.groups[0].parts.map((p) => p.section_key)).toEqual([
    "legitimate-part1-part1-part1",
    "legitimate-part1-part1-part2",
    "legitimate-part1-part2",
  ]);
  expect(
    exportSectionGroups(stored(sections), outline)[0].sections.map(
      (s) => s.section_key,
    ),
  ).toEqual(outline.groups[0].parts.map((p) => p.section_key));
});

it.each([
  "missing step",
  "duplicate step",
  "requirement order",
  "title",
  "volume",
  "suffix",
  "unfinished",
  "unknown extra",
])("does not invent lineage for %s", (change) => {
  const f = fixture();
  if (change === "missing step") f.steps.shift();
  if (change === "duplicate step") f.steps.push(structuredClone(f.steps[0]));
  if (change === "requirement order")
    f.steps[0].input.requirement_ids = [
      ...f.steps[0].input.requirement_ids,
    ].reverse();
  if (change === "title") f.steps[0].input.section.title = "Different title";
  if (change === "volume") f.steps[0].input.section.volume = "shared";
  if (change === "suffix") f.steps[0].input.section.key += "-part9";
  if (change === "unfinished") f.steps[0].status = "queued";
  if (change === "unknown extra")
    f.sections.push({
      key: "unmapped-part1",
      title: "Unmapped",
      volume: "technical",
    });
  expect(createSectionOutline(f.parents, f.steps, f.sections)).toBeNull();
});

it("keeps same-title independent planned sections separate and treats a literal part-like parent key as its own key", () => {
  const f = fixture([1, 1]);
  f.parents[1].title = f.parents[0].title;
  f.parents[1].key = "section-1-part1";
  f.steps[1].input = plannedDraftInputs(f.parents[1])[0];
  f.sections[1] = { ...f.sections[1], ...f.steps[1].input.section };
  const outline = createSectionOutline(f.parents, f.steps, f.sections)!;
  expect(outline.groups.map((g) => g.parent_section_key)).toEqual([
    "section-1",
    "section-1-part1",
  ]);
  expect(exportSectionGroups(stored(f.sections), outline)).toHaveLength(2);
});

it("retains fixed sections as separate headings and preserves all text after body edits or reordered database rows", () => {
  const f = fixture();
  f.sections.push({
    key: "fixed-terms",
    title: "Fixed terms",
    volume: "shared",
    fixed: true,
    body: "Exact fixed text",
  });
  const outline = createSectionOutline(f.parents, f.steps, f.sections)!;
  const rows = stored(f.sections).reverse();
  rows.find((s) => s.section_key === "section-1-part1")!.body =
    "Reviewed replacement body";
  const groups = exportSectionGroups(rows, outline);
  expect(groups.map((g) => g.title)).toEqual([
    "Synthetic section 1",
    "Synthetic section 2",
    "Fixed terms",
  ]);
  expect(groups[0].sections[0].body).toBe("Reviewed replacement body");
  expect(groups.at(-1)?.sections[0].body).toBe("Exact fixed text");
  expect(groups.flatMap((g) => g.sections)).toHaveLength(rows.length);
});

it.each([
  "missing",
  "bad version",
  "duplicate part",
  "missing part",
  "unknown part",
  "wrong volume",
  "wrong index",
  "wrong count",
  "edited title",
  "duplicate parent",
  "fixed merge",
])(
  "falls back to every original heading/content when outline is %s",
  (change) => {
    const f = fixture();
    let outline: any = createSectionOutline(f.parents, f.steps, f.sections)!;
    const rows = stored(f.sections);
    if (change === "missing") outline = undefined;
    if (change === "bad version") outline.version = 2;
    if (change === "duplicate part")
      outline.groups[0].parts[1].section_key =
        outline.groups[0].parts[0].section_key;
    if (change === "missing part") outline.groups[0].parts.pop();
    if (change === "unknown part")
      outline.groups[0].parts[0].section_key = "unknown";
    if (change === "wrong volume") outline.groups[0].volume = "financial";
    if (change === "wrong index") outline.groups[0].parts[0].part_index = 2;
    if (change === "wrong count") outline.groups[0].parts[0].part_count = 1;
    if (change === "edited title")
      rows[0].title = "Owner changed the section title";
    if (change === "duplicate parent")
      outline.groups[1].parent_section_key =
        outline.groups[0].parent_section_key;
    if (change === "fixed merge") rows[0].fixed = true;
    expect(exportSectionGroups(rows, outline)).toEqual(
      rows.map((section) => ({
        title: section.title,
        volume: section.volume,
        sections: [section],
      })),
    );
  },
);
