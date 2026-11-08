/** Actual image context, prompt and DOCX functions. Only synthetic fixtures. */
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const product = "/app/backend/supabase/functions/_shared/";
const { taskInput } = await import(product + "generation.ts");
const { modelPrompt, sha256, writingGuide } = await import(product + "model.ts");
const { modelSchemas } = await import(product + "modelSchemas.ts");
const { buildExportModel, exportParagraphs, verifyExportDocx } = await import(product + "export.ts");
const renderer = "/app/frontend/src/lib/renderDocx.ts";
const { renderDocx } = await import(renderer);
const baseline = runtime.env.get("NATIVE_BASELINE_MODE") === "true";
const check = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const equal = (a: unknown, b: unknown, code: string) => check(JSON.stringify(a) === JSON.stringify(b), code);
/** Synthetic inputs only; never customer or company claims. */
function commercialInputContext(): any {
  const source = {
    id: "rfp",
    text: "Provide a commercial delivery plan using the term RACI.",
    kind: "rfp",
    verified: false,
    reference: {
      entity_kind: "document",
      entity_id: "synthetic-rfp",
      content_hash: "a".repeat(64),
    },
  };
  return {
    plan: {
      id: "synthetic-plan",
      stage: "commercial",
      frozen_context: {
        notice: {
          id: "notice",
          text: "Synthetic tender.",
          kind: "notice",
          verified: false,
          reference: {
            entity_kind: "opportunity",
            entity_id: "synthetic-opportunity",
            content_hash: "b".repeat(64),
          },
        },
        blocks: [source],
        knowledge: [],
        reviews: [],
        rates: [],
        template: { id: "synthetic-template", required_sections: [] },
      },
    },
    step: {
      id: "synthetic-step",
      task: "plan_commercial",
      input: { requirement_ids: ["r-1"] },
    },
    requirements: [
      {
        id: "r-1",
        text: "Provide a commercial delivery plan.",
        category: "commercial",
        mandatory: true,
        interpretation: "Proposed delivery.",
        acceptance_evidence: "Review the plan.",
        owner_question: null,
        source_refs: [{ id: "rfp", quote: source.text }],
      },
    ],
    steps: [
      {
        task: "draft_section",
        status: "completed",
        input: {
          section: {
            key: "approach",
            title: "Proposed approach",
            volume: "technical",
            requirement_ids: ["r-1"],
          },
        },
        output: {
          section_key: "approach",
          title: "Proposed approach",
          volume: "technical",
          requirement_ids: ["r-1"],
          content_blocks: [
            { type: "paragraph", text: "Proposed delivery using RACI." },
          ],
          assumptions: [],
          evidence_refs: [{ id: "rfp", quote: source.text }],
          company_claims: [],
          questions: [],
        },
      },
    ],
  };
}

