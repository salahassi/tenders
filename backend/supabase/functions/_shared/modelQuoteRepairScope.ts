import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { ModelError, modelPrompt, sha256, type Evidence } from "./model.ts";
import { MAX_MODEL_VALIDATION_DIAGNOSTICS } from "./modelValidationDiagnostics.ts";

export type QuoteRepairScope = {
  version: 1;
  candidate_hash: string;
  allowed_paths: string[];
};
const quotePath = /^\$(?:\.[a-z][a-z0-9_]*|\[(?:0|[1-9][0-9]{0,5})\])*\.quote$/;
function pathKeys(path: string): (string | number)[] {
  if (!quotePath.test(path)) throw new ModelError("MODEL_IDENTITY_CHANGED");
  return [...path.matchAll(/\.([a-z][a-z0-9_]*)|\[([0-9]+)\]/g)].map(
    (match) => match[1] ?? Number(match[2]),
  );
}
function parentAt(value: any, path: string) {
  const keys = pathKeys(path);
  let parent = value;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
      throw new ModelError("MODEL_OUTPUT_INVALID");
    parent = parent[key];
  }
  const key = keys.at(-1)!;
  if (
    !parent ||
    typeof parent !== "object" ||
    !Object.hasOwn(parent, key) ||
    typeof parent[key] !== "string"
  )
    throw new ModelError("MODEL_OUTPUT_INVALID");
  return { parent, key };
}
const canonical = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** The complete legacy response schema remains on the wire. Treat it only as a
 * proposed patch: reject changes outside the application-owned quote paths,
 * then return a server-composed candidate. Never trust a changes summary. */
export function applyQuoteRepairScope(
  candidate: any,
  proposed: any,
  scope: QuoteRepairScope,
) {
  const composed = structuredClone(candidate);
  for (const path of scope.allowed_paths) {
    const original = parentAt(composed, path);
    const replacement = parentAt(proposed, path);
    original.parent[original.key] = replacement.parent[replacement.key];
  }
  if (canonical(composed) !== canonical(proposed))
    throw new ModelError("MODEL_OUTPUT_INVALID");
  return composed;
}

/** Pin before the first repair send. A historical paid/prepared phase retains
 * its exact old context even if its graph resumes under this newer runtime. */
export async function pinQuoteRepairScope(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string; checkpoint?: Record<string, any> };
  requestPrefix: string;
  context: any;
  evidence: Evidence[];
  requiredIds: string[];
  language: "en" | "ar";
}) {
  const diagnostics = o.context?.validation_diagnostics;
  // Semantic/report repair needs explicit dependency scope design. Do not
  // silently force it into quote-only edits or alter its historical behavior.
  if (
    !Array.isArray(diagnostics) ||
    !diagnostics.length ||
    o.context.untrusted_verification_report ||
    diagnostics.some(
      (d) =>
        d.code !== "EVIDENCE_REFERENCE_INVALID" ||
        !["source_quote_mismatch", "quote_empty"].includes(d.reason) ||
        !Array.isArray(d.paths) ||
        d.paths.length !== 1 ||
        !quotePath.test(d.paths[0]),
    )
  )
    return null;
  const paths = [...new Set<string>(diagnostics.map((d) => d.paths[0]))].sort();
  if (paths.length > MAX_MODEL_VALIDATION_DIAGNOSTICS)
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  for (const path of paths) parentAt(o.context.candidate, path);
  const candidateHash = await sha256(JSON.stringify(o.context.candidate));
  const legacyHash = await sha256(
    modelPrompt(
      "repair_result",
      o.context,
      o.evidence,
      o.requiredIds,
      o.language,
      true,
      1,
      0,
    ),
  );
  const prefixHash = await sha256(o.requestPrefix);
  const key = `quote-repair-scope-${prefixHash}`;
  let pin = await o.store.action("result_get", { key });
  if (!pin) {
    const semantic = await o.store.action("result_get", {
      key: `semantic-instructions-${prefixHash}`,
    });
    const started =
      semantic || o.job.checkpoint?.model_round?.input_hash === legacyHash
        ? true
        : await o.backend.internal("model_phase_started", {
            job_id: o.job.id,
            lease: o.job.lease_token,
            request_prefix: o.requestPrefix,
            legacy_input_hash: legacyHash,
          });
    if (typeof started !== "boolean")
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    pin = await o.store.action("result_put", {
      key,
      value: {
        version: started ? 0 : 1,
        candidate_hash: candidateHash,
        legacy_context_hash: legacyHash,
        allowed_paths: paths,
      },
    });
  }
  const value = pin.value;
  if (
    ![0, 1].includes(value?.version) ||
    value.candidate_hash !== candidateHash ||
    value.legacy_context_hash !== legacyHash ||
    canonical(value.allowed_paths) !== canonical(paths)
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return value.version === 0
    ? null
    : {
        version: 1 as const,
        candidate_hash: candidateHash,
        allowed_paths: paths,
      };
}
