// @vitest-environment node
import { expect, it } from "vitest";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import {
  typedCandidateStructure,
  MAX_TYPED_STRUCTURE_BYTES,
} from "../../supabase/functions/_shared/modelTypedCandidate";
import { verificationBatches } from "../../supabase/functions/_shared/modelVerification";
import {
  newVerificationBatchPin,
  verificationBatchContext,
} from "../../supabase/functions/_shared/modelVerificationBatchContext";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { sha256 } from "../../supabase/functions/_shared/model";
import { typedVerificationFixtures } from "./typedVerificationFixtures";

it("keeps canonical IDs, typed primitive/control fields and exact citation metadata", () => {
  const candidate = {
    requirements: [
      {
        text: "خدمة اختيارية بعد الموافقة.",
        mandatory: false,
        owner_question: null,
        category: "scope",
        source_refs: [{ id: "source", quote: "نص المصدر الدقيق." }],
      },
    ],
    lines: [
      {
        quantity: "0.00",
        included_in_base: false,
        rate_id: null,
        unit: "day",
        charge_group: "optional",
      },
    ],
    questions: [{ question: "Confirm scope.", blocking_level: "advisory" }],
    target_words: 100,
  };
  const typed = typedCandidateStructure(candidate);
  expect(typed.units).toEqual(candidateContent(candidate));
  expect(typed.structure.requirements[0]).toEqual({
    text: { content_unit_id: "content-0" },
    mandatory: false,
    owner_question: null,
    category: "scope",
    source_refs: candidate.requirements[0].source_refs,
  });
  expect(typed.structure.lines[0]).toEqual(candidate.lines[0]);
  expect(typed.structure.questions[0].blocking_level).toBe("advisory");
  expect(typed.structure.target_words).toBe(100);
  expect(candidate.requirements[0].text).toBe("خدمة اختيارية بعد الموافقة.");
});
it("does not duplicate a long draft into each batch and accounts for every scoped and unscoped unit", async () => {
  const candidate = structuredClone(
    typedVerificationFixtures.draft_section.candidate,
  );
  candidate.content_blocks = Array.from({ length: 96 }, (_, index) => ({
    type: "paragraph",
    text: `UNIT_${index}_` + "Synthetic conditional scope. ".repeat(300),
  }));
  modelSchemas.draft_section.parse(candidate);
  const fullBytes = new TextEncoder().encode(
    JSON.stringify(candidate),
  ).byteLength;
  expect(fullBytes).toBeLessThan(MAX_TYPED_STRUCTURE_BYTES);
  const units = candidateContent(candidate),
    batches = verificationBatches(candidate),
    seen: string[] = [];
  const hash = await sha256(JSON.stringify(candidate));
  for (const batch of batches) {
    const context = {
      original_task: "draft_section",
      candidate_hash: hash,
      candidate,
      candidate_text: units.map((unit) => unit.text).join("\n"),
      content_units: batch,
      verification_scope: "content_batch",
    };
    const wire = verificationBatchContext(
      context,
      candidate,
      newVerificationBatchPin("draft_section"),
    );
    expect(wire.candidate).toBeUndefined();
    expect(wire.candidate_text).toBeUndefined();
    expect(wire.typed_candidate_structure.content_blocks[0].type).toBe(
      "paragraph",
    );
    expect(wire.typed_content_manifest.content_unit_ids).toEqual(
      units.map((u) => u.id),
    );
    expect(wire.typed_content_manifest.scoped_content_ids).toEqual(
      batch.map((u) => u.id),
    );
    expect(wire.typed_context_instruction).toContain(
      "Do not invent missing text or report an omission",
    );
    const structureBytes = new TextEncoder().encode(
      JSON.stringify(wire.typed_candidate_structure),
    ).byteLength;
    expect(structureBytes).toBeLessThanOrEqual(MAX_TYPED_STRUCTURE_BYTES);
    expect(structureBytes).toBeLessThan(fullBytes);
    for (const unit of units.filter(
      (unit) => !batch.some((selected) => selected.id === unit.id),
    )) {
      if (unit.text.startsWith("UNIT_"))
        expect(JSON.stringify(wire)).not.toContain(unit.text);
    }
    seen.push(...batch.map((u) => u.id));
  }
  expect(seen).toEqual(units.map((u) => u.id));
  expect(new Set(seen).size).toBe(units.length);
});
it("rejects structural overflow before sending and refuses mismatched scoped text/IDs", () => {
  expect(() =>
    typedCandidateStructure({
      source_refs: [{ quote: "x".repeat(MAX_TYPED_STRUCTURE_BYTES) }],
    }),
  ).toThrow("MODEL_CONTEXT_TOO_LARGE");
  const candidate = typedVerificationFixtures.plan_commercial.candidate;
  const context = {
    original_task: "plan_commercial",
    candidate_hash: "a".repeat(64),
    content_units: [{ id: "content-0", text: "Forged scoped text" }],
    verification_scope: "content_batch",
  };
  expect(() =>
    verificationBatchContext(
      context,
      candidate,
      newVerificationBatchPin("plan_commercial"),
    ),
  ).toThrow("MODEL_IDENTITY_CHANGED");
});
