// @vitest-environment node
// Controlled in-process response bytes test canonical validators, not model quality.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import corpus from "./fixtures/qualification-reserve/corpus-v4.json";
import {
  buildReserveAdapter,
  compileReserveRequest,
  reserveAdapterCoverage,
  type ReserveAdapter,
} from "../../scripts/qualification/reserve-adapters";
import {
  executeModel,
  validateModelResult,
  type ModelConfiguration,
  type Ledger,
} from "../../supabase/functions/_shared/model";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { sha256 } from "../../scripts/qualification/reserve.mjs";
const isSupported = (r: (typeof corpus.cases)[number]) =>
  r.task === "connection_probe" ||
  r.task === "inspect_source_page" ||
  (r.task === "analyze_chunk" && r.scenario === "retention_exception") ||
  (r.task === "summarize_review" && r.scenario === "advisory_note");
const cases = corpus.cases.filter(isSupported),
  unsupported = corpus.cases.filter((row) => !isSupported(row));
const config: ModelConfiguration = {
  provider: "qwencloud",
  model: "synthetic-offline-model",
  project_ref: "synthetic-offline-project",
  enabled: true,
  automatic: true,
  free_only: false,
  billing_verified: true,
  free_quota_only: false,
  verified_at: "2026-11-04T00:00:00Z",
  quota_ends_at: null,
  quota_mode: "provider_managed",
  connection_id: "synthetic-connection",
  model_config_id: "synthetic-config",
  capabilities: defaultCapabilities("qwencloud"),
  profile: {
    revision: 1,
    max_output_tokens: 4096,
    reasoning: "none",
    require_native_strict: false,
  },
};
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it("retains all 50 slots with an explicit10/40 boundary; never quietly shrinks the campaign", async () => {
  const coverage = await reserveAdapterCoverage();
  expect(coverage).toHaveLength(50);
  expect(
    coverage.filter((r) => r.status === "offline_single_request_constructible"),
  ).toHaveLength(10);
  expect(coverage.filter((r) => r.status === "unsupported")).toHaveLength(40);
  expect(new Set(coverage.map((r) => r.task)).size).toBe(13);
});
it.each(cases)(
  "constructs $id through real phase/prompt/schema preparation before reservation",
  async (row) => {
    const external = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("external call forbidden"));
    const adapter = await buildReserveAdapter(row.id),
      compiled = await compileReserveRequest(adapter, config);
    expect(compiled.request.task).toBe(row.task);
    expect(compiled.request.target.model).toBe(config.model);
    expect(compiled.request_pin.input_sha256).toBe(
      sha256(compiled.request.prompt),
    );
    expect(compiled.request_pin.prompt_sha256).toBe(
      sha256(
        JSON.stringify({
          system: compiled.system_instructions,
          user: compiled.request.prompt,
        }),
      ),
    );
    expect(compiled.request_pin.output_schema_sha256).toBe(
      sha256(JSON.stringify(compiled.request.schema)),
    );
    expect(compiled).toMatchObject({
      provider_calls: 0,
      reservations: 0,
      database_mutations: 0,
      semantic_qualification: "not_evaluated",
    });
    expect(external).not.toHaveBeenCalled();
    expect(compiled.request.prompt).not.toContain(row.id);
    expect(compiled.request.prompt).not.toContain(row.scenario);
    expect(compiled.request.prompt).not.toMatch(
      /required_meaning|expected_behavior|noncritical_acceptance|"oracle"|"split_group"/,
    );
    expect(compiled.trace.database_authorization_proven).toBe(false);
    if (row.task === "analyze_chunk") {
      expect(compiled.request.schemaVersion).toBe("2");
      expect(
        compiled.request.schema.properties.requirements.items.required,
      ).toContain("source_semantics");
      expect(adapter.semanticRevision).toBe(4);
      const span = adapter.context.source_evidence.spans[0],
        original = row.documents[0];
      expect(span.quote).toBe(original.text);
      expect(span.content_hash).toBe(original.sha256);
      expect(
        Array.from(original.text).slice(span.start, span.end).join(""),
      ).toBe(span.quote);
      expect(adapter.context.source_evidence.reviews).toEqual([]);
      expect(adapter.evidence.find((e) => e.id === span.id)?.text).toBe(
        original.text,
      );
      expect(adapter.manifest).toEqual([
        {
          entity_kind: "document",
          entity_id: original.entity_id,
          content_hash: original.sha256,
        },
      ]);
    }
    if (row.task === "summarize_review") {
      expect(adapter.required).toEqual([row.documents[0].entity_id]);
      expect(adapter.evidence[0].id).not.toBe(row.documents[0].id);
      expect(adapter.trace.source_projection[0]).toMatchObject({
        canonical_id: row.documents[0].entity_id,
        corpus_document_id: row.documents[0].id,
        source_sha256: row.documents[0].sha256,
      });
    }
    if (row.task === "inspect_source_page") {
      const body = JSON.parse(compiled.request.prompt);
      expect(body.untrusted_data.page_text).toBe(
        row.documents[0].text
          .normalize("NFC")
          .replace(/\p{Cf}/gu, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
      expect(body.untrusted_data.mode).toBe("collect_notices");
      expect(adapter.language).toBe("ar");
      expect(adapter.caseLanguage).toBe(row.language);
      expect(adapter.trace.source_projection[0].source_sha256).toBe(
        row.documents[0].sha256,
      );
      expect(adapter.evidence.map((e) => e.id)).toEqual([
        "page",
        ...row.workflow_facts.links!.map((l) => l.id),
      ]);
    }
    expect(
      (await compileReserveRequest(await buildReserveAdapter(row.id), config))
        .request_pin,
    ).toEqual(compiled.request_pin);
  },
);
it.each(unsupported)(
  "refuses unsupported $id instead of fabricating prerequisite outputs",
  async (row) => {
    await expect(buildReserveAdapter(row.id)).rejects.toMatchObject({
      code: expect.stringMatching(/UNFROZEN|REQUIRED/),
    });
  },
);
it.each([
  "context",
  "evidence",
  "required",
  "manifest",
  "semanticRevision",
  "phasePins",
])("refuses changed %s after source construction", async (field) => {
  const adapter = await buildReserveAdapter(cases[0].id);
  if (field === "context") adapter.context.instruction += " changed";
  if (field === "evidence") adapter.evidence[0].text += " changed";
  if (field === "required") adapter.required.push("extra");
  if (field === "manifest") adapter.manifest[0].content_hash = "0".repeat(64);
  if (field === "semanticRevision") adapter.semanticRevision = 0;
  if (field === "phasePins") adapter.phasePins[0].value.version = 0;
  await expect(compileReserveRequest(adapter, config)).rejects.toThrow(
    "RESERVE_ADAPTER_INPUT_CHANGED",
  );
});
it("does not convert disabled configuration into an eligible route", async () => {
  const adapter = await buildReserveAdapter(cases[0].id);
  await expect(
    compileReserveRequest(adapter, { ...config, enabled: false }),
  ).rejects.toThrow();
});
async function dispatchControlled(adapter: ReserveAdapter, candidate: unknown) {
  const environment = {
    provider: config.provider,
    model: config.model,
    projectRef: config.project_ref,
    key: "synthetic-unused-credential",
  };
  const reserve = vi.fn(async () => "synthetic-in-memory-reservation"),
    settle = vi.fn(async () => {});
  const compiled = await compileReserveRequest(adapter, config);
  const transport = vi.fn(async (_url: any, init: any) => {
    const wire = JSON.parse(init.body);
    expect(
      wire.messages.find((message: any) => message.role === "system").content,
    ).toBe(compiled.system_instructions);
    expect(
      wire.messages.find((message: any) => message.role === "user").content,
    ).toBe(
      compiled.request.prompt +
        "\nJSON schema: " +
        JSON.stringify(compiled.request.schema),
    );
    return Response.json({
      id: "synthetic-response",
      model: config.model,
      choices: [
        {
          message: { content: JSON.stringify(candidate) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  const ledger: Ledger = {
    preflight: async () => ({
      providers: [config],
      routing_mode: "round_robin",
      executor_version: 2,
    }),
    reserve,
    settle,
    environment: () => environment,
    backgroundAllowed: async () => false,
    validateCandidate: adapter.domainValidate,
  };
  const result = await executeModel(
    adapter.task,
    adapter.context,
    adapter.evidence,
    adapter.required,
    adapter.manifest,
    { [config.provider]: environment },
    ledger,
    adapter.language,
    false,
    transport as typeof fetch,
    adapter.verificationRevision,
    { semanticRevision: adapter.semanticRevision },
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  return result;
}
function analysis(adapter: ReserveAdapter): any {
  const span = adapter.context.source_evidence.spans[0];
  return {
    processed_block_ids: adapter.required,
    requirements: [
      {
        text: span.quote,
        category: "data",
        mandatory: true,
        source_refs: [{ id: span.id, quote: span.quote }],
        interpretation: "",
        acceptance_evidence: "",
        owner_question: null,
        source_semantics: {
          version: 1,
          source_span_ids: [span.id],
          authority_role: "buyer_rfp",
          authority_status: "confirmed",
          modality: "unknown",
          actor: null,
          negated: null,
          conditions: [],
          exceptions: [],
          consequences: [],
          quantities: [],
          dates: [],
          review_status: "pending",
          review_id: null,
        },
      },
    ],
    questions: [],
    separate_volumes: false,
    summary: span.quote,
  };
}
it.each(["en", "ar"])(
  "canonical %s analysis materializes trusted source text and never grants model-authored review",
  async (language) => {
    const adapter = await buildReserveAdapter(
        `qr1.analyze_chunk.retention_exception.${language}`,
      ),
      candidate = analysis(adapter);
    candidate.requirements[0].text = "Untrusted replacement";
    candidate.requirements[0].source_refs[0].quote = "Untrusted replacement";
    candidate.requirements[0].source_semantics.review_status = "confirmed";
    candidate.requirements[0].source_semantics.review_id =
      "71111111-1111-4111-8111-111111111111";
    const result = await dispatchControlled(adapter, candidate),
      span = adapter.context.source_evidence.spans[0];
    expect(result.requirements[0].text).toBe(span.quote);
    expect(result.requirements[0].source_refs[0].quote).toBe(span.quote);
    expect(result.requirements[0].source_semantics).toMatchObject({
      authority_role: "buyer_rfp",
      authority_status: "confirmed",
      review_status: "pending",
      review_id: null,
    });
    // Schema/source success is not a semantic judgment of the neutral tuple.
  },
);
it.each(["unknown_span", "missing_processed_block", "missing_semantics"])(
  "actual analysis dispatch rejects %s",
  async (fault) => {
    const adapter = await buildReserveAdapter(
        "qr1.analyze_chunk.retention_exception.en",
      ),
      candidate = analysis(adapter);
    if (fault === "unknown_span") {
      candidate.requirements[0].source_refs[0].id = "unknown";
      candidate.requirements[0].source_semantics.source_span_ids = ["unknown"];
    }
    if (fault === "missing_processed_block") candidate.processed_block_ids = [];
    if (fault === "missing_semantics")
      delete candidate.requirements[0].source_semantics;
    await expect(dispatchControlled(adapter, candidate)).rejects.toThrow();
  },
);
it.each(["en", "ar"])(
  "canonical %s review validates UUID source mapping and rejects an original alias masquerading as a processed ID",
  async (language) => {
    const adapter = await buildReserveAdapter(
        `qr1.summarize_review.advisory_note.${language}`,
      ),
      source = adapter.evidence[0];
    const result = {
      processed_review_ids: adapter.required,
      directives: [
        {
          instruction: source.text,
          source_refs: [{ id: source.id, quote: source.text }],
        },
      ],
      questions: [],
    };
    await expect(dispatchControlled(adapter, result)).resolves.toMatchObject(
      result,
    );
    result.processed_review_ids = [
      adapter.trace.source_projection[0].corpus_document_id,
    ];
    await expect(dispatchControlled(adapter, result)).rejects.toThrow();
  },
);
it.each(["en", "ar"])(
  "actual source-page %s dispatch enforces collect mode beyond the base validator",
  async (language) => {
    const adapter = await buildReserveAdapter(
        `qr1.inspect_source_page.cancelled_listing.${language}`,
      ),
      text = adapter.evidence[0].text;
    const result = {
      page_kind: "no_open_notices",
      reason_quote: text,
      notices: [],
      follow_link_id: "L3",
      candidate_link_ids: [] as string[],
    };
    await expect(dispatchControlled(adapter, result)).resolves.toMatchObject(
      result,
    );
    result.candidate_link_ids = ["L3"];
    // This is the actual existing dispatch-only restriction, not a copied rule.
    expect(() =>
      validateModelResult(
        adapter.task,
        result,
        adapter.evidence,
        adapter.required,
      ),
    ).not.toThrow();
    await expect(dispatchControlled(adapter, result)).rejects.toThrow();
  },
);
it("actual connection probe validates protocol alone", async () => {
  const adapter = await buildReserveAdapter(
    "qr1.connection_probe.transport_identity.en",
  );
  await expect(
    dispatchControlled(adapter, { status: "ready" }),
  ).resolves.toEqual({ status: "ready" });
  await expect(
    dispatchControlled(adapter, { status: "approved" }),
  ).rejects.toThrow();
});

it("uses the canonical review target shape before taskInput projection", async () => {
  const adapter = await buildReserveAdapter(
    "qr1.summarize_review.advisory_note.en",
  );
  const input = {
    client_id: adapter.required[0],
    target_kind: adapter.context.target_kind,
    target_id: adapter.context.target_id,
    body: adapter.evidence[0].text,
  };
  expect(
    commandSchemas["review.save"].shape.inputs.element.safeParse(input).success,
  ).toBe(true);
  expect(input).toMatchObject({ target_kind: "general", target_id: "general" });
});
