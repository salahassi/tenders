// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  acceptProposalExport,
  browserWriteAllowed,
  durableBrowserWriteAllowed,
  observeDurablePackage,
  LIMITS,
  validateInput,
  verifyServerRoundtrip,
} from "../../scripts/ops/proposal-export-acceptance.mjs";
import {
  buildExportModel,
  verifyExportDocx,
} from "../../supabase/functions/_shared/export";
import { exportFixture } from "../../../frontend/src/test/fixtures/exportModels";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = {
  origin: "https://acceptance.example.test",
  access_token: "private-genuine-session-token-for-fixture-only",
  workspace_id: id(1),
  actor_id: id(2),
  opportunity_id: id(3),
  plan_id: id(4),
  proposal_id: id(5),
  proposal_version_id: id(6),
  expected_revision: 2,
  run_id: "12345",
  mode: "http",
};
function fixture(
  options: {
    wrongVersion?: boolean;
    corruptDownload?: boolean;
    separate?: boolean;
    roleByCheck?: string[];
    changeAtCheck?: number;
    changeField?: "revision" | "active_version" | "plan_status";
  } = {},
) {
  const calls: { path: string; method: string; body?: any }[] = [],
    exports = new Map<string, any>(),
    artifacts = new Map<string, any>(),
    stored = new Map<string, Uint8Array>();
  let next = 20,
    selectionCheck = 0;
  const envelope = (data: unknown) => Response.json({ data });
  const fetcher = vi.fn(
    async (url: any, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? "GET";
      expect(init?.redirect).toBe("error");
      if (!path.startsWith("/fonts/"))
        expect((init?.headers as any).Authorization).toBe(
          `Bearer ${input.access_token}`,
        );
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, method, body });
      if (path.startsWith("/fonts/"))
        return new Response(
          await readFile(
            new URL(`../../../frontend/public${path}`, import.meta.url),
          ),
        );
      const api = "/functions/v1/api/v1";
      if (path === `${api}/bootstrap`) {
        selectionCheck++;
        return envelope({
          membership: {
            user_id: input.actor_id,
            workspace_id: input.workspace_id,
            role:
              options.roleByCheck?.[
                Math.min(selectionCheck - 1, options.roleByCheck.length - 1)
              ] ?? "Owner",
          },
          workspace: { id: input.workspace_id },
        });
      }
      const changed = selectionCheck >= (options.changeAtCheck ?? Infinity);
      if (path === `${api}/proposal-versions/${input.proposal_version_id}`)
        return envelope({
          id: input.proposal_version_id,
          workspace_id: input.workspace_id,
          plan_id: input.plan_id,
          proposal_id: input.proposal_id,
          revision:
            options.wrongVersion ||
            (changed && options.changeField === "revision")
              ? 3
              : 2,
          ordinal: 1,
          separate_volumes: options.separate ?? false,
          status: "draft",
        });
      if (path === `${api}/generation-plans/${input.plan_id}`)
        return envelope({
          id: input.plan_id,
          workspace_id: input.workspace_id,
          proposal_id: input.proposal_id,
          opportunity_id: input.opportunity_id,
          status:
            changed && options.changeField === "plan_status"
              ? "running"
              : "completed",
          kind: "proposal",
        });
      if (path === `${api}/proposals/${input.proposal_id}`)
        return envelope({
          id: input.proposal_id,
          workspace_id: input.workspace_id,
          active_version_id:
            changed && options.changeField === "active_version"
              ? id(99)
              : input.proposal_version_id,
          opportunity_id: input.opportunity_id,
        });
      if (
        path ===
        `${api}/proposal-versions/${input.proposal_version_id}/readiness`
      )
        return envelope({
          blockers: ["Confirm real commercial inputs before final approval."],
        });
      if (path === `${api}/commands`) {
        expect(body.commands).toHaveLength(1);
        const { operation, input: value } = body.commands[0];
        expect(["export.prepare", "export.reserve"]).toContain(operation);
        if (operation === "export.prepare") {
          expect(value.mode).toBe("draft");
          const record = {
            ...exportFixture("ar", value.volume, "draft"),
            id: id(next++),
            workspace_id: input.workspace_id,
            proposal_version_id: input.proposal_version_id,
          };
          exports.set(record.id, record);
          return envelope([record]);
        }
        expect(value.kind).toBe("generated");
        expect(value.review_attested).toBe(false);
        const record = {
          id: id(next++),
          workspace_id: input.workspace_id,
          export_id: value.export_id,
          kind: "generated",
          mime_type: value.mime_type,
          original_name: value.original_name,
          expected_size: value.size,
          content_hash: value.hash,
          status: "pending",
          storage_key: "",
        };
        record.storage_key = `${input.workspace_id}/exports/${record.id}`;
        artifacts.set(record.id, record);
        return envelope([record]);
      }
      const context = path.match(/\/exports\/([^/]+)\/context$/);
      if (context) {
        const request = exports.get(context[1]);
        return envelope({ request, model: buildExportModel(request) });
      }
      if (path.startsWith("/storage/v1/object/tenderdesk-private/")) {
        expect(method).toBe("POST");
        const artifact = [...artifacts.values()].find((a) =>
          path.endsWith(a.storage_key),
        );
        expect(artifact).toBeTruthy();
        stored.set(artifact.id, new Uint8Array(init?.body as Uint8Array));
        return Response.json({ Key: artifact.storage_key });
      }
      const artifact = path.match(
        /\/export-artifacts\/([^/]+)\/(complete|download)$/,
      );
      if (artifact) {
        const record = artifacts.get(artifact[1]),
          bytes = stored.get(record.id)!;
        if (artifact[2] === "complete") {
          expect(() =>
            verifyExportDocx(
              bytes,
              buildExportModel(exports.get(record.export_id)),
            ),
          ).not.toThrow();
          return envelope({
            ...record,
            status: "ready",
            verification: "generated_content",
          });
        }
        return new Response(
          Uint8Array.from(options.corruptDownload ? [1, 2, 3] : bytes).buffer,
        );
      }
      throw new Error(`Unexpected isolated fixture route ${method} ${path}`);
    },
  ) as typeof fetch;
  return { fetcher, calls, exports, artifacts, stored };
}

