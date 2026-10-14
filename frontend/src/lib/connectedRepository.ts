import { z } from "zod";
import type { AppState, Opportunity, Role, Source } from "../types";
import { BackendClient, BackendRequestError } from "./backendClient";

type Row = Record<string, unknown> & { id: string; revision: number };
type Command = { operation: string; input: Record<string, unknown> };
const rowSchema = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .passthrough();
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const str = (row: Record<string, unknown>, key: string, fallback = "") =>
  row[key] == null ? fallback : z.string().parse(row[key]);
const strings = (value: unknown) => z.array(z.string()).parse(value ?? []);
const blocked = (message: string): never => {
  throw new BackendRequestError("CAPABILITY_NOT_ACTIVE", message, 422);
};

export function emptyConnectedState(): AppState {
  return {
    schemaVersion: 1,
    opportunities: [],
    proposals: [],
    sources: [],
    knowledge: [],
    knowledgeDocuments: [],
    jobs: [],
    notifications: [],
    audit: [],
    settings: {
      role: "Reviewer",
      companyName: "",
      dailyCallLimit: 50,
      inputTokenLimit: 250000,
      outputTokenLimit: 50000,
      pollHours: 6,
      retentionDays: 90,
    },
  };
}

export class ConnectedRepository {
  private rows: Record<string, Row[]> = {};
  private workspace!: Row;
  private loadGeneration = 0;
  private pending: {
    signature: string;
    key: string;
    commands: Command[];
  } | null = null;
  operations = {
    lastHeartbeat: null as string | null,
    lastCollection: null as string | null,
    schedulerEnabled: false,
  };
  constructor(readonly client: BackendClient) {}

