// @vitest-environment node
// Authored verdicts exercise report validation, not model semantic detection.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import corpus from "./fixtures/qualification-reserve/corpus-v4.json";
import fixture from "./fixtures/qualification-reserve/verifier-prerequisites-v1.json";
import { buildReserveAdapter } from "../../scripts/qualification/reserve-adapters";
import {
  loadVerifierPrerequisites,
  VERIFIER_PREREQUISITES_SHA256,
} from "../../scripts/qualification/reserve-verifier-adapters";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { sha256 } from "../../scripts/qualification/reserve.mjs";
const rows = corpus.cases.filter((r) => r.task === "verify_grounding");
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it("freezes the four explicit verifier-stage candidates before model outputs", async () => {
  expect(await loadVerifierPrerequisites()).toEqual(fixture);
  expect(sha256(JSON.stringify(fixture, null, 2) + "\n")).toBe(
    VERIFIER_PREREQUISITES_SHA256,
  );
});
it.each(rows)(
  "constructs the real typed source-bound whole verifier phase for $id",
  async (row) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external forbidden"));
    const adapter = await buildReserveAdapter(row.id),
      input = fixture.cases.find((c) => c.case_id === row.id)!;
    expect(adapter.verificationRevision).toBe(5);
    expect(adapter.context.response_style).toBe("compact-verification-v3");
    expect(adapter.context.candidate_text).toBeUndefined();
    expect(adapter.context.original_task).toBe("analyze_chunk");
    expect(adapter.context.original_context.source_contract_version).toBe(1);
    expect(adapter.context.original_context.source_evidence.reviews).toEqual(
      [],
    );
    expect(adapter.context.candidate_hash).toBe(
      sha256(JSON.stringify(adapter.context.candidate)),
    );
    expect(adapter.context.content_units).toEqual(
      candidateContent(adapter.context.candidate),
    );
    const requirement = adapter.context.candidate.requirements[0];
    expect(requirement.text).toBe(row.documents[0].text);
    expect(requirement.interpretation).toBe(input.interpretation);
    expect(requirement.source_semantics.quantities[0].unit).toBe(
      row.workflow_facts.candidate_semantics!.unit,
    );
    expect(requirement.source_semantics.review_status).toBe("pending");
    expect(requirement.source_semantics.review_id).toBeNull();
    expect(adapter.trace).toMatchObject({
      candidate_origin: "authored_direct_verifier_input",
      prior_provider_success: false,
      prior_semantic_approval: false,
      request_count: 1,
      verifier_prerequisites_sha256: VERIFIER_PREREQUISITES_SHA256,
    });
    expect(
      adapter.phasePins.some(
        (p) =>
          p.key.startsWith("verification-format-") && p.value.version === 3,
      ),
    ).toBe(true);
    expect(
      adapter.phasePins.some(
        (p) =>
          p.key.startsWith("verification-instructions-") &&
          p.value.version === 5,
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(rows)(
  "runs actual report hash, content, source and quote guards for $id",
  async (row) => {
    const adapter = await buildReserveAdapter(row.id),
      candidate = adapter.context.candidate;
    const requirement = candidate.requirements[0],
      reference = requirement.source_refs[0];
    const contradicted =
      row.workflow_facts.candidate_semantics!.action === "full_restoration";
    const status = contradicted ? "contradicted" : "supported";
    const result = {
      checked_candidate_hash: adapter.context.candidate_hash,
      reviewed_all_content: true,
      processed_content_ids: adapter.context.content_units.map(
        (u: any) => u.id,
      ),
      claims: [
        {
          id: "claim-1",
          claim: requirement.interpretation,
          candidate_quote: requirement.interpretation,
          kind: "tender_fact",
          status,
          source_refs: [reference],
          finding: contradicted
            ? "Action and elapsed-hour unit differ from the source."
            : "",
        },
      ],
      processed_requirement_ids: adapter.required,
      requirement_checks: adapter.required.map((id) => ({
        requirement_id: id,
        status,
        candidate_quote: requirement.interpretation,
        source_refs: [reference],
        finding: contradicted
          ? "Source requires acknowledgement in business hours."
          : "",
      })),
      findings: contradicted
        ? [
            {
              severity: "blocking",
              code: "ACTION_UNIT_CHANGED",
              detail: "The candidate changes the action and time unit.",
              claim_ids: ["claim-1"],
              requirement_ids: adapter.required,
            },
          ]
        : [],
    };
    expect(() => adapter.domainValidate!(result)).not.toThrow();
    const badHash = structuredClone(result);
    badHash.checked_candidate_hash = "0".repeat(64);
    expect(() => adapter.domainValidate!(badHash)).toThrow();
    const omitted = structuredClone(result);
    omitted.processed_content_ids.pop();
    expect(() => adapter.domainValidate!(omitted)).toThrow();
    const badSource = structuredClone(result);
    badSource.claims[0].source_refs = [
      { id: "unknown-source", quote: reference.quote },
    ];
    expect(() => adapter.domainValidate!(badSource)).toThrow();
    const badCandidateQuote = structuredClone(result);
    badCandidateQuote.claims[0].candidate_quote =
      "This is not present in the candidate.";
    expect(() => adapter.domainValidate!(badCandidateQuote)).toThrow();
  },
);
