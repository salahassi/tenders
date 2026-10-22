// @vitest-environment node
import { it, expect } from "vitest";
import {
  candidateContent,
  validateGroundingReport,
  groundingDefects,
  groundingOptions,
} from "../../supabase/functions/_shared/modelGrounding";
const candidate = {
  content_blocks: [
    { type: "paragraph", text: "The deadline is 10 March 2026." },
  ],
  company_claims: [],
};
const evidence = [
  {
    id: "notice",
    text: "The deadline is 10 March 2026.",
    kind: "notice" as const,
    verified: false,
  },
];
function report() {
  return {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((c) => c.id),
    claims: [
      {
        id: "claim-1",
        claim: candidate.content_blocks[0].text,
        candidate_quote: candidate.content_blocks[0].text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "notice", quote: evidence[0].text }],
        finding: "Exact deadline.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
}
it.each([
  {
    name: "adjacent atomic company fact and proposed assumption",
    text: "We deliver software. Buyer approval remains required.",
    quotes: ["We deliver software.", "Buyer approval remains required."],
    pass: true,
  },
  {
    name: "normalized whitespace between complete atomic quotes",
    text: "We deliver software.\n\tBuyer approval remains required.",
    quotes: ["We deliver software.", "Buyer approval remains required."],
    pass: true,
  },
  {
    name: "overlapping exact quotes in reverse order",
    text: "We deliver software and require approval.",
    quotes: ["software and require approval.", "We deliver software"],
    pass: true,
  },
  {
    name: "Arabic atomic quotes",
    text: "نطوّر البرمجيات. يتطلب التنفيذ موافقة العميل.",
    quotes: ["نطوّر البرمجيات.", "يتطلب التنفيذ موافقة العميل."],
    pass: true,
  },
  {
    name: "a missing clause",
    text: "We deliver software. We manage hosting. Buyer approval is required.",
    quotes: ["We deliver software.", "Buyer approval is required."],
    pass: false,
  },
  {
    name: "a missing number",
    text: "We deliver 3 workshops.",
    quotes: ["We deliver", "workshops."],
    pass: false,
  },
  {
    name: "a missing negation",
    text: "We do not supply hardware.",
    quotes: ["We do", "supply hardware."],
    pass: false,
  },
  {
    name: "missing punctuation is not whitespace",
    text: "We deliver software; approval is required.",
    quotes: ["We deliver software", "approval is required."],
    pass: false,
  },
  {
    name: "duplicate quotes cannot replace the remaining clause",
    text: "We deliver software. Buyer approval is required.",
    quotes: [
      "We deliver software.",
      "We deliver software.",
      "We deliver software.",
    ],
    pass: false,
  },
  {
    name: "overlapping spans cannot cover an omitted final word",
    text: "We deliver software and require approval.",
    quotes: ["We deliver software and require", "software and require"],
    pass: false,
  },
])(
  "checks declared-company coverage using exact quote spans: $name",
  ({ text, quotes, pass }) => {
    const c = {
      content_blocks: [{ type: "paragraph", text }],
      company_claims: [{ claim: text, source_id: "company", quote: text }],
    };
    const r = {
      ...report(),
      processed_content_ids: candidateContent(c).map((unit) => unit.id),
      claims: quotes.map((quote, index) => ({
        ...report().claims[0],
        id: `atomic-${index}`,
        claim: quote,
        candidate_quote: quote,
        kind: index ? "assumption" : "company_fact",
        source_refs: [{ id: "company", quote: text }],
      })),
    };
    const before = structuredClone(r);
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ id: "company", text, kind: "company", verified: true }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("MODEL_COVERAGE_INCOMPLETE");
    expect(r).toEqual(before);
  },
);

