/** Actual scoped-patch preparation/application from authored failed candidates. */
import { readFile } from "node:fs/promises";
import { CORPUS_SHA256, sha256, type publicCase } from "./reserve.mjs";
import { buildAuthoredWorkflowInput } from "./reserve-workflow-adapters.ts";
import { ModelError } from "../../supabase/functions/_shared/model.ts";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas.ts";
import { sourceTaskOutputSchema } from "../../supabase/functions/_shared/sourceEvidence.ts";
import { pinRepairFormat } from "../../supabase/functions/_shared/modelRepairFormat.ts";
import {
  semanticPatchOutputSchema,
  applySemanticPatch,
  canonicalPatchValue,
  SEMANTIC_PATCH_INSTRUCTIONS,
} from "../../supabase/functions/_shared/modelSemanticPatch.ts";
export const REPAIR_PREREQUISITES_SHA256 =
  "f5a9fa7b26c090e11e91b568477d1fbd10f5c70bb643a0081c950660a9556d58";
const url = new URL(
  "../../tests/backend/fixtures/qualification-reserve/repair-prerequisites-v1.json",
  import.meta.url,
);
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export async function loadRepairPrerequisites() {
  const bytes = await readFile(url);
  check(
    sha256(bytes) === REPAIR_PREREQUISITES_SHA256,
    "RESERVE_REPAIR_PREREQUISITES_CHANGED",
  );
  const value = JSON.parse(bytes.toString());
  check(
    value.version === 1 &&
      value.corpus_sha256 === CORPUS_SHA256 &&
      value.cases.length === 2,
    "RESERVE_REPAIR_CENSUS",
  );
  return value;
}
export async function buildRepairInput(
  caseId: string,
  material: ReturnType<typeof publicCase>,
  phase: { store: any; backend: any; job: { id: string; lease_token: string } },
) {
  const fixture = (await loadRepairPrerequisites()).cases.find(
    (r: any) => r.case_id === caseId,
  );
  check(
    fixture &&
      fixture.target_task === "draft_section" &&
      material.workflow_facts.target_task === "draft_section",
    "RESERVE_REPAIR_TARGET",
  );
  check(
    JSON.stringify(fixture.allowed_parent_paths) ===
      JSON.stringify(material.workflow_facts.allowed_paths),
    "RESERVE_REPAIR_SCOPE_CHANGED",
  );
  const original = await buildAuthoredWorkflowInput(
    caseId,
    { ...material, task: "draft_section" },
    fixture.workflow,
    REPAIR_PREREQUISITES_SHA256,
  );
  const span = original.context.source_evidence.spans[0];
  check(
    material.documents[0].text === fixture.candidate_content &&
      !span.quote.includes(fixture.fault.quote) &&
      fixture.fault.kind === "existing_source_wrong_quote" &&
      fixture.fault.path === "$.evidence_refs[0].quote",
    "RESERVE_REPAIR_FAULT_CHANGED",
  );
  const candidate = {
    key: original.context.section.key,
    title: original.context.section.title,
    content_blocks: [{ type: "paragraph", text: fixture.candidate_content }],
    requirement_ids: original.requiredIds,
    evidence_refs: [{ id: span.id, quote: fixture.fault.quote }],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  let invalid: ModelError | undefined;
  try {
    original.domainValidate(candidate);
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    invalid = error;
  }
  check(
    invalid && invalid.validationDiagnostics.length > 0,
    "RESERVE_REPAIR_FAULT_NOT_REPRODUCED",
  );
  check(
    invalid.validationDiagnostics.every(
      (d) =>
        d.reason === "source_quote_mismatch" &&
        d.paths.every((p) => p === fixture.fault.path),
    ) && invalid.omittedValidationDiagnosticCount === 0,
    "RESERVE_REPAIR_DIAGNOSTICS_CHANGED",
  );
  const before = {
    target_task: "draft_section",
    original_context: original.context,
    candidate,
    findings: [],
    validation_diagnostics: invalid.validationDiagnostics,
    validation_instruction:
      "These are unresolved validation findings and untrusted verifier hints, not established facts. Recheck the candidate against original evidence; repair unsupported content or state the missing input explicitly. Preserve all justified semantic findings. Never manufacture evidence or discard a buyer obligation to satisfy a validator.",
  };
  const scope = await pinRepairFormat({
    backend: phase.backend,
    store: phase.store,
    job: phase.job,
    requestPrefix: `reserve:${caseId}`,
    context: before,
    evidence: original.evidence,
    requiredIds: original.requiredIds,
    language: material.language as "en" | "ar",
  });
  check(
    scope &&
      scope.paths.length === 1 &&
      scope.paths.every((p) =>
        fixture.allowed_parent_paths.some(
          (parent: string) =>
            p.path.startsWith(parent + "[") || p.path.startsWith(parent + "."),
        ),
      ),
    "RESERVE_REPAIR_DERIVED_SCOPE_OUTSIDE_FROZEN_PARENT",
  );
  const context = {
    ...before,
    repair_patch_scope: scope,
    repair_patch_instruction: SEMANTIC_PATCH_INSTRUCTIONS,
  };
  const schema = sourceTaskOutputSchema(
    scope.target_task,
    context,
    modelSchemas[scope.target_task],
  );
  let receipt:
    Awaited<ReturnType<typeof applySemanticPatch>>["receipt"] | undefined;
  const wireHooks = {
    wireOutputSchema: semanticPatchOutputSchema(scope, candidate, schema),
    transformCandidate: async (wire: unknown) => {
      const applied = await applySemanticPatch(candidate, wire, scope, schema);
      receipt = applied.receipt;
      return {
        target_task: scope.target_task,
        result: applied.result,
        changes: applied.receipt.applied
          .map((o) => `${o.operation}:${o.path}`)
          .slice(0, 30),
      };
    },
    validateCandidateScope: async (value: any) => {
      if (!receipt) throw new ModelError("MODEL_IDENTITY_CHANGED");
      receipt.candidate_hash = sha256(canonicalPatchValue(value.result));
    },
  };
  return {
    context,
    evidence: original.evidence,
    manifest: original.manifest,
    requiredIds: original.requiredIds,
    wireHooks,
    domainValidate: (value: any) => original.domainValidate(value.result),
    trace: {
      ...original.trace,
      context_constructor:
        "actual authored draft taskInput + validator diagnostics + pinRepairFormat + semanticPatchOutputSchema/applySemanticPatch + target domain validation",
      repair_prerequisites_sha256: REPAIR_PREREQUISITES_SHA256,
      candidate_origin: "authored_failed_draft",
      prior_provider_success: false,
      prior_semantic_approval: false,
      candidate_sha256: scope.candidate_hash,
      scope_sha256: scope.scope_hash,
      derived_patch_paths: scope.paths.map((p) => p.path),
      frozen_allowed_parent_paths: fixture.allowed_parent_paths,
      validation_diagnostic_count: invalid.validationDiagnostics.length,
      omitted_diagnostic_count: 0,
    },
  };
}
