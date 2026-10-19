import { recoveryRoute } from "../_shared/recovery.ts";
import { buildExportModel, verifyExportDocx } from "../_shared/export.ts";
import { Backend, type BackendEnvironment } from "../_shared/backend.ts";
import {
  commandSchemas,
  invitationTokenSchema,
  invitationCreateSchema,
  invitationRevokeSchema,
  completeUploadSchema,
  uuid,
  type CommandName,
} from "../_shared/contracts.ts";
import { AppError, corsHeaders, readJson } from "../_shared/http.ts";
import { validateOriginal } from "../_shared/originals.ts";
import { z } from "zod";
import { adapterSchema, inertText, canonical } from "../_shared/collector.ts";
import { PDFDocument } from "pdf-lib";
import {
  sourceExtraction,
  extractionMatchesUrl,
} from "../_shared/officialListings.ts";
import { smtpStatus } from "../_shared/notifications.ts";
import {
  calculateEstimate,
  calculateDelivery,
  CommercialError,
} from "../_shared/finance.ts";

const readTables: Record<string, string> = {
  "storage-cleanup": "storage_cleanup_queue",
  "restore-sessions": "restore_sessions",
  acquisitions: "acquisitions",
  submissions: "submissions",
  "submission-events": "submission_events",
  "opportunity-relations": "opportunity_relations",
  exports: "export_requests",
  "export-artifacts": "export_artifacts",
  rates: "rate_records",
  templates: "templates",
  estimates: "estimate_records",
  deliveries: "delivery_versions",
  inventories: "requirement_inventories",
  compliance: "compliance_responses",
  reviews: "reviews",
  approvals: "approvals",
  sources: "sources",
  "generation-plans": "generation_plans",
  "generation-steps": "generation_steps",
  requirements: "requirements",
  "fit-assessments": "fit_assessments",
  "model-settings": "model_settings",
  "model-routing": "model_routing",
  "content-authorizations": "content_authorizations",
  "provider-usage": "provider_usage",
  "model-activity": "model_activity",
  "source-runs": "source_runs",
  snapshots: "advertisement_snapshots",
  "source-links": "opportunity_source_links",
  imports: "import_batches",
  opportunities: "opportunities",
  "opportunity-discovery": "opportunity_discovery",
  knowledge: "knowledge_items",
  jobs: "jobs",
  notifications: "notifications",
  "audit-events": "audit_events",
  proposals: "proposals",
  documents: "documents",
  "document-blocks": "document_blocks",
  packages: "document_packages",
  "proposal-versions": "proposal_versions",
  "proposal-sections": "proposal_sections",
  questions: "questions",
  "review-inputs": "review_inputs",
  "regeneration-requests": "regeneration_requests",
  invitations: "workspace_invitations",
  members: "workspace_members",
};
const routeCommands: Array<{
  method: string;
  pattern: RegExp;
  command: CommandName;
  idField?: string;
}> = [
  { method: "POST", pattern: /^\/v1\/sources$/, command: "source.create" },
  { method: "PUT", pattern: /^\/v1\/settings$/, command: "workspace.settings" },
  {
    method: "PATCH",
    pattern: /^\/v1\/opportunities\/([^/]+)$/,
    command: "opportunity.update",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/jobs\/([^/]+)\/actions$/,
    command: "job.action",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/sources\/([^/]+)\/actions$/,
    command: "source.action",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/opportunities$/,
    command: "opportunity.create",
  },
  {
    method: "POST",
    pattern: /^\/v1\/opportunities\/([^/]+)\/decision$/,
    command: "opportunity.decision",
    idField: "id",
  },
  { method: "POST", pattern: /^\/v1\/knowledge$/, command: "knowledge.save" },
  {
    method: "PATCH",
    pattern: /^\/v1\/knowledge\/([^/]+)$/,
    command: "knowledge.save",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/knowledge\/([^/]+)\/verify$/,
    command: "knowledge.verify",
    idField: "id",
  },
  {
    method: "PUT",
    pattern: /^\/v1\/proposals\/([^/]+)\/review-inputs$/,
    command: "review.save",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/proposals\/([^/]+)\/regenerate$/,
    command: "proposal.regenerate",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/documents\/prepare-upload$/,
    command: "document.prepare",
  },
  {
    method: "PATCH",
    pattern: /^\/v1\/notifications\/([^/]+)$/,
    command: "notification.read",
    idField: "id",
  },
  {
    method: "POST",
    pattern: /^\/v1\/memberships\/actions$/,
    command: "membership.set",
  },
];

