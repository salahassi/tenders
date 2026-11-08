/** Image-bound regression proof. Import the exported validator from /app;
 * no product overlay, database, transport, credentials or generated customer data. */
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const product = "/app/backend/supabase/functions/_shared/";
const { candidateContent, validateGroundingReport } = await import(product + "modelGrounding.ts");
const { ModelError, sha256 } = await import(product + "model.ts");
const baseline = runtime.env.get("NATIVE_BASELINE_MODE") === "true";
const check = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const equal = (a: unknown, b: unknown, code: string) => check(JSON.stringify(a) === JSON.stringify(b), code);
const sourceUuid = "12345678-abcd-4abc-8abc-abcdef123456";
const requirementUuid = "abcdef12-abcd-4abc-8abc-abcdef123456";
const namespaced = `proposal-review:${sourceUuid}`;
type Group = "colon" | "unknown" | "number" | "retained";
interface Case { name: string; group: Group; text: string; id?: string; requiredId?: string; source?: string }
const cases: Case[] = [];
for (const [kind, id] of [["plain", sourceUuid], ["namespaced", namespaced], ["requirement", requirementUuid]]) {
  for (const [delimiter, text] of [["space", " "], ["double_quote", '"'], ["single_quote", "'"],
    ["left_double", "“"], ["right_double", "”"], ["left_single", "‘"], ["right_single", "’"], ["end", ""]]) {
    cases.push({ name: `known_${kind}_colon_${delimiter}`, group: "colon", text: `Source ${id}:${text}`,
      id: kind === "namespaced" ? namespaced : sourceUuid,
      requiredId: kind === "requirement" ? requirementUuid : undefined });
  }
}
cases.push(
  { name: "unknown_uuid", group: "unknown", text: 'Source 87654321-abcd-4abc-8abc-abcdef123456: "Review."' },
  { name: "unknown_namespace", group: "unknown", text: `Source invented:${sourceUuid}: "Review."` },
  { name: "wrapped_namespace", group: "unknown", id: namespaced, text: `Source invented:${namespaced}: "Review."` },
  { name: "colon_suffix", group: "unknown", text: `Source ${sourceUuid}:suffix` },
  { name: "colon_version", group: "unknown", text: `Source ${sourceUuid}:v2` },
  { name: "double_colon", group: "unknown", text: `Source ${sourceUuid}:: "Review."` },
  { name: "embedded_prefix", group: "unknown", text: `Source prefix-${sourceUuid}: "Review."` },
  { name: "underscore_suffix", group: "unknown", text: `Source ${sourceUuid}_suffix: "Review."` },
  { name: "namespaced_suffix", group: "unknown", id: namespaced, text: `Source ${namespaced}:v2` },
  { name: "unscoped_requirement", group: "unknown", text: `Requirement ${requirementUuid}: "Review."` },
  { name: "adjacent_quantity", group: "number", text: `Source ${sourceUuid}: 50 engineers.` },
  { name: "quoted_quantity", group: "number", text: `Source ${sourceUuid}:"50 engineers."` },
  { name: "preceding_price", group: "number", text: `USD 50000 before source ${sourceUuid}: "Review."` },
  { name: "arabic_quantity", group: "number", text: `المصدر ${sourceUuid}: ٥٠ مهندسًا.` },
  { name: "namespaced_quantity", group: "number", id: namespaced, text: `Source ${namespaced}: 50 engineers.` },
  { name: "requirement_quantity", group: "number", requiredId: requirementUuid, text: `Requirement ${requirementUuid}: 50 engineers.` },
  { name: "plain_parentheses", group: "retained", text: `Confirm the design in source (${sourceUuid}).` },
  { name: "namespaced_period", group: "retained", id: namespaced, text: `Review the saved draft in ${namespaced}.` },
  { name: "requirement_parentheses", group: "retained", requiredId: requirementUuid, text: `Confirm the design for requirement (${requirementUuid}).` },
  { name: "supported_quantity", group: "retained", text: `Source (${sourceUuid}) requires 3 workshops.`, source: "The design requires 3 workshops." },
);
const caseResults: Record<string, { accepted: boolean; error_code: string | null; diagnostic_reasons: string[] }> = {};
const caseInputHashes: Record<string, string> = {};
for (const row of cases) {
  check(!(row.name in caseResults), "DUPLICATE_CASE");
  const id = row.id ?? sourceUuid, source = row.source ?? "The design requires documented review.";
  const requiredIds = row.requiredId ? [row.requiredId] : [];
  const candidate = { content_blocks: [{ type: "paragraph", text: row.text }] };
  const evidence = [{ id, text: source, kind: "notice", verified: false }];
  const candidateHash = await sha256(JSON.stringify(candidate));
  const report = {
    checked_candidate_hash: candidateHash, reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((unit: { id: string }) => unit.id),
    claims: [{ id: "claim-1", claim: row.text, candidate_quote: row.text, kind: "tender_fact", status: "supported",
      source_refs: [{ id, quote: source }], finding: "Synthetic reference boundary fixture." }],
    processed_requirement_ids: requiredIds,
    requirement_checks: requiredIds.map(requirement_id => ({ requirement_id, status: "supported",
      candidate_quote: row.text, source_refs: [{ id, quote: source }], finding: "Synthetic requirement mapping." })),
    findings: [],
  };
  const snapshot = () => JSON.stringify({ report, candidate, candidateHash, evidence, requiredIds });
  const before = snapshot();
  caseInputHashes[row.name] = await sha256(before);
  let outcome = { accepted: true, error_code: null as string | null, diagnostic_reasons: [] as string[] };
  try {
    // This is the changed runtime's public validator, not a copied pattern.
    validateGroundingReport(report, candidate, candidateHash, evidence, requiredIds);
  } catch (error: any) {
    check(error instanceof ModelError, "UNEXPECTED_VALIDATOR_EXCEPTION");
    outcome = { accepted: false, error_code: error.code,
      diagnostic_reasons: [...new Set<string>(error.validationDiagnostics.map((item: { reason: string }) => item.reason))].sort() };
  }
  equal(snapshot(), before, "VALIDATOR_MUTATED_INPUTS");
  const accepted = row.group === "retained" || row.group === "colon" && !baseline;
  equal(outcome, { accepted, error_code: accepted ? null : "EVIDENCE_REFERENCE_INVALID",
    diagnostic_reasons: accepted ? [] : ["numeric_evidence_mismatch"] }, "CASE_OUTCOME_CHANGED:" + row.name);
  caseResults[row.name] = outcome;
}
const source_sha256: Record<string, string> = {};
async function bytesHash(path: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await runtime.readFile(path)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function collectBytes(relative: string) {
  for await (const entry of runtime.readDir("/app/" + relative)) {
    const path = relative + "/" + entry.name;
    if (entry.isDirectory) await collectBytes(path);
    else if (entry.isFile) source_sha256[path] = await bytesHash("/app/" + path);
    else throw new Error("UNSUPPORTED_IMAGE_SOURCE_TYPE");
  }
}
for (const root of ["backend/supabase/functions", "backend/scripts/runtime", "frontend/public/fonts"]) await collectBytes(root);
for (const file of ["frontend/src/lib/renderDocx.ts", "frontend/src/lib/docxTableStream.ts"]) source_sha256[file] = await bytesHash("/app/" + file);
console.log(JSON.stringify({ version: 1, baseline, passed: true,
  checks: { known_identifier_colon_punctuation: true, unknown_or_extended_identifiers_rejected: true,
    unsupported_factual_numbers_rejected: true, existing_reference_behavior_retained: true, inputs_unchanged: true },
  case_results: caseResults, case_input_sha256: caseInputHashes, source_sha256, provider_calls: 0,
  scope: "Actual immutable-image validateGroundingReport; synthetic evidence and report inputs only." }));
