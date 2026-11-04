import { expect, it } from "vitest";
import {
  assessProposalConsistency,
  requireProposalAcceptance,
  type ConsistencyInput,
} from "../../supabase/functions/_shared/proposalConsistency.ts";
function fixture(): ConsistencyInput {
  const text =
    "We will conduct 0 workshops only after buyer approval. We will prepare the manual. Deliver the signed manual. Acceptance requires buyer signoff.";
  return {
    requirements: [
      {
        id: "r1",
        text: "Prepare the manual; 0 workshops only after buyer approval.",
        mandatory: true,
        source_refs: [
          { id: "buyer", quote: "0 workshops only after buyer approval" },
        ],
        source_semantics: {
          version: 1,
          source_span_ids: ["span1"],
          authority_role: "buyer_rfp",
          authority_status: "confirmed",
          modality: "required",
          actor: "supplier",
          negated: false,
          conditions: ["only after buyer approval"],
          exceptions: [],
          consequences: [],
          quantities: [{ value: "0", unit: "workshops" }],
          review_status: "confirmed",
          review_id: "semantic-1",
        },
      },
    ],
    sources: [
      {
        id: "buyer",
        text: "Prepare the manual; 0 workshops only after buyer approval.",
        reference: {
          entity_kind: "document",
          entity_id: "d",
          content_hash: "a".repeat(64),
        },
      },
    ],
    sections: [
      {
        key: "method",
        volume: "technical",
        requirement_ids: ["r1"],
        content_blocks: [{ type: "paragraph", text }],
      },
    ],
    fulfillment: [
      {
        requirement_id: "r1",
        response_section_key: "method",
        response_excerpt: text,
        method: "We will prepare the manual",
        deliverable: "Deliver the signed manual",
        acceptance_evidence: "Acceptance requires buyer signoff",
        conditions_preserved: ["only after buyer approval"],
        facts: [
          {
            key: "workshops",
            kind: "quantity",
            value: "0",
            unit: "workshops",
            currency: null,
            quote: "0 workshops",
          },
        ],
      },
    ],
    human_review: {
      review_id: "review-1",
      actor_id: "reviewer",
      requirement_ids: ["r1"],
      confirmed: true,
    },
    input_complete: true,
  };
}
it("accepts reviewed substantive method/deliverable/acceptance with genuine zero unchanged", async () => {
  const report = await assessProposalConsistency(fixture());
  expect(report.diagnostics).toEqual([]);
  expect(report.substantive_complete).toBe(true);
  expect(() => requireProposalAcceptance(report)).not.toThrow();
});
it("normalizes Arabic digits and known unit aliases without a floating-point calculation", async () => {
  const f = fixture();
  f.fulfillment[0].facts![0] = {
    ...f.fulfillment[0].facts![0],
    value: "٠",
    unit: "ورش",
  };
  const report = await assessProposalConsistency(f);
  expect(report.substantive_complete).toBe(true);
});
it.each(["method", "deliverable", "acceptance_evidence"] as const)(
  "does not accept a form-only %s absent from the actual response",
  async (field) => {
    const f = fixture();
    f.fulfillment[0][field] =
      "An invented statement not present in the document";
    const report = await assessProposalConsistency(f);
    expect(report.substantive_complete).toBe(false);
    expect(report.coverage[0].missing_fields).toContain(field);
  },
);
it("headings, long prose and model answered labels do not prove substantive coverage", async () => {
  const f = fixture();
  f.sections[0].title = "Method, Deliverable and Acceptance";
  f.sections[0].content_blocks = [
    {
      type: "paragraph",
      text: "We comply with all requirements. ".repeat(100),
    },
  ];
  f.fulfillment = [];
  const report = await assessProposalConsistency(f);
  expect(report.coverage[0].status).toBe("gap");
  expect(report.substantive_complete).toBe(false);
});
it("does not accept model or caller self-certification without current semantic review", async () => {
  const f = fixture();
  f.human_review = null;
  const report = await assessProposalConsistency(f);
  expect(report.semantic_review_required).toBe(true);
  expect(report.coverage[0].status).toBe("unreviewed");
});
it.each(["conditions", "exceptions", "consequences"] as const)(
  "a missing late %s qualifier prevents completion",
  async (field) => {
    const f = fixture();
    f.requirements[0].source_semantics![field] = [
      "except where the buyer declines",
    ];
    const report = await assessProposalConsistency(f);
    expect(report.coverage[0].missing_fields).toContain(field);
    expect(report.substantive_complete).toBe(false);
  },
);
it.each(["unconfirmed", "revoked"])(
  "%s authority cannot be promoted by a response",
  async (status) => {
    const f = fixture();
    f.requirements[0].source_semantics!.authority_status = status;
    expect(
      (await assessProposalConsistency(f)).coverage[0].missing_fields,
    ).toContain("confirmed_source_semantics");
  },
);
it("copied source alone is not a proposed method/deliverable/acceptance response", async () => {
  const f = fixture();
  f.sections[0].content_blocks = [
    { type: "paragraph", text: f.sources[0].text },
  ];
  f.fulfillment[0].response_excerpt = f.sources[0].text;
  expect(
    (await assessProposalConsistency(f)).coverage[0].missing_fields,
  ).toEqual(
    expect.arrayContaining(["method", "deliverable", "acceptance_evidence"]),
  );
});
it("rejects exact source restatement even when all three declared components are copied substrings", async () => {
  const f = fixture();
  f.sources[0].text = f.fulfillment[0].response_excerpt;
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "SOURCE_RESTATEMENT_ONLY",
    ),
  ).toBe(true);
});
it("keeps unknown quantity distinct from zero", async () => {
  const f = fixture();
  f.fulfillment[0].facts![0].value = null;
  expect(
    (await assessProposalConsistency(f)).coverage[0].missing_fields,
  ).toContain("source_quantity");
});
it.each(["quantity", "money", "date", "decision"] as const)(
  "detects conflicting shared %s facts across sections",
  async (kind) => {
    const f = fixture();
    f.requirements[0].source_semantics!.quantities = [];
    f.sections.push({
      key: "other",
      requirement_ids: [],
      content_blocks: [
        {
          type: "paragraph",
          text: "The value is 20; date 2026-12-02; option B.",
        },
      ],
    });
    f.fulfillment[0].facts = [
      {
        key: "shared",
        kind,
        value:
          kind === "date" ? "2026-12-01" : kind === "decision" ? "A" : "10",
        unit: kind === "quantity" ? "day" : null,
        currency: kind === "money" ? "USD" : null,
        quote: f.fulfillment[0].response_excerpt,
      },
    ];
    f.fulfillment.push({
      ...f.fulfillment[0],
      response_section_key: "other",
      response_excerpt: "The value is 20; date 2026-12-02; option B.",
      facts: [
        {
          ...f.fulfillment[0].facts[0],
          value:
            kind === "date" ? "2026-12-02" : kind === "decision" ? "B" : "20",
          quote: "The value is 20; date 2026-12-02; option B.",
        },
      ],
    });
    expect(
      (await assessProposalConsistency(f)).diagnostics.some(
        (d) => d.code === "SHARED_FACT_CONFLICT",
      ),
    ).toBe(true);
  },
);
it("same number with another currency or unit is a conflict for the same bound meaning", async () => {
  const f = fixture();
  f.fulfillment[0].facts!.push({ ...f.fulfillment[0].facts![0], unit: "day" });
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "SHARED_FACT_CONFLICT",
    ),
  ).toBe(true);
});
it("source quote/hash and current inventory are indispensable", async () => {
  const f = fixture();
  f.sources[0].text = "Changed source";
  expect(
    (await assessProposalConsistency(f)).coverage[0].missing_fields,
  ).toContain("current_source_binding");
  f.requirements = [];
  expect((await assessProposalConsistency(f)).substantive_complete).toBe(false);
});
it("hash changes when a response, review, authority or qualifier changes", async () => {
  const f = fixture(),
    before = await assessProposalConsistency(f);
  f.requirements[0].source_semantics!.conditions.push(
    "subject to written approval",
  );
  expect((await assessProposalConsistency(f)).input_hash).not.toBe(
    before.input_hash,
  );
});
it("separate volumes cannot hide an Arabic monetary price in a table", async () => {
  const f = fixture();
  f.separate_volumes = true;
  f.sections[0].content_blocks.push({
    type: "table",
    headers: ["البند", "السعر"],
    rows: [["التنفيذ", "١٠٠ ريال"]],
  });
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "TECHNICAL_VOLUME_PRICE",
    ),
  ).toBe(true);
});
it("detects an unbound contradictory number in another section even when all requirement responses are bound", async () => {
  const f = fixture();
  f.sections.push({
    key: "summary",
    requirement_ids: [],
    content_blocks: [{ type: "paragraph", text: "We deliver 5 workshops." }],
  });
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) =>
        d.code === "NUMERIC_ASSERTION_UNBOUND" &&
        d.section_keys.includes("summary"),
    ),
  ).toBe(true);
  f.section_facts = [
    {
      section_key: "summary",
      facts: [
        {
          key: "workshops",
          kind: "quantity",
          value: "5",
          unit: "workshops",
          currency: null,
          quote: "5 workshops",
        },
      ],
    },
  ];
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "SHARED_FACT_CONFLICT",
    ),
  ).toBe(true);
});
it("a current Decimal financial total and currency remain authority for explicitly bound prices", async () => {
  const f = fixture();
  f.sections.push({
    key: "commercial",
    volume: "financial",
    requirement_ids: [],
    content_blocks: [{ type: "paragraph", text: "SAR 0" }],
  });
  f.section_facts = [
    {
      section_key: "commercial",
      facts: [
        {
          key: "estimate.gross_total",
          kind: "money",
          value: "0",
          unit: null,
          currency: "SAR",
          quote: "SAR 0",
        },
      ],
    },
  ];
  f.financial_truth = {
    currency: "SAR",
    values: [{ key: "estimate.gross_total", value: "0.00000000" }],
  };
  expect((await assessProposalConsistency(f)).substantive_complete).toBe(true);
  f.financial_truth.values[0].value = "0.00000001";
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "FINANCIAL_TRUTH_CONFLICT",
    ),
  ).toBe(true);
});
it("a source date cannot disappear while only headings and quantities match", async () => {
  const f = fixture();
  f.requirements[0].source_semantics!.dates = [
    { value: "2026-12-02", event: "acceptance" },
  ];
  expect(
    (await assessProposalConsistency(f)).coverage[0].missing_fields,
  ).toContain("source_date");
});
it.each([
  ["12", "125 workshops", "workshops", null],
  ["30", "30 months", "days", null],
  ["30", "EUR 30", null, "USD"],
])(
  "rejects unanchored numeric/unit/currency declaration %s in %s",
  async (value, quote, unit, currency) => {
    const f = fixture();
    f.requirements[0].source_semantics!.quantities = [];
    f.sections[0].content_blocks.push({ type: "paragraph", text: quote! });
    f.fulfillment[0].response_excerpt += " " + quote;
    f.fulfillment[0].facts = [
      {
        key: "unanchored",
        kind: currency ? "money" : "quantity",
        value,
        unit,
        currency,
        quote: quote!,
      },
    ];
    const report = await assessProposalConsistency(f);
    expect(report.substantive_complete).toBe(false);
    expect(
      report.diagnostics.some((d) =>
        [
          "FACT_VALUE_NOT_IN_QUOTE",
          "FACT_UNIT_NOT_IN_QUOTE",
          "FACT_CURRENCY_NOT_IN_QUOTE",
        ].includes(d.code),
      ),
    ).toBe(true);
  },
);
it("requires explicit complete input coverage rather than treating undefined as complete", async () => {
  const f = fixture();
  delete f.input_complete;
  expect(
    (await assessProposalConsistency(f)).diagnostics.some(
      (d) => d.code === "INPUT_COVERAGE_INCOMPLETE",
    ),
  ).toBe(true);
});
it("accepts a source-bound human-reviewed Arabic qualifier equivalence and rejects altered bindings", async () => {
  const { qualifierHash } =
    await import("../../supabase/functions/_shared/proposalConsistency");
  const f = fixture();
  const original = "only after buyer approval",
    translated = "فقط بعد موافقة المشتري";
  f.fulfillment[0].response_excerpt = f.fulfillment[0].response_excerpt.replace(
    original,
    translated,
  );
  f.sections[0].content_blocks[0].text = f.fulfillment[0].response_excerpt;
  f.fulfillment[0].conditions_preserved = [];
  f.fulfillment[0].qualifier_equivalences = [
    {
      kind: "conditions",
      source_index: 0,
      source_quote: original,
      source_hash: await qualifierHash(original),
      response_quote: translated,
    },
  ];
  expect((await assessProposalConsistency(f)).substantive_complete).toBe(true);
  f.fulfillment[0].qualifier_equivalences[0].source_hash = "b".repeat(64);
  expect(
    (await assessProposalConsistency(f)).coverage[0].missing_fields,
  ).toContain("conditions");
});
