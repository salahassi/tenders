import { ModelError } from "./model.ts";
import { validationDiagnostic } from "./modelValidationDiagnostics.ts";
import { runModelValidationChecks } from "./modelContextDiagnostics.ts";
import { DEFAULT_OUTPUT_CEILING } from "./modelOutputPolicy.ts";
import {
  expandBlueprint,
  requirementAliases,
  validateBlueprint,
  validateBlueprintMetadata,
  assertRequirementAliases,
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
  const references: { alias: string; path: string }[] = [];
  for (const field of ["sections", "decisions", "questions"] as const)
    value[field].forEach((entry, index) =>
      entry.requirement_ids.forEach((alias, i) =>
        references.push({
          alias,
          path: `$.${field}[${index}].requirement_ids[${i}]`,
        }),
      ),
    );
  assertRequirementAliases(references, map);
  const id = (alias: string, path: string) => {
    const found = map.get(alias);
    if (!found)
      throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
        validationDiagnostic(
          "EVIDENCE_REFERENCE_INVALID",
          "invalid_finding_reference",
          {
            paths: [path],
            requirement_ids: [...map.keys()],
          },
        ),
      ]);
    return found;
  };
  return {
    ...value,
    sections: value.sections.map((s, si) => ({
      ...s,
      requirement_ids: s.requirement_ids.map((alias, i) =>
        id(alias, `$.sections[${si}].requirement_ids[${i}]`),
      ),
    })),
    decisions: value.decisions.map((d, di) => ({
      ...d,
      requirement_ids: d.requirement_ids.map((alias, i) =>
        id(alias, `$.decisions[${di}].requirement_ids[${i}]`),
      ),
    })),
    questions: value.questions.map((q, qi) => ({
      ...q,
      requirement_ids: q.requirement_ids.map((alias, i) =>
        id(alias, `$.questions[${qi}].requirement_ids[${i}]`),
      ),
    })),
  };
}

function validateStructureRules(
  value: ProposalStructure,
  requiredIds: string[],
  template: Row[],
  diagnosticRequirementIds?: ReadonlyMap<string, string>,
  metadataOnly = false,
) {
  const invalidOwnership = value.sections.flatMap((s, i) =>
    s.mode === "compliance_matrix" && s.requirement_ids.length
      ? [`$.sections[${i}].requirement_ids`]
      : [],
  );
  runModelValidationChecks([
    () => {
      if (invalidOwnership.length)
        throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
          ...invalidOwnership.map((path) =>
            validationDiagnostic("MODEL_COVERAGE_INCOMPLETE", "invalid_scope", {
              paths: [path],
            }),
          ),
        ]);
    },
    () => {
      // Reuse the same ownership/template/decision checks as the final blueprint.
      // These virtual units are validation scaffolding, never saved writing work.
      const virtual = {
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
      } as ProposalBlueprint;
      const diagnosticContext = {
        diagnosticRequirementIds,
        diagnosticPath: (path: string) =>
          path
            .replace(/\.units\[0\]/g, "")
            .replace(/\.units/g, ".requirement_ids"),
      };
      if (metadataOnly)
        validateBlueprintMetadata(virtual, template, diagnosticContext);
      else validateBlueprint(virtual, requiredIds, template, diagnosticContext);
    },
  ]);
}

export function validateStructure(
  value: ProposalStructure,
  requiredIds: string[],
  template: Row[],
  diagnosticRequirementIds?: ReadonlyMap<string, string>,
) {
  validateStructureRules(
    value,
    requiredIds,
    template,
    diagnosticRequirementIds,
  );
}

/** Raw alias metadata only after expansion already failed; never ownership. */
export function validateStructureMetadata(
  value: ProposalStructure,
  template: Row[],
) {
  validateStructureRules(value, [], template, undefined, true);
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
  let expanded: ProposalBlueprint | undefined;
  const diagnosticRequirementIds = requirementAliases(requirements);
  runModelValidationChecks([
    () => {
      if (
        value.decisions.length ||
        value.sections.length !== input.section_keys.length
      )
        throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
          validationDiagnostic("MODEL_COVERAGE_INCOMPLETE", "invalid_scope", {
            paths: ["$.decisions", "$.sections"],
            content_ids: input.section_keys,
          }),
        ]);
    },
    () => {
      expanded = expandBlueprint(value, requirements);
    },
    ...value.sections.map((section, si) => () => {
      const original = structure.sections.find((s) => s.key === section.key);
      if (
        !original ||
        !input.section_keys.includes(section.key) ||
        ["title", "purpose", "volume", "mode"].some(
          (key) => (section as Row)[key] !== (original as Row)[key],
        ) ||
        // Only successfully expanded, canonical IDs may enter ownership checks.
        expanded?.sections[si].units.some((unit) =>
          unit.requirement_ids.some(
            (id) => !original.requirement_ids.includes(id),
          ),
        )
      )
        throw new ModelError("MODEL_COVERAGE_INCOMPLETE", null, [
          validationDiagnostic("MODEL_COVERAGE_INCOMPLETE", "invalid_scope", {
            paths: [`$.sections[${si}]`],
            content_ids: input.section_keys,
            requirement_ids: original?.requirement_ids.map(
              (id) => diagnosticRequirementIds.get(id) ?? id,
            ),
          }),
        ]);
    }),
    () => {
      if (expanded)
        validateBlueprint(expanded, input.requirement_ids, [], {
          decisions: structure.decisions,
          referenceIds: requirements.map((r) => r.id),
          diagnosticRequirementIds,
        });
      else
        validateBlueprintMetadata(value, [], {
          decisions: structure.decisions,
        });
    },
  ]);
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
