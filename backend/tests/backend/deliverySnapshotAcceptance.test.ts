// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import {
  acceptDeliverySnapshot,
  checkIssuance,
  classifySnapshot,
} from "../../scripts/ops/delivery-snapshot-acceptance.mjs";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input: Record<string, any> = {
  version: 2,
  origin: "https://acceptance.example.test",
  workspace_id: id(1),
  actor_id: id(2),
  opportunity_id: id(3),
  proposal_id: id(4),
  snapshot_id: id(5),
  content_hash: "a".repeat(64),
  delivery_revision: 1,
  expectation: "template",
  input_state: "insufficient",
  package_status: "ready",
  plan_id: null,
  issuance_id: null,
  issuance_outcome: null,
  wait_seconds: 0,
  access_token: "synthetic-session-token-only-in-unit-test",
};
const snapshot: Record<string, any> = {
  id: input.snapshot_id,
  workspace_id: input.workspace_id,
  opportunity_id: input.opportunity_id,
  proposal_id: input.proposal_id,
  content_hash: input.content_hash,
  ordinal: 1,
  created_at: "2026-11-04T00:00:00Z",
  payload: {
    version: 1,
    title: "Synthetic blank input",
    language: "en",
    template: {},
    separate_volumes: false,
    input_state: "insufficient",
    content_state: "template",
    assurance_state: "unreviewed",
    substantive_complete: false,
    approval_state: "draft",
    notice: "Insufficient information: response inputs must be supplied.",
    source_manifest: [],
    input_materials: {},
    sections: [
      {
        section_key: "scope",
        title: "Proposed response",
        volume: "shared",
        kind: "response",
        source_ids: [],
        provenance: null,
        content_blocks: [{ type: "placeholder", gap_id: "missing" }],
      },
    ],
    gaps: [
      {
        id: "missing",
        section_key: "scope",
        field_path: "response",
        reason: "INSUFFICIENT_INPUT",
        label: "Supply the actual response method and delivery information.",
        required_for: "substantive_completion",
        source_ids: [],
      },
    ],
  },
};
let bytes: Uint8Array;
beforeAll(async () => {
  const fonts = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (n) => [
          n,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${n}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
  bytes = new Uint8Array(
    await (
      await renderDocx(buildDeliveryExport(snapshot, "combined"), fonts)
    ).arrayBuffer(),
  );
});
function transport(options: Record<string, any> = {}) {
  const selected = { ...input, ...options.input },
    snap = structuredClone(snapshot);
  Object.assign(snap.payload, options.payload || {});
  const artifact = {
    id: id(10),
    volume: "combined",
    status: "ready",
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    expected_size: bytes.length,
    original_name: "saved.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const pkg = {
    snapshot: {
      id: input.snapshot_id,
      proposal_id: input.proposal_id,
      delivery_revision: 1,
      content_state: snap.payload.content_state,
    },
    status: "ready",
    job: { status: "succeeded", error_code: null },
    artifacts: [artifact],
    ...options.pkg,
  };
  let contexts = 0,
    packages = 0,
    identities = 0;
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as any).Authorization).toBe(
      `Bearer ${input.access_token}`,
    );
    const path = new URL(String(url)).pathname.split("/functions/v1/api")[1];
    calls.push(path);
    if (path === "/v1/bootstrap") {
      identities++;
      return Response.json({
        data: {
          workspace: { id: input.workspace_id },
          membership: {
            user_id: input.actor_id,
            workspace_id: input.workspace_id,
            role: options.revoke && identities > 1 ? "Reviewer" : "Owner",
          },
        },
      });
    }
    if (path === `/v1/proposals/${input.proposal_id}`)
      return Response.json({
        data: {
          id: input.proposal_id,
          workspace_id: input.workspace_id,
          opportunity_id: input.opportunity_id,
          active_delivery_snapshot_id: input.snapshot_id,
          delivery_revision: options.stale ? 2 : 1,
        },
      });
    if (path.endsWith("/context")) {
      contexts++;
      if (options.lateSource && contexts > 1)
        return Response.json(
          { error: { code: "STALE_SOURCE" } },
          { status: 409 },
        );
      return Response.json({ data: snap });
    }
    if (path.endsWith("/package")) {
      packages++;
      return Response.json({
        data:
          options.lateCancel && packages > 1
            ? { ...pkg, status: "blocked", job: { status: "canceled" } }
            : pkg,
      });
    }
    if (path.includes("proposal-issuance"))
      return Response.json({ data: options.issuance });
    if (path.endsWith("/download")) {
      if (options.denied) return new Response("blocked", { status: 409 });
      return new Response(new Uint8Array(options.corrupt ? [1, 2, 3] : bytes).buffer);
    }
    throw Error("Unexpected test route");
  });
  return { selected, fetcher, calls };
}
it("verifies actual stored template DOCX and yellow placeholder without calling it issued", async () => {
  const f = transport();
  const r = await acceptDeliverySnapshot(f.selected, f.fetcher);
  expect(r).toMatchObject({
    passed: true,
    deliverable_verified: true,
    issuance_verified: false,
    substantive_complete: false,
  });
  expect(r.artifacts).toHaveLength(1);
  expect(r.artifacts[0].canonical_docx_verified).toBe(true);
  expect(f.calls.filter((p) => p.endsWith("/package"))).toHaveLength(2);
});
it.each(["corrupt", "lateSource", "revoke", "stale", "lateCancel"])(
  "rejects %s instead of claiming stored success",
  async (kind) => {
    const f = transport({ [kind]: true });
    expect((await acceptDeliverySnapshot(f.selected, f.fetcher)).passed).toBe(
      false,
    );
  },
);
it("reports pending first-volume state and verifies incomplete package download is denied", async () => {
  const f = transport({
    input: { package_status: "preparing" },
    payload: { separate_volumes: true },
    pkg: {
      status: "preparing",
      job: { status: "running" },
      artifacts: [
        { id: id(10), volume: "technical", status: "ready" },
        { id: id(11), volume: "financial", status: "pending" },
      ],
    },
    denied: true,
  });
  const r = await acceptDeliverySnapshot(f.selected, f.fetcher);
  expect(r).toMatchObject({
    passed: true,
    deliverable_verified: false,
    issuance_verified: false,
    artifacts: [],
  });
  expect(r.observations[0].ready_volumes).toEqual(["technical"]);
});
it("rejects one ready volume advertised as the complete two-volume package", async () => {
  const f = transport({ payload: { separate_volumes: true } });
  expect((await acceptDeliverySnapshot(f.selected, f.fetcher)).code).toBe(
    "DELIVERY_WHOLE_PACKAGE_REQUIRED",
  );
});
it("rejects pending package whose first volume is downloadable", async () => {
  const f = transport({
    input: { package_status: "preparing" },
    pkg: { status: "preparing", job: { status: "running" } },
  });
  expect((await acceptDeliverySnapshot(f.selected, f.fetcher)).passed).toBe(
    false,
  );
});
it("classifies contracts independently of file existence", () => {
  const p = snapshot.payload;
  expect(
    classifySnapshot({ payload: { ...p, content_state: "partial_draft" } }),
  ).toBe("partial");
  expect(
    classifySnapshot({
      payload: { ...p, version: 2, content_state: "authored_draft" },
    }),
  ).toBe("partial");
  expect(
    classifySnapshot({
      payload: {
        ...p,
        version: 2,
        content_state: "substantive_draft",
        substantive_complete: true,
        assurance_state: "human_reviewed",
      },
    }),
  ).toBe("substantive");
  expect(
    classifySnapshot({
      payload: {
        ...p,
        version: 3,
        content_state: "generated_review_draft",
        assurance_state: "model_checked_source_review_required",
      },
    }),
  ).toBe("issued");
  expect(() =>
    classifySnapshot({ payload: { ...p, substantive_complete: true } }),
  ).toThrow();
});
const request = () => ({
  id: id(20),
  workspace_id: input.workspace_id,
  plan_id: id(21),
  deadline_version: 1,
  accepted_at: "2026-11-04T00:00:00Z",
  deadline_at: "2026-11-04T00:10:00Z",
  server_now: "2026-11-04T00:05:00Z",
  outcome: "issued",
  effective_outcome: "issued",
  issued_snapshot_id: input.snapshot_id,
  completed_at: "2026-11-04T00:04:00Z",
  effective_completed_at: "2026-11-04T00:04:00Z",
  error_code: null,
  effective_error_code: null,
});
const issuedInput = {
  ...input,
  plan_id: id(21),
  issuance_id: id(20),
  issuance_outcome: "issued",
  expectation: "issued",
};
it("requires exact canonical request and strictly less than 600s completion", () => {
  expect(checkIssuance(request(), issuedInput).outcome).toBe("issued");
  for (const delta of [
    { deadline_at: "2026-11-04T00:11:00Z" },
    { completed_at: "2026-11-04T00:10:00Z" },
    { issued_snapshot_id: id(999) },
    { id: id(999) },
  ])
    expect(() =>
      checkIssuance({ ...request(), ...delta }, issuedInput),
    ).toThrow();
});
it("never counts expired active requests or generated files without issuance receipt", async () => {
  expect(() =>
    checkIssuance(
      {
        ...request(),
        outcome: "active",
        effective_outcome: "active",
        completed_at: null,
        server_now: "2026-11-04T00:10:00Z",
      },
      issuedInput,
    ),
  ).toThrow();
  const f = transport({
    input: issuedInput,
    payload: {
      version: 3,
      content_state: "generated_review_draft",
      assurance_state: "model_checked_source_review_required",
    },
    issuance: {
      ...request(),
      outcome: "failed",
      effective_outcome: "failed",
      issued_snapshot_id: null,
      error_code: "ALL_AI_PROVIDERS_UNAVAILABLE",
      effective_error_code: "ALL_AI_PROVIDERS_UNAVAILABLE",
    },
  });
  expect((await acceptDeliverySnapshot(f.selected, f.fetcher)).code).toBe(
    "DELIVERY_TERMINAL_BEFORE_EXPECTATION",
  );
  expect(f.calls.some((p) => p.endsWith("/download"))).toBe(false);
});
it("retains actual failed request alongside available template without claiming issuance", async () => {
  const f = transport({
    input: { plan_id: id(21), issuance_id: id(20), issuance_outcome: "failed" },
    issuance: {
      ...request(),
      outcome: "failed",
      effective_outcome: "failed",
      issued_snapshot_id: null,
      error_code: "ALL_AI_PROVIDERS_UNAVAILABLE",
      effective_error_code: "ALL_AI_PROVIDERS_UNAVAILABLE",
    },
  });
  expect(await acceptDeliverySnapshot(f.selected, f.fetcher)).toMatchObject({
    passed: true,
    deliverable_verified: true,
    issuance_verified: false,
  });
});
