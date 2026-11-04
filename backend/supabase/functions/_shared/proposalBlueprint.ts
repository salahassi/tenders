import type { ProposalBlueprint } from "./proposalBlueprintSchema.ts";
import { ModelError } from "./model.ts";
import {
  validationDiagnostic,
  mergeModelValidationDiagnostics,
  type ModelValidationDiagnostic,
  type ModelValidationReason,
} from "./modelValidationDiagnostics.ts";

type Row = Record<string, any>;
export const semanticWorkflow = (plan: Row) => plan.workflow_version >= 2;

/** Fulfillment uses the supplied prose. An unresolved response or cross-section
 * finding may identify an existing location that still needs review, while
 * remaining anchored to the actual reviewed scope. The index is not evidence. */
export function validateReviewSectionReferences(result: Row, context: Row) {
  const reviewed = new Set((context.sections || []).map((s: Row) => s.key));
  const known = new Set([
    ...reviewed,
    ...(context.response_locations || []).map((s: Row) => s.section_key),
  ]);
  const badResponses = result.responses.flatMap((r: Row, i: number) => {
    const unresolved = [
      "partial",
      "missing",
      "clarification_required",
    ].includes(r.status);
    const allowed = unresolved ? known : reviewed;
    return r.section_ids.some((key: string) => !allowed.has(key)) ||
      (r.section_ids.length &&
        !r.section_ids.some((key: string) => reviewed.has(key)))
      ? [`$.responses[${i}].section_ids`]
      : [];
  });
  const badFindings = result.findings.flatMap((f: Row, i: number) =>
    f.section_ids.some((key: string) => !known.has(key)) ||
    (f.section_ids.length &&
      !f.section_ids.some((key: string) => reviewed.has(key)))
      ? [`$.findings[${i}].section_ids`]
      : [],
  );
  if (badResponses.length || badFindings.length) {
    const merged = mergeModelValidationDiagnostics({
      diagnostics: [...badResponses, ...badFindings].map((path) =>
        validationDiagnostic(
          "EVIDENCE_REFERENCE_INVALID",
          "invalid_finding_reference",
          {
            paths: [path],
          },
        ),
      ),
    });
    throw new ModelError(
      "EVIDENCE_REFERENCE_INVALID",
      null,
      merged.diagnostics,
      merged.omittedCount,
    );
  }
}

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

/** Enumerate all unknown references before constructing any expanded object.
 * Unknown aliases must never become canonical IDs or partially saved output. */
export function assertRequirementAliases(
  references: readonly { alias: string; path: string }[],
  aliases: ReadonlyMap<string, string>,
) {
  const diagnostics = references
    .filter((reference) => !aliases.has(reference.alias))
    .map((reference) =>
      validationDiagnostic(
        "EVIDENCE_REFERENCE_INVALID",
        "invalid_finding_reference",
        { paths: [reference.path], requirement_ids: [...aliases.keys()] },
      ),
    );
  if (diagnostics.length) {
    const merged = mergeModelValidationDiagnostics({ diagnostics });
    throw new ModelError(
      "EVIDENCE_REFERENCE_INVALID",
      null,
      merged.diagnostics,
      merged.omittedCount,
    );
  }
}

