import { expect, it, vi } from "vitest";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";
import {
  newVerificationBatchPin,
  verificationBatchContext,
  verificationBatchPartition,
} from "../../supabase/functions/_shared/modelVerificationBatchContext";

const evidence = [
  {
    id: "source-1",
    kind: "rfp" as const,
    verified: false,
    text: "The vendor proposes workshops.",
  },
];
async function fixture() {
  const candidate = {
    summary:
      "The reference describes vendor-proposed work; buyer authority is unconfirmed.",
    requirements: [
      {
        text: "Deliver workshops.",
        category: "scope",
        mandatory: true,
        source_refs: [
          { id: "source-1", quote: "The vendor proposes workshops." },
        ],
        interpretation: "Proposed work, not an established buyer mandate.",
        owner_question: null,
        acceptance_evidence: "Workshop delivery record.",
      },
    ],
    questions: [
      {
        question: "Is a formal buyer RFP available?",
        blocking_level: "generation",
        requirement_ids: [],
      },
    ],
    processed_block_ids: ["source-1"],
    separate_volumes: false,
  };
  return {
    original_task: "analyze_chunk",
    original_context: {
      draft_input_version: 1,
      instruction: "Synthetic extraction fixture.",
    },
    candidate,
    candidate_hash: await sha256(JSON.stringify(candidate)),
    candidate_text: candidateContent(candidate)
      .map((u) => u.text)
      .join("\n"),
    content_units: candidateContent(candidate),
  };
}
function memory(version?: number) {
  let pin = version === undefined ? null : { value: { version } };
  const action = vi.fn(async (op, payload) => {
    if (op === "result_get") return pin;
    if (op === "result_put") return (pin = { value: payload.value });
    throw Error("Unexpected store mutation");
  });
  return { action } as any;
}
const ledger = () =>
  ({ preflight: vi.fn(async () => ({ providers: [] })) }) as any;
const prompt = (context: unknown) =>
  modelPrompt(
    "verify_grounding",
    context,
    evidence,
    ["source-1"],
    "en",
    false,
    4,
    4,
  );

it("new whole analysis verification exposes typed authority and question ownership", async () => {
  const original = await fixture();
  const before = JSON.stringify(original);
  const store = memory();
  const wire = await verificationContext(store, ledger(), original, []);
  expect(store.action).toHaveBeenCalledWith("result_put", {
    key: `verification-format-${original.candidate_hash}`,
    value: { version: 3 },
  });
  expect(wire.response_style).toBe("compact-verification-v3");
  expect(wire.candidate_text).toBeUndefined();
  expect(wire.candidate).toEqual(original.candidate);
  expect(wire.candidate.requirements[0].mandatory).toBe(true);
  expect(wire.candidate.requirements[0].owner_question).toBeNull();
  expect(wire.candidate.questions[0].blocking_level).toBe("generation");
  expect(wire.candidate.separate_volumes).toBe(false);
  expect(wire.content_units).toEqual(original.content_units);
  expect(wire.candidate_hash).toBe(original.candidate_hash);
  const sent = JSON.parse(prompt(wire).split("\nJSON schema: ")[0]);
  expect(sent.untrusted_data.candidate.requirements[0].mandatory).toBe(true);
  expect(sent.untrusted_data.candidate.questions[0].blocking_level).toBe(
    "generation",
  );
  expect(JSON.stringify(original)).toBe(before);
});

it("the same prose with opposite mandatory flags remains distinguishable to a verifier", async () => {
  const first = await fixture();
  const second = structuredClone(first);
  second.candidate.requirements[0].mandatory = false;
  second.candidate_hash = await sha256(JSON.stringify(second.candidate));
  expect(candidateContent(second.candidate)).toEqual(first.content_units);
  const wires = await Promise.all(
    [first, second].map((c) => verificationContext(memory(), ledger(), c, [])),
  );
  expect(wires.map((c) => c.candidate.requirements[0].mandatory)).toEqual([
    true,
    false,
  ]);
});