it.each([
  "source",
  "numeric",
  "content",
  "requirements",
  "unsupported",
  "blocking",
])(
  "preserves %s validation after complete atomic company-claim coverage",
  (defect) => {
    const text = "We deliver 3 workshops. Buyer approval is required.";
    const c = {
      content_blocks: [{ type: "paragraph", text }],
      company_claims: [{ claim: text, source_id: "company", quote: text }],
    };
    const r = {
      ...report(),
      processed_content_ids: candidateContent(c).map((unit) => unit.id),
      claims: ["We deliver 3 workshops.", "Buyer approval is required."].map(
        (quote, index) => ({
          ...report().claims[0],
          id: `atomic-${index}`,
          claim: quote,
          candidate_quote: quote,
          kind: index ? "assumption" : "company_fact",
          source_refs: [{ id: "company", quote: text }],
        }),
      ),
      findings: [] as any[],
    };
    if (defect === "source") r.claims[0].source_refs[0].id = "missing";
    if (defect === "numeric") r.claims[0].source_refs[0].quote = "workshops.";
    if (defect === "content") r.processed_content_ids.pop();
    if (defect === "unsupported") r.claims[0].status = "insufficient";
    if (defect === "blocking")
      r.findings.push({
        severity: "blocking",
        code: "NEEDS_CONFIRMATION",
        detail: "Unresolved company assertion.",
        claim_ids: ["atomic-0"],
        requirement_ids: [],
      });
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ id: "company", text, kind: "company", verified: true }],
        defect === "requirements" ? ["missing-requirement"] : [],
      );
    if (["unsupported", "blocking"].includes(defect)) {
      expect(check).not.toThrow();
      expect(groundingDefects(r)).toHaveLength(1);
    } else expect(check).toThrow();
  },
);
const sourceUuid = "12345678-abcd-4abc-8abc-abcdef123456";
it.each([
  { text: "Review delivery-7-access_gate before implementation.", pass: true },
  { text: "Review (delivery-7-access_gate).", pass: true },
  { text: "Review decision-3-approval.", pass: true },
  { text: "Review delivery-8-access_gate.", pass: false },
  { text: "Review prefix-delivery-7-access_gate.", pass: false },
  { text: "Review delivery-7-access_gate_suffix.", pass: false },
  {
    text: "Review delivery-7-access_gate then deliver within 50 days.",
    pass: false,
  },
  { text: "Pay USD 50000 under delivery-7-access_gate.", pass: false },
  { text: "راجع delivery-7-access_gate خلال ٥٠ يومًا.", pass: false },
  { text: "Review delivery-7-access_gate.", legacy: true, pass: false },
])(
  "distinguishes frozen proposal references from factual quantities: $text",
  ({ text, legacy, pass }) => {
    const source = "Review approval before implementation.";
    const c = { content_blocks: [{ type: "paragraph", text }] };
    const r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim: text,
      candidate_quote: text,
      source_refs: [{ id: "notice", quote: source }],
    };
    const options = groundingOptions({
      workflow_version: legacy ? 1 : 2,
      response_locations: [{ section_key: "delivery-7-access_gate" }],
      shared_decisions: [{ key: "decision-3-approval" }],
    });
    const before = structuredClone(r);
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text: source }],
        [],
        undefined,
        options,
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
    expect(r).toEqual(before);
  },
);
it("never derives proposal identifier exemptions from candidate fields or numeric labels", () => {
  expect(
    groundingOptions({
      workflow_version: 2,
      candidate: { response_locations: [{ section_key: "made-up-55" }] },
      response_locations: [
        { section_key: "50" },
        null,
        {},
        { section_key: "a" },
      ],
    }).proposalReferenceKeys,
  ).toEqual([]);
});
const requirementUuid = "abcdef12-abcd-4abc-8abc-abcdef123456";
it.each([
  {
    name: "a supplied source UUID",
    text: `Confirm the design in source (${sourceUuid}).`,
    pass: true,
  },
  {
    name: "a supplied requirement UUID",
    text: `Confirm the design for requirement (${requirementUuid}).`,
    requiredId: requirementUuid,
    pass: true,
  },
  {
    name: "a quantity beside a supplied requirement UUID",
    text: `Requirement (${requirementUuid}) requires 50 engineers.`,
    requiredId: requirementUuid,
    pass: false,
  },
  {
    name: "a requirement UUID absent from the supplied scope",
    text: `Confirm the design for requirement (${requirementUuid}).`,
    pass: false,
  },
  {
    name: "an unknown source UUID",
    text: "Confirm the design in source (87654321-abcd-4abc-8abc-abcdef123456).",
    pass: false,
  },
  {
    name: "a UUID inside a larger identifier",
    text: `Confirm the design in source prefix-${sourceUuid}.`,
    pass: false,
  },
  {
    name: "a UUID with an appended identifier suffix",
    text: `Confirm the design in source ${sourceUuid}_suffix.`,
    pass: false,
  },
  {
    name: "a quantity following a supplied UUID",
    text: `Source (${sourceUuid}) requires 50 engineers.`,
    pass: false,
  },
  {
    name: "a price preceding a supplied UUID",
    text: `USD 50000 is required by source (${sourceUuid}).`,
    pass: false,
  },
  {
    name: "an Arabic quantity beside a supplied UUID",
    text: `المصدر (${sourceUuid}) يتطلب ٥٠ مهندسًا.`,
    pass: false,
  },
  {
    name: "a supported quantity beside a supplied UUID",
    text: `Source (${sourceUuid}) requires 3 workshops.`,
    source: "The design requires 3 workshops.",
    pass: true,
  },
  {
    name: "an identifier alone cannot support a quantity",
    text: `Source (${sourceUuid}) requires 12345678 engineers.`,
    source: `The design is documented in source ${sourceUuid}.`,
    pass: false,
  },
  {
    name: "an arbitrary numeric source ID is not exempt",
    id: "50",
    text: "The design requires 50 engineers.",
    pass: false,
  },
])(
  "checks numbers without mistaking evidence metadata for quantities: $name",
  ({
    text,
    source = "The design requires documented review.",
    id = sourceUuid,
    requiredId,
    pass,
  }) => {
    const c = { content_blocks: [{ type: "paragraph", text }] };
    const required = requiredId ? [requiredId] : [];
    const r = {
      ...report(),
      processed_requirement_ids: required,
      requirement_checks: required.map((requirement_id) => ({
        requirement_id,
        status: "supported",
        candidate_quote: text,
        source_refs: [{ id, quote: source }],
        finding: "Synthetic requirement mapping.",
      })),
    };
    r.claims[0] = {
      ...r.claims[0],
      claim: text,
      candidate_quote: text,
      source_refs: [{ id, quote: source }],
    };
    const before = structuredClone(r);
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], id, text: source }],
        required,
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
    expect(r).toEqual(before);
  },
);
it.each([
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: true,
  },
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ 2 requires architecture design.",
    pass: true,
  },
  {
    text: "3\nArchitecture design\nPackage 1",
    claim: "BOQ 2 requires architecture design.",
    pass: false,
  },
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ 2 requires 2 engineers.",
    pass: false,
  },
  {
    text: "2 Architecture design\nPackage 1",
    claim: "البند ٢ يتطلب تصميم المعمارية.",
    pass: true,
  },
  {
    text: "3\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
  {
    text: "2\nUnrelated heading\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires 2 engineers.",
    pass: false,
  },
  {
    text: "2\nArchitecture design\nPackage 1\n3\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
])(
  "checks adjacent item labels without using them to justify quantities: $claim ($pass)",
  ({ text, claim, pass }) => {
    const c = { content_blocks: [{ type: "paragraph", text: claim }] };
    const r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim,
      candidate_quote: claim,
      source_refs: [{ id: "notice", quote: "Architecture design\nPackage 1" }],
    };
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);
it.each([
  ["Section 4.2 requires approval.", "Section 4.2 requires approval.", true],
  ["Section 4.2 requires approval.", "Section 4 requires 2 approvals.", false],
  [
    "Section 4.2.1 requires approval.",
    "Section 4.2.1 requires approval.",
    true,
  ],
  [
    "Section 4.2 requires 3 workshops.",
    "Section 4.2 requires workshops.",
    false,
  ],
  ["البند ٤٫٢ يتطلب الموافقة.", "البند ٤٫٢ يتطلب الموافقة.", true],
  ["البند ۴.۲ يتطلب الموافقة.", "البند ۴.۲ يتطلب الموافقة.", true],
  [
    "Section 4,200 requires approval.",
    "Section 4,200 requires approval.",
    true,
  ],
  ["Section 4.2 requires approval.", "4\nrequires approval.", false],
])(
  "keeps a complete numeric label instead of inventing integer fragments: %s",
  (text, quote, pass) => {
    const c = { content_blocks: [{ type: "paragraph", text }] };
    const r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim: text,
      candidate_quote: text,
      source_refs: [{ id: "notice", quote }],
    };
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text: quote }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);
it("reports exact failed numeric citation paths without copying source or candidate text", () => {
  const c = {
    content_blocks: [{ type: "paragraph", text: "Provide 3 workshops." }],
  };
  const r = report();
  r.claims[0] = {
    ...r.claims[0],
    claim: "Provide workshops",
    candidate_quote: c.content_blocks[0].text,
    source_refs: [{ id: "notice", quote: "Provide workshops." }],
  };
  let caught: any;
  try {
    validateGroundingReport(
      r,
      c,
      "a".repeat(64),
      [{ ...evidence[0], text: "Provide workshops." }],
      [],
    );
  } catch (error) {
    caught = error;
  }
  expect(caught.validationDiagnostics).toEqual([
    {
      code: "EVIDENCE_REFERENCE_INVALID",
      reason: "numeric_evidence_mismatch",
      paths: ["$.claims[0].candidate_quote", "$.claims[0].source_refs"],
      evidence_ids: ["notice"],
      numeric_literals: ["3"],
    },
  ]);
  expect(JSON.stringify(caught.validationDiagnostics)).not.toContain(
    "workshops",
  );
});
it("validates a supported deadline and checks undeclared text, including tables", () => {
  expect(() =>
    validateGroundingReport(report(), candidate, "a".repeat(64), evidence, []),
  ).not.toThrow();
  expect(
    candidateContent({
      content_blocks: [
        { type: "table", rows: [["An undeclared company claim"]] },
      ],
      evidence_refs: [{ id: "notice", quote: "Evidence copy" }],
    }).map((c) => c.text),
  ).toContain("An undeclared company claim");
  expect(
    candidateContent({
      evidence_refs: [{ id: "notice", quote: "Evidence copy" }],
    }),
  ).toEqual([]);
});
it.each([
  "hash",
  "missing_text",
  "extra_text",
  "fabricated_quote",
  "wrong_source",
  "unsupported_number",
  "missing_requirement",
])("rejects %s independently of a verifier claiming support", (defect) => {
  const r = report();
  let required: string[] = [];
  if (defect === "hash") r.checked_candidate_hash = "b".repeat(64);
  if (defect === "missing_text") r.processed_content_ids.pop();
  if (defect === "extra_text") r.processed_content_ids.push("fake");
  if (defect === "fabricated_quote")
    r.claims[0].candidate_quote = "Invented quote";
  if (defect === "wrong_source")
    r.claims[0].source_refs[0].id = "invented-source";
  if (defect === "unsupported_number") {
    r.claims[0].source_refs[0].quote = "March";
  }
  if (defect === "missing_requirement") required = ["required-1"];
  expect(() =>
    validateGroundingReport(r, candidate, "a".repeat(64), evidence, required),
  ).toThrow();
});
it("requires verified Company Knowledge for supported expertise instead of a notice or a style sample", () => {
  const r = report();
  r.claims[0].kind = "company_fact";
  expect(() =>
    validateGroundingReport(r, candidate, "a".repeat(64), evidence, []),
  ).toThrow();
  expect(() =>
    validateGroundingReport(
      r,
      candidate,
      "a".repeat(64),
      [{ ...evidence[0], kind: "company", verified: false }],
      [],
    ),
  ).toThrow();
});
it("allows explicit missing information without claiming eligibility failure", () => {
  const c = {
    questions: [
      { question: "[INPUT REQUIRED: Confirm the proposed delivery team.]" },
    ],
  };
  const r = {
    ...report(),
    processed_content_ids: candidateContent(c).map((x) => x.id),
    claims: [
      {
        ...report().claims[0],
        candidate_quote: c.questions[0].question,
        claim: c.questions[0].question,
        kind: "assumption",
        source_refs: [],
        finding: "Clear missing input.",
      },
    ],
  };
  expect(() =>
    validateGroundingReport(r, c, "a".repeat(64), [], []),
  ).not.toThrow();
  expect(groundingDefects(r)).toEqual([]);
  r.claims[0].status = "insufficient";
  const unresolved = structuredClone(r);
  expect(groundingDefects(r)).toEqual([]);
  expect(r).toEqual(unresolved);
  r.claims[0].status = "contradicted";
  expect(groundingDefects(r)).toHaveLength(1);
});