export function expandBlueprint(
  blueprint: ProposalBlueprint,
  requirements: Row[],
): ProposalBlueprint {
  const aliases = new Map(
    [...requirementAliases(requirements)].map(([id, alias]) => [alias, id]),
  );
  const references: { alias: string; path: string }[] = [];
  blueprint.processed_requirement_ids.forEach((alias, i) =>
    references.push({ alias, path: `$.processed_requirement_ids[${i}]` }),
  );
  blueprint.sections.forEach((section, si) =>
    section.units.forEach((unit, ui) => {
      unit.requirement_ids.forEach((alias, i) =>
        references.push({
          alias,
          path: `$.sections[${si}].units[${ui}].requirement_ids[${i}]`,
        }),
      );
      unit.secondary_links.forEach((link, li) =>
        references.push({
          alias: link.requirement_id,
          path: `$.sections[${si}].units[${ui}].secondary_links[${li}].requirement_id`,
        }),
      );
    }),
  );
  blueprint.decisions.forEach((decision, di) =>
    decision.requirement_ids.forEach((alias, i) =>
      references.push({
        alias,
        path: `$.decisions[${di}].requirement_ids[${i}]`,
      }),
    ),
  );
  blueprint.questions.forEach((question, qi) =>
    question.requirement_ids.forEach((alias, i) =>
      references.push({
        alias,
        path: `$.questions[${qi}].requirement_ids[${i}]`,
      }),
    ),
  );
  assertRequirementAliases(references, aliases);
  const id = (alias: string, path: string) => {
    const value = aliases.get(alias);
    if (!value)
      throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
        validationDiagnostic(
          "EVIDENCE_REFERENCE_INVALID",
          "invalid_finding_reference",
          {
            paths: [path],
            requirement_ids: [...aliases.keys()],
          },
        ),
      ]);
    return value;
  };
  return {
    ...blueprint,
    processed_requirement_ids: blueprint.processed_requirement_ids.map(
      (alias, i) => id(alias, `$.processed_requirement_ids[${i}]`),
    ),
    sections: blueprint.sections.map((s, si) => ({
      ...s,
      units: s.units.map((u, ui) => ({
        ...u,
        requirement_ids: u.requirement_ids.map((alias, i) =>
          id(alias, `$.sections[${si}].units[${ui}].requirement_ids[${i}]`),
        ),
        secondary_links: u.secondary_links.map((l, li) => ({
          ...l,
          requirement_id: id(
            l.requirement_id,
            `$.sections[${si}].units[${ui}].secondary_links[${li}].requirement_id`,
          ),
        })),
      })),
    })),
    decisions: blueprint.decisions.map((d, di) => ({
      ...d,
      requirement_ids: d.requirement_ids.map((alias, i) =>
        id(alias, `$.decisions[${di}].requirement_ids[${i}]`),
      ),
    })),
    questions: blueprint.questions.map((q, qi) => ({
      ...q,
      requirement_ids: q.requirement_ids.map((alias, i) =>
        id(alias, `$.questions[${qi}].requirement_ids[${i}]`),
      ),
    })),
  };
}

