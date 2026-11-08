// @vitest-environment node
import { expect, it } from "vitest";
import { taskInput } from "../../supabase/functions/_shared/generation";
import {
  modelPrompt,
  sha256,
  writingGuide,
} from "../../supabase/functions/_shared/model";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { newVerificationBatchPin } from "../../supabase/functions/_shared/modelVerificationBatchContext";
import {
  buildExportModel,
  exportParagraphs,
} from "../../supabase/functions/_shared/export";
import { commercialInputContext } from "./commercialInputFixture";

const wire = (input: ReturnType<typeof taskInput>) =>
  modelPrompt(
    input.task,
    input.context,
    input.evidence,
    input.requiredIds,
    "en",
  );

it("keeps absent and version-1 commercial context and wire bytes at the frozen baseline", async () => {
  const context = commercialInputContext();
  const before = structuredClone(context);
  const absent = taskInput(context);
  expect(await sha256(JSON.stringify(absent.context))).toBe(
    "06adbc3a7d27eaf929c02a8cf7d3b73c067f23b98f5bb6fbbc259fdef97b3aee",
  );
  expect(await sha256(JSON.stringify(absent))).toBe(
    "37bf0a8756052bca7f8334d3104232e5c114bf90e557264f5fdff73ed3c168b6",
  );
  expect(await sha256(wire(absent))).toBe(
    "b3be21beda8357d7c531400bb84ed2c0cba60585b7ad679c816eecdd6fdcdfca",
  );
  context.step.input.commercial_input_version = 1;
  const version1 = taskInput(context);
  expect(JSON.stringify(version1)).toBe(JSON.stringify(absent));
  expect(wire(version1)).toBe(wire(absent));
  expect(absent.context).not.toHaveProperty("commercial_input_version");
  delete context.step.input.commercial_input_version;
  expect(context).toEqual(before);
  expect(newVerificationBatchPin("plan_commercial")).toEqual({
    version: 6,
    context_format: 4,
    partition: { version: 3 },
  });
});

it("binds the version-2 business input policy to a fresh prompt without changing its evidence or accepted sections", () => {
  const context = commercialInputContext();
  const legacy = taskInput(context);
  context.step.input.commercial_input_version = 2;
  context.step.input.commercial_predecessor_job_id = "old-commercial-job";
  context.steps.push({
    task: "plan_commercial",
    status: "failed",
    input: {},
    output: { private: "old-candidate-body" },
  });
  context.predecessor_usage = { private: "old-usage-body" };
  const before = structuredClone(context);
  const version2 = taskInput(context);
  expect(context).toEqual(before);
  expect(version2.context.commercial_input_version).toBe(2);
  expect(version2.evidence).toEqual(legacy.evidence);
  expect(version2.requiredIds).toEqual(legacy.requiredIds);
  expect(version2.manifest).toEqual(legacy.manifest);
  expect(version2.context.section_titles).toEqual(
    legacy.context.section_titles,
  );
  const {
    instruction: _instruction,
    commercial_input_version: _version,
    ...unchanged
  } = version2.context;
  const { instruction: _legacyInstruction, ...expected } = legacy.context;
  expect(unchanged).toEqual(expected);
  const prompt = wire(version2);
  expect(prompt).not.toBe(wire(legacy));
  expect(prompt).not.toContain("old-candidate-body");
  expect(prompt).not.toContain("old-usage-body");
  expect(prompt).not.toContain("old-commercial-job");
  expect(prompt).toContain("RACI");
  expect(prompt).not.toContain("Responsible, Accountable");
  expect(version2.context.instruction).toContain(
    'tax_category as the empty string ("")',
  );
  expect(version2.context.instruction).toContain(
    "quantity, rate_id, period_count, effort_days, allocation and duration_days null",
  );
  expect(version2.context.instruction).toContain(
    "approved tax category and applicable rate, quantities, periods, effort and resource availability",
  );
  expect(version2.context.instruction).toContain(
    "Never put JSON, schema constraints, field types, validators",
  );
  expect(version2.context.instruction).toContain(
    "advisory clarification question",
  );
});