it("keeps explicit blockers and failed requirement checks while retaining unresolved assumptions", () => {
  const r = {
    ...report(),
    claims: [
      {
        ...report().claims[0],
        kind: "assumption",
        status: "insufficient",
        source_refs: [],
      },
    ],
    requirement_checks: [
      {
        requirement_id: "required-control",
        status: "insufficient",
        candidate_quote: "",
        source_refs: [],
        finding:
          "A required control is neither addressed nor identified as missing input.",
      },
    ],
    findings: [
      {
        severity: "blocking",
        code: "UNBOUNDED_ASSUMPTION",
        detail: "The assumption makes an unconditional delivery promise.",
        claim_ids: ["claim-1"],
        requirement_ids: [],
      },
    ],
  };
  const original = structuredClone(r);
  expect(groundingDefects(r)).toEqual([
    expect.objectContaining({
      requirement_id: "required-control",
      status: "insufficient",
    }),
    r.findings[0],
  ]);
  expect(r).toEqual(original);
});

it.each([
  "company_fact",
  "tender_fact",
  "commercial_commitment",
  "proposed_solution",
])(
  "keeps insufficient %s blocking instead of treating it as a missing-input assumption",
  (kind) => {
    const r = {
      ...report(),
      claims: [
        {
          ...report().claims[0],
          kind,
          status: "insufficient",
          source_refs: [],
        },
      ],
    };
    expect(groundingDefects(r)).toEqual([
      expect.objectContaining({ kind, status: "insufficient" }),
    ]);
  },
);

