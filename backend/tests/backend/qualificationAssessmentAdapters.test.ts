// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import corpus from "./fixtures/qualification-reserve/corpus-v4.json";
import fixture from "./fixtures/qualification-reserve/assessment-prerequisites-v1.json";
import { buildReserveAdapter } from "../../scripts/qualification/reserve-adapters";
import {
  loadAssessmentPrerequisites,
  ASSESSMENT_PREREQUISITES_SHA256,
} from "../../scripts/qualification/reserve-assessment-adapters";
import { sha256 } from "../../scripts/qualification/reserve.mjs";
const rows = corpus.cases.filter((r) => r.task === "classify_opportunity");
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it("binds the actual default policy without introducing new keywords or a collected-notice claim", async () => {
  expect(await loadAssessmentPrerequisites()).toEqual(fixture);
  expect(sha256(JSON.stringify(fixture, null, 2) + "\n")).toBe(
    ASSESSMENT_PREREQUISITES_SHA256,
  );
  expect(fixture.scope_policy).toEqual({
    scope: "company_knowledge",
    include_keywords: [],
    exclude_keywords: [],
  });
});
it.each(rows)(
  "preserves notice projection and company authority through actual taskInput for $id",
  async (row) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
    const adapter = await buildReserveAdapter(row.id);
    expect(adapter.semanticRevision).toBe(3);
    expect(adapter.context.scope_policy).toEqual(fixture.scope_policy);
    expect(adapter.context.notice_evidence).toBeNull();
    expect(adapter.context.title_only).toBe(true);
    expect(adapter.context.company_evidence_coverage).toEqual({
      available_sources: 1,
      supplied_sources: 1,
      complete_text: true,
    });
    const notice = adapter.evidence.find((e) => e.kind === "notice")!,
      company = adapter.evidence.find((e) => e.kind === "company")!;
    expect(notice.id).not.toBe(row.documents[0].entity_id);
    expect(notice.text).toBe(row.documents[0].text);
    expect(notice.verified).toBe(false);
    expect(company.id).toBe(row.documents[1].entity_id);
    expect(company.text).toBe(row.documents[1].text);
    expect(company.verified).toBe(true);
    expect(adapter.manifest).toEqual([
      {
        entity_kind: "notice",
        entity_id: notice.id,
        content_hash: row.documents[0].sha256,
      },
      {
        entity_kind: "knowledge",
        entity_id: company.id,
        content_hash: row.documents[1].sha256,
      },
    ]);
    expect(adapter.trace.notice_collection_performed).toBe(false);
    expect(adapter.trace.source_projection[0]).toMatchObject({
      corpus_document_id: row.documents[0].id,
      original_entity_id: row.documents[0].entity_id,
      original_authority: "buyer_rfp",
      canonical_kind: "notice",
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(rows)(
  "enforces actual source-kind, quotation and scope-policy gates for $id",
  async (row) => {
    const adapter = await buildReserveAdapter(row.id),
      notice = adapter.evidence.find((e) => e.kind === "notice")!,
      company = adapter.evidence.find((e) => e.kind === "company")!;
    const factor = {
      rating: null,
      reason: "",
      notice_evidence: [{ id: notice.id, quote: notice.text }],
      company_evidence: [{ id: company.id, quote: company.text }],
    };
    const result = {
      factors: {
        capability: factor,
        scope: factor,
        sector: factor,
        prerequisite: factor,
      },
      scope_decision: {
        status:
          row.scenario === "mixed_scope_boundary"
            ? "out_of_scope"
            : "uncertain",
        reason: notice.text,
        notice_evidence: factor.notice_evidence,
        company_evidence: factor.company_evidence,
        keyword_evidence: [],
      },
      critical_unknown: row.scenario === "unproven_licence",
      reason_summary: notice.text,
      missing_information: [],
      risk_flags: [],
      suggested_tags: [],
    };
    expect(() => adapter.domainValidate!(result)).not.toThrow();
    const wrongKind = structuredClone(result);
    wrongKind.scope_decision.company_evidence = [
      { id: notice.id, quote: notice.text },
    ];
    expect(() => adapter.domainValidate!(wrongKind)).toThrow();
    const wrongQuote = structuredClone(result);
    wrongQuote.scope_decision.notice_evidence = [
      { id: notice.id, quote: "Not a supplied statement" },
    ];
    expect(() => adapter.domainValidate!(wrongQuote)).toThrow();
    const inventedPolicy = structuredClone(result) as any;
    inventedPolicy.scope_decision.keyword_evidence = [
      { kind: "include", keyword: "invented policy" },
    ];
    expect(() => adapter.domainValidate!(inventedPolicy)).toThrow();
  },
);
