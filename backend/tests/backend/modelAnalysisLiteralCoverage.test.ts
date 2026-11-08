// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { analysisLiteralCoverage } from "../../supabase/functions/_shared/modelAnalysisLiteralCoverage";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";
import { canonicalSourceSpanId } from "../../supabase/functions/_shared/sourceEvidence";
import { pinVerificationPrompt } from "../../supabase/functions/_shared/modelVerificationPrompt";
import { verificationPolicyText } from "../../supabase/functions/_shared/modelVerificationInstructions";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";

const block = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const quotes = [
    "Do not pay before acceptance of ٣ units. 😀",
    "Retain the buyer's explicit exception.",
  ];
  const spans = quotes.map((quote, index) => {
    const base = {
      version: 1,
      entity_kind: "document",
      entity_id: block,
      content_hash: "a".repeat(64),
      extraction_version: "native-v1",
      block_id: block,
      block_hash: "b".repeat(64),
      coordinate: "unicode_code_point",
      start: index * 100,
      end: index * 100 + Array.from(quote).length,
      quote,
      locator: { kind: "synthetic" },
      authority: {
        version: 1,
        decision_id: block,
        revision: 1,
        role: "buyer_rfp",
        status: "confirmed",
        supersedes: null,
        precedence: 0,
      },
    };
    return { ...base, id: canonicalSourceSpanId(base as any) };
  });
  const evidence = spans.map((span) => ({
    id: span.id,
    text: span.quote,
    kind: "rfp" as const,
    verified: false,
    reference: {
      entity_kind: span.entity_kind,
      entity_id: span.entity_id,
      content_hash: span.content_hash,
    },
  }));
  const candidate: any = {
    processed_block_ids: [block],
    requirements: [
      {
        text: quotes.join("\n[Separate source passage]\n"),
        category: "contractual",
        mandatory: true,
        source_refs: spans.map((span) => ({ id: span.id, quote: span.quote })),
        interpretation: "Payment is conditional on acceptance.",
        acceptance_evidence: "Acceptance record",
        owner_question: null,
        source_semantics: {
          version: 1,
          modality: "prohibited",
          actor: "supplier",
          negated: true,
          conditions: ["acceptance"],
          exceptions: ["explicit exception"],
          consequences: [],
          quantities: [{ value: "3", unit: "units", currency: null }],
          dates: [],
          source_span_ids: spans.map((span) => span.id),
          authority_role: "buyer_rfp",
          authority_status: "confirmed",
          review_status: "pending",
          review_id: null,
        },
      },
    ],
    questions: [],
    separate_volumes: false,
    summary: "Preserve the buyer's payment condition.",
  };
  const context: any = {
    original_task: "analyze_chunk",
    original_context: {
      source_contract_version: 1,
      source_evidence: { version: 1, spans, reviews: [] },
    },
    candidate,
    candidate_hash: "c".repeat(64),
    content_units: candidateContent(candidate),
  };
  return { candidate, context, evidence, spans, requiredIds: [block] };
}

it("proves only the exact typed materialized text, preserving full candidate, IDs and source semantics", () => {
  const x = fixture(),
    before = JSON.stringify(x);
  const result = analysisLiteralCoverage(x.context, x.evidence, x.requiredIds)!;
  expect(result).toEqual({
    version: 1,
    kind: "source_literal_fidelity",
    candidate_hash: x.context.candidate_hash,
    units: [
      {
        content_id: "content-0",
        path: "$.requirements[0].text",
        source_span_ids: x.spans.map((s) => s.id),
      },
    ],
  });
  expect(JSON.stringify(x)).toBe(before);
  expect(x.context.content_units).toEqual(candidateContent(x.candidate));
  // The same quotation in another field remains ordinary generated content.
  x.candidate.summary = x.candidate.requirements[0].text;
  x.context.content_units = candidateContent(x.candidate);
  expect(
    analysisLiteralCoverage(x.context, x.evidence, x.requiredIds)?.units,
  ).toEqual(result.units);
});