export function createApiHandler(
  env: BackendEnvironment,
  factory = () => new Backend(env),
) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    const respond = (
      data: unknown,
      status = 200,
      meta: Record<string, unknown> = {},
    ) =>
      new Response(
        JSON.stringify({ data, meta: { request_id: requestId, ...meta } }),
        { status, headers },
      );
    try {
      headers = corsHeaders(request, env.allowedOrigins);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const url = new URL(request.url),
        path = url.pathname.replace(/^\/(?:functions\/v1\/)?api(?=\/)/, "");
      if (path === "/v1/health" && request.method === "GET")
        return respond({ status: "available" });
      if (path === "/v1/invitations/check" && request.method === "POST") {
        const input = invitationTokenSchema.parse(
          await readJson(request, 2048),
        );
        return respond(await factory().checkInvitation(input.token));
      }
      const token = request.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token)
        throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
      const backend = factory();
      const user = await backend.authenticate(token);
      if (path === "/v1/invitations/accept" && request.method === "POST") {
        const input = invitationTokenSchema.parse(
          await readJson(request, 2048),
        );
        return respond(await backend.acceptInvitation(token, input.token));
      }
      const membership = await backend.membership(token);
      if (path === "/v1/model-environment" && request.method === "GET") {
        if (membership.role !== "Owner")
          throw new AppError(
            403,
            "OWNER_REQUIRED",
            "Only the Owner can inspect model setup.",
          );
        return respond({
          providers: Object.values(env.models).map((slot) => ({
            provider: slot.provider,
            model: slot.model,
            project_ref: slot.projectRef,
            key_configured: Boolean(slot.key),
          })),
        });
      }
      if (path === "/v1/notification-settings" && request.method === "GET")
        return respond({
          ...(await backend.userRpc(token, "notification_settings", {})),
          transport: smtpStatus(env),
        });
      const recovery = await recoveryRoute(
        request,
        path,
        backend,
        token,
        user.id,
        membership.role,
        headers,
        respond,
      );
      if (recovery) return recovery;
      if (path === "/v1/bootstrap" && request.method === "GET")
        return respond({
          mode: "CONNECTED_FREE",
          membership: { ...membership, user_id: user.id },
          workspace: await backend.one(
            token,
            "workspaces",
            membership.workspace_id,
          ),
          operations: await backend.operations(token),
          model: await (async () => {
            const { records } = await backend.list(
              token,
              "model_settings",
              {},
              10,
            );
            const enabled = records.some((row) => Boolean(row.enabled));
            return records.length
              ? { enabled, providers: records }
              : { enabled: false, blocker: "MODEL_NOT_CONFIGURED" };
          })(),
        });
      if (path === "/v1/status" && request.method === "GET")
        return respond(await backend.status(token));
      const maintenanceAction = path.match(
        /^\/v1\/opportunities\/([^/]+)\/(archive|purge-preview|purge)$/,
      );
      if (maintenanceAction) {
        const opportunity_id = uuid.parse(maintenanceAction[1]),
          action = maintenanceAction[2];
        if (action === "purge-preview" && request.method === "GET")
          return respond(
            await backend.userRpc(token, "preview_opportunity_purge", {
              opportunity_id,
            }),
          );
        if (request.method === "POST" && action !== "purge-preview") {
          const body =
            action === "archive"
              ? z
                  .object({
                    expected_revision: z.number().int().positive(),
                    archive: z.boolean(),
                    reason: z.string().trim().min(10).max(3000),
                  })
                  .strict()
                  .parse(await readJson(request, 16384))
              : z
                  .object({
                    preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
                    confirmed_title: z.string().max(1000),
                    reason: z.string().trim().min(10).max(3000),
                    acknowledge_history: z.literal(true),
                  })
                  .strict()
                  .parse(await readJson(request, 16384));
          return respond(
            await backend.userRpc(
              token,
              action === "archive"
                ? "archive_opportunity"
                : "purge_opportunity",
              { opportunity_id, ...body },
            ),
          );
        }
      }
      const cleanupRetry = path.match(
        /^\/v1\/storage-cleanup\/([^/]+)\/retry$/,
      );
      if (cleanupRetry && request.method === "POST")
        return respond(
          await backend.userRpc(token, "retry_storage_cleanup", {
            cleanup_id: uuid.parse(cleanupRetry[1]),
          }),
        );
      if (path === "/v1/eligibility" && request.method === "GET")
        return respond(
          await backend.eligibility(
            token,
            url.searchParams.has("opportunity")
              ? uuid.parse(url.searchParams.get("opportunity"))
              : null,
          ),
        );
      if (path === "/v1/template-defaults" && request.method === "GET")
        return respond(
          await backend.userRpc(token, "template_defaults", {
            language: z
              .enum(["en", "ar"])
              .parse(url.searchParams.get("language") || "en"),
          }),
        );
      const readiness = path.match(
        /^\/v1\/proposal-versions\/([^/]+)\/readiness$/,
      );
      if (readiness && request.method === "GET")
        return respond(
          await backend.userRpc(token, "proposal_readiness", {
            version_id: uuid.parse(readiness[1]),
          }),
        );
      const read = path.match(/^\/v1\/([a-z-]+)(?:\/([^/]+))?$/);
      if (request.method === "GET" && read && readTables[read[1]]) {
        if (read[2]) {
          const id =
            read[1] === "model-activity"
              ? z
                  .string()
                  .regex(/^[1-9][0-9]{0,18}$/)
                  .parse(read[2])
              : uuid.parse(read[2]);
          const record = await backend.one(token, readTables[read[1]], id);
          return respond(record, 200, { revision: record.revision });
        }
        const limit = Number(url.searchParams.get("limit") || 25);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(
            400,
            "INVALID_PAGINATION",
            "Limit must be between 1 and 100.",
          );
        const cursor = url.searchParams.get("cursor") || undefined;
        if (cursor) {
          if (read[1] === "model-activity")
            z.string()
              .regex(/^[1-9][0-9]{0,18}$/)
              .parse(cursor);
          else uuid.parse(cursor);
        }
        const filters: Record<string, string> = {};
        if (
          [
            "exports",
            "estimates",
            "deliveries",
            "compliance",
            "reviews",
            "approvals",
            "questions",
            "proposal-sections",
          ].includes(read[1]) &&
          url.searchParams.has("version")
        )
          filters.proposal_version_id = uuid.parse(
            url.searchParams.get("version"),
          );
        if (read[1] === "review-inputs" && url.searchParams.has("proposal"))
          filters.proposal_id = uuid.parse(url.searchParams.get("proposal"));
        if (
          [
            "acquisitions",
            "submissions",
            "submission-events",
            "generation-plans",
            "fit-assessments",
            "requirements",
          ].includes(read[1]) &&
          url.searchParams.has("opportunity")
        )
          filters.opportunity_id = uuid.parse(
            url.searchParams.get("opportunity"),
          );
        if (read[1] === "provider-usage" && url.searchParams.has("state"))
          filters.state = z
            .enum(["reserved", "settled", "unknown"])
            .parse(url.searchParams.get("state"));
        if (read[1] === "model-activity") {
          for (const key of ["job", "opportunity", "proposal"]) {
            if (url.searchParams.has(key))
              filters[`${key}_id`] = uuid.parse(url.searchParams.get(key));
          }
          if (url.searchParams.has("provider"))
            filters.provider = z
              .enum([
                "gemini_free",
                "groq_free",
                "zai_free",
                "openai",
                "anthropic",
                "mistral_free",
                "qwen_free",
                "cloudflare_free",
              ])
              .parse(url.searchParams.get("provider"));
          if (url.searchParams.has("status"))
            filters.status = z
              .enum([
                "running",
                "succeeded",
                "failed",
                "skipped",
                "waiting",
                "historical",
                "interrupted",
              ])
              .parse(url.searchParams.get("status"));
        }
        const decision = url.searchParams.get("decision");
        if (decision && read[1] === "opportunities") {
          if (
            !["undecided", "shortlisted", "deferred", "declined"].includes(
              decision,
            )
          )
            throw new AppError(
              400,
              "INVALID_FILTER",
              "Unknown opportunity decision.",
            );
          filters.decision = decision;
        }
        return respond(
          await backend.list(
            token,
            readTables[read[1]],
            filters,
            limit,
            cursor,
          ),
        );
      }
      const exportPath = path.match(/^\/v1\/exports\/([^/]+)\/context$/);
      if (request.method === "GET" && exportPath) {
        const record = await backend.userRpc(token, "export_context", {
          request_id: uuid.parse(exportPath[1]),
        });
        return respond({ request: record, model: buildExportModel(record) });
      }
      const artifactPath = path.match(
        /^\/v1\/export-artifacts\/([^/]+)\/(complete|download)$/,
      );
      if (
        artifactPath &&
        ((request.method === "POST" && artifactPath[2] === "complete") ||
          (request.method === "GET" && artifactPath[2] === "download"))
      ) {
        const id = uuid.parse(artifactPath[1]),
          context = await backend.userRpc(token, "artifact_context", {
            artifact_id: id,
          }),
          artifact = context.artifact;
        const blob = await backend.object(artifact.storage_key);
        if (
          blob.size !== Number(artifact.expected_size) ||
          blob.size > 10485760
        )
          throw new AppError(
            422,
            "ARTIFACT_MISMATCH",
            "Uploaded bytes differ from the reserved artifact.",
          );
        const bytes = new Uint8Array(await blob.arrayBuffer()),
          hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
        if (hash !== artifact.content_hash)
          throw new AppError(
            422,
            "ARTIFACT_MISMATCH",
            "Artifact hash verification failed.",
          );
        if (artifactPath[2] === "complete") {
          validateOriginal(artifact.original_name, artifact.mime_type, bytes);
          if (artifact.mime_type === "application/pdf") {
            const pdf = await PDFDocument.load(bytes, {
              ignoreEncryption: false,
            });
            if (pdf.getPageCount() > 200)
              throw new AppError(
                422,
                "EXPORT_PAGE_CAP_REACHED",
                "Split the reviewed PDF.",
              );
          } else verifyExportDocx(bytes, buildExportModel(context.request));
          return respond(
            await backend.internal("complete_export_artifact", {
              artifact_id: id,
              actor_id: user.id,
              actual_hash: hash,
              actual_size: bytes.length,
              verification_kind:
                artifact.kind === "generated"
                  ? "generated_content"
                  : artifact.mime_type === "application/pdf"
                    ? "owner_reviewed_pdf"
                    : "reviewed_docx",
            }),
          );
        }
        await backend.internal("authorize_artifact_download", {
          artifact_id: id,
          actor_id: user.id,
          actual_hash: hash,
        });
        const headers = corsHeaders(request, env.allowedOrigins);
        headers.set("content-type", artifact.mime_type);
        headers.set("content-disposition", "attachment");
        return new Response(bytes, { headers });
      }
      const downloads = path.match(/^\/v1\/documents\/([^/]+)\/download$/);
      if (request.method === "GET" && downloads) {
        const document = await backend.one(
          token,
          "documents",
          uuid.parse(downloads[1]),
        );
        if (["pending", "expired"].includes(document.status))
          throw new AppError(
            422,
            "DOCUMENT_NOT_READY",
            "The original is not available yet.",
          );
        return respond({
          url: await backend.download(document.storage_key),
          expires_in: 300,
        });
      }
      const complete = path.match(
        /^\/v1\/documents\/([^/]+)\/complete-upload$/,
      );
      const key = request.headers.get("idempotency-key");
      if (!key || key.length > 200)
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Supply an Idempotency-Key of at most 200 characters.",
        );
      if (
        request.method === "POST" &&
        ["/v1/estimates", "/v1/deliveries"].includes(path)
      ) {
        const kind = path === "/v1/estimates" ? "estimate" : "delivery",
          operation =
            kind === "estimate" ? "estimate.prepare" : "delivery.prepare";
        const input = commandSchemas[operation].parse(await readJson(request));
        const pending = await backend.command(token, operation, input, key);
        const context = await backend.userRpc(token, "calculation_context", {
          record_id: pending.id,
          kind,
        });
        if (context.record.status !== "pending") return respond(context.record);
        const computed =
          kind === "estimate"
            ? calculateEstimate(context.record.input, context.rates)
            : calculateDelivery(context.record.input);
        return respond(
          await backend.internal("complete_calculation", {
            record_id: pending.id,
            kind,
            actor_id: user.id,
            input_hash: context.record.input_hash,
            rates_hash: context.rates_hash,
            computed,
          }),
          201,
        );
      }
      if (request.method === "POST" && path === "/v1/commands") {
        const batch = z
          .object({
            commands: z
              .array(
                z
                  .object({
                    operation: z.enum(
                      Object.keys(commandSchemas) as [
                        CommandName,
                        ...CommandName[],
                      ],
                    ),
                    input: z.unknown(),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict()
          .parse(await readJson(request));
        const commands = batch.commands.map(({ operation, input }) => {
          const parsed = commandSchemas[operation].parse(input);
          if (operation === "source.configure") {
            const config = parsed as z.infer<
              (typeof commandSchemas)["source.configure"]
            >;
            if (
              config.kind === "link_directory" &&
              config.adapter_config.discover_source_links !== undefined
            ) {
              const discover = z
                .boolean()
                .parse(config.adapter_config.discover_source_links);
              if (discover && !config.adapter_config.official_listing)
                throw new AppError(
                  422,
                  "SOURCE_EXTRACTION_INVALID",
                  "Combined collection requires saved notice extraction settings.",
                );
            }
            if (
              config.kind === "link_directory" &&
              config.adapter_config.official_listing
            ) {
              try {
                const extraction = sourceExtraction(
                  config.adapter_config.extraction,
                );
                if (!extractionMatchesUrl(extraction, config.url))
                  throw new Error("OFFICIAL_ADAPTER_URL_MISMATCH");
                config.adapter_config.extraction = extraction;
              } catch {
                throw new AppError(
                  422,
                  "SOURCE_EXTRACTION_INVALID",
                  "Source extraction settings must be valid and match the collection URL.",
                );
              }
            }
            if (config.kind === "json_feed")
              config.adapter_config = adapterSchema.parse(
                config.adapter_config,
              );
          }
          if (operation === "import.preview") {
            const preview = parsed as z.infer<
              (typeof commandSchemas)["import.preview"]
            >;
            preview.rows = preview.rows.map((row, index) => {
              if (preview.kind === "sources") {
                const url = canonical(row.url);
                if (!url)
                  throw new AppError(
                    422,
                    "INVALID_IMPORT_ROW",
                    `Row ${index + 1}: a public HTTPS URL is required.`,
                  );
                return {
                  url,
                  name: inertText(row.name, 200) || new URL(url).hostname,
                };
              }
              const title = inertText(row.title, 1000),
                url = canonical(row.canonical_url),
                reference = inertText(row.external_id || row.reference, 1000);
              if (!title || (!url && !reference))
                throw new AppError(
                  422,
                  "INVALID_IMPORT_ROW",
                  `Row ${index + 1}: title and a URL or reference are required.`,
                );
              return {
                title,
                canonical_url: url,
                reference,
                identity_key: reference
                  ? `external:${reference}`
                  : `url:${url}`,
                description: inertText(row.description),
                buyer: inertText(row.buyer_name || row.buyer, 1000),
                deadline_raw: inertText(row.deadline_raw, 1000) || null,
                source_name: inertText(row.source_name, 200),
                language: /[\u0600-\u06ff]/.test(title) ? "ar" : "en",
              };
            });
          }
          return { operation, input: parsed };
        });
        return respond(await backend.batch(token, commands, key));
      }
      if (path === "/v1/invitations" && request.method === "POST")
        return respond(
          await backend.invitationCommand(
            token,
            "invitation.create",
            invitationCreateSchema.parse(await readJson(request, 4096)),
            key,
          ),
          201,
        );
      const revokeInvite = path.match(/^\/v1\/invitations\/([^/]+)\/revoke$/);
      if (revokeInvite && request.method === "POST")
        return respond(
          await backend.invitationCommand(
            token,
            "invitation.revoke",
            {
              id: uuid.parse(revokeInvite[1]),
              ...invitationRevokeSchema.parse(await readJson(request, 2048)),
            },
            key,
          ),
        );
      if (request.method === "POST" && complete) {
        const id = uuid.parse(complete[1]),
          input = completeUploadSchema.parse(await readJson(request));
        const document = await backend.one(token, "documents", id);
        if (document.created_by !== user.id)
          throw new AppError(
            403,
            "ROLE_FORBIDDEN",
            "Only the uploader can accept this original.",
          );
        if (membership.role === "Reviewer" && document.kind !== "review")
          throw new AppError(
            403,
            "ROLE_FORBIDDEN",
            "Only your review attachments may be uploaded.",
          );
        const original = await backend.object(document.storage_key);
        if (original.size !== Number(document.expected_size))
          throw new AppError(
            422,
            "UPLOAD_MISMATCH",
            "The uploaded size does not match the reservation.",
          );
        const bytes = new Uint8Array(await original.arrayBuffer());
        validateOriginal(document.original_name, document.mime_type, bytes);
        let pages = 0;
        if (document.mime_type === "application/pdf") {
          try {
            pages = (
              await PDFDocument.load(bytes, { ignoreEncryption: false })
            ).getPageCount();
          } catch {
            throw new AppError(
              422,
              "PDF_UNREADABLE",
              "Replace the encrypted or corrupt PDF with a readable original.",
            );
          }
        }
        await backend.verifyPages(id, pages);
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        const data = await backend.accept(
          id,
          user.id,
          hash,
          bytes.length,
          input.from_parts
            ? await backend.extraction(token, id)
            : input.extracted_text,
          input.status,
          key,
        );
        return respond(data, 200, { revision: data.revision });
      }
      for (const route of routeCommands) {
        const match = path.match(route.pattern);
        if (!match || request.method !== route.method) continue;
        const raw = await readJson(request);
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new AppError(400, "INVALID_INPUT", "Supply a JSON object.");
        if (route.idField && route.idField in raw)
          throw new AppError(
            400,
            "INVALID_INPUT",
            "The record ID belongs in the route only.",
          );
        const input = commandSchemas[route.command].parse({
          ...raw,
          ...(route.idField ? { [route.idField]: uuid.parse(match[1]) } : {}),
        });
        const data = await backend.command(token, route.command, input, key);
        if (route.command === "document.prepare")
          return respond(
            {
              ...data,
              bucket: "tenderdesk-private",
              upload_path: data.storage_key,
              upload_expires_at: new Date(
                new Date(data.created_at).getTime() + 15 * 60 * 1000,
              ).toISOString(),
              upload_method: "authenticated_storage",
            },
            201,
            { revision: data.revision },
          );
        return respond(
          data,
          route.command === "proposal.regenerate"
            ? 202
            : request.method === "POST" && !route.idField
              ? 201
              : 200,
          { revision: data.revision },
        );
      }
      throw new AppError(
        503,
        "CAPABILITY_NOT_ACTIVE",
        "This workflow has not been activated. Existing records are preserved.",
      );
    } catch (error) {
      const invalid = error && typeof error === "object" && "issues" in error;
      const e =
        error instanceof CommercialError
          ? new AppError(
              422,
              error.code,
              "Resolve the commercial validation issues.",
              { issues: error.issues },
            )
          : error instanceof AppError
            ? error
            : invalid
              ? new AppError(400, "INVALID_INPUT", "Check the request fields.")
              : new AppError(
                  503,
                  "SERVICE_UNAVAILABLE",
                  "The request could not be completed.",
                  null,
                  true,
                );
      return new Response(
        JSON.stringify({
          error: {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            details: e.details,
          },
          request_id: requestId,
        }),
        { status: e.status, headers },
      );
    }
  };
}
