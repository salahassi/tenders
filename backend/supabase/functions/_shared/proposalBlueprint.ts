import type { ProposalBlueprint } from "./proposalBlueprintSchema.ts";
import { ModelError } from "./model.ts";

type Row = Record<string, any>;
export const semanticWorkflow = (plan: Row) => plan.workflow_version >= 2;

// Compact, deterministic references reduce repeated UUID tokens in planning.
// They label requirements; the model still makes the semantic assignments.
export function requirementAliases(requirements: Row[]): Map<string, string> {
  const name = (index: number): string =>
    index < 26
      ? String.fromCharCode(97 + index)
      : name(Math.floor(index / 26) - 1) +
        String.fromCharCode(97 + (index % 26));
  return new Map(
    [...requirements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r, i) => [r.id, `req_${name(i)}`]),
  );
}
export function expandBlueprint(
  blueprint: ProposalBlueprint,
  requirements: Row[],
): ProposalBlueprint {
  const aliases = new Map(
    [...requirementAliases(requirements)].map(([id, alias]) => [alias, id]),
  );
  const id = (alias: string) => {
    const value = aliases.get(alias);
    if (!value) throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    return value;
  };
  return {
    ...blueprint,
    processed_requirement_ids: blueprint.processed_requirement_ids.map(id),
    sections: blueprint.sections.map((s) => ({
      ...s,
      units: s.units.map((u) => ({
        ...u,
        requirement_ids: u.requirement_ids.map(id),
        secondary_links: u.secondary_links.map((l) => ({
          ...l,
          requirement_id: id(l.requirement_id),
        })),
      })),
    })),
    decisions: blueprint.decisions.map((d) => ({
      ...d,
      requirement_ids: d.requirement_ids.map(id),
    })),
    questions: blueprint.questions.map((q) => ({
      ...q,
      requirement_ids: q.requirement_ids.map(id),
    })),
  };
}

export function validateBlueprint(
  blueprint: ProposalBlueprint,
  requiredIds: string[],
  template: Row[] = [],
  shared: {
    decisions?: ProposalBlueprint["decisions"];
    referenceIds?: string[];
  } = {},
) {
  const fail = () => {
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  };
  if (
    blueprint.processed_requirement_ids.length !== requiredIds.length ||
    new Set(blueprint.processed_requirement_ids).size !== requiredIds.length ||
    requiredIds.some((id) => !blueprint.processed_requirement_ids.includes(id))
  )
    fail();
  const sectionKeys = new Set<string>(),
    unitKeys = new Set<string>();
  const decisions = [...(shared.decisions ?? []), ...blueprint.decisions];
  const referenceIds = shared.referenceIds ?? requiredIds;
  const decisionKeys = new Set(decisions.map((d) => d.key));
  if (decisionKeys.size !== decisions.length) fail();
  const owners = new Map<string, string>();
  for (const section of blueprint.sections) {
    if (sectionKeys.has(section.key) || section.key.startsWith("fixed-"))
      fail();
    sectionKeys.add(section.key);
    if (section.mode === "compliance_matrix" && section.units.length) fail();
    if (section.mode !== "compliance_matrix" && !section.units.length) fail();
    for (const unit of section.units) {
      if (
        blueprint.sections.some(
          (other) => other.key === unit.key && other.key !== section.key,
        )
      )
        fail();
      if (unitKeys.has(unit.key) || unit.key.startsWith("fixed-")) fail();
      unitKeys.add(unit.key);
      if (unit.decision_ids.some((id) => !decisionKeys.has(id))) fail();
      if (
        unit.secondary_links.some(
          (link) => !referenceIds.includes(link.requirement_id),
        )
      )
        fail();
      if (section.mode === "executive_summary" && unit.requirement_ids.length)
        fail();
      for (const id of unit.requirement_ids) {
        if (!requiredIds.includes(id) || owners.has(id)) fail();
        owners.set(id, unit.key);
      }
    }
  }
  if (requiredIds.some((id) => !owners.has(id))) fail();
  for (const section of template) {
    if (section.applicable && !sectionKeys.has(section.key)) fail();
    if (!section.applicable && sectionKeys.has(section.key)) fail();
    if (
      section.applicable &&
      blueprint.sections.find((s) => s.key === section.key)?.volume !==
        section.volume
    )
      fail();
  }
  for (const decision of blueprint.decisions) {
    if (decision.requirement_ids.some((id) => !referenceIds.includes(id)))
      fail();
    if (
      ["buyer_fact", "company_fact"].includes(decision.kind) &&
      !decision.evidence_refs.length
    )
      fail();
  }
  return owners;
}

export function savedBlueprint(
  steps: Row[],
  requirements: Row[] = [],
): ProposalBlueprint | undefined {
  const outputs = steps.filter(
    (s) =>
      s.task === "plan_proposal" &&
      s.status === "completed" &&
      s.output?.version === 2,
  );
  if (outputs.length > 1) throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  const step = outputs[0];
  return step?.input.id_aliases_version === 1
    ? expandBlueprint(step.output, requirements)
    : step?.output;
}

export function blueprintSections(blueprint: ProposalBlueprint): Row[] {
  return blueprint.sections.map((section) => ({
    ...section,
    workflow_version: 2,
    requirement_ids: section.units.flatMap((unit) => unit.requirement_ids),
  }));
}