it.each([false, true])(
  "packages, uploads, server-verifies and downloads the actual Arabic renderer output with separate volumes=%s",
  async (separate) => {
    const mock = fixture({ separate });
    const report = await acceptProposalExport(input, mock.fetcher);
    expect(report.passed, report.code).toBe(true);
    expect(report.artifacts).toHaveLength(separate ? 2 : 1);
    expect(report.requests).toBeLessThanOrEqual(LIMITS.httpRequests);
    expect(report.readiness.blockers).toHaveLength(1);
    expect(report.model_calls).toBe(0);
    expect(report.approval_commands).toBe(0);
    expect(
      report.artifacts.every(
        (a: any) =>
          a.exact_authorized_content &&
          a.authenticated_server_download_verified &&
          a.embedded_fonts === 4 &&
          a.visual_layout_reviewed === false &&
          Buffer.from(a.docx_base64, "base64").length === a.bytes,
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(input.access_token);
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(
      separate ? 8 : 4,
    );
    expect(
      mock.calls.filter((c) => c.path.endsWith("/bootstrap")),
    ).toHaveLength(3);
  },
  30000,
);

it("rejects a changed proposal version before any export mutation", async () => {
  const mock = fixture({ wrongVersion: true });
  const report = await acceptProposalExport(input, mock.fetcher);
  expect(report).toMatchObject({
    passed: false,
    code: "EXPORT_SELECTED_VERSION_NOT_CURRENT",
  });
  expect(mock.calls.every((c) => c.method === "GET")).toBe(true);
});

it.each([1, 2, 3])(
  "rejects an Owner-to-Editor role change at selection check %s",
  async (checkNumber) => {
    const mock = fixture({
      roleByCheck: [...Array(checkNumber - 1).fill("Owner"), "Editor"],
    });
    const report = await acceptProposalExport(input, mock.fetcher);
    expect(report).toMatchObject({
      passed: false,
      code: "EXPORT_MEMBERSHIP_MISMATCH",
    });
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(
      checkNumber === 3 ? 4 : 0,
    );
  },
);

it.each([
  [2, "revision"],
  [2, "active_version"],
  [2, "plan_status"],
  [3, "revision"],
  [3, "active_version"],
  [3, "plan_status"],
] as const)(
  "rejects a concurrent %s/%s change before claiming acceptance",
  async (checkNumber, field) => {
    const mock = fixture({ changeAtCheck: checkNumber, changeField: field });
    const report = await acceptProposalExport(input, mock.fetcher);
    expect(report).toMatchObject({
      passed: false,
      code: "EXPORT_SELECTED_VERSION_NOT_CURRENT",
    });
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(
      checkNumber === 3 ? 4 : 0,
    );
    expect(report.artifacts).toHaveLength(checkNumber === 3 ? 1 : 0);
  },
);

it("requires a successful independent server download identical to the browser bytes", async () => {
  const mock = fixture();
  const report = await acceptProposalExport(input, mock.fetcher);
  expect(report.passed).toBe(true);
  const artifact = mock.artifacts.get(report.artifacts[0].id),
    bytes = mock.stored.get(artifact.id)!;
  const model = buildExportModel(mock.exports.get(artifact.export_id));
  const missing = vi.fn(async () => new Response(null, { status: 404 }));
  await expect(
    verifyServerRoundtrip(bytes, artifact, model, missing),
  ).rejects.toThrow("EXPORT_SERVER_DOWNLOAD_FAILED");
  expect(missing).toHaveBeenCalledExactlyOnceWith(artifact.id);
  const corrupt = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  await expect(
    verifyServerRoundtrip(bytes, artifact, model, corrupt),
  ).rejects.toThrow("EXPORT_DOWNLOADED_HASH_MISMATCH");
  const correct = vi.fn(
    async () => new Response(Uint8Array.from(bytes).buffer),
  );
  await expect(
    verifyServerRoundtrip(new Uint8Array([1]), artifact, model, correct),
  ).rejects.toThrow("EXPORT_BROWSER_SERVER_BYTES_MISMATCH");
  const proof = await verifyServerRoundtrip(bytes, artifact, model, correct);
  expect(proof.authenticated_server_download_verified).toBe(true);
});

it("does not accept corrupted downloaded bytes and retains exact created artifact identities", async () => {
  const mock = fixture({ corruptDownload: true });
  const report = await acceptProposalExport(input, mock.fetcher);
  expect(report).toMatchObject({
    passed: false,
    code: "EXPORT_DOWNLOADED_HASH_MISMATCH",
  });
  expect(report.artifacts).toHaveLength(0);
  expect(report.created_exports).toHaveLength(1);
  expect(report.reserved_artifacts).toHaveLength(1);
});

it("requires the exact genuine browser session and blocks every non-export command", () => {
  expect(() =>
    validateInput({
      ...input,
      mode: "browser",
      session: {
        access_token: input.access_token,
        refresh_token: "private-refresh",
        user: { id: id(99) },
      },
    }),
  ).toThrow("EXPORT_SESSION_INVALID");
  expect(() =>
    validateInput({ ...input, origin: "http://insecure.example.test" }),
  ).toThrow("EXPORT_ORIGIN_INVALID");
  const state = {
    volumes: ["combined"],
    preparedVolumes: new Set(),
    contexts: new Map(),
    reservedExports: new Set(),
    artifacts: new Map(),
    uploaded: new Set(),
    completed: new Set(),
  };
  const allowed = (operation: string, value: any) =>
    browserWriteAllowed(
      "/functions/v1/api/v1/commands",
      "POST",
      JSON.stringify({ commands: [{ operation, input: value }] }),
      state,
      input,
    );
  expect(
    allowed("export.prepare", {
      proposal_version_id: input.proposal_version_id,
      expected_revision: 2,
      mode: "draft",
      volume: "combined",
    }),
  ).toBe(true);
  expect(
    allowed("export.prepare", {
      proposal_version_id: input.proposal_version_id,
      expected_revision: 2,
      mode: "final",
      volume: "combined",
    }),
  ).toBe(false);
  for (const operation of [
    "proposal.generate",
    "proposal.approve",
    "generation.retry",
    "review.verdict",
    "export.renew",
  ])
    expect(allowed(operation, {})).toBe(false);
  expect(
    browserWriteAllowed(
      `/storage/v1/object/tenderdesk-private/${input.workspace_id}/exports/${id(9)}`,
      "POST",
      null,
      state,
      input,
    ),
  ).toBe(false);
});

it("durable browser permits one exact selected draft package preparation and no retry, upload or approval", () => {
  const selected = { ...input, mode: "browser" },
    state = { prepared: false };
  const body = (
    operation = "export.package.prepare",
    value: any = {
      proposal_version_id: input.proposal_version_id,
      expected_revision: input.expected_revision,
      mode: "draft",
    },
  ) => JSON.stringify({ commands: [{ operation, input: value }] });
  const path = "/functions/v1/api/v1/commands";
  expect(
    durableBrowserWriteAllowed(path, "POST", body(), state, selected),
  ).toBe(true);
  for (const operation of [
    "export.package.retry",
    "export.prepare",
    "export.reserve",
    "proposal.approve",
    "generation.retry",
  ])
    expect(
      durableBrowserWriteAllowed(
        path,
        "POST",
        body(operation),
        state,
        selected,
      ),
    ).toBe(false);
  for (const changes of [
    { mode: "final" },
    { proposal_version_id: id(999) },
    { expected_revision: 999 },
    { extra: "unapproved" },
  ])
    expect(
      durableBrowserWriteAllowed(
        path,
        "POST",
        body("export.package.prepare", {
          proposal_version_id: input.proposal_version_id,
          expected_revision: input.expected_revision,
          mode: "draft",
          ...changes,
        }),
        state,
        selected,
      ),
    ).toBe(false);
  expect(
    durableBrowserWriteAllowed(
      path,
      "POST",
      body(),
      { prepared: true },
      selected,
    ),
  ).toBe(false);
  expect(
    durableBrowserWriteAllowed(
      "/storage/v1/object/tenderdesk-private/object",
      "POST",
      body(),
      state,
      selected,
    ),
  ).toBe(false);
});
function durablePackage() {
  return {
    id: id(100),
    revision: 1,
    proposal_version_id: input.proposal_version_id,
    mode: "draft",
    status: "preparing",
    accepted_at: "2026-11-04T00:00:00Z",
    deadline_at: "2026-11-04T00:10:00Z",
    server_now: "2026-11-04T00:02:00Z",
    job: { status: "running" },
    artifacts: [
      { id: null, export_id: id(101), volume: "technical", status: "pending" },
      { id: null, export_id: id(102), volume: "financial", status: "pending" },
    ],
  };
}
it("durable browser tracks pending volumes and keeps original canonical deadline across readiness", () => {
  const state: any = {},
    first = durablePackage();
  observeDurablePackage(first, state, input, ["technical", "financial"]);
  const ready = {
    ...first,
    status: "ready",
    job: { status: "succeeded" },
    artifacts: first.artifacts.map((a, i) => ({
      ...a,
      id: id(200 + i),
      status: "ready",
      content_hash: "a".repeat(64),
      expected_size: 50,
    })),
  };
  expect(
    observeDurablePackage(ready, state, input, ["technical", "financial"])
      .status,
  ).toBe("ready");
  expect(() =>
    observeDurablePackage(
      { ...ready, deadline_at: "2026-11-04T00:11:00Z" },
      state,
      input,
      ["technical", "financial"],
    ),
  ).toThrow();
  expect(() =>
    observeDurablePackage(
      {
        ...ready,
        accepted_at: "2026-11-04T00:01:00Z",
        deadline_at: "2026-11-04T00:11:00Z",
      },
      state,
      input,
      ["technical", "financial"],
    ),
  ).toThrow("IDENTITY_CHANGED");
});
it.each(["single", "pending", "wrong-version", "missing-export"])(
  "durable browser rejects %s masquerading as a complete package",
  (kind) => {
    const first = durablePackage(),
      ready: any = {
        ...first,
        status: "ready",
        job: { status: "succeeded" },
        artifacts: first.artifacts.map((a, i) => ({
          ...a,
          id: id(200 + i),
          status: "ready",
          content_hash: "a".repeat(64),
          expected_size: 50,
        })),
      };
    if (kind === "single") ready.artifacts.pop();
    if (kind === "pending") ready.artifacts[1].status = "pending";
    if (kind === "wrong-version") ready.proposal_version_id = id(999);
    if (kind === "missing-export") ready.artifacts[1].export_id = null;
    expect(() =>
      observeDurablePackage(ready, {}, input, ["technical", "financial"]),
    ).toThrow();
  },
);
