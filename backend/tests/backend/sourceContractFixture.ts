// Synthetic transport fixture adapter. Never used by product runtime.
import { materializeSourceCandidate } from "../../supabase/functions/_shared/sourceEvidence";
export function sourceContractFixture(input: any, result: any) {
  if (
    input.context.source_contract_version !== 1 ||
    input.task !== "analyze_chunk"
  )
    return result;
  const spans = input.context.source_evidence.spans;
  return materializeSourceCandidate(
    input.task,
    {
      ...result,
      requirements: result.requirements.map((r: any) => {
        const selected = spans.filter((s: any) =>
          r.source_refs.some(
            (ref: any) => ref.id === s.id || ref.id === s.block_id,
          ),
        );
        if (!selected.length)
          throw new Error(
            "Synthetic requirement must select supplied source spans",
          );
        return {
          ...r,
          source_refs: selected.map((s: any) => ({ id: s.id, quote: s.quote })),
          source_semantics: {
            version: 1,
            source_span_ids: selected.map((s: any) => s.id),
            modality: "unknown",
            actor: null,
            negated: null,
            conditions: [],
            exceptions: [],
            consequences: [],
            quantities: [],
            dates: [],
            authority_role: "unknown",
            authority_status: "unconfirmed",
            review_status: "pending",
            review_id: null,
          },
        };
      }),
    },
    input.context,
    input.evidence,
  );
}