it.each([
  ["company_fact", "We have 50 certified engineers."],
  ["tender_fact", "The tender closes on 10 March 2026."],
  ["commercial_commitment", "Our fixed price is 50000 USD."],
])(
  "blocks an uncited supported %s as a repairable evidence defect without trusting the verifier",
  (kind, text) => {
    const c = { content_blocks: [{ type: "paragraph", text }] };
    const r = {
      ...report(),
      processed_content_ids: candidateContent(c).map((u) => u.id),
      claims: [
        {
          ...report().claims[0],
          kind,
          claim: text,
          candidate_quote: text,
          source_refs: [],
          finding: "Verifier incorrectly says this is supported.",
        },
      ],
    };
    const original = structuredClone(r);
    // Numerical claims with no references must reach candidate repair too;
    // there is no quoted evidence against which to run the numeric check.
    expect(() =>
      validateGroundingReport(r, c, "a".repeat(64), [], []),
    ).not.toThrow();
    expect(groundingDefects(r)).toEqual([
      expect.objectContaining({
        claim_id: "claim-1",
        kind,
        status: "insufficient",
        reason: "missing_supporting_evidence",
        candidate_quote: text,
        source_refs: [],
        instruction: expect.stringContaining("Never invent"),
      }),
    ]);
    expect(r).toEqual(original);
  },
);