it.each(["en", "ar"] as const)(
  "keeps %s acronym guidance consistent only for new commercial phases",
  (language) => {
    const context = commercialInputContext();
    context.step.input.commercial_input_version = 2;
    const input = taskInput(context);
    const modern = JSON.parse(
      modelPrompt(
        "plan_commercial",
        input.context,
        input.evidence,
        input.requiredIds,
        language,
      ),
    );
    expect(modern.writing_guide).not.toBe(writingGuide[language]);
    expect(modern.writing_guide).not.toContain(
      "Define abbreviations at first use",
    );
    expect(modern.writing_guide).not.toContain("اذكر المقابل الإنجليزي الكامل");
    for (const task of ["repair_result", "verify_grounding"] as const) {
      const phase = {
        [task === "repair_result" ? "target_task" : "original_task"]:
          "plan_commercial",
        original_context: input.context,
      };
      const prompt = JSON.parse(
        modelPrompt(task, phase, input.evidence, input.requiredIds, language),
      );
      expect(prompt.writing_guide).toBe(modern.writing_guide);
      const historical = {
        ...phase,
        original_context: { ...input.context, commercial_input_version: 1 },
      };
      expect(
        JSON.parse(
          modelPrompt(
            task,
            historical,
            input.evidence,
            input.requiredIds,
            language,
          ),
        ).writing_guide,
      ).toBe(writingGuide[language]);
    }
    const other = { ...input.context, commercial_input_version: 2 };
    expect(
      JSON.parse(
        modelPrompt(
          "draft_section",
          other,
          input.evidence,
          input.requiredIds,
          language,
        ),
      ).writing_guide,
    ).toBe(writingGuide[language]);
  },
);

it("requires a commercial task and the numeric version-2 marker before changing context", () => {
  for (const marker of [undefined, 1, "2", null]) {
    const context = commercialInputContext();
    context.step.input.commercial_input_version = marker;
    expect(taskInput(context).context).not.toHaveProperty(
      "commercial_input_version",
    );
  }
  const context = commercialInputContext();
  context.step.task = "review_proposal";
  const legacy = taskInput(context);
  context.step.input.commercial_input_version = 2;
  expect(taskInput(context)).toEqual(legacy);
});

it("uses existing nullable commercial fields and the existing text tax category contract", () => {
  const result = {
    lines: [
      {
        description: "Proposed planning",
        quantity: null,
        unit: "package",
        rate_id: null,
        period_count: null,
        included_in_base: true,
        charge_group: "one_time",
        tax_category: "",
        requirement_ids: ["r-1"],
        section_ids: ["approach"],
        deliverable: "Proposed delivery plan",
        basis: "Scope confirmation required.",
      },
    ],
    tasks: [
      {
        key: "planning",
        title: "Proposed planning",
        predecessors: [],
        role: "Role to be confirmed",
        effort_days: null,
        allocation: null,
        duration_days: null,
        basis: "Effort confirmation required.",
      },
    ],
    questions: [
      {
        question: "Which approved tax category and rate should apply?",
        blocking_level: "finalization",
        requirement_ids: ["r-1"],
      },
      {
        question:
          "Please confirm the intended RACI terminology for the proposed scope.",
        blocking_level: "advisory",
        requirement_ids: ["r-1"],
      },
    ],
  };
  expect(modelSchemas.plan_commercial.parse(result)).toEqual(result);
  expect(
    modelSchemas.plan_commercial.safeParse({
      ...result,
      lines: [{ ...result.lines[0], tax_category: null }],
    }).success,
  ).toBe(false);
  expect(
    modelSchemas.plan_commercial.safeParse({
      ...result,
      lines: [{ ...result.lines[0], charge_group: "approved" }],
    }).success,
  ).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(
    /JSON|schema|validator|field type/,
  );
  for (const [language, label] of [
    ["en", "Tax category: [INPUT REQUIRED: tax category]"],
    ["ar", "الفئة الضريبية: [INPUT REQUIRED: الفئة الضريبية]"],
  ]) {
    const rendered = buildExportModel({
      id: "synthetic-export",
      mode: "draft",
      volume: "combined",
      created_at: "2026-11-08T00:00:00Z",
      snapshot: {
        language,
        title: "Synthetic proposal",
        opportunity_title: "Synthetic opportunity",
        ordinal: 1,
        template: {},
        sections: [],
        requirements: [],
        compliance: [],
        commercial_draft: result,
        questions: [],
      },
    });
    expect(exportParagraphs(rendered).join("\n")).toContain(label);
  }
});
