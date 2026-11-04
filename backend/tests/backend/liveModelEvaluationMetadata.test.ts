// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtures,
  evaluate,
  limitsForSuite,
  validateTargets,
} from "../../scripts/ops/live-model-evaluation.mjs";
import { SEMANTIC_V2_CORPUS_SHA256 } from "../../scripts/ops/live-model-evaluation-semantics-v2.mjs";
import { modelPrompt } from "../../supabase/functions/_shared/model";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { VERIFICATION_INSTRUCTIONS_V5 } from "../../supabase/functions/_shared/modelVerificationInstructions";
afterEach(() => vi.restoreAllMocks());
it.each(["en", "ar"] as const)(
  "offers an explicit %s prompt5 campaign while baseline v2 remains prompt4",
  async (language) => {
    const baseline = await fixtures(`semantic_v2_${language}`),
      campaign = await fixtures(`semantic_v2_metadata_${language}`);
    expect(campaign).toHaveLength(16);
    expect(baseline.every((f: any) => f.verificationRevision === 4)).toBe(true);
    for (const [i, f] of campaign.entries()) {
      expect(f.id).toBe(
        baseline[i].id.replace("semantic_v2_", "semantic_v2_metadata_"),
      );
      expect(f.context).toEqual(baseline[i].context);
      expect(f.evidence).toEqual(baseline[i].evidence);
      expect(f.qualification).toMatchObject({
        corpus_sha256: SEMANTIC_V2_CORPUS_SHA256,
        oracle_version: 2,
        verification_policy_version: 5,
      });
      expect(f.verificationRevision).toBe(5);
      const prompt = JSON.parse(
        modelPrompt(
          f.task,
          f.context,
          f.evidence,
          f.required,
          f.language,
          false,
          f.verificationRevision,
          f.semanticRevision,
        ),
      );
      expect(prompt.verification_policy).toBe(VERIFICATION_INSTRUCTIONS_V5);
      expect(prompt.prompt_version).toContain(
        "tenderdesk-grounding-v5-analysis-metadata",
      );
      expect(JSON.stringify(prompt.untrusted_data)).not.toMatch(
        /verification_policy_version|oracle_version|defect_term_groups|qualification|offending_candidate_spans/,
      );
    }
  },
);
it.each(["en", "ar"] as const)(
  "retains unavailable %s prompt5 cases as unqualified with distinct receipt identity",
  async (language) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const suite = `semantic_v2_metadata_${language}` as const;
    const targets = ["openai", "qwencloud"].map((provider) => ({
      provider,
      model: "synthetic-model",
      project_ref: "fixture",
      key: "synthetic-private-key",
      capabilities: defaultCapabilities(provider as "openai" | "qwencloud"),
    }));
    expect(limitsForSuite(suite)).toMatchObject({ models: 4, generations: 64 });
    const transport = vi.fn(async () =>
      Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }),
    );
    const report = await evaluate(
      targets,
      transport as typeof fetch,
      async () => {},
      undefined,
      suite,
    );
    expect(report.complete).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(32);
    expect(transport).toHaveBeenCalledTimes(32);
    expect(
      report.results.every(
        (r: any) =>
          r.case.startsWith(`semantic_v2_metadata_${language}_`) &&
          r.qualification.verification_policy_version === 5 &&
          r.semantic_outcome === "not_scored",
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(targets[0].key);
    expect(() => validateTargets([...targets, ...targets], suite)).toThrow(
      "EVAL_DUPLICATE_TARGET",
    );
    expect(() => validateTargets([targets[0]], suite)).toThrow(
      "EVAL_BOTH_PROVIDERS_REQUIRED",
    );
  },
);
