// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  applyQuoteRepairScope,
  pinQuoteRepairScope,
} from "../../supabase/functions/_shared/modelQuoteRepairScope";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";

async function fixture() {
  const candidate = {
    requirements: [
      {
        text: "Buyer requires an audit log.",
        mandatory: true,
        source_refs: [{ id: "source", quote: "Bad quote." }],
      },
      {
        text: "Delivery is conditional on approval.",
        mandatory: false,
        source_refs: [{ id: "source", quote: "Delivery follows approval." }],
      },
    ],
    summary: "Known buyer scope.",
  };
  const context = {
    target_task: "analyze_chunk",
    original_context: {},
    candidate,
    findings: [],
    validation_diagnostics: [
      {
        code: "EVIDENCE_REFERENCE_INVALID",
        reason: "source_quote_mismatch",
        paths: ["$.requirements[0].source_refs[0].quote"],
        evidence_ids: ["source"],
      },
    ],
  };
  const records = new Map<string, any>();
  const action = vi.fn(async (operation: string, payload: any) => {
    if (operation === "result_get") return records.get(payload.key) ?? null;
    if (operation === "result_put") {
      const row = { value: structuredClone(payload.value) };
      records.set(payload.key, row);
      return row;
    }
    throw Error("Unexpected operation");
  });
  const internal = vi.fn(async () => false);
  const options = {
    backend: { internal },
    store: { action },
    job: { id: "job", lease_token: "lease" },
    requestPrefix: "step:fixture:candidate-1",
    context,
    evidence: [
      {
        id: "source",
        kind: "rfp" as const,
        verified: false,
        text: "Buyer requires an audit log. Delivery follows approval.",
      },
    ],
    requiredIds: ["source"],
    language: "en" as const,
  };
  return { candidate, context, records, options, internal, action };
}
it("pins a quote-only scope and composes allowed replacements without changing the original candidate", async () => {
  const f = await fixture(),
    scope = await pinQuoteRepairScope(f.options);
  expect(scope).toEqual({
    version: 1,
    candidate_hash: await sha256(JSON.stringify(f.candidate)),
    allowed_paths: ["$.requirements[0].source_refs[0].quote"],
  });
  const corrected = structuredClone(f.candidate);
  corrected.requirements[0].source_refs[0].quote =
    "Buyer requires an audit log.";
  expect(applyQuoteRepairScope(f.candidate, corrected, scope!)).toEqual(
    corrected,
  );
  expect(f.candidate.requirements[0].source_refs[0].quote).toBe("Bad quote.");
  expect(await pinQuoteRepairScope(f.options)).toEqual(scope);
  expect(f.internal).toHaveBeenCalledOnce();
});
it.each([
  "mandatory",
  "text",
  "source",
  "delete",
  "reorder",
  "unlisted_quote",
  "summary",
])(
  "rejects out-of-scope %s changes even when the listed quotation is repaired",
  async (change) => {
    const f = await fixture(),
      scope = await pinQuoteRepairScope(f.options);
    const corrected = structuredClone(f.candidate);
    corrected.requirements[0].source_refs[0].quote =
      "Buyer requires an audit log.";
    if (change === "mandatory") corrected.requirements[0].mandatory = false;
    if (change === "text")
      corrected.requirements[0].text = "Optional audit log.";
    if (change === "source")
      corrected.requirements[0].source_refs[0].id = "other-source";
    if (change === "delete") corrected.requirements.pop();
    if (change === "reorder") corrected.requirements.reverse();
    if (change === "unlisted_quote")
      corrected.requirements[1].source_refs[0].quote = "Changed quote.";
    if (change === "summary")
      corrected.summary = "All requirements are optional.";
    expect(() => applyQuoteRepairScope(f.candidate, corrected, scope!)).toThrow(
      "MODEL_OUTPUT_INVALID",
    );
  },
);
it.each(["accepted", "prepared", "saved_round"])(
  "preserves the exact context of a historical %s phase",
  async (state) => {
    const f = await fixture();
    const old = modelPrompt(
      "repair_result",
      f.context,
      f.options.evidence,
      ["source"],
      "en",
      true,
      1,
      4,
    );
    if (state === "accepted") f.internal.mockResolvedValue(true);
    if (state === "prepared")
      f.records.set(
        `semantic-instructions-${await sha256(f.options.requestPrefix)}`,
        { value: { version: 4 } },
      );
    if (state === "saved_round")
      (f.options.job as any).checkpoint = {
        model_round: {
          input_hash: await sha256(
            modelPrompt(
              "repair_result",
              f.context,
              f.options.evidence,
              ["source"],
              "en",
              true,
              1,
              0,
            ),
          ),
        },
      };
    expect(await pinQuoteRepairScope(f.options)).toBeNull();
    expect(
      modelPrompt(
        "repair_result",
        f.context,
        f.options.evidence,
        ["source"],
        "en",
        true,
        1,
        4,
      ),
    ).toBe(old);
    f.internal.mockResolvedValue(false);
    expect(await pinQuoteRepairScope(f.options)).toBeNull();
  },
);
it("refuses stale candidate identity and widened paths on pin replay", async () => {
  const f = await fixture();
  await pinQuoteRepairScope(f.options);
  f.context.candidate.requirements[0].mandatory = false;
  await expect(pinQuoteRepairScope(f.options)).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
  f.context.candidate.requirements[0].mandatory = true;
  f.context.validation_diagnostics[0].paths[0] =
    "$.requirements[1].source_refs[0].quote";
  await expect(pinQuoteRepairScope(f.options)).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});
it("does not force semantic or source-identity repairs into an unrelated quote-only contract", async () => {
  const f = await fixture();
  f.context.validation_diagnostics[0].reason = "source_missing";
  expect(await pinQuoteRepairScope(f.options)).toBeNull();
  expect(f.action).not.toHaveBeenCalled();
  f.context.validation_diagnostics[0].reason = "source_quote_mismatch";
  (f.context as any).untrusted_verification_report = {
    findings: [{ detail: "Quantity is contradicted." }],
  };
  expect(await pinQuoteRepairScope(f.options)).toBeNull();
  expect(f.action).not.toHaveBeenCalled();
});
it("treats overflow as unresolved without widening the finite repair paths", async () => {
  const f = await fixture();
  (f.context as any).omitted_validation_diagnostic_count = 2;
  const scope = await pinQuoteRepairScope(f.options);
  expect(scope?.allowed_paths).toHaveLength(1);
  const changed = structuredClone(f.candidate);
  changed.requirements[1].mandatory = true;
  expect(() => applyQuoteRepairScope(f.candidate, changed, scope!)).toThrow(
    "MODEL_OUTPUT_INVALID",
  );
});

it("does not confuse an unrelated previous round with this new repair phase", async () => {
  const f = await fixture();
  (f.options.job as any).checkpoint = {
    model_round: { input_hash: "a".repeat(64) },
  };
  expect(await pinQuoteRepairScope(f.options)).toMatchObject({ version: 1 });
  expect(f.internal).toHaveBeenCalledOnce();
});
