// @vitest-environment node
import { expect, it } from "vitest";
import {
  validateModelResult,
  type Evidence,
} from "../../supabase/functions/_shared/model";

const evidence: Evidence = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "company",
  verified: true,
  text: "Example Studio delivered workflow software for a public organization.",
};
const draft = (claim = "Example Studio has delivered workflow software.") => ({
  key: "experience",
  title: "Relevant experience",
  content_blocks: [
    {
      type: "paragraph",
      text: "We propose a phased implementation with buyer review.",
    },
  ],
  requirement_ids: [],
  evidence_refs: [{ id: evidence.id, quote: evidence.text }],
  company_claims: [{ claim, source_id: evidence.id, quote: evidence.text }],
  assumptions: [],
  questions: [],
});

it.each([
  "Example Studio has delivered workflow software.",
  "نفّذت الشركة برمجيات لسير العمل لدى جهة عامة.",
])(
  "allows a cited company paraphrase or translation to reach semantic verification: %s",
  (claim) => {
    const result = draft(claim);
    expect(evidence.text).not.toContain(claim);
    expect(result.content_blocks[0].text).not.toContain(claim);
    expect(
      validateModelResult("draft_section", result, [evidence], [], {
        independentGrounding: true,
      }),
    ).toEqual(result);
  },
);

it("accepts a contiguous company quote after the same harmless whitespace normalization used for evidence references", () => {
  const result = draft();
  const wrapped = {
    ...evidence,
    text: evidence.text.replace("workflow software", "workflow\nsoftware"),
  };
  expect(
    validateModelResult("draft_section", result, [wrapped], [], {
      independentGrounding: true,
    }),
  ).toEqual(result);
});

it.each([
  { name: "missing source", sources: [] },
  {
    name: "unverified company source",
    sources: [{ ...evidence, verified: false }],
  },
  { name: "style example", sources: [{ ...evidence, kind: "style" as const }] },
  {
    name: "buyer requirement",
    sources: [{ ...evidence, kind: "rfp" as const }],
  },
])("rejects declared company facts backed by a $name", ({ sources }) => {
  const result = draft();
  result.evidence_refs = [];
  expect(() =>
    validateModelResult("draft_section", result, sources, [], {
      independentGrounding: true,
    }),
  ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
});

it.each([
  "Example Studio delivered certified nationwide banking systems.",
  " ",
  "Example Studio delivered software for a public organization.",
])(
  "rejects an invented, empty or noncontiguous company quotation: %s",
  (quote) => {
    const result = draft();
    result.evidence_refs = [];
    result.company_claims[0].quote = quote;
    expect(() =>
      validateModelResult("draft_section", result, [evidence], [], {
        independentGrounding: true,
      }),
    ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
  },
);

it("does not mistake a declared strong-claim paraphrase for a malformed citation on the V2 path", () => {
  const result = draft();
  result.content_blocks[0].text =
    "We have delivered workflow software for a public organization.";
  expect(() =>
    validateModelResult("draft_section", result, [evidence], [], {
      independentGrounding: true,
    }),
  ).not.toThrow();
  expect(() =>
    validateModelResult("draft_section", result, [evidence]),
  ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
});

it("keeps legacy strong-claim and quotation guards when no independent verifier is guaranteed", () => {
  const result = draft();
  expect(() =>
    validateModelResult("draft_section", result, [evidence]),
  ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
  result.company_claims = [];
  result.content_blocks[0].text =
    "We are certified to deliver regulated banking systems.";
  expect(() =>
    validateModelResult("draft_section", result, [evidence]),
  ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
  // Parsing succeeds only as an intermediate V2 candidate. The integration
  // tests exercise the mandatory verifier and reject unsupported content.
  expect(() =>
    validateModelResult("draft_section", result, [evidence], [], {
      independentGrounding: true,
    }),
  ).not.toThrow();
});

it("propagates independent verification policy through a repair result without weakening legacy validation", () => {
  const result = {
    target_task: "draft_section",
    result: draft(),
    changes: ["Preserved the source citation while clarifying the wording."],
  };
  expect(() =>
    validateModelResult("repair_result", result, [evidence], [], {
      independentGrounding: true,
    }),
  ).not.toThrow();
  expect(() =>
    validateModelResult("repair_result", result, [evidence]),
  ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
});