it.each([
  [1, "e67ab19407a73969918c3a70ecb449062bbf3f4bdbc3c5d3deadcc3b8e0b5e85"],
  [2, "75c283901d64e81f798c2398e59e8adac98568fd9632cb80d7886fdca4cc03c2"],
] as const)(
  "preserves the complete historical format %s prompt bytes",
  async (version, hash) => {
    const original = await fixture();
    const store = memory(version);
    const existing = ledger();
    const wire = await verificationContext(store, existing, original, []);
    expect(await sha256(prompt(wire))).toBe(hash);
    expect(existing.preflight).not.toHaveBeenCalled();
    expect(store.action).not.toHaveBeenCalledWith(
      "result_put",
      expect.anything(),
    );
  },
);

it("does not assign a new format to an accepted unpinned legacy request", async () => {
  const original = await fixture();
  const store = memory();
  const pending = {
    preflight: vi.fn(async () => ({ pending_model_config_id: "accepted" })),
  } as any;
  expect(await verificationContext(store, pending, original, [])).toEqual(
    original,
  );
  expect(store.action).not.toHaveBeenCalledWith(
    "result_put",
    expect.anything(),
  );
});

it("replays format3 and report correction without another format or preflight", async () => {
  const original = await fixture();
  const corrected = {
    ...original,
    invalid_verification_result: {
      checked_candidate_hash: original.candidate_hash,
    },
    validation_error: "EVIDENCE_REFERENCE_INVALID",
  };
  const store = memory(3);
  const existing = ledger();
  const wire = await verificationContext(store, existing, corrected, []);
  expect(wire.candidate).toEqual(original.candidate);
  expect(wire.invalid_verification_result).toEqual(
    corrected.invalid_verification_result,
  );
  expect(wire.validation_error).toBe(corrected.validation_error);
  expect(existing.preflight).not.toHaveBeenCalled();
  expect(await verificationContext(store, existing, corrected, [])).toEqual(
    wire,
  );
});

it.each(["missing_candidate", "wrong_task", "array_candidate"])(
  "fails closed for an inconsistent format3 identity: %s",
  async (mode) => {
    const original: any = await fixture();
    if (mode === "missing_candidate") delete original.candidate;
    else if (mode === "array_candidate") original.candidate = [];
    else original.original_task = "draft_section";
    await expect(
      verificationContext(memory(3), ledger(), original, []),
    ).rejects.toThrow("MODEL_IDENTITY_CHANGED");
  },
);

async function batchFixture() {
  const original = await fixture();
  const context = {
    original_task: original.original_task,
    original_context: original.original_context,
    candidate_hash: original.candidate_hash,
    content_units: original.content_units.slice(0, 2),
    verification_scope: "content_batch",
  };
  return { original, context };
}

it.each([undefined, { version: 2 as const, outputTokens: 40000 }])(
  "pins typed analysis batches separately without changing their partition policy (%j)",
  async (policy) => {
    const { original, context } = await batchFixture();
    const before = JSON.stringify(context);
    const pin = newVerificationBatchPin("analyze_chunk", policy);
    expect(pin).toEqual({
      version: 5,
      context_format: 3,
      partition: policy ? { version: 4, policy } : { version: 3 },
    });
    expect(verificationBatchPartition(pin, "analyze_chunk")).toEqual(
      policy ? { version: 4, policy } : { version: 3 },
    );
    const wire = verificationBatchContext(context, original.candidate, pin);
    expect(wire.candidate.requirements[0].mandatory).toBe(true);
    expect(wire.candidate.questions[0].blocking_level).toBe("generation");
    expect(wire.response_style).toBe("compact-verification-v3");
    expect(wire.content_units).toEqual(context.content_units);
    expect(wire.verification_scope).toBe("content_batch");
    expect(wire.candidate_hash).toBe(original.candidate_hash);
    expect(JSON.stringify(context)).toBe(before);
  },
);

it.each([
  { version: 3 },
  { version: 4, policy: { version: 2, outputTokens: 40000 } },
])("keeps old batch format %j payloads byte-identical", async (pin) => {
  const { original, context } = await batchFixture();
  const wire = verificationBatchContext(context, original.candidate, pin);
  expect(wire).toBe(context);
  expect(wire).not.toHaveProperty("candidate");
  expect(wire).not.toHaveProperty("response_style");
  expect(prompt(wire)).toBe(prompt(context));
  expect(
    await sha256(
      modelPrompt("verify_grounding", wire, evidence, [], "en", false, 4, 4),
    ),
  ).toBe("e1494ce5ac847a36fa24e6b70dc95b693f8fb8022cceeb526522c81753441b0c");
  expect(verificationBatchPartition(pin, "analyze_chunk")).toBe(pin);
});

