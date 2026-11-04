/** Frozen synthetic development gold is never included in provider context. */
import { readFile } from "node:fs/promises";
import { ModelError, sha256, validateModelResult } from "../../supabase/functions/_shared/model.ts";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph.ts";
import { candidateContent, groundingDefects, groundingOptions, validateGroundingReport } from "../../supabase/functions/_shared/modelGrounding.ts";

const corpusUrl = new URL("../../tests/backend/fixtures/semantic-qualification/corpus-v2.json", import.meta.url);
export const SEMANTIC_V2_CORPUS_SHA256 = "b53d46395d713d85e3beb2ac8341cf34bc12b429cd2844a0af033288c0527d9c";
export async function semanticV2Corpus() {
  const bytes = await readFile(corpusUrl, "utf8");
  const hash = await sha256(bytes);
  if (hash !== SEMANTIC_V2_CORPUS_SHA256) throw new ModelError("EVAL_CORPUS_CHANGED");
  const parsed = JSON.parse(bytes);
  // Every gold phrase is bound to the deliberately changed requirement, never
  // to another sentence that happens to contain the same number.
  if (parsed.version !== 2 || parsed.oracle_version !== 2 || parsed.cases.some((row) =>
    row.oracle.candidate_path !== "requirements[0].text" ||
    row.oracle.offending_candidate_spans.some((span) => !row.mutated.text.includes(span)) ||
    (row.oracle.supporting_source_spans || []).some((span) => !row.source.includes(span))))
    throw new ModelError("EVAL_CORPUS_INVALID");
  return { corpus: JSON.parse(bytes), sha256: hash };
}
export async function semanticV2Fixtures(language) {
  if (!["en", "ar"].includes(language)) throw new ModelError("EVAL_SEMANTIC_LANGUAGE_INVALID");
  const { corpus, sha256: corpusHash } = await semanticV2Corpus();
  const fixtures = [];
  for (const row of corpus.cases.filter((c) => c.language === language)) {
    for (const variant of ["faithful", "mutated"]) {
      const evidence = [{ id: "eval-source-1", kind: "rfp", verified: false, text: row.source }];
      const required = [evidence[0].id];
      const originalContext = { draft_input_version: 1, segment: { start: 0, end: Array.from(row.source).length },
        instruction: "Extract all requirements and their associated actor, modality, prohibition, condition, exception, quantity, unit or consequence. Preserve original source meaning in the requested response language." };
      const candidate = { processed_block_ids: required,
        requirements: [row[variant], ...(row.unchanged_requirements ?? [])].map((requirement) => ({ ...requirement, category: "deliverables", source_refs: [{ id: required[0], quote: row.source }],
          interpretation: "", acceptance_evidence: "", owner_question: null })),
        questions: [], separate_volumes: false, summary: [row[variant], ...(row.unchanged_requirements ?? [])].map((r) => r.text).join(" ") };
      validateModelResult("analyze_chunk", candidate, evidence, required, { draftInputVersion: 1 });
      const hash = await sha256(JSON.stringify(candidate));
      let format = null;
      const context = await verificationContext({ action: async (operation, payload) => {
        if (operation === "result_get") return format;
        if (operation === "result_put") return (format = { value: payload.value });
        throw new ModelError("EVAL_FIXTURE_FORMAT_OPERATION_INVALID");
      } }, { preflight: async () => ({ providers: [] }) }, {
        original_task: "analyze_chunk", original_context: originalContext, candidate_hash: hash,
        candidate, candidate_text: JSON.stringify(candidate), content_units: candidateContent(candidate),
      }, []);
      if (format?.value.version !== 3 || context.response_style !== "compact-verification-v3")
        throw new ModelError("EVAL_SEMANTIC_TYPED_FORMAT_MISSING");
      fixtures.push({ id: `semantic_v2_${language}_${row.family}_${variant}_v2`, task: "verify_grounding", language,
        semanticRevision: 4, verificationRevision: 4, evidence, required, context,
        qualification: { corpus_sha256: corpusHash, split: corpus.split, oracle_version: 2, family: row.family, variant,
          expected_field_paths: row.oracle.field_paths, repetitions: 1 },
        assertion_scope: "frozen_synthetic_semantic_pair_with_canonical_source_candidate_binding",
        domainValidate: (report) => validateGroundingReport(report, candidate, hash, evidence, required, undefined, groundingOptions(originalContext)),
        assert: (report) => {
          const defects = groundingDefects(report);
          if (variant === "faithful") {
            if (defects.length || !report.requirement_checks.every((r) => r.status === "supported"))
              throw new ModelError("EVAL_SEMANTIC_FALSE_REJECTION");
            return;
          }
          // Normalize explanation spelling only. Source/candidate quotes and offsets
          // retain their exact original bytes and canonical domain validation.
          const specific = (detail) => row.oracle.defect_term_groups.every((group) =>
            new RegExp(group, "iu").test(detail.normalize("NFC").replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/g, "")));
          const sourceLinked = (refs) => refs.some((ref) => ref.id === required[0] &&
            (!row.oracle.supporting_source_spans || row.oracle.supporting_source_spans.some((span) => ref.quote.includes(span))));
          const quotedDefect = (quote) => typeof quote === "string" && quote.length > 0 && candidateContent(candidate).some((unit) => unit.text.includes(quote)) &&
            row.oracle.offending_candidate_spans.some((span) => quote.includes(span));
          const linkedClaim = (claim) => quotedDefect(claim.candidate_quote) && sourceLinked(claim.source_refs);
          const detected = report.requirement_checks.some((r) => r.requirement_id === required[0] &&
            ["contradicted", "insufficient"].includes(r.status) && quotedDefect(r.candidate_quote) && sourceLinked(r.source_refs) && specific(r.finding)) ||
            report.claims.some((c) => linkedClaim(c) && ["contradicted", "insufficient"].includes(c.status) && specific(c.finding)) ||
            report.findings.some((f) => f.severity === "blocking" && specific(f.detail) &&
              f.claim_ids.some((id) => report.claims.some((c) => c.id === id && linkedClaim(c))));
          if (!detected) throw new ModelError("EVAL_SEMANTIC_FALSE_ACCEPTANCE");
        },
      });
    }
  }
  return fixtures;
}