export function blueprintDraftInputs(section: Row): Row[] {
  return section.units.map((unit: Row) => ({
    workflow_version: 2,
    parent_section_key: section.key,
    unit_key: unit.key,
    section: {
      key: unit.key,
      title: unit.title,
      volume: section.volume,
      purpose: unit.purpose,
      requirement_ids: unit.requirement_ids,
      target_words: unit.target_words,
    },
    requirement_ids: unit.requirement_ids,
    secondary_links: unit.secondary_links,
    decision_ids: unit.decision_ids,
    ...(unit.requirement_ids.length ? {} : { rfp_context_version: 1 }),
  }));
}

/** Pack review around whole saved sections and actual prose size. Ownership is
 * unique; a long section can be reviewed in a bounded requirement subset while
 * retaining its entire prose/evidence. Never shorten the content being checked. */
export function semanticReviewInputs(
  requirements: Row[],
  sections: Row[],
  outputTokens: number,
): Row[] {
  const target = Math.max(4000, Math.min(32000, outputTokens * 2));
  const groups: Row[] = [];
  let current: Row = { requirement_ids: [], section_keys: [], size: 0 };
  const flush = () => {
    if (current.section_keys.length)
      groups.push({
        workflow_version: 2,
        requirement_ids: current.requirement_ids,
        section_keys: current.section_keys,
      });
    current = { requirement_ids: [], section_keys: [], size: 0 };
  };
  const owned = new Set<string>();
  for (const section of sections) {
    const ids = (section.requirement_ids as string[]).filter(
      (id) => !owned.has(id),
    );
    const size =
      JSON.stringify(section.content_blocks).length +
      requirements
        .filter((r) => ids.includes(r.id))
        .reduce((n, r) => n + r.text.length, 0);
    if (ids.length > 50) {
      flush();
      for (let start = 0; start < ids.length; start += 50)
        groups.push({
          workflow_version: 2,
          requirement_ids: ids.slice(start, start + 50),
          section_keys: [section.key],
        });
      for (const id of ids) owned.add(id);
      continue;
    }
    if (
      current.section_keys.length &&
      (current.size + size > target ||
        current.requirement_ids.length + ids.length > 50)
    )
      flush();
    for (const id of ids) owned.add(id);
    current.requirement_ids.push(...ids);
    current.section_keys.push(section.key);
    current.size += size;
  }
  flush();
  const missing = requirements.filter((r) => !owned.has(r.id));
  if (missing.length) throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  return groups;
}

export function complianceMatrixSections(
  blueprint: ProposalBlueprint,
  requirements: Row[],
  responses: Row[],
  sections: Row[],
  language: string,
): Row[] {
  const ar = language === "ar";
  const labels: Record<string, string> = ar
    ? {
        answered: "تمت الإجابة",
        partial: "إجابة جزئية",
        missing: "غير مُجاب",
        clarification_required: "يحتاج توضيحًا",
        not_applicable_approved: "عدم الانطباق موثّق",
      }
    : {
        answered: "Answered",
        partial: "Partial",
        missing: "Missing",
        clarification_required: "Clarification required",
        not_applicable_approved: "Not applicable (approved)",
      };
  return blueprint.sections
    .filter((s) => s.mode === "compliance_matrix")
    .map((section) => {
      const rows = requirements.map((requirement) => {
        const response = responses.find(
          (r) => r.requirement_id === requirement.id,
        );
        if (!response) throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
        return [
          requirement.text,
          (response.section_ids as string[])
            .map((key) => sections.find((s) => s.key === key)?.title || key)
            .join(" / "),
          labels[response.status] || response.status,
          response.rationale,
        ];
      });
      const content_blocks = [];
      for (let i = 0; i < rows.length; i += 50)
        content_blocks.push({
          type: "table",
          headers: ar
            ? ["المتطلب", "موضع الإجابة", "حالة التغطية", "الملاحظات"]
            : ["Requirement", "Response location", "Coverage", "Notes"],
          rows: rows.slice(i, i + 50),
        });
      if (!content_blocks.length)
        content_blocks.push({
          type: "table",
          headers: ar ? ["المتطلب", "الحالة"] : ["Requirement", "Status"],
          rows: [],
        });
      return {
        key: section.key,
        title: section.title,
        volume: section.volume,
        generated_matrix: true,
        content_blocks,
        body: rows.map((row) => row.join(" | ")).join("\n"),
        requirement_ids: [],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
        fixed: false,
      };
    });
}

export function deduplicateQuestions(questions: Row[]): Row[] {
  const unique = new Map<string, Row>();
  for (const question of questions) {
    const key = question.question.normalize("NFKC").trim().replace(/\s+/g, " ");
    const existing = unique.get(key);
    if (!existing) unique.set(key, { ...question });
    else {
      existing.requirement_ids = [
        ...new Set([
          ...(existing.requirement_ids || []),
          ...(question.requirement_ids || []),
        ]),
      ];
      const severity = ["advisory", "finalization", "generation"];
      if (
        severity.indexOf(question.blocking_level) >
        severity.indexOf(existing.blocking_level)
      )
        existing.blocking_level = question.blocking_level;
    }
  }
  return [...unique.values()];
}
