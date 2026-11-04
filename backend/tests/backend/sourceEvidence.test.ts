import { describe, it, expect } from "vitest";
import { primaryModelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import {
  canonicalSourceSpanId,
  resolveSourceSpan,
  materializeSourceCandidate,
  validateSourceCandidate,
  sourceTaskOutputSchema,
  sourceAuthorityFor,
  normalizeSourceWithMap,
  type SourceSpanV1,
} from "../../supabase/functions/_shared/sourceEvidence";
const id = "00000000-0000-4000-8000-000000000001",
  hash = "a".repeat(64);
const text =
  "لا يجوز للمورد الدفع إلا بعد قبول ٣ وحدات بسعر 20 USD يوم 2026-11-04.\r\nشرط 😀";
const authority = {
  version: 1 as const,
  decision_id: id,
  revision: 1,
  role: "buyer_rfp" as const,
  status: "confirmed" as const,
  supersedes: null,
  precedence: 0,
};
const base = {
  version: 1 as const,
  entity_kind: "document" as const,
  entity_id: id,
  content_hash: hash,
  extraction_version: "native-v1",
  block_id: id,
  block_hash: hash,
  coordinate: "unicode_code_point" as const,
  start: 0,
  end: Array.from(text).length,
  quote: text,
  locator: { kind: "test" },
  authority,
};
const span: SourceSpanV1 = { ...base, id: canonicalSourceSpanId(base) };
const tuple = {
  modality: "prohibited",
  actor: "المورد",
  negated: true,
  conditions: ["بعد قبول ٣ وحدات"],
  exceptions: ["إلا بعد قبول"],
  consequences: [],
  quantities: [{ value: "20", unit: "وحدة", currency: "USD" }],
  dates: [{ value: "2026-11-04", event: "الدفع" }],
};
function fixture() {
  const semantics = {
    ...tuple,
    version: 1,
    source_span_ids: [span.id],
    authority_role: "buyer_rfp",
    authority_status: "confirmed",
    review_status: "confirmed",
    review_id: id,
  };
  const context = {
    source_contract_version: 1,
    source_evidence: {
      version: 1,
      spans: [span],
      reviews: [
        {
          version: 1,
          id,
          revision: 1,
          opportunity_id: id,
          spans: [span],
          semantics: tuple,
          reason: "Reviewed original",
          status: "confirmed",
        },
      ],
    },
  };
  const value = {
    processed_block_ids: [id],
    requirements: [
      {
        text: "model paraphrase",
        category: "scope",
        mandatory: true,
        source_refs: [{ id: span.id, quote: "bad model quote" }],
        interpretation: "interpretation",
        acceptance_evidence: "acceptance",
        owner_question: "",
        source_semantics: semantics,
      },
    ],
    questions: [],
    separate_volumes: false,
    summary: "summary",
  };
  return { context, value };
}
describe("source authority contract v1", () => {
  it("keeps bounded identifiers and exact original Unicode coordinates", () => {
    expect(span.id.length).toBeLessThanOrEqual(120);
    expect(
      resolveSourceSpan(span, {
        id,
        text,
        reference: {
          entity_kind: "document",
          entity_id: id,
          content_hash: hash,
        },
        block_hash: hash,
        extraction_version: "native-v1",
      }),
    ).toBe(text);
    expect(() =>
      resolveSourceSpan(
        { ...span, end: span.end - 1 },
        {
          id,
          text,
          reference: {
            entity_kind: "document",
            entity_id: id,
            content_hash: hash,
          },
          block_hash: hash,
          extraction_version: "native-v1",
        },
      ),
    ).toThrow();
  });
  it("normalization retains a reversible source range for diacritics, emoji, CRLF and NBSP", () => {
    const original = "ا\u0654\u00a0  لا\r\n😀";
    const mapped = normalizeSourceWithMap(original);
    expect(mapped.text).toBe("أ لا 😀");
    expect(mapped.ranges[0]).toEqual({ start: 0, end: 2 });
    expect(mapped.ranges.at(-1)).toEqual({ start: 9, end: 10 });
  });
  it("materializes source wording from immutable spans, leaving interpretation separate", () => {
    const { context, value } = fixture();
    const result = materializeSourceCandidate(
      "analyze_chunk",
      value,
      context,
      [],
    );
    expect(result.requirements[0].text).toBe(text);
    expect(result.requirements[0].source_refs[0].quote).toBe(text);
    expect(result.requirements[0].interpretation).toBe("interpretation");
  });
  for (const field of [
    "modality",
    "actor",
    "negated",
    "conditions",
    "exceptions",
    "consequences",
    "quantities",
    "dates",
  ] as const)
    it(`rejects mutation of reviewed ${field} with indexed diagnostic`, () => {
      const { context, value } = fixture();
      const result = materializeSourceCandidate(
        "analyze_chunk",
        value,
        context,
        [],
      );
      result.requirements[0].source_semantics[field] =
        field === "negated"
          ? false
          : field === "modality"
            ? "permitted"
            : field === "actor"
              ? "buyer"
              : field === "quantities"
                ? [{ value: "200", unit: "unit", currency: "EUR" }]
                : field === "dates"
                  ? [{ value: "2027-01-01", event: "delivery" }]
                  : ["changed"];
      try {
        validateSourceCandidate("analyze_chunk", result, context, []);
        throw new Error("accepted");
      } catch (error) {
        expect(error).toMatchObject({
          code: "SOURCE_SEMANTICS_CONTRADICTION",
          source_path: `$.requirements[0].source_semantics.${field}`,
        });
      }
    });
  it("does not let a model self-confirm meaning or unknown authority", () => {
    const { context, value } = fixture();
    context.source_evidence.reviews = [];
    expect(
      materializeSourceCandidate("analyze_chunk", value, context, [])
        .requirements[0].source_semantics,
    ).toMatchObject({ review_status: "pending", review_id: null });
    expect(
      sourceAuthorityFor([
        { ...span, authority: { ...authority, role: "unknown" } },
      ]).authority_status,
    ).toBe("unconfirmed");
  });
  it("preserves legacy schema and uses versioned exact schema in repair", () => {
    const { context } = fixture();
    expect(
      sourceTaskOutputSchema(
        "analyze_chunk",
        {},
        primaryModelSchemas.analyze_chunk,
      ),
    ).toBe(primaryModelSchemas.analyze_chunk);
    const fallback = (primaryModelSchemas.analyze_chunk as any).constructor;
    const direct: any = sourceTaskOutputSchema(
      "analyze_chunk",
      context,
      primaryModelSchemas.analyze_chunk,
    );
    expect(
      direct.shape.requirements.element.shape.source_semantics,
    ).toBeTruthy();
  });
});
it("reports sibling semantic faults without hiding known defects", async () => {
  const { collectSourceCandidateDiagnostics } =
    await import("../../supabase/functions/_shared/sourceEvidence");
  const { context, value } = fixture();
  const result = materializeSourceCandidate(
    "analyze_chunk",
    value,
    context,
    [],
  );
  result.requirements[0].source_semantics.negated = false;
  result.requirements[0].source_semantics.conditions = ["invented"];
  expect(
    collectSourceCandidateDiagnostics("analyze_chunk", result, context, []).map(
      (e) => e.source_path,
    ),
  ).toEqual([
    "$.requirements[0].source_semantics.negated",
    "$.requirements[0].source_semantics.conditions",
  ]);
});
it("keeps buyer obligations even when no company evidence exists", () => {
  const { context, value } = fixture();
  const requirement = materializeSourceCandidate(
    "analyze_chunk",
    value,
    context,
    [],
  ).requirements[0];
  expect(() =>
    validateSourceCandidate(
      "draft_section",
      { requirement_ids: [id] },
      { ...context, source_requirements: [{ id, ...requirement }] },
      [],
    ),
  ).not.toThrow();
});
it("rejects expanded source material over durable capacity without trimming original passages", () => {
  const { context, value } = fixture();
  const long = { ...span, quote: "x".repeat(10000), end: 10000 };
  long.id = canonicalSourceSpanId(long);
  context.source_evidence.spans = [long];
  context.source_evidence.reviews = [];
  const requirement = {
    ...value.requirements[0],
    source_refs: [{ id: long.id, quote: "x" }],
    source_semantics: {
      ...value.requirements[0].source_semantics,
      source_span_ids: [long.id],
    },
  };
  expect(() =>
    materializeSourceCandidate(
      "analyze_chunk",
      {
        ...value,
        requirements: Array.from({ length: 100 }, () => requirement),
      },
      context,
      [],
    ),
  ).toThrow("SOURCE_MATERIALIZATION_CAPACITY");
  expect(context.source_evidence.spans[0].quote).toHaveLength(10000);
});
