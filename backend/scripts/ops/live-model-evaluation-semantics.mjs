/** Frozen synthetic development gold is never included in provider context. */
import { readFile } from "node:fs/promises";
import { ModelError, sha256, validateModelResult } from "../../supabase/functions/_shared/model.ts";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph.ts";
import { candidateContent, groundingDefects, groundingOptions, validateGroundingReport } from "../../supabase/functions/_shared/modelGrounding.ts";

const corpusUrl = new URL("../../tests/backend/fixtures/semantic-qualification/corpus-v1.json", import.meta.url);
export const SEMANTIC_CORPUS_SHA256 = "698127390ac44cd1e1ba7c0591af7bc3668c0be2fed0cff22079dc4bdba7847b";
export async function semanticCorpus() {
  const bytes = await readFile(corpusUrl, "utf8");
  const hash = await sha256(bytes);
  if (hash !== SEMANTIC_CORPUS_SHA256) throw new ModelError("EVAL_CORPUS_CHANGED");
  return { corpus: JSON.parse(bytes), sha256: hash };
}
export async function semanticFixtures(language) {
  if (!["en", "ar"].includes(language)) throw new ModelError("EVAL_SEMANTIC_LANGUAGE_INVALID");
  const { corpus, sha256: corpusHash } = await semanticCorpus();
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
      fixtures.push({ id: `semantic_${language}_${row.family}_${variant}_v1`, task: "verify_grounding", language,
        semanticRevision: 4, verificationRevision: 4, evidence, required, context,
        qualification: { corpus_sha256: corpusHash, split: corpus.split, family: row.family, variant,
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
          const specific = (detail) => row.oracle.defect_term_groups.every((group) => new RegExp(group, "iu").test(detail));
          const quotedDefect = (quote) => typeof quote === "string" && quote.length > 0 && row[variant].text.includes(quote) &&
            row.oracle.offending_candidate_spans.some((span) => quote.includes(span));
          const linkedClaim = (claim) => quotedDefect(claim.candidate_quote) && claim.source_refs.some((r) => r.id === required[0]);
          const detected = report.requirement_checks.some((r) => r.requirement_id === required[0] &&
            ["contradicted", "insufficient"].includes(r.status) && quotedDefect(r.candidate_quote) && r.source_refs.some((ref) => ref.id === required[0]) && specific(r.finding)) ||
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
