// @vitest-environment node
import { expect, it, vi } from "vitest";
import { pinRepairFormat } from "../../supabase/functions/_shared/modelRepairFormat";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import { typedVerificationFixtures } from "./typedVerificationFixtures";

async function fixture() {
  const records = new Map<string, any>();
  const action = vi.fn(async (operation: string, args: any) => {
    if (operation === "result_get") return records.get(args.key) ?? null;
    if (operation === "result_put") {
      const row = { value: structuredClone(args.value) };
      records.set(args.key, row);
      return row;
    }
    throw Error("Unexpected action");
  });
  const internal = vi.fn(async () => false);
  const candidate = structuredClone(
    typedVerificationFixtures.analyze_chunk.candidate,
  );
  candidate.requirements[0].source_refs[0].quote = "Wrong quotation.";
  const context = {
    target_task: "analyze_chunk",
    original_context: { repair_contract_version: 1 },
    candidate,
    validation_diagnostics: [
      {
        code: "EVIDENCE_REFERENCE_INVALID",
        reason: "source_quote_mismatch",
        paths: ["$.requirements[0].source_refs[0].quote"],
      },
    ],
  };
  const options = {
    backend: { internal } as any,
    store: { action },
    job: {
      id: "synthetic-job",
      lease_token: "synthetic-lease",
      checkpoint: {} as any,
    },
    requestPrefix: "synthetic:phase:candidate-1",
    context,
    evidence: [],
    requiredIds: ["source"],
    language: "en" as const,
  };
  const hash = await sha256(
    modelPrompt("repair_result", context, [], options.requiredIds, "en", true),
  );
  return {
    records,
    internal,
    options,
    hash,
    suffix: await sha256(options.requestPrefix),
  };
}
it.each(["semantic", "quote", "saved_round", "reserved", "settled", "unknown"])(
  "keeps an already prepared/paid %s repair on its exact legacy wire",
  async (state) => {
    const f = await fixture();
    if (state === "semantic" || state === "quote")
      f.records.set(
        `${state === "semantic" ? "semantic-instructions" : "quote-repair-scope"}-${f.suffix}`,
        { value: { version: 1 } },
      );
    else if (state === "saved_round")
      f.options.job.checkpoint.model_round = { input_hash: f.hash };
    else f.internal.mockResolvedValue(true);
    expect(await pinRepairFormat(f.options)).toBeNull();
    expect(f.records.get(`repair-format-${f.suffix}`).value).toEqual({
      version: 0,
      legacy_input_hash: f.hash,
      scope: null,
    });
    expect(
      await sha256(
        modelPrompt(
          "repair_result",
          f.options.context,
          [],
          ["source"],
          "en",
          true,
        ),
      ),
    ).toBe(f.hash);
    f.internal.mockResolvedValue(false);
    expect(await pinRepairFormat(f.options)).toBeNull();
    if (["semantic", "quote", "saved_round"].includes(state))
      expect(f.internal).not.toHaveBeenCalled();
    else expect(f.internal).toHaveBeenCalledOnce();
  },
);
it("pins an unstarted patch once with base/scope identity and rejects later scope tampering", async () => {
  const f = await fixture(),
    scope = await pinRepairFormat(f.options);
  expect(scope?.paths.map((path) => path.path)).toEqual([
    "$.requirements[0].source_refs[0].quote",
  ]);
  f.internal.mockResolvedValue(true);
  expect(await pinRepairFormat(f.options)).toEqual(scope);
  expect(f.internal).toHaveBeenCalledOnce();
  f.records.get(`repair-format-${f.suffix}`).value.scope.paths[0].path =
    "$.requirements[0].mandatory";
  await expect(pinRepairFormat(f.options)).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});
it("does not introduce patch contracts into legacy workflows or accept an indeterminate phase result", async () => {
  const f = await fixture();
  expect(
    await pinRepairFormat({
      ...f.options,
      context: { ...f.options.context, original_context: {} },
    }),
  ).toBeNull();
  expect(f.internal).not.toHaveBeenCalled();
  expect(f.records.size).toBe(0);
  f.internal.mockResolvedValue(undefined as any);
  await expect(pinRepairFormat(f.options)).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
  expect(f.records.size).toBe(0);
});