it("tracks the original object ordering and only the exact scoped content IDs", () => {
  const x = fixture();
  x.candidate = { summary: x.candidate.summary, ...x.candidate };
  x.context.candidate = x.candidate;
  x.context.content_units = candidateContent(x.candidate);
  const literal = analysisLiteralCoverage(x.context, x.evidence, x.requiredIds)!
    .units[0];
  expect(literal.content_id).toBe("content-1");
  x.context.verification_scope = "content_batch";
  x.context.content_units = [x.context.content_units[1]];
  expect(analysisLiteralCoverage(x.context, x.evidence, [])?.units).toEqual([
    literal,
  ]);
  x.context.content_units = [candidateContent(x.candidate)[0]];
  expect(analysisLiteralCoverage(x.context, x.evidence, [])).toBeNull();
});

it("adds the proved manifest only to version 6 wire and refuses forged literal text", () => {
  const x = fixture();
  const before = JSON.stringify(x);
  const prompt = (version: 5 | 6) =>
    modelPrompt(
      "verify_grounding",
      x.context,
      x.evidence,
      x.requiredIds,
      "en",
      false,
      version,
    );
  const current = JSON.parse(prompt(6));
  expect(current.analysis_literal_coverage).toEqual(
    analysisLiteralCoverage(x.context, x.evidence, x.requiredIds),
  );
  expect(current.untrusted_data).toEqual(x.context);
  expect(current.required_ids).toEqual(x.requiredIds);
  expect(current.untrusted_data.content_units).toEqual(
    candidateContent(x.candidate),
  );
  expect(JSON.parse(prompt(5))).not.toHaveProperty("analysis_literal_coverage");
  expect(JSON.stringify(x)).toBe(before);
  x.candidate.requirements[0].text += " This supplier is already compliant.";
  x.context.content_units = candidateContent(x.candidate);
  expect(() => prompt(6)).toThrow("MODEL_IDENTITY_CHANGED");
  expect(() => prompt(5)).not.toThrow();
});

describe("no literal exemption when proof changes", () => {
  const changes: [string, (x: ReturnType<typeof fixture>) => void][] = [
    [
      "arbitrary text",
      (x) => {
        x.candidate.requirements[0].text += " Added assertion.";
      },
    ],
    [
      "source quote",
      (x) => {
        x.spans[0].quote += " changed";
      },
    ],
    [
      "evidence text",
      (x) => {
        x.evidence[0].text += " changed";
      },
    ],
    [
      "ref quote",
      (x) => {
        x.candidate.requirements[0].source_refs[0].quote += " changed";
      },
    ],
    [
      "ref order",
      (x) => {
        x.candidate.requirements[0].source_refs.reverse();
      },
    ],
    [
      "missing authority",
      (x) => {
        delete (x.spans[0] as any).authority;
      },
    ],
    [
      "authority mismatch",
      (x) => {
        x.candidate.requirements[0].source_semantics.authority_role =
          "company_evidence";
      },
    ],
    [
      "missing evidence",
      (x) => {
        x.evidence.pop();
      },
    ],
    [
      "changed source kind",
      (x) => {
        (x.evidence[0] as any).kind = "company";
      },
    ],
    [
      "upgraded source trust",
      (x) => {
        x.evidence[0].verified = true;
      },
    ],
    [
      "changed evidence identity",
      (x) => {
        x.evidence[0].reference.content_hash = "d".repeat(64);
      },
    ],
    [
      "wrong task",
      (x) => {
        x.context.original_task = "draft_section";
      },
    ],
    [
      "missing block",
      (x) => {
        x.candidate.processed_block_ids = [];
      },
    ],
    [
      "missing scoped content",
      (x) => {
        x.context.content_units.pop();
      },
    ],
    [
      "extra source ID",
      (x) => {
        x.requiredIds.push("other-source");
      },
    ],
    [
      "candidate-only exemption",
      (x) => {
        x.candidate.literal_source_units = ["content-0"];
      },
    ],
  ];
  it.each(changes)("rejects %s", (_name, change) => {
    const x = fixture();
    change(x);
    expect(
      analysisLiteralCoverage(x.context, x.evidence, x.requiredIds),
    ).toBeNull();
  });
});