const tableQuote = "Architectural assessment\nDeliver a documented design.";
const tableHeader = "# Description Qty Unit price Total";
const tableText = `${tableHeader}
1
Discovery package 1
Research existing workflows.
[Page 8]
8
2 Architecture package 1
${tableQuote}
3 Delivery package 1
Train the internal team.`;
it.each([
  {
    name: "a titled row separated from its quote by quantity",
    text: tableText,
    claim: "BOQ item 2 requires architectural assessment.",
    pass: true,
  },
  {
    name: "Arabic table columns and digits",
    text: tableText
      .replace(tableHeader, "# الوصف الكمية سعر الوحدة السعر الإجمالي")
      .replace(/2/g, "٢")
      .replace(/1/g, "١")
      .replace(/3/g, "٣"),
    claim: "البند ٢ يتطلب تقييم المعمارية.",
    pass: true,
  },
  {
    name: "a wrong row label",
    text: tableText,
    claim: "BOQ item 1 requires architectural assessment.",
    pass: false,
  },
  {
    name: "row number reused as an invented quantity",
    text: tableText,
    claim: "BOQ item 2 requires 2 architects.",
    pass: false,
  },
  {
    name: "quantity column reused without a supporting quotation",
    text: tableText,
    claim: "BOQ item 2 requires 1 architect.",
    pass: false,
  },
  {
    name: "an ordinary numbered list without table columns",
    text: tableText.replace(tableHeader, "# Project plan"),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "an unmarked numeric page or ambiguous boundary",
    text: tableText.replace("[Page 8]\n8\n", "8\n"),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "nonconsecutive row numbering",
    text: tableText.replace("2 Architecture", "4 Architecture"),
    claim: "BOQ item 4 requires architectural assessment.",
    pass: false,
  },
  {
    name: "an ambiguous repeated quote",
    text: tableText + "\n" + tableQuote,
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "a quote in the final unbounded row",
    text: tableText.replace(
      "3 Delivery package 1\nTrain the internal team.",
      "",
    ),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "a quantity on its own line cannot masquerade as the row label",
    text: tableText.replace(
      "2 Architecture package 1",
      "2 Architecture package\n1",
    ),
    claim: "BOQ item 1 requires architectural assessment.",
    pass: false,
  },
])("validates table labels conservatively: $name", ({ text, claim, pass }) => {
  const c = { content_blocks: [{ type: "paragraph", text: claim }] };
  const r = report();
  r.claims[0] = {
    ...r.claims[0],
    claim,
    candidate_quote: claim,
    source_refs: [{ id: "notice", quote: tableQuote }],
  };
  const check = () =>
    validateGroundingReport(
      r,
      c,
      "a".repeat(64),
      [{ ...evidence[0], text }],
      [],
    );
  if (pass) expect(check).not.toThrow();
  else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("rejects one quotation spanning two table rows", () => {
  const quote = tableQuote + "\n3 Delivery package 1\nTrain the internal team.";
  const claim = "BOQ item 2 requires architectural assessment and training.";
  const c = { content_blocks: [{ type: "paragraph", text: claim }] },
    r = report();
  r.claims[0] = {
    ...r.claims[0],
    claim,
    candidate_quote: claim,
    source_refs: [{ id: "notice", quote }],
  };
  expect(() =>
    validateGroundingReport(
      r,
      c,
      "a".repeat(64),
      [{ ...evidence[0], text: tableText }],
      [],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it.each([
  {
    name: "the final row paragraph before an explicit page break",
    suffix: "\n\n[Page 8]\n8\nUnrelated trailing text.",
    claim: "BOQ item 2 requires architectural assessment.",
    quote: tableQuote,
    pass: true,
  },
  {
    name: "Arabic page marker",
    suffix: "\n\n[صفحة ٨]\n٨\nUnrelated trailing text.",
    claim: "البند ٢ يتطلب تقييم المعمارية.",
    quote: tableQuote,
    pass: true,
  },
  {
    name: "an unrelated paragraph before the page break",
    suffix: "\n\nUnrelated trailing text.\n\n[Page 8]\n8",
    claim: "BOQ item 2 includes unrelated trailing text.",
    quote: "Unrelated trailing text.",
    pass: false,
  },
  {
    name: "text after the page break",
    suffix: "\n\n[Page 8]\n8\nUnrelated trailing text.",
    claim: "BOQ item 2 includes unrelated trailing text.",
    quote: "Unrelated trailing text.",
    pass: false,
  },
  {
    name: "a nonconsecutive row before the page break",
    suffix: "\n4 Unrelated new row.\n\n[Page 8]\n8",
    claim: "BOQ item 2 includes unrelated new work.",
    quote: "Unrelated new row.",
    pass: false,
  },
  {
    name: "an unmarked numeric boundary before the page break",
    suffix: "\n8\nUnrelated new row.\n\n[Page 9]\n9",
    claim: "BOQ item 2 includes unrelated new work.",
    quote: "Unrelated new row.",
    pass: false,
  },
  {
    name: "a fabricated quantity",
    suffix: "\n\n[Page 8]\n8",
    claim: "BOQ item 2 requires 2 architects.",
    quote: tableQuote,
    pass: false,
  },
  {
    name: "a row without any explicit boundary",
    suffix: "",
    claim: "BOQ item 2 requires architectural assessment.",
    quote: tableQuote,
    pass: false,
  },
])(
  "bounds a final table row conservatively: $name",
  ({ suffix, claim, quote, pass }) => {
    const text =
      tableText
        .replace("3 Delivery package 1\nTrain the internal team.", "")
        .trimEnd() + suffix;
    const c = { content_blocks: [{ type: "paragraph", text: claim }] },
      r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim,
      candidate_quote: claim,
      source_refs: [{ id: "notice", quote }],
    };
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);
