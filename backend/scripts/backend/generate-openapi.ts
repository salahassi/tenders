import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  commandSchemas,
  invitationCreateSchema,
  invitationRevokeSchema,
  invitationTokenSchema,
  completeUploadSchema,
  type CommandName,
} from "../../supabase/functions/_shared/contracts.ts";
const commands: Array<[string, string, CommandName]> = [
  ["/v1/estimates", "post", "estimate.prepare"],
  ["/v1/deliveries", "post", "delivery.prepare"],
  ["/v1/sources", "post", "source.create"],
  ["/v1/settings", "put", "workspace.settings"],
  ["/v1/opportunities/{id}", "patch", "opportunity.update"],
  ["/v1/jobs/{id}/actions", "post", "job.action"],
  ["/v1/sources/{id}/actions", "post", "source.action"],
  ["/v1/opportunities", "post", "opportunity.create"],
  ["/v1/opportunities/{id}/decision", "post", "opportunity.decision"],
  ["/v1/knowledge", "post", "knowledge.save"],
  ["/v1/knowledge/{id}", "patch", "knowledge.save"],
  ["/v1/knowledge/{id}/verify", "post", "knowledge.verify"],
  ["/v1/proposals/{id}/review-inputs", "put", "review.save"],
  ["/v1/proposals/{id}/regenerate", "post", "proposal.regenerate"],
  ["/v1/documents/prepare-upload", "post", "document.prepare"],
  ["/v1/notifications/{id}", "patch", "notification.read"],
  ["/v1/memberships/actions", "post", "membership.set"],
];
const paths: Record<string, Record<string, unknown>> = {};
const responses = {
  "200": { description: "Successful command result" },
  "201": { description: "Record or reservation created" },
  "202": { description: "Recorded job; inspect its actual status and blocker" },
  "400": { description: "Invalid request" },
  "401": { description: "Authentication required" },
  "403": { description: "Membership or role denied" },
  "409": { description: "Revision/idempotency conflict" },
  "413": { description: "Request too large" },
  "422": { description: "Business validation blocker" },
  "429": { description: "Application quota reached" },
  "503": { description: "Dependency or capability unavailable" },
};
for (const [path, method, name] of commands) {
  const schema = z.toJSONSchema(commandSchemas[name], {
    unrepresentable: "any",
  });
  if (path.includes("{id}")) {
    const s = schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    if (s.properties) delete s.properties.id;
    if (s.required) s.required = s.required.filter((x) => x !== "id");
  }
  paths[path] ||= {};
  paths[path][method] = {
    operationId: name,
    security: [{ userJWT: [] }],
    parameters: [
      {
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      },
      ...(path.includes("{id}")
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : []),
    ],
    requestBody: {
      required: true,
      content: { "application/json": { schema } },
    },
    responses,
  };
}
for (const table of [
  "exports",
  "export-artifacts",
  "acquisitions",
  "submissions",
  "submission-events",
  "opportunity-relations",
  "restore-sessions",
  "rates",
  "templates",
  "estimates",
  "deliveries",
  "compliance",
  "reviews",
  "approvals",
  "inventories",
  "generation-plans",
  "generation-steps",
  "fit-assessments",
  "requirements",
  "model-settings",
  "content-authorizations",
  "provider-usage",
  "sources",
  "source-runs",
  "source-links",
  "snapshots",
  "imports",
  "document-blocks",
  "packages",
  "opportunities",
  "knowledge",
  "jobs",
  "notifications",
  "audit-events",
  "proposals",
  "documents",
  "proposal-versions",
  "proposal-sections",
  "questions",
  "review-inputs",
  "regeneration-requests",
  "invitations",
  "members",
]) {
  for (const detail of [false, true]) {
    const path = `/v1/${table}${detail ? "/{id}" : ""}`;
    paths[path] ||= {};
    paths[path].get = {
      security: [{ userJWT: [] }],
      parameters: detail
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : [
            {
              in: "query",
              name: "limit",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 25,
              },
            },
            {
              in: "query",
              name: "cursor",
              schema: { type: "string", format: "uuid" },
            },
          ],
      responses,
    };
  }
}
paths["/v1/commands"] = {
  post: {
    security: [{ userJWT: [] }],
    description:
      "Atomically apply up to 100 validated commands. All writes and audit records roll back on failure.",
    parameters: [
      {
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["commands"],
            properties: {
              commands: {
                type: "array",
                minItems: 1,
                maxItems: 100,
                items: {
                  oneOf: Object.entries(commandSchemas).map(
                    ([operation, schema]) => ({
                      type: "object",
                      additionalProperties: false,
                      required: ["operation", "input"],
                      properties: {
                        operation: { const: operation },
                        input: z.toJSONSchema(schema, {
                          unrepresentable: "any",
                        }),
                      },
                    }),
                  ),
                },
              },
            },
          },
        },
      },
    },
    responses,
  },
};
for (const [path, schema, publicRoute] of [
  ["/v1/invitations", invitationCreateSchema, false],
  ["/v1/invitations/{id}/revoke", invitationRevokeSchema, false],
  ["/v1/invitations/check", invitationTokenSchema, true],
  ["/v1/invitations/accept", invitationTokenSchema, false],
] as const) {
  paths[path] ||= {};
  paths[path].post = {
    security: publicRoute ? [] : [{ userJWT: [] }],
    parameters: [
      ...(path.includes("{id}")
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : []),
      ...(!path.endsWith("check") && !path.endsWith("accept")
        ? [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { type: "string" },
            },
          ]
        : []),
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: z.toJSONSchema(schema, { unrepresentable: "any" }),
        },
      },
    },
    responses,
  };
}
paths["/v1/health"] = {
  get: {
    security: [],
    responses: { "200": { description: "Minimal public availability" } },
  },
};
paths["/v1/status"] = { get: { security: [{ userJWT: [] }], responses } };
paths["/v1/bootstrap"] = { get: { security: [{ userJWT: [] }], responses } };
paths["/v1/documents/{id}/download"] = {
  get: {
    security: [{ userJWT: [] }],
    parameters: [
      {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    ],
    responses,
  },
};
paths["/v1/documents/{id}/complete-upload"] = {
  post: {
    security: [{ userJWT: [] }],
    parameters: [
      {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      {
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: z.toJSONSchema(completeUploadSchema) },
      },
    },
    responses,
  },
};

const recoveryPaths: Array<[string, string, string, unknown?]> = [
  [
    "/v1/opportunities/{id}/archive",
    "post",
    "Archive or restore with revision and reason",
    z.object({
      expected_revision: z.number().int().positive(),
      archive: z.boolean(),
      reason: z.string().min(10).max(3000),
    }),
  ],
  [
    "/v1/opportunities/{id}/purge-preview",
    "get",
    "Owner-only dependency counts, files and content-bound preview hash",
  ],
  [
    "/v1/opportunities/{id}/purge",
    "post",
    "Owner-confirmed permanent purge after archive; preserve minimal usage accounting",
    z.object({
      preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
      confirmed_title: z.string().max(1000),
      reason: z.string().min(10).max(3000),
      acknowledge_history: z.literal(true),
    }),
  ],
  [
    "/v1/storage-cleanup/{id}/retry",
    "post",
    "Owner queues another reference-checked cleanup attempt",
  ],
  [
    "/v1/recovery/manifest",
    "get",
    "Owner-only exact row/file hashes; rejects excessive metadata",
  ],
  [
    "/v1/recovery/rows",
    "post",
    "Owner-only bounded metadata batch",
    z.object({ keys: z.array(z.string()).min(1).max(30) }),
  ],
  [
    "/v1/recovery/restore",
    "post",
    "Validate a manifest and stage into an empty matching-schema workspace",
    z.object({
      manifest: z.record(z.string(), z.unknown()),
      eligibility_attested: z.literal(true),
    }),
  ],
  [
    "/v1/recovery/restore/{id}/rows",
    "post",
    "Check exact metadata hashes before staging",
    z.object({
      items: z
        .array(
          z.object({ key: z.string(), data: z.string(), hash: z.string() }),
        )
        .min(1)
        .max(30),
    }),
  ],
  [
    "/v1/recovery/restore/{id}/commit",
    "post",
    "Atomically restore complete verified history; reset all operational authorizations",
  ],
  [
    "/v1/recovery/restore/{id}/cancel",
    "post",
    "Cancel staging and schedule object cleanup",
  ],
  [
    "/v1/recovery/restore-files/{id}/complete",
    "post",
    "Server-check actual private bytes, hash, size and file signature",
  ],
  [
    "/v1/recovery/files/{kind}/{id}",
    "get",
    "Owner-only original-inclusive backup download with actual hash and membership recheck",
  ],
  ["/v1/exports/{id}/context", "get", "Return a current bound export model"],
  [
    "/v1/export-artifacts/{id}/complete",
    "post",
    "Verify exact artifact bytes and authorized Word content or Owner-reviewed PDF",
  ],
  [
    "/v1/export-artifacts/{id}/download",
    "get",
    "Recheck approval and actual hash immediately before private artifact download",
  ],
];
for (const [path, method, summary, body] of recoveryPaths) {
  paths[path] = {
    [method]: {
      summary,
      security: [{ userJWT: [] }],
      parameters: [
        ...(path.includes("{id}")
          ? [
              {
                in: "path",
                name: "id",
                required: true,
                schema: { type: "string", format: "uuid" },
              },
            ]
          : []),
        ...(path.includes("{kind}")
          ? [
              {
                in: "path",
                name: "kind",
                required: true,
                schema: {
                  type: "string",
                  enum: ["documents", "export_artifacts"],
                },
              },
            ]
          : []),
      ],
      ...(body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(body as z.ZodType),
                },
              },
            },
          }
        : {}),
      responses,
    },
  };
}
await writeFile(
  new URL("../../docs/openapi.json", import.meta.url),
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "Tenderdesk connected trial API",
        version: "0.3.0",
        description:
          "Authenticated connected workflows. Source collection and free model execution require explicit approved configuration; this contract is not evidence of hosted activation.",
      },
      servers: [
        {
          url: "https://{projectRef}.supabase.co/functions/v1/api",
          variables: { projectRef: { default: "your-project-ref" } },
        },
      ],
      components: {
        securitySchemes: {
          userJWT: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      paths,
    },
    null,
    2,
  ) + "\n",
);
