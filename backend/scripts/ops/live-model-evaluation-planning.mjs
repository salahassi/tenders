/** Exact synthetic ownership failure retained for bounded planning repair QA. */
import { readFile } from "node:fs/promises";
import { ModelError } from "../../supabase/functions/_shared/model.ts";
import { extendedFixtures } from "./live-model-evaluation-extended.mjs";

export async function planningFixtures() {
  const blueprint = extendedFixtures().find((f) => f.task === "plan_blueprint");
  const candidate = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/blueprint-missing-owners.synthetic.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let diagnostics;
  try {
    blueprint.domainValidate(candidate);
  } catch (error) {
    if (
      error instanceof ModelError &&
      error.code === "MODEL_COVERAGE_INCOMPLETE" &&
      error.validationDiagnostics.length
    )
      diagnostics = error.validationDiagnostics;
    else throw error;
  }
  if (!diagnostics) throw new ModelError("EVAL_REPAIR_SOURCE_INVALID");
  return [
    {
      ...blueprint,
      id: "proposal_blueprint_ownership_v5",
      semanticRevision: 5,
    },
    {
      id: "repair_blueprint_missing_owners_v5",
      task: "repair_result",
      language: blueprint.language,
      semanticRevision: 5,
      evidence: blueprint.evidence,
      required: blueprint.required,
      context: {
        target_task: "plan_blueprint",
        original_context: blueprint.context,
        candidate,
        validation_diagnostics: diagnostics,
      },
      assertion_scope:
        "canonical_repair_contract_and_production_blueprint_ownership_and_decision_roles",
      domainValidate: (r) => blueprint.domainValidate(r.result),
      assert: (r) => blueprint.assert(r.result),
    },
  ];
}