const phases = ["plan_commercial", "repair_result", "verify_grounding"] as const;
const languages = ["en", "ar"] as const;
const policies = ["legacy", "pinned"] as const;
function phaseContext(input: any, phase: typeof phases[number]) {
  if (phase === "plan_commercial") return input.context;
  return { [phase === "repair_result" ? "target_task" : "original_task"]: "plan_commercial",
    original_context: input.context };
}
function wire(input: any, language: typeof languages[number], phase: typeof phases[number], policy: typeof policies[number]) {
  // Current commercial phases use semantic 5 and verification 5; the revision-6
  // batch context is separate from the analysis-only verification prompt 6.
  return modelPrompt(phase, phaseContext(input, phase), input.evidence, input.requiredIds,
    language, false, policy === "pinned" ? 5 : 1, policy === "pinned" ? 5 : 0);
}
const original = commercialInputContext(), fixtureBefore = JSON.stringify(original);
const fixture_input_sha256 = await sha256(fixtureBefore);
const legacy_context_sha256: Record<string, string> = {};
const legacy_wire_sha256: Record<string, string> = {};
const modern_wire_sha256: Record<string, string> = {};
const checks: Record<string, boolean> = {};
const legacy = taskInput(original);
for (const version of ["absent", "1"]) {
  const context = commercialInputContext();
  if (version === "1") context.step.input.commercial_input_version = 1;
  const before = JSON.stringify(context), input = taskInput(context);
  equal(JSON.stringify(context), before, "CONTEXT_INPUT_MUTATED");
  equal(input, legacy, "VERSION1_CONTEXT_CHANGED");
  legacy_context_sha256[`${version}:context`] = await sha256(JSON.stringify(input.context));
  legacy_context_sha256[`${version}:task_input`] = await sha256(JSON.stringify(input));
  for (const language of languages) for (const phase of phases) for (const policy of policies) {
    const text = wire(input, language, phase, policy);
    legacy_wire_sha256[`${language}:${phase}:${version}:${policy}`] = await sha256(text);
    check(JSON.parse(text).writing_guide === writingGuide[language], "LEGACY_WRITING_GUIDE_CHANGED");
  }
}
check(legacy_context_sha256["absent:context"] === "06adbc3a7d27eaf929c02a8cf7d3b73c067f23b98f5bb6fbbc259fdef97b3aee", "FROZEN_CONTEXT_CHANGED");
check(legacy_context_sha256["absent:task_input"] === "37bf0a8756052bca7f8334d3104232e5c114bf90e557264f5fdff73ed3c168b6", "FROZEN_TASK_INPUT_CHANGED");
check(legacy_wire_sha256["en:plan_commercial:absent:legacy"] === "b3be21beda8357d7c531400bb84ed2c0cba60585b7ad679c816eecdd6fdcdfca", "FROZEN_COMMERCIAL_WIRE_CHANGED");
checks.legacy_context_bytes_retained = true;
checks.legacy_prompt_bytes_retained = true;
if (!baseline) {
  const context = commercialInputContext();
  context.step.input.commercial_input_version = 2;
  context.step.input.commercial_predecessor_job_id = "synthetic-old-commercial-job";
  context.steps.push({ task: "plan_commercial", status: "failed", input: {}, output: { private: "synthetic-old-candidate" } });
  context.predecessor_usage = { private: "synthetic-old-paid-history" };
  const before = JSON.stringify(context), modern = taskInput(context);
  equal(JSON.stringify(context), before, "MODERN_INPUT_MUTATED");
  check(modern.context.commercial_input_version === 2, "MODERN_VERSION_NOT_BOUND");
  for (const field of ["evidence", "requiredIds", "manifest"]) equal(modern[field], legacy[field], "MODERN_EVIDENCE_CHANGED");
  const { instruction: _modernInstruction, commercial_input_version: _version, ...rest } = modern.context;
  const { instruction: _oldInstruction, ...oldRest } = legacy.context;
  equal(rest, oldRest, "MODERN_CONTEXT_SCOPE_CHANGED");
  const instruction = modern.context.instruction;
  for (const required of ['tax_category as the empty string ("")',
    "quantity, rate_id, period_count, effort_days, allocation and duration_days null",
    "approved tax category and applicable rate, quantities, periods, effort and resource availability",
    "Never put JSON, schema constraints, field types, validators", "advisory clarification question"])
    check(instruction.includes(required), "MODERN_BUSINESS_INSTRUCTION_MISSING");
  for (const language of languages) {
    let selectedGuide: string | undefined;
    for (const phase of phases) for (const policy of policies) {
      const text = wire(modern, language, phase, policy), prompt = JSON.parse(text);
      check(prompt.writing_guide !== writingGuide[language], "MODERN_GUIDE_NOT_SELECTED");
      check(!prompt.writing_guide.includes("Define abbreviations at first use") &&
        !prompt.writing_guide.includes("اذكر المقابل الإنجليزي الكامل"), "MODERN_ACRONYM_GUIDE_CONFLICT");
      selectedGuide ??= prompt.writing_guide;
      check(prompt.writing_guide === selectedGuide, "MODERN_PHASE_GUIDE_CHANGED");
      for (const forbidden of ["synthetic-old-commercial-job", "synthetic-old-candidate", "synthetic-old-paid-history"])
        check(!text.includes(forbidden), "HISTORICAL_PRIVATE_INPUT_LEAK");
      check(text.includes("RACI") && !text.includes("Responsible, Accountable"), "UNSUPPLIED_DEFINITION_ADDED");
      modern_wire_sha256[`${language}:${phase}:${policy}`] = await sha256(text);
      check(modern_wire_sha256[`${language}:${phase}:${policy}`] !==
        legacy_wire_sha256[`${language}:${phase}:absent:${policy}`], "MODERN_WIRE_IDENTITY_UNCHANGED");
    }
    const unrelated = JSON.parse(modelPrompt("draft_section", modern.context, modern.evidence, modern.requiredIds, language));
    check(unrelated.writing_guide === writingGuide[language], "UNRELATED_GUIDE_CHANGED");
  }
  for (const marker of [undefined, 1, "2", null]) {
    const input = commercialInputContext(); input.step.input.commercial_input_version = marker;
    equal(taskInput(input), legacy, "NON_NUMERIC_VERSION_ACTIVATED");
  }
  const unrelated = commercialInputContext(); unrelated.step.task = "review_proposal";
  const oldUnrelated = taskInput(unrelated); unrelated.step.input.commercial_input_version = 2;
  equal(taskInput(unrelated), oldUnrelated, "UNRELATED_TASK_CONTEXT_CHANGED");
  checks.version2_context_bound = true;
  checks.version2_business_guidance = true;
  checks.history_excluded_from_prompt = true;
  checks.version2_scope_is_exact = true;
}

