import { ModelError } from "./model.ts";
import { DEFAULT_OUTPUT_CEILING } from "./modelOutputPolicy.ts";
import {
  expandBlueprint,
  requirementAliases,
  validateBlueprint,
} from "./proposalBlueprint.ts";
import type {
  ProposalBlueprint,
  ProposalStructure,
} from "./proposalBlueprintSchema.ts";

type Row = Record<string, any>;
export const hierarchicalPlanning = (plan: Row) => plan.workflow_version === 3;

export function expandStructure(
  value: ProposalStructure,
  requirements: Row[],
): ProposalStructure {
  const map = new Map(
    [...requirementAliases(requirements)].map(([id, alias]) => [alias, id]),
  );
  const id = (alias: string) => {
    const found = map.get(alias);
    if (!found) throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    return found;
  };
  return {
    ...value,
    sections: value.sections.map((s) => ({
      ...s,
      requirement_ids: s.requirement_ids.map(id),
    })),
    decisions: value.decisions.map((d) => ({
      ...d,
      requirement_ids: d.requirement_ids.map(id),
    })),
    questions: value.questions.map((q) => ({
      ...q,
      requirement_ids: q.requirement_ids.map(id),
    })),
  };
}

export function validateStructure(
  value: ProposalStructure,
  requiredIds: string[],
  template: Row[],
) {
  if (
    value.sections.some(
      (s) => s.mode !== "narrative" && s.requirement_ids.length,
    )
  )
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  // Reuse the same ownership/template/decision checks as the final blueprint.
  // These virtual units are validation scaffolding, never saved writing work.
  validateBlueprint(
    {
      version: 2,
      processed_requirement_ids: requiredIds,
      decisions: value.decisions,
      questions: value.questions,
      sections: value.sections.map((s) => ({
        ...s,
        units:
          s.mode === "compliance_matrix"
            ? []
            : [
                {
                  key: s.key,
                  title: s.title,
                  purpose: s.purpose,
                  requirement_ids: s.requirement_ids,
                  secondary_links: [],
                  decision_ids: [],
                  target_words: 100,
                },
              ],
      })),
    },
    requiredIds,
    template,
  );
}

export function savedStructure(
  steps: Row[],
  requirements: Row[],
): ProposalStructure | undefined {
  const found = steps.filter(
    (s) =>
      s.task === "plan_proposal" &&
      s.status === "completed" &&
      s.input.planning_phase === "structure",
  );
  if (found.length > 1) throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  return found[0] ? expandStructure(found[0].output, requirements) : undefined;
}

/** Pack complete model-selected subjects by the actual requirement projection
 * size, not a fixed requirement count. Oversized subjects remain intact until a
 * measured truncation requests subdivision; original evidence is never cut. */
export function planningDetailInputs(
  structure: ProposalStructure,
  requirements: Row[],
  ceiling = DEFAULT_OUTPUT_CEILING,
): Row[] {
  const target = Math.max(6000, Math.floor(ceiling * 0.6));
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const groups: Row[] = [];
  let keys: string[] = [],
    ids: string[] = [],
    size = 0;
  const flush = () => {
    if (keys.length)
      groups.push({
        workflow_version: 3,
        planning_phase: "details",
        id_aliases_version: 1,
        section_keys: keys,
        requirement_ids: ids,
        detail_path: "root",
      });
    keys = [];
    ids = [];
    size = 0;
  };
  for (const section of structure.sections.filter(
    (s) => s.mode !== "compliance_matrix",
  )) {
    const weight =
      JSON.stringify(section).length +
      section.requirement_ids.reduce(
        (n, id) => n + JSON.stringify(byId.get(id) ?? {}).length,
        0,
      );
    if (keys.length && size + weight > target) flush();
    keys.push(section.key);
    ids.push(...section.requirement_ids);
    size += weight;
  }
  flush();
  return groups;
}

export function validatePlanningDetails(
  value: ProposalBlueprint,
  input: Row,
  structure: ProposalStructure,
  requirements: Row[],
) {
  if (
    value.decisions.length ||
    value.sections.length !== input.section_keys.length
  )
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  const expanded = expandBlueprint(value, requirements);
  for (const section of expanded.sections) {
    const original = structure.sections.find((s) => s.key === section.key);
    if (
      !original ||
      !input.section_keys.includes(section.key) ||
      ["title", "purpose", "volume", "mode"].some(
        (key) => (section as Row)[key] !== (original as Row)[key],
      ) ||
      section.units.some((u) =>
        u.requirement_ids.some((id) => !original.requirement_ids.includes(id)),
      )
    )
      throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  }
  validateBlueprint(expanded, input.requirement_ids, [], {
    decisions: structure.decisions,
    referenceIds: requirements.map((r) => r.id),
  });
}

export function mergePlanningDetails(
  steps: Row[],
  requirements: Row[],
  template: Row[] = [],
): ProposalBlueprint | undefined {
  const structure = savedStructure(steps, requirements);
  if (!structure) return;
  const details = steps.filter(
    (s) =>
      s.task === "plan_proposal" &&
      s.status === "completed" &&
      s.input.planning_phase === "details",
  );
  const sections = structure.sections.map((section) => ({
    ...section,
    units: [] as ProposalBlueprint["sections"][number]["units"],
  }));
  const questions = [...structure.questions];
  for (const step of details) {
    validatePlanningDetails(step.output, step.input, structure, requirements);
    const expanded = expandBlueprint(step.output, requirements);
    questions.push(...expanded.questions);
    for (const section of expanded.sections) {
      const target = sections.find((s) => s.key === section.key)!;
      // Stable namespace avoids incidental key collisions between separately
      // written groups; semantic section identity and order stay unchanged.
      target.units.push(
        ...section.units.map((u) => ({
          ...u,
          key: `${section.key.slice(0, 35)}-${step.ordinal}-${u.key.slice(0, 45)}`,
        })),
      );
    }
  }
  const blueprint: ProposalBlueprint = {
    version: 2,
    processed_requirement_ids: requirements.map((r) => r.id),
    sections,
    decisions: structure.decisions,
    questions,
  };
  validateBlueprint(blueprint, blueprint.processed_requirement_ids, template);
  return blueprint;
}

export function splitPlanningDetails(
  input: Row,
  structure: ProposalStructure,
): Row[] | null {
  if (input.planning_phase !== "details") return null;
  const path = input.detail_path ?? "root";
  if (input.section_keys.length > 1) {
    const mid = Math.ceil(input.section_keys.length / 2);
    return [
      input.section_keys.slice(0, mid),
      input.section_keys.slice(mid),
    ].map((section_keys, i) => ({
      ...input,
      section_keys,
      detail_path: `${path}-${i + 1}`,
      requirement_ids: input.requirement_ids.filter((id: string) =>
        structure.sections.some(
          (s) => section_keys.includes(s.key) && s.requirement_ids.includes(id),
        ),
      ),
    }));
  }
  if (input.requirement_ids.length < 2) return null;
  const mid = Math.ceil(input.requirement_ids.length / 2);
  return [
    input.requirement_ids.slice(0, mid),
    input.requirement_ids.slice(mid),
  ].map((requirement_ids, i) => ({
    ...input,
    requirement_ids,
    detail_path: `${path}-${i + 1}`,
  }));
}
