import { z } from "zod";
import { Decimal } from "decimal.js";
import { ModelError, sha256 } from "./model.ts";
import { normalizedEvidence } from "./sourceModel.ts";
import { isCandidateMetadataField } from "./modelGrounding.ts";
import {
  MAX_MODEL_VALIDATION_DIAGNOSTICS,
  MAX_MODEL_VALIDATION_PATHS,
  type ModelValidationDiagnostic,
} from "./modelValidationDiagnostics.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";

export const MAX_REPAIR_PATCH_PATHS =
  MAX_MODEL_VALIDATION_DIAGNOSTICS * MAX_MODEL_VALIDATION_PATHS;
const pathPattern = /^\$(?:\.[a-z][a-z0-9_]*|\[(?:0|[1-9][0-9]{0,5})\])+$/;
const protectedField = /\.(?:key|requirement_id|review_id|review_status)$/;
export const canonicalPatchValue = (value: any): string => {
  if (Array.isArray(value))
    return `[${value.map(canonicalPatchValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPatchValue(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export function patchPathKeys(path: string): (string | number)[] {
  if (path.length > 240 || !pathPattern.test(path))
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const keys = [...path.matchAll(/\.([a-z][a-z0-9_]*)|\[([0-9]+)\]/g)].map(
    (match) => match[1] ?? Number(match[2]),
  );
  if (
    keys.some((key) =>
      ["__proto__", "prototype", "constructor"].includes(String(key)),
    )
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return keys;
}
export function patchValueAt(value: any, path: string) {
  if (path === "$") return value;
  for (const key of patchPathKeys(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    value = value[key];
  }
  return value;
}
function parentAt(value: any, path: string) {
  const keys = patchPathKeys(path),
    key = keys.pop()!;
  for (const part of keys) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    value = value[part];
  }
  return { parent: value, key };
}
type Dependency = { path: string; reason: string };
export type SemanticPatchPath = {
  path: string;
  operation: "replace" | "append" | "remove" | "add";
  unit_id: string;
  unit_path: string;
  unit_hash: string;
  previous_hash: string;
  reason_ids: string[];
  dependencies: Dependency[];
};
export type SemanticPatchScope = {
  version: 1;
  target_task: PrimaryModelTask;
  candidate_hash: string;
  scope_hash: string;
  paths: SemanticPatchPath[];
  diagnostic_count: number;
  omitted_diagnostic_count: number;
  unresolved_finding_ids: string[];
};
function textPaths(candidate: any) {
  const paths: { path: string; text: string }[] = [];
  const visit = (value: any, path: string) => {
    if (typeof value === "string" && value.trim())
      paths.push({ path, text: value });
    else if (Array.isArray(value))
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        if (!isCandidateMetadataField(key)) visit(item, `${path}.${key}`);
  };
  visit(candidate, "$");
  return paths;
}
function unitPath(path: string) {
  // References and table cells belong to their enclosing requirement/section
  // content block. Nested blueprint units remain separate from sibling units.
  const units = [
    ...path.matchAll(
      /\.(requirements|directives|sections|units|decisions|content_blocks|company_claims|lines|tasks|responses|findings|questions|notices)\[[0-9]+\]/g,
    ),
  ];
  const last = units.at(-1);
  if (last) return path.slice(0, last.index! + last[0].length);
  const factor = path.match(/^\$\.factors\.[a-z_]+/);
  return factor?.[0] ?? path;
}
const writableUnitFields: Record<string, string[]> = {
  requirements: [
    "text",
    "category",
    "mandatory",
    "source_refs",
    "interpretation",
    "acceptance_evidence",
    "owner_question",
    "source_semantics",
  ],
  directives: ["instruction", "source_refs"],
  sections: ["title", "purpose", "volume", "mode", "requirement_ids"],
  units: [
    "title",
    "purpose",
    "requirement_ids",
    "secondary_links",
    "target_words",
    "decision_ids",
  ],
  decisions: ["statement", "kind", "requirement_ids", "evidence_refs"],
  content_blocks: ["text", "headers", "rows"],
  company_claims: ["claim", "source_id", "quote"],
  lines: [
    "description",
    "quantity",
    "unit",
    "rate_id",
    "period_count",
    "included_in_base",
    "charge_group",
    "tax_category",
    "requirement_ids",
    "section_ids",
    "deliverable",
    "basis",
  ],
  tasks: [
    "title",
    "predecessors",
    "role",
    "effort_days",
    "allocation",
    "duration_days",
    "basis",
  ],
  responses: ["status", "section_ids", "evidence_refs", "rationale"],
  findings: [
    "severity",
    "category",
    "detail",
    "section_ids",
    "requirement_ids",
  ],
  questions: ["question", "blocking_level", "requirement_ids"],
};

/** Application-owned dependency graph. A verifier can identify an affected unit,
 * but cannot grant itself an arbitrary path or authority/approval mutation. */
export async function buildSemanticPatchScope(options: {
  task: PrimaryModelTask;
  candidate: any;
  diagnostics?: ModelValidationDiagnostic[];
  omittedDiagnosticCount?: number;
  findings?: any[];
  trustedFindings?: boolean;
}) {
  const { candidate } = options;
  if (
    !Number.isSafeInteger(options.omittedDiagnosticCount ?? 0) ||
    (options.omittedDiagnosticCount ?? 0) < 0
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const candidateHash = await sha256(JSON.stringify(candidate));
  const selected = new Map<
    string,
    {
      operation: SemanticPatchPath["operation"];
      reasons: Set<string>;
      dependencies: Dependency[];
      unit: string;
    }
  >();
  const expanded = new Set<string>();
  const unresolved: string[] = [];
  const add = (
    path: string,
    reason: string,
    dependency?: Dependency,
    operation: SemanticPatchPath["operation"] = "replace",
    unit = unitPath(path),
  ) => {
    patchPathKeys(path);
    if (protectedField.test(path) || path.endsWith(".source_semantics")) return;
    const target = parentAt(candidate, path);
    if (
      operation === "add"
        ? Object.hasOwn(target.parent, target.key)
        : !Object.hasOwn(target.parent, target.key)
    )
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    const previous = selected.get(path);
    if (previous && previous.operation !== operation)
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    const entry = previous ?? {
      operation,
      reasons: new Set<string>(),
      dependencies: [],
      unit,
    };
    entry.reasons.add(reason);
    if (
      dependency &&
      !entry.dependencies.some(
        (item) =>
          item.path === dependency.path && item.reason === dependency.reason,
      )
    )
      entry.dependencies.push(dependency);
    selected.set(path, entry);
    if (selected.size > MAX_REPAIR_PATCH_PATHS)
      throw new ModelError("MODEL_CONTEXT_TOO_LARGE");
  };
  const expand = (path: string, reason: string) => {
    let existing = candidate,
      prefix = "$";
    for (const key of patchPathKeys(path)) {
      const next = `${prefix}${typeof key === "number" ? `[${key}]` : `.${key}`}`;
      if (!existing || typeof existing !== "object")
        throw new ModelError("MODEL_IDENTITY_CHANGED");
      if (!Object.hasOwn(existing, key)) {
        if (typeof key !== "string")
          throw new ModelError("MODEL_IDENTITY_CHANGED");
        add(
          next,
          reason,
          { path, reason: "missing_optional_field" },
          "add",
          prefix,
        );
        return;
      }
      existing = existing[key];
      prefix = next;
    }
    const root = unitPath(path),
      unit = patchValueAt(candidate, root);
    if (expanded.has(`${root}:${reason}`)) return;
    expanded.add(`${root}:${reason}`);
    add(path, reason);
    const group = [...root.matchAll(/\.([a-z_]+)\[/g)].at(-1)?.[1];
    const fields = group
      ? writableUnitFields[group]
      : root.startsWith("$.factors.")
        ? ["rating", "reason", "notice_evidence", "company_evidence"]
        : undefined;
    if (!fields || !unit || typeof unit !== "object" || Array.isArray(unit))
      return;
    for (const field of fields)
      if (Object.hasOwn(unit, field)) {
        if (field === "source_semantics") {
          for (const semanticField of Object.keys(unit[field]))
            if (
              !["version", "review_status", "review_id"].includes(semanticField)
            )
              add(
                `${root}.${field}.${semanticField}`,
                reason,
                { path, reason: "same_requirement_semantic_dependency" },
                "replace",
                root,
              );
        } else
          add(
            `${root}.${field}`,
            reason,
            { path, reason: `same_${group ?? "factor"}_semantic_dependency` },
            "replace",
            root,
          );
      }
    // A schema-declared company claim cannot truthfully remain an asserted
    // capability when no proof exists. Removal is allowed only in this metadata
    // list, with the associated narrative also scoped and fully reverified.
    if (group === "company_claims") {
      selected.delete(path);
      for (const key of [...selected.keys()])
        if (key.startsWith(root + ".")) selected.delete(key);
      add(
        root,
        reason,
        { path, reason: "unsupported_company_declaration_removal" },
        "remove",
        root,
      );
      if (Array.isArray(candidate.questions))
        add(
          "$.questions",
          reason,
          { path, reason: "record_unresolved_company_proof" },
          "append",
          root,
        );
      const claims = textPaths(candidate).filter(
        (entry) =>
          !entry.path.startsWith("$.company_claims[") &&
          normalizedEvidence(entry.text).includes(
            normalizedEvidence(unit.claim ?? ""),
          ),
      );
      selected.get(root)!.dependencies.push({
        path: "$.questions",
        reason: "required_missing_proof_question",
      });
      for (const claim of claims)
        if (unit.claim) {
          expand(claim.path, reason);
          selected.get(root)!.dependencies.push({
            path: claim.path,
            reason: "required_narrative_uncertainty_rewrite",
          });
        }
    }
  };
  const diagnostics = (options.diagnostics ?? []).slice(
    0,
    MAX_MODEL_VALIDATION_DIAGNOSTICS,
  );
  diagnostics.forEach((diagnostic, index) => {
    const reason = `diagnostic-${index}`;
    for (const path of diagnostic.paths) {
      if (
        diagnostic.reason === "required_content_missing" &&
        Array.isArray(patchValueAt(candidate, path))
      )
        add(
          path,
          reason,
          {
            path,
            reason:
              "append_missing_required_unit_without_rewriting_existing_units",
          },
          "append",
        );
      else if (
        ["source_quote_mismatch", "quote_empty"].includes(diagnostic.reason)
      )
        add(path, reason);
      else if (
        [
          "source_missing",
          "source_kind_mismatch",
          "company_not_verified",
        ].includes(diagnostic.reason) &&
        path.endsWith(".quote") &&
        !path.includes(".company_claims[")
      ) {
        add(path, reason);
        const sourcePath = path.replace(/\.quote$/, ".id");
        add(sourcePath, reason, {
          path,
          reason: "reference_source_and_quote_dependency",
        });
      } else expand(path, reason);
    }
  });
  if (options.trustedFindings) {
    const texts = textPaths(candidate);
    (options.findings ?? []).forEach((finding, index) => {
      const reason = `finding-${index}`,
        targets = new Set<string>();
      if (
        typeof finding.candidate_quote === "string" &&
        normalizedEvidence(finding.candidate_quote)
      ) {
        const matching = texts.filter((entry) =>
          normalizedEvidence(entry.text).includes(
            normalizedEvidence(finding.candidate_quote),
          ),
        );
        if (matching.length === 1) targets.add(matching[0].path);
      }
      const ids = [
        finding.requirement_id,
        ...(finding.requirement_ids ?? []),
      ].filter((id) => typeof id === "string");
      if (!targets.size && ids.length) {
        const matching = new Map<string, string>();
        for (const text of texts) {
          const root = unitPath(text.path),
            unit = patchValueAt(candidate, root);
          if (
            unit &&
            typeof unit === "object" &&
            (ids.includes(unit.requirement_id) ||
              unit.requirement_ids?.some((id: string) => ids.includes(id)) ||
              unit.source_refs?.some((ref: any) => ids.includes(ref.id)))
          )
            matching.set(root, text.path);
        }
        // A source-block check can cover several obligations. It cannot
        // authorize rewriting every obligation merely because they cite it.
        if (matching.size === 1) targets.add([...matching.values()][0]);
        else if (
          options.task === "analyze_chunk" &&
          Array.isArray(candidate.requirements)
        )
          add(
            "$.requirements",
            reason,
            {
              path: "$.requirements",
              reason:
                "append_omitted_source_obligation_without_rewriting_existing_units",
            },
            "append",
          );
      }
      if (!targets.size) unresolved.push(reason);
      for (const path of targets) expand(path, reason);
    });
  }
  // Remove redundant descendants when a typed parent replacement is allowed.
  // Array unit removal is applied separately and never broadens other units.
  for (const [path, entry] of selected)
    if (
      [...selected].some(
        ([ancestor, parent]) =>
          parent.operation === "replace" &&
          ancestor !== path &&
          (path.startsWith(ancestor + ".") || path.startsWith(ancestor + "[")),
      )
    )
      selected.delete(path);
  const paths: SemanticPatchPath[] = [];
  for (const [path, entry] of [...selected].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const unitHash = await sha256(
      canonicalPatchValue(patchValueAt(candidate, entry.unit)),
    );
    paths.push({
      path,
      operation: entry.operation,
      unit_id: await sha256(`${candidateHash}:${entry.unit}:${unitHash}`),
      unit_path: entry.unit,
      unit_hash: unitHash,
      previous_hash: await sha256(
        canonicalPatchValue(
          entry.operation === "add"
            ? { absent: true }
            : patchValueAt(candidate, path),
        ),
      ),
      reason_ids: [...entry.reasons].sort(),
      dependencies: entry.dependencies.sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    });
  }
  const body = {
    version: 1 as const,
    target_task: options.task,
    candidate_hash: candidateHash,
    paths,
    diagnostic_count: diagnostics.length,
    omitted_diagnostic_count:
      (options.omittedDiagnosticCount ?? 0) +
      (options.diagnostics?.length ?? 0) -
      diagnostics.length,
    unresolved_finding_ids: unresolved,
  };
  return { ...body, scope_hash: await sha256(canonicalPatchValue(body)) };
}

function unwrapped(schema: any, value: any): any {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return unwrapped(schema.unwrap(), value);
  if (
    schema instanceof z.ZodUnion ||
    schema instanceof z.ZodDiscriminatedUnion
  ) {
    const option = (schema.options as any[]).find(
      (item: any) => item.safeParse(value).success,
    );
    if (!option) throw new ModelError("MODEL_IDENTITY_CHANGED");
    return unwrapped(option, value);
  }
  return schema;
}
function schemaAt(schema: z.ZodType, candidate: any, path: string): z.ZodType {
  let current: any = schema,
    value = candidate;
  for (const key of patchPathKeys(path)) {
    current = unwrapped(current, value);
    current =
      typeof key === "number" && current instanceof z.ZodArray
        ? current.element
        : current instanceof z.ZodObject
          ? current.shape[key]
          : undefined;
    if (!current) throw new ModelError("MODEL_IDENTITY_CHANGED");
    value = value[key];
  }
  return current;
}
export function semanticPatchOutputSchema(
  scope: SemanticPatchScope,
  candidate: any,
  targetSchema: z.ZodType,
) {
  if (!scope.paths.length) throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
  const operations = scope.paths.map((path) => {
    let value = schemaAt(targetSchema, candidate, path.path);
    if (path.operation === "append") {
      const array = unwrapped(value, patchValueAt(candidate, path.path));
      if (!(array instanceof z.ZodArray))
        throw new ModelError("MODEL_IDENTITY_CHANGED");
      value = array.element as z.ZodType;
    } else if (path.operation === "remove") value = z.null();
    return z
      .object({
        operation: z.literal(path.operation),
        path: z.literal(path.path),
        unit_id: z.literal(path.unit_id),
        previous_hash: z.literal(path.previous_hash),
        reason_ids: z
          .array(z.enum(path.reason_ids as [string, ...string[]]))
          .min(1)
          .max(path.reason_ids.length),
        value,
      })
      .strict();
  });
  return z
    .object({
      version: z.literal(1),
      target_task: z.literal(scope.target_task),
      base_candidate_hash: z.literal(scope.candidate_hash),
      scope_hash: z.literal(scope.scope_hash),
      operations: z.array(z.union(operations)).min(1).max(scope.paths.length),
    })
    .strict();
}

export async function applySemanticPatch(
  candidate: any,
  proposed: any,
  scope: SemanticPatchScope,
  targetSchema: z.ZodType,
) {
  if ((await sha256(JSON.stringify(candidate))) !== scope.candidate_hash)
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const patch = semanticPatchOutputSchema(scope, candidate, targetSchema).parse(
    proposed,
  );
  const requested = new Set(
    patch.operations.map((operation) => operation.path),
  );
  for (const operation of patch.operations) {
    const allowed = scope.paths.find((path) => path.path === operation.path)!;
    for (const dependency of allowed.dependencies)
      if (
        dependency.reason.startsWith("required_") &&
        !requested.has(dependency.path)
      )
        throw new ModelError("MODEL_OUTPUT_INVALID");
  }
  const seen = new Set<string>(),
    composed = structuredClone(candidate),
    removals: { parent: any[]; index: number }[] = [];
  const applied: {
    path: string;
    operation: string;
    reason_ids: string[];
    dependencies: Dependency[];
  }[] = [];
  for (const operation of patch.operations) {
    if (seen.has(operation.path)) throw new ModelError("MODEL_OUTPUT_INVALID");
    seen.add(operation.path);
    const allowed = scope.paths.find((path) => path.path === operation.path)!;
    if (
      (await sha256(
        canonicalPatchValue(patchValueAt(candidate, allowed.unit_path)),
      )) !== allowed.unit_hash ||
      (await sha256(
        canonicalPatchValue(
          allowed.operation === "add"
            ? { absent: true }
            : patchValueAt(candidate, allowed.path),
        ),
      )) !== allowed.previous_hash
    )
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    const { parent, key } = parentAt(composed, operation.path);
    if (operation.operation === "add" && Object.hasOwn(parent, key))
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    if (operation.operation === "append")
      parent[key].push(structuredClone(operation.value));
    else if (operation.operation === "remove") {
      if (
        !/^\$\.company_claims\[[0-9]+\]$/.test(operation.path) ||
        !Array.isArray(parent) ||
        typeof key !== "number"
      )
        throw new ModelError("MODEL_OUTPUT_INVALID");
      removals.push({ parent, index: key });
    } else parent[key] = structuredClone(operation.value);
    applied.push({
      path: allowed.path,
      operation: allowed.operation,
      reason_ids: [...new Set(operation.reason_ids)],
      dependencies: allowed.dependencies,
    });
  }
  for (const removal of removals.sort((a, b) => b.index - a.index))
    removal.parent.splice(removal.index, 1);
  const derived: {
    path: string;
    rule: string;
    minimum: string;
    value: string;
  }[] = [];
  if (scope.target_task === "plan_commercial") {
    const affected = new Set(
      patch.operations
        .map(
          (operation) =>
            operation.path.match(
              /^(\$\.tasks\[[0-9]+\])\.(?:effort_days|allocation|duration_days)$/,
            )?.[1],
        )
        .filter((path): path is string => Boolean(path)),
    );
    const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_CEIL });
    for (const path of affected) {
      const task = patchValueAt(composed, path);
      if (task.effort_days === null || task.allocation === null) continue;
      if (
        ![task.effort_days, task.allocation].every(
          (value) =>
            typeof value === "string" &&
            /^\d{1,9}(?:\.\d{1,6})?$/.test(value) &&
            new D(value).gt(0),
        )
      )
        throw new ModelError("MODEL_OUTPUT_INVALID");
      const minimum = new D(task.effort_days)
        .div(task.allocation)
        .toDecimalPlaces(6, Decimal.ROUND_CEIL);
      if (
        task.duration_days !== null &&
        (typeof task.duration_days !== "string" ||
          !/^\d{1,9}(?:\.\d{1,6})?$/.test(task.duration_days))
      )
        throw new ModelError("MODEL_OUTPUT_INVALID");
      const duration =
        task.duration_days === null
          ? minimum
          : D.max(minimum, task.duration_days);
      if (duration.toString() !== task.duration_days) {
        if (
          !scope.paths.some(
            (allowed) => allowed.path === `${path}.duration_days`,
          )
        )
          throw new ModelError("MODEL_OUTPUT_INVALID");
        task.duration_days = duration.toString();
        derived.push({
          path: `${path}.duration_days`,
          rule: "duration_at_least_effort_divided_by_allocation",
          minimum: minimum.toString(),
          value: duration.toString(),
        });
      }
    }
  }
  const result: any = targetSchema.parse(composed);
  return {
    result,
    receipt: {
      version: 1,
      base_candidate_hash: scope.candidate_hash,
      candidate_hash: await sha256(canonicalPatchValue(result)),
      candidate_hash_kind: "canonical_json_v1",
      scope_hash: scope.scope_hash,
      applied,
      derived,
      omitted_diagnostic_count: scope.omitted_diagnostic_count,
      unresolved_finding_ids: scope.unresolved_finding_ids,
    },
  };
}

export const SEMANTIC_PATCH_INSTRUCTIONS =
  "Return only the versioned patch schema. Copy the pinned base candidate hash, scope hash, unit IDs and previous value hashes. Replace or append only application-authorized paths, and cite their supplied reason IDs. Dependency paths have been authorized by the application's recorded task-field relationships, not by your preference. Never replace the whole candidate, reorder an array, remove a buyer obligation, modify another unit, approve a review, invent supporting evidence or lower an obligation because company proof is missing. Unlisted and overflow defects remain unresolved. The server composes and validates the whole new candidate and independently verifies it; a patch is not evidence that the result is correct.";
