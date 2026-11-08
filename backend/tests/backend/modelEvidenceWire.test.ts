import { expect, it } from "vitest";
import {
  modelPrompt,
  sha256,
  type ModelTask,
} from "../../supabase/functions/_shared/model";
import {
  canonicalSourceSpanId,
  materializeSourceCandidate,
  validateSourceCandidate,
} from "../../supabase/functions/_shared/sourceEvidence";

const entity = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const text =
  "لا يجوز تعديل ٣ شروط؛ Preserve each exact condition 😀.\r\n".repeat(24);
const base = {
  version: 1 as const,
  entity_kind: "document" as const,
  entity_id: entity,
  content_hash: hash,
  extraction_version: "native-v1",
  block_id: entity,
  block_hash: hash,
  coordinate: "unicode_code_point" as const,
  start: 0,
  end: Array.from(text).length,
  quote: text,
  locator: { paragraph: 1 },
  authority: {
    version: 1 as const,
    decision_id: null,
    revision: 0,
    role: "unknown" as const,
    status: "unconfirmed" as const,
    supersedes: null,
    precedence: 0,
  },
};
const span = { ...base, id: canonicalSourceSpanId(base) };
const context = {
  source_contract_version: 1,
  repair_contract_version: 1,
  source_evidence: { version: 1, spans: [span], reviews: [] },
};
const reference = {
  entity_kind: "document",
  entity_id: entity,
  content_hash: hash,
};
const evidence = [
  {
    id: entity,
    kind: "rfp" as const,
    verified: false,
    text,
    reference,
    locator: base.locator,
  },
  {
    id: span.id,
    kind: "rfp" as const,
    verified: false,
    text,
    reference,
    source_span: span,
  },
];
const semantics = {
  version: 1,
  source_span_ids: [span.id],
  modality: "prohibited",
  actor: "supplier",
  negated: true,
  conditions: ["Preserve each condition"],
  exceptions: [],
  consequences: [],
  quantities: [],
  dates: [],
  authority_role: "unknown",
  authority_status: "unconfirmed",
  review_status: "pending",
  review_id: null,
};
const rawCandidate = {
  processed_block_ids: [entity],
  requirements: [
    {
      text: "model paraphrase",
      category: "scope",
      mandatory: true,
      interpretation: "Retain the prohibition and conditions.",
      acceptance_evidence: "Owner review",
      owner_question: "Confirm authority.",
      source_refs: [{ id: span.id }],
      source_semantics: semantics,
    },
  ],
  questions: [],
  separate_volumes: false,
  summary: "Source requires preserving its conditions.",
};

it.each(["analyze_chunk", "verify_grounding", "repair_result"] as ModelTask[])(
  "projects only redundant transport metadata for a newly pinned %s phase",
  (task) => {
    const phaseContext =
      task === "analyze_chunk"
        ? context
        : {
            [task === "verify_grounding" ? "original_task" : "target_task"]:
              "analyze_chunk",
            original_context: context,
          };
    const before = structuredClone({ phaseContext, evidence });
    const legacy = JSON.parse(
      modelPrompt(task, phaseContext, evidence, [entity], "ar", false, 5, 4),
    );
    const compact = JSON.parse(
      modelPrompt(task, phaseContext, evidence, [entity], "ar", false, 5, 6),
    );
    expect(compact.untrusted_data).toEqual(legacy.untrusted_data);
    expect(compact.analysis_evidence_contract).toEqual(
      legacy.analysis_evidence_contract,
    );
    expect(compact.evidence).toEqual(
      evidence.map(({ id, text, kind, verified }) => ({
        id,
        text,
        kind,
        verified,
      })),
    );
    expect(
      compact.evidence.every(
        (e: any) => !("source_span" in e) && !("locator" in e),
      ),
    ).toBe(true);
    expect(compact.prompt_version).toContain(".evidence-wire-v1.");
    expect({ phaseContext, evidence }).toEqual(before);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(legacy).length - JSON.stringify(span).length,
    );
  },
);

it("retains every internal citation and source-authority validation result", () => {
  const candidate = materializeSourceCandidate(
    "analyze_chunk",
    rawCandidate,
    context,
    evidence,
    true,
  );
  const before = structuredClone(candidate);
  const prompt = JSON.parse(
    modelPrompt(
      "analyze_chunk",
      context,
      evidence,
      [entity],
      "ar",
      false,
      1,
      6,
    ),
  );
  expect(prompt.untrusted_data.source_evidence).toEqual(
    context.source_evidence,
  );
  expect(() =>
    validateSourceCandidate("analyze_chunk", candidate, context, evidence),
  ).not.toThrow();
  expect(candidate).toEqual(before);
  const bad = structuredClone(candidate);
  bad.requirements[0].source_refs[0].quote += " invented";
  expect(() =>
    validateSourceCandidate("analyze_chunk", bad, context, evidence),
  ).toThrow();
});

it("rejects compact policy outside its validated analysis source contract", () => {
  expect(() =>
    modelPrompt("draft_section", context, evidence, [], "en", false, 1, 6),
  ).toThrow("MODEL_IDENTITY_CHANGED");
  expect(() =>
    modelPrompt("analyze_chunk", {}, evidence, [], "en", false, 1, 6),
  ).toThrow("MODEL_IDENTITY_CHANGED");
  expect(() =>
    modelPrompt(
      "analyze_chunk",
      { ...context, source_evidence: {} },
      evidence,
      [],
      "en",
      false,
      1,
      6,
    ),
  ).toThrow("MODEL_IDENTITY_CHANGED");
});

it("never mutates legacy prompt bytes or identities while producing the new wire", async () => {
  for (const revision of [0, 1, 2, 3, 4, 5] as const) {
    const original = modelPrompt(
      "analyze_chunk",
      context,
      evidence,
      [entity],
      "ar",
      false,
      1,
      revision,
    );
    const identity = await sha256(original);
    modelPrompt(
      "analyze_chunk",
      context,
      evidence,
      [entity],
      "ar",
      false,
      1,
      6,
    );
    expect(
      modelPrompt(
        "analyze_chunk",
        context,
        evidence,
        [entity],
        "ar",
        false,
        1,
        revision,
      ),
    ).toBe(original);
    expect(await sha256(original)).toBe(identity);
    expect(JSON.parse(original).evidence[1].source_span).toEqual(span);
  }
});