function validateBlueprintRules(
  blueprint: ProposalBlueprint,
  requiredIds: string[],
  template: Row[] = [],
  shared: {
    decisions?: ProposalBlueprint["decisions"];
    referenceIds?: string[];
    diagnosticRequirementIds?: ReadonlyMap<string, string>;
    diagnosticPath?: (path: string) => string;
  } = {},
  checkRequirementReferences = true,
) {
  // Canonical validation still uses immutable IDs; only diagnostic metadata is
  // projected back to the aliases actually supplied to this model phase.
  const fail = (
    reason: ModelValidationReason,
    paths: string[],
    requirementIds: string[] = [],
    contentIds: string[] = [],
  ): void => {
    diagnostics.push(
      validationDiagnostic("MODEL_COVERAGE_INCOMPLETE", reason, {
        // Project virtual planning scaffolding before deduplication/capping;
        // otherwise two paths can collapse after their omitted count is frozen.
        paths: shared.diagnosticPath ? paths.map(shared.diagnosticPath) : paths,
        requirement_ids: requirementIds.map(
          (id) => shared.diagnosticRequirementIds?.get(id) ?? id,
        ),
        content_ids: contentIds,
      }),
    );
  };
  const diagnostics: ModelValidationDiagnostic[] = [];
  if (
    checkRequirementReferences &&
    (blueprint.processed_requirement_ids.length !== requiredIds.length ||
      new Set(blueprint.processed_requirement_ids).size !==
        requiredIds.length ||
      requiredIds.some(
        (id) => !blueprint.processed_requirement_ids.includes(id),
      ))
  )
    fail("required_ids_mismatch", ["$.processed_requirement_ids"], requiredIds);
  const sectionKeys = new Set<string>(),
    unitKeys = new Set<string>();
  const decisions = [...(shared.decisions ?? []), ...blueprint.decisions];
  const referenceIds = shared.referenceIds ?? requiredIds;
  const decisionKeys = new Set(decisions.map((d) => d.key));
  if (decisionKeys.size !== decisions.length)
    fail("content_ids_mismatch", ["$.decisions"]);
  const owners = new Map<string, string>();
  for (const [si, section] of blueprint.sections.entries()) {
    const path = `$.sections[${si}]`;
    if (sectionKeys.has(section.key) || section.key.startsWith("fixed-"))
      fail("content_ids_mismatch", [`${path}.key`]);
    sectionKeys.add(section.key);
    if (section.mode === "compliance_matrix" && section.units.length)
      fail("invalid_scope", [`${path}.units`]);
    if (section.mode !== "compliance_matrix" && !section.units.length)
      fail("required_content_missing", [`${path}.units`]);
    for (const [ui, unit] of section.units.entries()) {
      const unitPath = `${path}.units[${ui}]`;
      if (
        blueprint.sections.some(
          (other) => other.key === unit.key && other.key !== section.key,
        )
      )
        fail("content_ids_mismatch", [`${unitPath}.key`]);
      if (unitKeys.has(unit.key) || unit.key.startsWith("fixed-"))
        fail("content_ids_mismatch", [`${unitPath}.key`]);
      unitKeys.add(unit.key);
      if (unit.decision_ids.some((id) => !decisionKeys.has(id)))
        fail(
          "invalid_finding_reference",
          [`${unitPath}.decision_ids`],
          [],
          [...decisionKeys],
        );
      if (
        checkRequirementReferences &&
        unit.secondary_links.some(
          (link) => !referenceIds.includes(link.requirement_id),
        )
      )
        fail(
          "invalid_finding_reference",
          [`${unitPath}.secondary_links`],
          referenceIds,
        );
      if (section.mode === "executive_summary" && unit.requirement_ids.length)
        fail("invalid_scope", [`${unitPath}.requirement_ids`]);
      if (checkRequirementReferences)
        for (const id of unit.requirement_ids) {
          if (!requiredIds.includes(id) || owners.has(id))
            fail(
              "required_ids_mismatch",
              [`${unitPath}.requirement_ids`],
              requiredIds,
            );
          owners.set(id, unit.key);
        }
    }
  }
  const missingOwners = requiredIds.filter((id) => !owners.has(id));
  if (checkRequirementReferences && missingOwners.length)
    fail("required_content_missing", ["$.sections"], missingOwners);
  for (const section of template) {
    const present = blueprint.sections.find((s) => s.key === section.key);
    if (section.applicable && !sectionKeys.has(section.key))
      fail("required_content_missing", ["$.sections"], [], [section.key]);
    if (!section.applicable && sectionKeys.has(section.key))
      fail("invalid_scope", ["$.sections"], [], [section.key]);
    if (section.applicable && present && present.volume !== section.volume)
      fail("invalid_scope", ["$.sections"], [], [section.key]);
  }
  for (const [di, decision] of blueprint.decisions.entries()) {
    if (
      checkRequirementReferences &&
      decision.requirement_ids.some((id) => !referenceIds.includes(id))
    )
      fail(
        "invalid_finding_reference",
        [`$.decisions[${di}].requirement_ids`],
        referenceIds,
      );
    if (
      ["buyer_fact", "company_fact"].includes(decision.kind) &&
      !decision.evidence_refs.length
    )
      fail("source_missing", [`$.decisions[${di}].evidence_refs`]);
  }
  if (diagnostics.length) {
    const merged = mergeModelValidationDiagnostics({ diagnostics });
    throw new ModelError(
      "MODEL_COVERAGE_INCOMPLETE",
      null,
      merged.diagnostics,
      merged.omittedCount,
    );
  }
  return owners;
}

/** Full validation remains the only function that returns canonical ownership. */
export function validateBlueprint(
  blueprint: ProposalBlueprint,
  requiredIds: string[],
  template: Row[] = [],
  shared: NonNullable<Parameters<typeof validateBlueprintRules>[3]> = {},
) {
  return validateBlueprintRules(blueprint, requiredIds, template, shared);
}

/** Independent metadata only, for an already rejected alias candidate.
 * Does not check/return ownership or repeat unknown requirement-reference
 * diagnostics already enumerated by alias preflight. Never an acceptance gate. */
export function validateBlueprintMetadata(
  blueprint: ProposalBlueprint,
  template: Row[] = [],
  shared: NonNullable<Parameters<typeof validateBlueprintRules>[3]> = {},
): void {
  validateBlueprintRules(blueprint, [], template, shared, false);
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
