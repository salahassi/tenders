import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  commandSchemas,
  completeUploadSchema,
  type CommandName,
} from "../../supabase/functions/_shared/contracts.ts";
const commands: Array<[string, string, CommandName]> = [
  ["/v1/sources", "post", "source.create"],
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
  "sources",
  "opportunities",
  "knowledge",
  "jobs",
  "notifications",
  "audit-events",
  "proposals",
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
paths["/v1/health"] = {
  get: {
    security: [],
    responses: { "200": { description: "Minimal public availability" } },
  },
};
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
await writeFile(
  new URL("../../docs/openapi.json", import.meta.url),
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "Tenderdesk M2 foundation API",
        version: "0.2.0",
        description:
          "Implemented authenticated foundation only. Unimplemented historical specification routes return an explicit capability error; model and source execution are inactive.",
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
