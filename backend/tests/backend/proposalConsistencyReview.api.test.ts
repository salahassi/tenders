// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createApiHandler } from "../../supabase/functions/api/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
const actor = "00000000-0000-4000-8000-000000000001",
  version = "00000000-0000-4000-8000-000000000002",
  req = "00000000-0000-4000-8000-000000000003";
const env: BackendEnvironment = {
  url: "https://example.test",
  publishableKey: "synthetic",
  serviceKey: "synthetic",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic",
  models: modelEnvironments(() => undefined),
};
function fixture() {
  const text =
    "Configure the workflow. Deliver the manual. Acceptance requires buyer signoff.";
  const context = {
    version_id: version,
    version_revision: 1,
    binding_hash: "a".repeat(64),
    input: {
      requirements: [
        {
          id: req,
          text: "Provide an approval workflow",
          source_refs: [
            { id: "source", quote: "Provide an approval workflow" },
          ],
          source_semantics: {
            version: 1,
            source_span_ids: ["source"],
            authority_role: "buyer_rfp",
            authority_status: "confirmed",
            review_status: "confirmed",
            review_id: "source-review",
            modality: "required",
            actor: "supplier",
            negated: false,
            conditions: [],
            exceptions: [],
            consequences: [],
            quantities: [],
          },
        },
      ],
      sections: [
        {
          key: "approach",
          requirement_ids: [req],
          content_blocks: [{ type: "paragraph", text }],
        },
      ],
      sources: [
        {
          id: "source",
          text: "Provide an approval workflow",
          reference: {
            entity_kind: "document",
            entity_id: "source",
            content_hash: "b".repeat(64),
          },
        },
      ],
      input_complete: true,
    },
    shared_decisions: [],
  };
  const input = {
    expected_revision: 1,
    binding_hash: context.binding_hash,
    reason:
      "I verified the method, deliverable and acceptance against the exact buyer scope.",
    reviewed_requirement_ids: [req],
    confirmed_decision_ids: [],
    fulfillment: [
      {
        requirement_id: req,
        response_section_key: "approach",
        response_excerpt: text,
        method: "Configure the workflow",
        deliverable: "Deliver the manual",
        acceptance_evidence: "Acceptance requires buyer signoff",
        conditions_preserved: [],
        exceptions_preserved: [],
        consequences_preserved: [],
        facts: [],
      },
    ],
  };
  const backend = {
    authenticate: vi.fn(async () => ({ id: actor })),
    membership: vi.fn(async () => ({ role: "Owner" })),
    userRpc: vi.fn(async () => context),
    internal: vi.fn(async (_name: string, payload: any) => ({
      report: payload.report,
    })),
  };
  const handle = createApiHandler(env, () => backend as unknown as Backend);
  const request = (body: unknown) =>
    new Request(
      `https://api.example.test/api/v1/proposal-versions/${version}/consistency`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          origin: env.allowedOrigins[0],
          "content-type": "application/json",
          "idempotency-key": "synthetic-review",
        },
        body: JSON.stringify(body),
      },
    );
  return { backend, handle, request, input, context };
}
it("computes report from exact server content and authenticated actor rather than accepting trusted client flags", async () => {
  const f = fixture(),
    response = await f.handle(f.request(f.input));
  expect(response.status).toBe(201);
  expect(f.backend.internal).toHaveBeenCalledWith(
    "complete_proposal_consistency",
    expect.objectContaining({
      actor_id: actor,
      report: expect.objectContaining({ substantive_complete: true }),
      review: expect.objectContaining({ actor_id: actor, confirmed: true }),
    }),
  );
  const forged = await f.handle(
    f.request({
      ...f.input,
      report: { substantive_complete: true },
      actor_id: "other",
    }),
  );
  expect(forged.status).toBe(400);
  expect(f.backend.internal).toHaveBeenCalledTimes(1);
});
it("preserves an actual incomplete response as a gap and rejects stale binding before service write", async () => {
  const f = fixture();
  f.input.fulfillment[0].deliverable = "Invented absent deliverable";
  const response = await f.handle(f.request(f.input));
  expect(response.status).toBe(201);
  expect((await response.json()).data.report.substantive_complete).toBe(false);
  f.input.binding_hash = "c".repeat(64);
  expect((await f.handle(f.request(f.input))).status).toBe(409);
  expect(f.backend.internal).toHaveBeenCalledTimes(1);
});