it("does not let typed whole-candidate visibility expand a batch's quotations or coverage", async () => {
  const { original, context } = await batchFixture();
  const wire = verificationBatchContext(
    context,
    original.candidate,
    newVerificationBatchPin("analyze_chunk"),
  );
  const report = {
    checked_candidate_hash: original.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: context.content_units.map((u) => u.id),
    processed_requirement_ids: [],
    requirement_checks: [],
    claims: [
      {
        id: "claim-1",
        kind: "assumption",
        status: "supported",
        claim: context.content_units[0].text,
        candidate_quote: context.content_units[0].text,
        source_refs: [],
        finding: "The source authority remains explicitly unconfirmed.",
      },
    ],
    findings: [],
  };
  const validate = (value: any) =>
    validateGroundingReport(
      value,
      wire.candidate,
      original.candidate_hash,
      evidence,
      [],
      { units: context.content_units },
    );
  expect(() => validate(report)).not.toThrow();
  expect(groundingDefects(report)).toEqual([]);
  // This text exists in the full typed candidate, but is outside this batch.
  const outside = wire.candidate.requirements[0].acceptance_evidence;
  expect(context.content_units.every((u) => !u.text.includes(outside))).toBe(
    true,
  );
  expect(() =>
    validate({
      ...report,
      claims: [{ ...report.claims[0], candidate_quote: outside }],
    }),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(() =>
    validate({
      ...report,
      processed_content_ids: original.content_units.map((u) => u.id),
    }),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  expect(() =>
    validate({
      ...report,
      checked_candidate_hash: "f".repeat(64),
    }),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
});

it("retains typed authority in the full requirements-only check without adding claims", async () => {
  const original = await fixture();
  const wire = verificationBatchContext(
    {
      original_task: "analyze_chunk",
      candidate_hash: original.candidate_hash,
      content_units: original.content_units,
      verification_scope: "requirements_only",
    },
    original.candidate,
    newVerificationBatchPin("analyze_chunk"),
  );
  expect(wire.candidate.requirements[0].mandatory).toBe(true);
  expect(wire.content_units).toEqual(original.content_units);
  const report = {
    checked_candidate_hash: original.candidate_hash,
    reviewed_all_content: true,
    processed_content_ids: original.content_units.map((u) => u.id),
    processed_requirement_ids: ["source-1"],
    requirement_checks: [
      {
        requirement_id: "source-1",
        status: "insufficient",
        candidate_quote: original.candidate.requirements[0].text,
        source_refs: [{ id: "source-1", quote: evidence[0].text }],
        finding:
          "The mandatory flag promotes vendor-proposed work into a buyer obligation.",
      },
    ],
    claims: [],
    findings: [],
  };
  expect(() =>
    validateGroundingReport(
      report,
      original.candidate,
      original.candidate_hash,
      evidence,
      ["source-1"],
      { units: original.content_units, requirementsOnly: true },
    ),
  ).not.toThrow();
  expect(groundingDefects(report)).toHaveLength(1);
});

it.each([
  { version: 5, context_format: 2, partition: { version: 3 } },
  { version: 5, context_format: 3, partition: { version: 3, extra: true } },
  { version: 5, context_format: 3, partition: { version: 4 } },
  { version: 5, context_format: 3, partition: { version: 3 }, extra: true },
])("rejects inconsistent new batch identity %j", (pin) => {
  expect(() => verificationBatchPartition(pin, "analyze_chunk")).toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});

it("keeps other tasks on their old batch pins and rejects analysis-pin reuse", () => {
  expect(newVerificationBatchPin("draft_section")).toEqual({ version: 3 });
  expect(() =>
    verificationBatchPartition(
      newVerificationBatchPin("analyze_chunk"),
      "draft_section",
    ),
  ).toThrow("MODEL_IDENTITY_CHANGED");
});