  private async list(path: string): Promise<Row[]> {
    const rows: Row[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const { data } = await this.client.request<unknown>(
        `/v1/${path}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const schema = ["audit-events", "regeneration-requests"].includes(path)
        ? rowSchema.extend({ revision: z.number().int().positive().default(1) })
        : rowSchema;
      const page = z
        .object({ records: z.array(schema), next_cursor: z.uuid().nullable() })
        .parse(data);
      rows.push(...page.records);
      cursor = page.next_cursor;
      if (cursor && (seen.has(cursor) || rows.length >= 10000))
        throw new BackendRequestError(
          "PAGINATION_INVALID",
          "Workspace results exceeded the supported boundary.",
          503,
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }

  async load(): Promise<AppState> {
    const generation = ++this.loadGeneration;
    const { data } = await this.client.request<unknown>("/v1/bootstrap");
    const boot = z
      .object({
        membership: z.object({
          workspace_id: z.uuid(),
          role: z.enum(["Owner", "Editor", "Reviewer"]),
        }),
        workspace: rowSchema,
        operations: z
          .object({
            last_heartbeat_at: z.string().nullable(),
            last_source_success_at: z.string().nullable(),
            scheduler_enabled: z.boolean(),
          })
          .nullable(),
      })
      .parse(data);
    if (boot.workspace.id !== boot.membership.workspace_id)
      throw new BackendRequestError(
        "WORKSPACE_MISMATCH",
        "The workspace response did not match your membership.",
        403,
      );
    const paths = [
      "sources",
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
    ];
    const tables = await Promise.all(
      paths.map(async (path) => [path, await this.list(path)] as const),
    );
    if (generation !== this.loadGeneration)
      throw new Error("A newer workspace request replaced this response.");
    this.rows = Object.fromEntries(tables);
    this.workspace = boot.workspace;
    this.operations = {
      lastHeartbeat: boot.operations?.last_heartbeat_at ?? null,
      lastCollection: boot.operations?.last_source_success_at ?? null,
      schedulerEnabled: boot.operations?.scheduler_enabled ?? false,
    };
    return this.mapState(boot.membership.role);
  }

  private mapState(role: Role): AppState {
    const state = emptyConnectedState();
    const settings = z
      .record(z.string(), z.unknown())
      .parse(this.workspace.settings ?? {});
    const number = (key: string, fallback: number) =>
      settings[key] == null ? fallback : z.number().parse(settings[key]);
    state.settings = {
      role,
      companyName: str(this.workspace, "name"),
      dailyCallLimit: number("daily_call_limit", 50),
      inputTokenLimit: number("input_token_limit", 250000),
      outputTokenLimit: number("output_token_limit", 50000),
      pollHours: number("poll_hours", 6),
      retentionDays: number("retention_days", 90),
    };
    state.sources = this.rows.sources.map((r) => ({
      id: r.id,
      name: str(r, "name"),
      type: z
        .enum(["rss", "json_feed", "link_directory", "manual"])
        .parse(r.kind),
      url: str(r, "url"),
      status: z
        .enum(["proposed", "approved", "paused", "rejected"])
        .parse(r.approval),
      health: ["healthy", "unavailable", "blocked"].includes(str(r, "health"))
        ? (r.health as Source["health"])
        : "unknown",
      lastRun: str(r, "last_success_at") || null,
      nextRun: str(r, "next_due") || null,
      count: this.rows.opportunities.filter((o) => o.source_id === r.id).length,
      policy: str(r, "policy_note"),
      tags: strings(r.tags),
    }));
    const documents = this.rows.documents.filter(
      (d) => !["pending", "expired"].includes(str(d, "status")),
    );
    const document = (d: Row) => ({
      id: d.id,
      name: str(d, "original_name"),
      size: Number(d.uploaded_size ?? d.expected_size),
      uploadedAt: str(d, "created_at"),
      text: str(d, "extracted_text"),
      status: z
        .enum(["ready", "needs_ocr", "needs_processing", "error"])
        .parse(d.status),
      classification: "unspecified" as const,
      hash: str(d, "original_hash"),
    });
    state.opportunities = this.rows.opportunities.map((r) => {
      const files = documents
        .filter((d) => d.opportunity_id === r.id && d.kind === "rfp")
        .map(document);
      return {
        id: r.id,
        title: str(r, "title"),
        reference: str(r, "reference"),
        buyer: str(r, "buyer"),
        description: str(r, "description"),
        category: str(r, "category"),
        tags: strings(r.tags),
        deadline: str(r, "deadline_at"),
        deadlineSource: str(r, "deadline_raw"),
        score: null,
        coverage: 0,
        status:
          r.decision === "undecided"
            ? "new"
            : z.enum(["shortlisted", "deferred", "declined"]).parse(r.decision),
        sourceId: str(r, "source_id"),
        value: null,
        saved: r.saved === true,
        createdAt: str(r, "created_at"),
        documents: files,
        requirements: [],
        gaps: this.rows.questions
          .filter((q) => q.opportunity_id === r.id)
          .map((q) => ({
            id: q.id,
            question: str(q, "question"),
            answer: str(q, "answer"),
            required: q.blocking_level !== "advisory",
          })),
        acquisition: files.length ? "document_available" : "not_requested",
        language: z.enum(["en", "ar"]).parse(r.language),
        sourceUrl: str(r, "canonical_url"),
      };
    });
    const linkedKnowledge = new Set(
      documents
        .filter((d) => d.kind === "company")
        .map((d) => d.knowledge_item_id),
    );
    state.knowledge = this.rows.knowledge
      .filter((r) => !linkedKnowledge.has(r.id))
      .map((r) => ({
        id: r.id,
        category: [
          "capability",
          "company",
          "exclusion",
          "rate",
          "template",
        ].includes(str(r, "category"))
          ? (r.category as AppState["knowledge"][number]["category"])
          : "company",
        title: str(r, "title"),
        content: str(r, "content"),
        evidence: str(r, "evidence"),
        verified: r.verified === true,
      }));
    state.knowledgeDocuments = documents
      .filter((d) => d.kind === "company")
      .map((d) => {
        const knowledge = this.rows.knowledge.find(
          (r) => r.id === d.knowledge_item_id,
        );
        return {
          ...document(d),
          category:
            knowledge &&
            [
              "company",
              "team",
              "previous_proposal",
              "template",
              "other",
            ].includes(str(knowledge, "category"))
              ? (knowledge.category as AppState["knowledgeDocuments"][number]["category"])
              : "other",
          enabled: knowledge?.enabled === true,
        };
      });
    state.proposals = this.rows.proposals.flatMap((p) => {
      const version = this.rows["proposal-versions"].find(
        (v) => v.id === p.active_version_id,
      );
      if (!version) return [];
      return [
        {
          id: p.id,
          opportunityId: str(p, "opportunity_id"),
          title: str(p, "title"),
          status:
            p.state === "approved"
              ? ("approved" as const)
              : p.state === "in_review"
                ? ("in_review" as const)
                : ("draft" as const),
          version: z.number().int().positive().parse(version.ordinal),
          sections: this.rows["proposal-sections"]
            .filter((s) => s.proposal_version_id === version.id)
            .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
            .map((s) => ({
              id: str(s, "section_key"),
              title: str(s, "title"),
              body: str(s, "body"),
              evidence: strings(s.evidence_refs),
            })),
          lines: [],
          pricingMode: "markup" as const,
          percentage: "",
          contingency: "",
          tax: "",
          approvalVersion:
            p.state === "approved" ? Number(version.ordinal) : null,
          updatedAt: str(p, "updated_at"),
          comments: [],
        },
      ];
    });
    state.jobs = this.rows.jobs.map((r) => ({
      id: r.id,
      type: str(r, "type"),
      target: str(r, "entity_id"),
      status:
        r.status === "succeeded"
          ? "completed"
          : r.status === "canceled"
            ? "cancelled"
            : ["running", "failed", "blocked"].includes(str(r, "status"))
              ? (r.status as "running" | "failed" | "blocked")
              : "queued",
      progress: r.status === "succeeded" ? 100 : 0,
      attempt: Number(r.attempts),
      message: str(r, "error_code"),
      createdAt: str(r, "created_at"),
    }));
    state.notifications = this.rows.notifications.map((r) => ({
      id: r.id,
      title: str(r, "title"),
      body: str(r, "body"),
      href: "/jobs",
      read: r.read_at != null,
      createdAt: str(r, "created_at"),
    }));
    state.audit = this.rows["audit-events"].map((r) => ({
      id: r.id,
      action: str(r, "action"),
      target: str(r, "entity_id"),
      at: str(r, "created_at"),
      actor: str(r, "actor_id"),
    }));
    return state;
  }

  private revision(table: string, id: string) {
    const row = this.rows[table]?.find((r) => r.id === id);
    if (!row)
      blocked("This record is no longer loaded. Refresh before saving.");
    return row!.revision;
  }

  plan(previous: AppState, next: AppState): Command[] {
    const commands: Command[] = [];
    const add = (operation: string, input: Record<string, unknown>) =>
      commands.push({ operation, input });
    if (previous.settings.role !== next.settings.role)
      blocked(
        "Roles are assigned by the workspace Owner, not by this browser.",
      );
    if (!equal(previous.settings, next.settings))
      add("workspace.settings", {
        expected_revision: this.workspace.revision,
        name: next.settings.companyName,
        daily_call_limit: next.settings.dailyCallLimit,
        input_token_limit: next.settings.inputTokenLimit,
        output_token_limit: next.settings.outputTokenLimit,
        poll_hours: next.settings.pollHours,
        retention_days: next.settings.retentionDays,
      });
    const noDeletes = (before: { id: string }[], after: { id: string }[]) => {
      if (before.some((r) => !after.some((x) => x.id === r.id)))
        blocked(
          "Removal for this record must use an authorized archive command.",
        );
    };
    noDeletes(previous.sources, next.sources);
    noDeletes(previous.opportunities, next.opportunities);
    noDeletes(previous.knowledge, next.knowledge);
    for (const source of next.sources) {
      const before = previous.sources.find((s) => s.id === source.id);
      if (!before)
        add("source.create", {
          client_id: source.id,
          name: source.name,
          kind: source.type,
          url: source.url || undefined,
          approved_hosts: source.url ? [new URL(source.url).hostname] : [],
          policy_note: source.policy,
          tags: source.tags,
          poll_interval_hours: next.settings.pollHours,
        });
      else if (!equal(before, source)) {
        if (
          !equal(
            { ...before, status: source.status, nextRun: source.nextRun },
            source,
          )
        )
          blocked("Only source approval or pause can be changed in this view.");
        const action = {
          approved: "approve",
          paused: "pause",
          rejected: "reject",
          proposed: "",
        }[source.status];
        if (!action)
          blocked(
            "A source cannot return to proposed through an approval action.",
          );
        add("source.action", {
          id: source.id,
          action,
          reason: `Source ${source.status}`,
          expected_revision: this.revision("sources", source.id),
        });
      }
    }
    let manual = next.sources.find((s) => s.type === "manual")?.id;
    for (const opportunity of next.opportunities) {
      const before = previous.opportunities.find(
        (o) => o.id === opportunity.id,
      );
      const fields = (o: Opportunity) => ({
        title: o.title,
        description: o.description,
        buyer: o.buyer,
        reference: o.reference,
        canonical_url: o.sourceUrl || undefined,
        language: o.language,
        category: o.category,
        tags: o.tags,
        deadline_raw: o.deadlineSource || undefined,
        deadline_at: o.deadline || undefined,
        deadline_timezone: o.deadline ? "Asia/Riyadh" : undefined,
      });
      const decision = (o: Opportunity) =>
        o.status === "new" ? "undecided" : o.status;
      if (!before) {
        if (
          opportunity.documents.length ||
          opportunity.requirements.length ||
          opportunity.gaps.length ||
          opportunity.saved ||
          opportunity.value !== null ||
          opportunity.score !== null ||
          opportunity.coverage !== 0 ||
          opportunity.acquisition !== "not_requested"
        )
          blocked(
            "Import the opportunity details first. Files, assessment, and acquisition need their own connected workflow.",
          );
        if (opportunity.sourceId === "manual" && !manual) {
          manual = crypto.randomUUID();
          add("source.create", {
            client_id: manual,
            name: "Added by you",
            kind: "manual",
            policy_note: "Manual entries and imported records; never polled.",
            tags: [],
            approved_hosts: [],
          });
        }
        add("opportunity.create", {
          ...fields(opportunity),
          client_id: opportunity.id,
          source_id:
            opportunity.sourceId === "manual" ? manual : opportunity.sourceId,
          decision: decision(opportunity),
        });
      } else {
        if (
          !equal(
            {
              ...before,
              ...Object.fromEntries(
                [
                  "title",
                  "description",
                  "buyer",
                  "reference",
                  "sourceUrl",
                  "language",
                  "category",
                  "tags",
                  "deadlineSource",
                  "deadline",
                  "saved",
                  "status",
                ].map((key) => [key, opportunity[key as keyof Opportunity]]),
              ),
            },
            opportunity,
          )
        )
          blocked(
            "This change includes fields that require a separate connected workflow.",
          );
        if (
          !equal(before.documents, opportunity.documents) ||
          !equal(before.requirements, opportunity.requirements) ||
          !equal(before.gaps, opportunity.gaps)
        )
          blocked(
            "Files and requirement changes need their connected document workflow before saving.",
          );
        let revision = this.revision("opportunities", opportunity.id);
        if (
          !equal(fields(before), fields(opportunity)) ||
          before.saved !== opportunity.saved
        ) {
          add("opportunity.update", {
            ...fields(opportunity),
            id: opportunity.id,
            saved: opportunity.saved,
            expected_revision: revision,
          });
          revision++;
        }
        if (before.status !== opportunity.status) {
          if (["submitted", "in_progress"].includes(opportunity.status))
            blocked(
              "Submission needs a persisted proposal version and its own server command.",
            );
          add("opportunity.decision", {
            id: opportunity.id,
            target_state: decision(opportunity),
            reason: `Opportunity ${opportunity.status}`,
            expected_revision: revision,
          });
        }
      }
    }
    for (const fact of next.knowledge) {
      const before = previous.knowledge.find((f) => f.id === fact.id);
      if (equal(before, fact)) continue;
      if (fact.verified && !before?.verified) {
        if (!before || !equal({ ...before, verified: true }, fact))
          blocked("Save the note before verifying its current content.");
        add("knowledge.verify", {
          id: fact.id,
          expected_revision: this.revision("knowledge", fact.id),
        });
        continue;
      }
      add("knowledge.save", {
        ...(before
          ? {
              id: fact.id,
              expected_revision: this.revision("knowledge", fact.id),
            }
          : { client_id: fact.id }),
        category: fact.category,
        title: fact.title,
        content: fact.content,
        evidence: fact.evidence,
        enabled: true,
      });
    }
    for (const notification of next.notifications) {
      const before = previous.notifications.find(
        (n) => n.id === notification.id,
      );
      if (before && !before.read && notification.read)
        add("notification.read", {
          id: notification.id,
          expected_revision: this.revision("notifications", notification.id),
        });
    }
    for (const job of next.jobs) {
      const before = previous.jobs.find((j) => j.id === job.id);
      if (before && !equal(before, job))
        add("job.action", {
          id: job.id,
          expected_revision: this.revision("jobs", job.id),
          action: job.status === "cancelled" ? "cancel" : "retry",
          reason:
            job.status === "cancelled"
              ? "Canceled by user"
              : "Retry requested by user",
        });
    }
    if (!equal(previous.knowledgeDocuments, next.knowledgeDocuments))
      blocked(
        "Company files need the connected upload workflow before saving.",
      );
    if (!equal(previous.proposals, next.proposals))
      blocked(
        "Proposal changes need their connected version and review workflow before saving.",
      );
    if (commands.length > 100)
      blocked("Save at most 100 changes in one request.");
    return commands;
  }

  async save(previous: AppState, next: AppState): Promise<AppState> {
    const signature = JSON.stringify([previous, next]);
    if (this.pending && this.pending.signature !== signature)
      blocked(
        "The previous save has an uncertain result. Retry that save or refresh to check the server before editing another record.",
      );
    if (!this.pending)
      this.pending = {
        signature,
        key: crypto.randomUUID(),
        commands: this.plan(previous, next),
      };
    const pending = this.pending;
    try {
      if (pending.commands.length)
        await this.client.request("/v1/commands", {
          method: "POST",
          body: { commands: pending.commands },
          idempotencyKey: pending.key,
        });
      const saved = await this.load();
      this.pending = null;
      return saved;
    } catch (error) {
      if (
        error instanceof BackendRequestError &&
        error.status >= 400 &&
        error.status < 500
      )
        this.pending = null;
      throw error;
    }
  }

  async refresh(): Promise<AppState> {
    const state = await this.load();
    this.pending = null;
    return state;
  }
}
