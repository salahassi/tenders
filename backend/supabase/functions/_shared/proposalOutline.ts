import { blueprintDraftInputs } from "./proposalBlueprint.ts";
type Row = Record<string, any>;
type Volume = "technical" | "financial" | "shared";

export type ProposalSectionOutline = {
  version: 1;
  groups: {
    parent_section_key: string;
    title: string;
    volume: Volume;
    parts: { section_key: string; part_index: number; part_count: number }[];
  }[];
};

// This is the existing generation protocol, also used for frozen plans created
// before outlines existed. A suffix or repeated title alone proves no lineage.
const partSize = 8;
const volumes = new Set(["technical", "financial", "shared"]);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
const equalIds = (left: unknown, right: unknown) =>
  strings(left) &&
  strings(right) &&
  JSON.stringify(left) === JSON.stringify(right);

export function plannedDraftInputs(section: Row): Row[] {
  if (section.workflow_version === 2) return blueprintDraftInputs(section);
  const ids: string[] = section.requirement_ids;
  const groups = Array.from(
    { length: Math.ceil(ids.length / partSize) },
    (_, i) => ids.slice(i * partSize, (i + 1) * partSize),
  );
  return (groups.length ? groups : [[]]).map((requirement_ids, index) => ({
    section: {
      ...section,
      key: groups.length > 1 ? `${section.key}-part${index + 1}` : section.key,
      requirement_ids,
    },
    requirement_ids,
  }));
}

/** Derive display structure only from exact saved generation lineage. */
export function createSectionOutline(
  parents: Row[],
  draftSteps: Row[],
  sections: Row[],
): ProposalSectionOutline | null {
  const outline: ProposalSectionOutline = { version: 1, groups: [] };
  const usedSteps = new Set<Row>(),
    usedKeys = new Set<string>();
  const sectionByKey = new Map(sections.map((s) => [s.key, s]));
  if (sectionByKey.size !== sections.length) return null;
  const parentKeys = new Set<string>();
  const matches = (expected: Row, actual: Row) =>
    actual?.section?.key === expected.section.key &&
    actual.section.title === expected.section.title &&
    actual.section.volume === expected.section.volume &&
    equalIds(actual.requirement_ids, expected.requirement_ids) &&
    equalIds(actual.section.requirement_ids, expected.requirement_ids);

  const visit = (expected: Row, depth: number, keys: string[]): boolean => {
    if (depth > 8) return false;
    const found = draftSteps.filter((s) => matches(expected, s.input));
    if (found.length !== 1) return false;
    const step = found[0];
    if (
      usedSteps.has(step) ||
      (step.depth !== undefined && step.depth !== depth)
    )
      return false;
    usedSteps.add(step);
    if (step.status === "split") {
      const ids = expected.requirement_ids as string[];
      if (ids.length < 2 || depth >= 8) return false;
      const mid = Math.ceil(ids.length / 2);
      return [ids.slice(0, mid), ids.slice(mid)].every((requirement_ids, i) =>
        visit(
          {
            ...expected,
            requirement_ids,
            section: {
              ...expected.section,
              key: `${expected.section.key}-part${i + 1}`,
              requirement_ids,
            },
          },
          depth + 1,
          keys,
        ),
      );
    }
    const section = sectionByKey.get(expected.section.key);
    if (
      step.status !== "completed" ||
      !section ||
      section.fixed ||
      section.title !== expected.section.title ||
      section.volume !== expected.section.volume ||
      usedKeys.has(section.key)
    )
      return false;
    usedKeys.add(section.key);
    keys.push(section.key);
    return true;
  };

  for (const parent of parents) {
    if (
      typeof parent.key !== "string" ||
      !parent.key ||
      parentKeys.has(parent.key) ||
      typeof parent.title !== "string" ||
      !volumes.has(parent.volume) ||
      !strings(parent.requirement_ids)
    )
      return null;
    parentKeys.add(parent.key);
    const keys: string[] = [];
    if (parent.workflow_version === 2 && parent.mode === "compliance_matrix") {
      const matrix = sectionByKey.get(parent.key);
      if (
        !matrix?.generated_matrix ||
        matrix.title !== parent.title ||
        matrix.volume !== parent.volume
      )
        return null;
      usedKeys.add(parent.key);
      outline.groups.push({
        parent_section_key: parent.key,
        title: parent.title,
        volume: parent.volume,
        parts: [{ section_key: parent.key, part_index: 1, part_count: 1 }],
      });
      continue;
    }
    if (!plannedDraftInputs(parent).every((input) => visit(input, 0, keys)))
      return null;
    outline.groups.push({
      parent_section_key: parent.key,
      title: parent.title,
      volume: parent.volume,
      parts: keys.map((section_key, index) => ({
        section_key,
        part_index: index + 1,
        part_count: keys.length,
      })),
    });
  }
  if (draftSteps.some((step) => !usedSteps.has(step))) return null;
  for (const section of sections) {
    if (usedKeys.has(section.key)) continue;
    if (
      !section.fixed ||
      parentKeys.has(section.key) ||
      typeof section.key !== "string" ||
      typeof section.title !== "string" ||
      !volumes.has(section.volume)
    )
      return null;
    parentKeys.add(section.key);
    usedKeys.add(section.key);
    outline.groups.push({
      parent_section_key: section.key,
      title: section.title,
      volume: section.volume,
      parts: [{ section_key: section.key, part_index: 1, part_count: 1 }],
    });
  }
  return usedKeys.size === sections.length ? outline : null;
}

/** A missing/invalid outline keeps every original section and heading. */
export function exportSectionGroups(
  sections: Row[],
  value: unknown,
): {
  title: string;
  volume: string;
  sections: Row[];
}[] {
  const fallback = () =>
    sections.map((section) => ({
      title: section.title,
      volume: section.volume,
      sections: [section],
    }));
  if (!value || typeof value !== "object") return fallback();
  const outline = value as ProposalSectionOutline;
  if (outline.version !== 1 || !Array.isArray(outline.groups))
    return fallback();
  const byKey = new Map(
    sections.map((section) => [section.section_key, section]),
  );
  if (byKey.size !== sections.length) return fallback();
  const used = new Set<string>(),
    parents = new Set<string>();
  const groups: ReturnType<typeof exportSectionGroups> = [];
  for (const group of outline.groups) {
    if (
      !group ||
      typeof group.parent_section_key !== "string" ||
      !group.parent_section_key ||
      parents.has(group.parent_section_key) ||
      typeof group.title !== "string" ||
      !volumes.has(group.volume) ||
      !Array.isArray(group.parts) ||
      !group.parts.length
    )
      return fallback();
    parents.add(group.parent_section_key);
    const parts: Row[] = [];
    for (const [index, part] of group.parts.entries()) {
      if (
        !part ||
        typeof part.section_key !== "string" ||
        used.has(part.section_key) ||
        part.part_index !== index + 1 ||
        part.part_count !== group.parts.length
      )
        return fallback();
      const section = byKey.get(part.section_key);
      if (
        !section ||
        section.volume !== group.volume ||
        section.title !== group.title ||
        (section.fixed &&
          (group.parts.length !== 1 ||
            group.parent_section_key !== section.section_key))
      )
        return fallback();
      used.add(part.section_key);
      parts.push(section);
    }
    groups.push({ title: group.title, volume: group.volume, sections: parts });
  }
  return used.size === sections.length ? groups : fallback();
}
