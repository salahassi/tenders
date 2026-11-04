import type { Evidence, Reference } from "./model.ts";

// Version 1 is frozen in the proposal input snapshot. These are conservative
// byte limits for added context, not a tokenizer or a model capacity assertion.
// The normal provider/context and exact-content authorization gates still apply.
export const COMPANY_RETRIEVAL_VERSION = 1;
export const COMPANY_EVIDENCE_BYTE_LIMIT = 24000;
export const COMPANY_CONTEXT_BYTE_LIMIT = 48000;
const encoder = new TextEncoder();
export const encodedSize = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;

type Requirement = {
  id: string;
  text: string;
  source_refs?: { id: string; quote: string }[];
};
type CompanySource = Evidence & { reference: Reference };
const tokens = (text: string) => [
  ...new Set(
    text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) || [],
  ),
];

export const COMPANY_RETRIEVAL_INSTRUCTION =
  "Company evidence coverage describes only the verified sources in this frozen request. " +
  "Selection and literal matches do not establish semantic support or company capability. " +
  "Read the full supplied source blocks, including conditions and negation. Cross-language wording and synonyms may express the same capability. " +
  "When selection_complete is false, evidence was omitted for context capacity: retain an explicit company-evidence retrieval gap and request targeted evidence review; never conclude that the company lacks a capability or that no supporting record exists. " +
  "Even complete retrieval or an empty verified snapshot does not prove capability absence. Missing proof must remain unknown. Historical style material never proves company facts.";

/**
 * Select complete immutable source blocks, not synthetic stitched quotations.
 * All bounded evidence wins over lexical ranking. Ranking only determines which
 * whole blocks fit when context is limited; it never labels a fact supported.
 * Currentness/authorization are resolved by the snapshot and model preflight,
 * not inferred from a source ID or these lexical scores.
 */
export function retrieveCompanyEvidence(
  sources: CompanySource[],
  requirements: Requirement[],
  byteLimit = COMPANY_EVIDENCE_BYTE_LIMIT,
  prioritySourceIds: string[] = [],
) {
  const blocks = [
    ...new Map(
      sources
        .filter(
          (s) => s.kind === "company" && s.verified === true && s.text.trim(),
        )
        .map((s) => [s.id, s]),
    ).values(),
  ];
  // A document may have multiple immutable blocks. Admit all of its blocks
  // together so a qualification in the next block cannot disappear as a crop.
  const grouped = new Map<string, CompanySource[]>();
  for (const block of blocks) {
    const key = JSON.stringify([
      block.reference.entity_kind,
      block.reference.entity_id,
      block.reference.content_hash,
    ]);
    grouped.set(key, [...(grouped.get(key) || []), block]);
  }
  const available = [...grouped]
    .map(([id, sourceBlocks]) => ({
      id,
      blocks: sourceBlocks,
      text: sourceBlocks.map((s) => s.text).join("\n"),
      bytes: sourceBlocks.reduce((sum, s) => sum + encodedSize(s), 0),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const budget = Math.max(
    0,
    Math.min(
      COMPANY_EVIDENCE_BYTE_LIMIT,
      Number.isFinite(byteLimit) ? Math.floor(byteLimit) : 0,
    ),
  );
  const costs = new Map(available.map((s) => [s.id, s.bytes]));
  const requirementScores = requirements.map((r) => {
    const terms = tokens(r.text);
    return {
      requirement_id: r.id,
      candidates: available
        .map((s) => {
          const text = s.text.normalize("NFC").toLowerCase();
          return {
            source: s,
            cited: (r.source_refs || []).some((ref) =>
              s.blocks.some((b) => b.id === ref.id),
            ),
            matches: terms.reduce(
              (n, term) => n + Number(text.includes(term)),
              0,
            ),
          };
        })
        .sort(
          (a, b) =>
            Number(b.cited) - Number(a.cited) ||
            b.matches - a.matches ||
            a.source.id.localeCompare(b.source.id),
        ),
    };
  });
  const chosen = new Map<string, (typeof available)[number]>();
  let used = 0;
  const add = (source: (typeof available)[number]) => {
    const cost = costs.get(source.id)!;
    if (chosen.has(source.id)) return true;
    if (used + cost > budget) return false;
    chosen.set(source.id, source);
    used += cost;
    return true;
  };
  if (available.reduce((sum, s) => sum + costs.get(s.id)!, 0) <= budget) {
    available.forEach(add);
  } else {
    available
      .filter((s) => s.blocks.some((b) => prioritySourceIds.includes(b.id)))
      .forEach(add);
    // One matching block per requirement on each pass avoids one long query
    // monopolizing the budget. Oversized blocks are omitted intact and reported.
    const remaining = requirementScores.map((r) =>
      r.candidates.filter((c) => c.cited || c.matches > 0),
    );
    for (let round = 0; round < available.length; round++) {
      for (const candidates of remaining) {
        while (candidates.length && chosen.has(candidates[0].source.id))
          candidates.shift();
        const candidate = candidates.shift();
        if (candidate) add(candidate.source);
      }
    }
    // No-match sources may contain synonyms or another language. Include them
    // whenever space permits, without claiming lexical relevance proves support.
    available.forEach(add);
  }
  // Canonical source ordering makes source-rank ties stable. Within a document,
  // preserve the frozen block sequence rather than reordering random block IDs.
  const evidence = [...chosen.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((s) => s.blocks);
  const complete = chosen.size === available.length;
  return {
    evidence,
    coverage: {
      version: COMPANY_RETRIEVAL_VERSION,
      available_sources: available.length,
      supplied_sources: chosen.size,
      omitted_sources: available.length - chosen.size,
      available_blocks: blocks.length,
      supplied_blocks: evidence.length,
      available_bytes: available.reduce((sum, s) => sum + costs.get(s.id)!, 0),
      supplied_bytes: used,
      byte_budget: budget,
      selection_complete: complete,
      supplied_sources_complete: true,
      capability_absence_proven: false,
      cited_source_coverage_complete: prioritySourceIds.every((id) =>
        evidence.some((s) => s.id === id),
      ),
      gap: complete
        ? available.length
          ? null
          : "no_verified_source_in_snapshot"
        : "context_capacity",
      requirement_coverage: requirementScores.map((r) => ({
        requirement_id: r.requirement_id,
        lexical_match_source_ids: r.candidates
          .filter((c) => chosen.has(c.source.id) && c.matches > 0)
          .flatMap((c) => c.source.blocks.map((b) => b.id)),
        semantic_support: "not_evaluated",
        retrieval_gap: !complete,
      })),
    },
    // Keep complete exclusion identities in the local receipt, not the prompt:
    // omitted sources are not part of the request's content manifest.
    omitted: available
      .filter((s) => !chosen.has(s.id))
      .map((s) => ({
        source_ids: s.blocks.map((b) => b.id),
        content_hash: s.blocks[0].reference.content_hash,
        reason: "context_capacity",
        bytes: costs.get(s.id)!,
      })),
  };
}
