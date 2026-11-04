// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { retrieveCompanyEvidence } from "../../supabase/functions/_shared/companyEvidenceRetrieval";
import { followupCompanyEvidence } from "../../supabase/functions/_shared/companyEvidenceFollowup";
import {
  validateModelResult,
  type Evidence,
  type Reference,
} from "../../supabase/functions/_shared/model";

const bytes = readFileSync(
  new URL(
    "./fixtures/g09-qualification/retrieval-qualification-v1.json",
    import.meta.url,
  ),
);
const corpus = JSON.parse(bytes.toString());
const frozenHash =
  "64413933d81a5f9d66fb5671eb4472874b5441228b9e74eaee393e944f312272";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
type Source = Evidence & { reference: Reference };
function source(
  id: string,
  text: string,
  kind: Evidence["kind"] = "company",
  verified = true,
): Source {
  return {
    id,
    kind,
    verified,
    text,
    reference: {
      entity_kind: "knowledge",
      entity_id: id,
      content_hash: digest(text),
    },
  };
}
function input(testCase: any, bounded: boolean) {
  const fact = testCase.decisive_fact,
    qualifier = testCase.decisive_qualifier;
  const filler = corpus.filler.paragraph.repeat(corpus.filler.repetitions);
  // The long unrelated paragraphs force whole-source admission to omit the
  // decisive source; short neighbors and a distant qualification remain intact.
  const text = bounded
    ? filler +
      "\n\nRecord context 😀.\n\n" +
      fact +
      "\n\nEvidence note.\n\n" +
      filler +
      "\n\n" +
      qualifier
    : fact + "\n\n" + qualifier;
  const sources = Array.from({ length: 6 }, (_, i) =>
    source(
      `archive-${i}`,
      `Archived address record ${i}. Contact information is unrelated to the requested deliverable.`,
    ),
  );
  sources.push(source(testCase.gold_source_id, text));
  return { sources, requirements: [{ id: "R1", text: testCase.query }], text };
}
const receipts: any[] = [];
it("binds the independent bilingual corpus before reporting retrieval outcomes", () => {
  expect(digest(bytes.toString())).toBe(frozenHash);
  expect(corpus.cases).toHaveLength(16);
  expect(
    corpus.cases.filter((row: any) => row.query_language === "ar"),
  ).toHaveLength(8);
  expect(
    corpus.cases.filter((row: any) => row.query_language === "en"),
  ).toHaveLength(8);
});
it.each(corpus.cases as Record<string, any>[])(
  "qualifies full and bounded evidence for $id without inferring capability absence",
  (testCase: any) => {
    const wholeInput = input(testCase, false),
      limitedInput = input(testCase, true);
    const whole = retrieveCompanyEvidence(
      wholeInput.sources,
      wholeInput.requirements,
    );
    const complete = followupCompanyEvidence(
      wholeInput.sources,
      wholeInput.requirements,
    );
    const gold = wholeInput.sources.find(
      (source) => source.id === testCase.gold_source_id,
    )!;
    expect(whole.evidence).toContainEqual(gold);
    expect(complete.evidence).toContainEqual(gold);
    expect(complete.claimEligibleIds).toContain(gold.id);
    expect(complete.coverage.selection_complete).toBe(true);
    expect(complete.coverage.capability_absence_proven).toBe(false);
    expect(complete.coverage.requirement_coverage[0].semantic_support).toBe(
      "not_evaluated",
    );
    const first = retrieveCompanyEvidence(
      limitedInput.sources,
      limitedInput.requirements,
      testCase.bounded_budget_bytes,
    );
    expect(
      first.omitted.some((item) => item.source_ids.includes(gold.id)),
    ).toBe(true);
    expect(first.coverage.selection_complete).toBe(false);
    const result = followupCompanyEvidence(
      limitedInput.sources,
      limitedInput.requirements,
      testCase.bounded_budget_bytes,
    );
    const found = result.evidence.find((source) => source.id === gold.id);
    const retrievedFact = Boolean(found?.text.includes(testCase.decisive_fact));
    const retrievedQualifier = Boolean(
      found?.text.includes(testCase.decisive_qualifier),
    );
    const decisiveSpans = result.coverage.spans.filter(
      (span) => span.source_id === gold.id,
    );
    expect(result.coverage.supplied_bytes).toBeLessThanOrEqual(
      testCase.bounded_budget_bytes,
    );
    expect(result.coverage.selection_complete).toBe(false);
    expect(result.coverage.capability_absence_proven).toBe(false);
    expect(result.coverage.unresolved_requirement_ids).toContain("R1");
    expect(result.coverage.requirement_coverage[0]).toMatchObject({
      semantic_support: "not_evaluated",
      retrieval_gap: true,
    });
    expect(result.claimEligibleIds).not.toContain(gold.id);
    if (found) {
      // A lexical discovery hit may help a later reader, but even a useful
      // fragment must not inherit its parent's verified company-claim authority.
      expect(found.verified).toBe(false);
      expect(found.reference).toEqual(limitedInput.sources.at(-1)!.reference);
      expect(retrievedFact).toBe(true);
      expect(retrievedQualifier).toBe(true);
      expect(decisiveSpans.length).toBeGreaterThan(0);
      for (const span of decisiveSpans) {
        expect(span).toMatchObject({
          coordinate: "unicode_code_point",
          content_hash: digest(limitedInput.text),
          source_complete: false,
          claim_eligible: false,
        });
        const original = Array.from(limitedInput.text)
          .slice(span.start, span.end)
          .join("");
        expect(original.length).toBeGreaterThan(0);
        expect(found.text).toContain(original);
      }
      const draft = {
        key: "capability",
        title: "Relevant experience",
        content_blocks: [{ type: "paragraph", text: testCase.decisive_fact }],
        requirement_ids: ["R1"],
        evidence_refs: [],
        company_claims: [
          {
            claim: testCase.decisive_fact,
            source_id: found.id,
            quote: testCase.decisive_fact,
          },
        ],
        assumptions: [],
        questions: [],
      };
      expect(() =>
        validateModelResult("draft_section", draft, result.evidence, ["R1"], {
          independentGrounding: true,
        }),
      ).toThrow("UNSUPPORTED_COMPANY_CLAIM");
    } else {
      if (!("omitted_source_ids" in result.coverage))
        throw Error("Incomplete retrieval must expose omitted source IDs");
      expect(result.coverage.omitted_source_ids).toContain(gold.id);
      expect(decisiveSpans).toEqual([]);
    }
    receipts.push({
      id: testCase.id,
      query_language: testCase.query_language,
      complete_source_retrieved: true,
      bounded_fact_retrieved: retrievedFact,
      bounded_qualifier_retrieved: retrievedQualifier,
      bounded_source_omitted: !found,
      partial_claim_eligible: result.claimEligibleIds.includes(gold.id),
      selection_complete: result.coverage.selection_complete,
      capability_absence_proven: result.coverage.capability_absence_proven,
      retrieval_gap: result.coverage.requirement_coverage[0].retrieval_gap,
      semantic_support:
        result.coverage.requirement_coverage[0].semantic_support,
      partial_spans: decisiveSpans.length,
    });
  },
);
it.each(corpus.cases as Record<string, any>[])(
  "excludes style/unverified lookalikes for $id and reports absent verified proof truthfully",
  (testCase: any) => {
    const exact = testCase.decisive_fact + "\n\n" + testCase.decisive_qualifier;
    const excluded = [
      source("style", exact, "style"),
      source("unverified", exact, "company", false),
    ];
    const result = followupCompanyEvidence(excluded, [
      { id: "R1", text: testCase.query },
    ]);
    expect(result.evidence).toEqual([]);
    expect(result.claimEligibleIds).toEqual([]);
    expect(result.coverage).toMatchObject({
      available_sources: 0,
      gap: "no_verified_source_in_snapshot",
      capability_absence_proven: false,
    });
    expect(result.coverage.requirement_coverage[0].semantic_support).toBe(
      "not_evaluated",
    );
  },
);
afterAll(() => {
  if (!process.env.G09_QUALIFICATION_REPORT) return;
  const correct = receipts.filter(
    (row) => row.bounded_fact_retrieved && row.bounded_qualifier_retrieved,
  );
  const report = {
    version: 1,
    corpus_sha256: frozenHash,
    provider_calls: 0,
    label_scope:
      "Independent source retrieval/omission controls; no model semantic qualification",
    expected_cases: corpus.cases.length,
    evaluated_cases: receipts.length,
    metrics: {
      complete_source_recall: {
        numerator: receipts.filter((row) => row.complete_source_retrieved)
          .length,
        denominator: corpus.cases.length,
      },
      bounded_discovery_recall: {
        numerator: correct.length,
        denominator: corpus.cases.length,
      },
      silent_omissions: receipts.filter(
        (row) =>
          !row.bounded_fact_retrieved &&
          (row.selection_complete ||
            row.capability_absence_proven ||
            !row.retrieval_gap),
      ).length,
      false_partial_claim_eligibility: receipts.filter(
        (row) => row.partial_claim_eligible,
      ).length,
    },
    by_query_language: ["ar", "en"].map((language) => ({
      language,
      bounded_discovery_recall: {
        numerator: correct.filter((row) => row.query_language === language)
          .length,
        denominator: corpus.cases.filter(
          (row: any) => row.query_language === language,
        ).length,
      },
    })),
    cases: receipts.sort((a, b) => a.id.localeCompare(b.id)),
    acceptance:
      "Full-source controls must retain gold; omitted/partial evidence must remain explicit and cannot grant claim authority. Bounded semantic recall is measured, with no post-outcome minimum introduced.",
  };
  writeFileSync(
    process.env.G09_QUALIFICATION_REPORT,
    JSON.stringify(report, null, 2) + "\n",
  );
});