const result = {
  lines: [{ description: "Proposed planning", quantity: null, unit: "package", rate_id: null,
    period_count: null, included_in_base: true, charge_group: "one_time", tax_category: "",
    requirement_ids: ["r-1"], section_ids: ["approach"], deliverable: "Proposed delivery plan",
    basis: "Scope confirmation required." }],
  tasks: [{ key: "planning", title: "Proposed planning", predecessors: [], role: "Role to be confirmed",
    effort_days: null, allocation: null, duration_days: null, basis: "Effort confirmation required." }],
  questions: [
    { question: "Which approved tax category and rate should apply?", blocking_level: "finalization", requirement_ids: ["r-1"] },
    { question: "Please confirm the intended RACI terminology for the proposed scope.", blocking_level: "advisory", requirement_ids: ["r-1"] },
  ],
};
const resultBefore = JSON.stringify(result);
equal(modelSchemas.plan_commercial.parse(result), result, "NULLABLE_COMMERCIAL_CONTRACT_CHANGED");
for (const patch of [{ tax_category: null }, { charge_group: "approved" }])
  check(!modelSchemas.plan_commercial.safeParse({ ...result, lines: [{ ...result.lines[0], ...patch }] }).success, "INVALID_COMMERCIAL_CONTRACT_ACCEPTED");
checks.commercial_schema_retained = true;
const fonts = Object.fromEntries(await Promise.all(["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"]
  .map(async name => [name, await runtime.readFile(`/app/frontend/public/fonts/${name}.ttf`)])));
const renders: Record<string, unknown> = {};
async function bytesHash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
}
for (const language of languages) {
  const request = { id: "synthetic-commercial-native", mode: "draft", volume: "combined", created_at: "2026-11-08T00:00:00Z",
    snapshot: { language, title: "Synthetic proposal", opportunity_title: "Synthetic opportunity", ordinal: 1,
      template: {}, sections: [], requirements: [], compliance: [], commercial_draft: result,
      questions: result.questions, export_renderer_version: "ordinary-2" } };
  const requestBefore = JSON.stringify(request), model = buildExportModel(request);
  const visible = exportParagraphs(model).join("\n");
  const taxLabel = language === "en" ? "Tax category: [INPUT REQUIRED: tax category]" : "الفئة الضريبية: [INPUT REQUIRED: الفئة الضريبية]";
  check(visible.includes(taxLabel), "MISSING_TAX_LABEL_NOT_RENDERED");
  check(!/JSON|schema|validator|field type/.test(visible), "IMPLEMENTATION_COMMENTARY_RENDERED");
  const modelBefore = JSON.stringify(model), bytes = new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
  check(verifyExportDocx(bytes, model) === true, "ACTUAL_DOCX_VERIFICATION_FAILED");
  equal(JSON.stringify(model), modelBefore, "RENDER_MODEL_MUTATED");
  equal(JSON.stringify(request), requestBefore, "RENDER_REQUEST_MUTATED");
  renders[language] = { model_sha256: await sha256(modelBefore), text_sha256: await sha256(visible),
    docx_sha256: await bytesHash(bytes), bytes: bytes.length, verified: true, missing_tax_label: true };
}
checks.localized_docx_verified = true;
equal(JSON.stringify(original), fixtureBefore, "ORIGINAL_INPUT_MUTATED");
equal(JSON.stringify(result), resultBefore, "COMMERCIAL_RESULT_MUTATED");
checks.inputs_unchanged = true;
const source_sha256: Record<string, string> = {};
async function collectBytes(relative: string) {
  for await (const entry of runtime.readDir("/app/" + relative)) {
    const path = relative + "/" + entry.name;
    if (entry.isDirectory) await collectBytes(path);
    else if (entry.isFile) source_sha256[path] = await bytesHash(await runtime.readFile("/app/" + path));
    else throw new Error("UNSUPPORTED_IMAGE_SOURCE_TYPE");
  }
}
for (const root of ["backend/supabase/functions", "backend/scripts/runtime", "frontend/public/fonts"]) await collectBytes(root);
for (const file of ["frontend/src/lib/renderDocx.ts", "frontend/src/lib/docxTableStream.ts"])
  source_sha256[file] = await bytesHash(await runtime.readFile("/app/" + file));
console.log(JSON.stringify({ version: 1, baseline, passed: true, checks, source_sha256, fixture_input_sha256,
  legacy_context_sha256, legacy_wire_sha256, modern_wire_sha256, renders, provider_calls: 0,
  scope: "Actual immutable-image context/prompt and DOCX renderer/verifier; synthetic inputs only, no visual/customer acceptance." }));