it("does not approve semantic decisions or weaken quotation, coverage and nonempty-claim guards", () => {
  const x = fixture();
  // Literal fidelity holds even if the model's semantic judgment needs repair.
  x.candidate.requirements[0].source_semantics.negated = false;
  expect(
    analysisLiteralCoverage(x.context, x.evidence, x.requiredIds),
  ).not.toBeNull();
  const report: any = {
    checked_candidate_hash: x.context.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: candidateContent(x.candidate).map((u) => u.id),
    claims: [],
    processed_requirement_ids: x.requiredIds,
    requirement_checks: [
      {
        requirement_id: block,
        status: "contradicted",
        candidate_quote: "supplier",
        source_refs: [{ id: x.spans[0].id, quote: x.spans[0].quote }],
        finding: "The extraction loses the prohibition.",
      },
    ],
    findings: [],
  };
  expect(groundingDefects(report)).toHaveLength(1);
  expect(() =>
    validateGroundingReport(
      report,
      x.candidate,
      x.context.candidate_hash,
      x.evidence,
      x.requiredIds,
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  report.claims = [
    {
      id: "semantic",
      claim: "Payment is conditional on acceptance.",
      candidate_quote: "NOT PRESENT",
      kind: "tender_fact",
      status: "supported",
      source_refs: [{ id: x.spans[0].id, quote: x.spans[0].quote }],
      finding: "Synthetic",
    },
  ];
  expect(() =>
    validateGroundingReport(
      report,
      x.candidate,
      x.context.candidate_hash,
      x.evidence,
      x.requiredIds,
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

async function pinFixture(started = false) {
  const x = fixture(),
    results = new Map<string, any>();
  x.context.candidate_hash = await sha256(JSON.stringify(x.candidate));
  const backend = { internal: vi.fn(async () => started) };
  const store = {
    action: vi.fn(async (operation: string, input: any) => {
      if (operation === "result_get") return results.get(input.key) ?? null;
      const result = { value: structuredClone(input.value) };
      results.set(input.key, result);
      return result;
    }),
  };
  const options: any = {
    backend,
    store,
    job: { id: block, lease_token: block, checkpoint: {} },
    requestPrefix: "synthetic-analysis-verification",
    context: x.context,
    evidence: x.evidence,
    requiredIds: x.requiredIds,
    language: "en",
    repair: false,
  };
  return { ...x, options, results, backend };
}
it("pins version 6 only for a proved unstarted phase and replays its exact policy", async () => {
  const x = await pinFixture();
  expect(await pinVerificationPrompt(x.options)).toBe(6);
  expect(await pinVerificationPrompt(x.options)).toBe(6);
  expect(x.backend.internal).toHaveBeenCalledTimes(1);
  expect([...x.results.values()][0].value.instructions).toBe(
    verificationPolicyText(6),
  );
});
it("retains started/legacy/recheck policies and refuses changed pinned input", async () => {
  expect(await pinVerificationPrompt((await pinFixture(true)).options)).toBe(1);
  const x = await pinFixture();
  x.candidate.requirements[0].text += " Unproved wording.";
  x.context.content_units = candidateContent(x.candidate);
  expect(await pinVerificationPrompt(x.options)).toBe(5);
  x.candidate.requirements[0].text = x.spans
    .map((s) => s.quote)
    .join("\n[Separate source passage]\n");
  x.context.content_units = candidateContent(x.candidate);
  await expect(pinVerificationPrompt(x.options)).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
  const recheck = await pinFixture();
  recheck.options.job.checkpoint.verifier_recheck = {};
  expect(await pinVerificationPrompt(recheck.options)).toBe(4);
});

it("does not pin literal-copy policy for a syntactically valid but false candidate hash", async () => {
  const x = await pinFixture();
  x.context.candidate_hash = "d".repeat(64);
  expect(
    analysisLiteralCoverage(x.context, x.evidence, x.requiredIds),
  ).not.toBeNull();
  expect(await pinVerificationPrompt(x.options)).toBe(5);
});
