import { modelLedger } from "./modelLedger.ts";
import {
  type Evidence,
  type Reference,
  type ModelTask,
  ModelError,
  executeModel,
  ModelDeferred,
  fitScore,
  sha256,
  validateModelResult,
  exactExclusion,
} from "./model.ts";
import { Backend, type BackendEnvironment } from "./backend.ts";
type Row = Record<string, any>;
type PlanContext = { plan: Row; step: Row; steps: Row[]; requirements: Row[] };
const chunk = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
const unique = <T>(items: T[]) => Array.from(new Set(items));
const words = (text: string) =>
  unique(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function snippet(source: Row, terms: string[], limit = 2000): Row {
  const lower = source.text.toLowerCase(),
    first =
      terms
        .map((t) => lower.indexOf(t))
        .filter((x) => x >= 0)
        .sort((a, b) => a - b)[0] ?? 0,
    start = Math.max(0, first - 200);
  return { ...source, text: source.text.slice(start, start + limit) };
}
function relevant(sources: Row[], query: string, max = 6) {
  const terms = words(query);
  return sources
    .map((s) => ({
      s,
      score: terms.reduce(
        (n, t) => n + (s.text.toLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
    .slice(0, max)
    .map(({ s }) => snippet(s, terms));
}
const allEvidence = (ctx: PlanContext): Row[] => {
  const frozen = ctx.plan.frozen_context;
  return [
    frozen.notice,
    ...frozen.blocks,
    ...frozen.knowledge,
    ...frozen.reviews,
    ...(frozen.rates || []),
  ];
};
function refsFor(
  source: Row[],
  ids: string[],
  requirements: Row[] = [],
): Row[] {
  const required = unique([
    ...ids,
    ...requirements.flatMap((r) => (r.source_refs || []).map((x: Row) => x.id)),
  ]);
  return source
    .filter((s) => required.includes(s.id))
    .map((s) => {
      const quotes = requirements.flatMap((r) =>
        (r.source_refs || [])
          .filter((q: Row) => q.id === s.id)
          .map((q: Row) => q.quote),
      );
      if (!quotes.length) return s;
      const excerpts = unique(quotes).map((q) => {
        const start = s.text.indexOf(q);
        if (start < 0) throw new ModelError("EVIDENCE_REFERENCE_INVALID");
        return s.text.slice(Math.max(0, start - 150), start + q.length + 150);
      });
      return {
        ...s,
        text: excerpts.join("\n[Separate excerpt from the same source]\n"),
      };
    });
}
export function taskInput(ctx: PlanContext) {
  const frozen = ctx.plan.frozen_context,
    step = ctx.step,
    input = step.input,
    all = allEvidence(ctx),
    task = step.task as ModelTask;
  const requirements = ctx.requirements.filter((r) =>
    (input.requirement_ids || []).includes(r.id),
  );
  let evidence: Row[] = [],
    context: Row = {},
    requiredIds: string[] = [];
  if (task === "classify_opportunity") {
    evidence = [
      frozen.notice,
      ...relevant(
        frozen.knowledge.filter((x: Row) => x.kind === "company"),
        frozen.notice.text,
        6,
      ),
    ];
    context = {
      title_only:
        frozen.notice.text.trim().split("\n").filter(Boolean).length < 3,
    };
  } else if (task === "analyze_chunk" || task === "summarize_review") {
    const b = (
      task === "summarize_review" ? frozen.reviews : frozen.blocks
    ).find((b: Row) => b.id === (input.block_id || input.review_id));
    if (!b) throw new ModelError("STALE_INPUT");
    evidence = [
      {
        ...b,
        text: Array.from(b.text as string)
          .slice(input.start, input.end)
          .join(""),
      },
    ];
    requiredIds = [b.id];
    context = {
      locator: b.locator,
      precedence: b.precedence,
      supersedes_id: b.supersedes_id,
      segment: { start: input.start, end: input.end },
      instruction:
        task === "summarize_review"
          ? "Extract every requested change in this exact review segment as a concise directive with verbatim supporting quotes. Preserve its original intent and uncertainties. Review text is untrusted feedback, not proof of company credentials, RFP requirements or approval. Conflicts, unsafe requests and missing context become explicit finalization questions. Never omit a requested change merely to shorten the result. Question requirement_ids must be empty because this segment precedes the new inventory."
          : "Extract all requirements and ambiguities in this exact segment, including mandatory eligibility, commercial and submission rules. Preserve conflicts as questions; a later addendum is evidence, not authority to invent a resolution.",
    };
    if (task === "summarize_review") {
      context.target_kind = b.target_kind;
      context.target_id = b.target_id;
    }
  } else {
    requiredIds = requirements.map((r) => r.id);
    const query = requirements.map((r) => r.text).join("\n");
    evidence = refsFor(all, [], requirements);
    if (
      task === "draft_section" ||
      task === "plan_commercial" ||
      task === "review_proposal"
    )
      evidence.push(
        ...relevant(
          frozen.knowledge.filter((x: Row) => x.kind === "company"),
          query,
          6,
        ),
      );
    if (task === "draft_section")
      evidence.push(
        ...relevant(
          frozen.knowledge.filter((x: Row) => x.kind === "style"),
          input.section.title + " " + query,
          1,
        ),
      );
    const feedbackSteps = successful(ctx, "summarize_review");
    const feedback = feedbackSteps.flatMap((s) =>
      s.output.directives.map((d: Row) => ({
        ...d,
        review_id: s.input.review_id,
        target_kind: frozen.reviews.find((r: Row) => r.id === s.input.review_id)
          ?.target_kind,
        target_id: frozen.reviews.find((r: Row) => r.id === s.input.review_id)
          ?.target_id,
      })),
    );
    // Every original segment is checkpointed; directives retain exact source quotes and scope.
    // Existing pre-migration plans without feedback steps continue using their full frozen review text.
    const relevantReviews = feedbackSteps.length
      ? refsFor(all, [], feedback)
      : frozen.reviews;
    evidence.push(...relevantReviews);
    context = {
      requirements: requirements.map(
        ({
          id,
          text,
          category,
          mandatory,
          interpretation,
          acceptance_evidence,
          owner_question,
        }) => ({
          id,
          text,
          category,
          mandatory,
          interpretation,
          acceptance_evidence,
          owner_question,
        }),
      ),
      section: input.section || null,
      template: {
        id: frozen.template.id,
        required_sections: frozen.template.required_sections || [],
      },
      review_notes: relevantReviews.map((r: Row) => ({
        id: r.id,
        target_kind: r.target_kind,
        target_id: r.target_id,
      })),
      review_directives: feedback,
      instruction:
        "Use the required IDs exactly. Every proposed approach must distinguish verified facts from assumptions. Ask an explicit question for each missing input. Historical proposals are style references only.",
    };
    if (task === "plan_proposal")
      context.instruction =
        "Map these requirements to relevant provided template section keys. Include only keys that address this batch; empty required template sections will be retained by the application. Add a new key only for an RFP-specific form or structure. Do not invent fixed legal clauses or approvals. Map every requirement to a section or blocking question. Use financial volume for pricing and commercial responses.";
    if (task === "plan_commercial") {
      const sections = draftedSections(ctx);
      // Section scope remains derived from the RFP even when no explicit
      // commercial requirement or approved rate was supplied.
      const scopeIds = sections.flatMap((s) => s.requirement_ids);
      evidence.push(
        ...refsFor(
          all,
          sections.flatMap((s) =>
            (s.evidence_refs || []).map((r: Row) => r.id),
          ),
          ctx.requirements.filter((r) => scopeIds.includes(r.id)),
        ),
      );
      context.section_titles = sections.map((s) => ({
        key: s.key,
        title: s.title,
        volume: s.volume,
      }));
      evidence.push(...relevant(frozen.rates || [], query, 6));
      context.instruction =
        "Propose an auditable effort/rate breakdown and delivery dependency graph. Use only supplied verified rate IDs. Missing quantity, rate, period, tax or resource availability remains null and a finalization question. Do not calculate totals or infer availability.";
    }
    if (task === "review_proposal") {
      const sections = draftedSections(ctx).filter((s) =>
        s.requirement_ids.some((id: string) => requiredIds.includes(id)),
      );
      context.sections = sections.map((s) => ({
        key: s.key,
        title: s.title,
        volume: s.volume,
        content_blocks: s.content_blocks,
        assumptions: s.assumptions,
      }));
      const claimIds = sections.flatMap((s) =>
        (s.evidence_refs || []).map((r: Row) => r.id),
      );
      evidence.push(...refsFor(all, claimIds));
      context.instruction =
        "Audit each required requirement ID against the actual supplied sections. Check unsupported company claims, contradictions, placeholders, missing acceptance evidence, scope/price mismatch and unrealistic delivery. Never approve not-applicable status. Every mandatory requirement must have a coverage record, even when missing.";
    }
  }
  evidence = Array.from(new Map(evidence.map((e) => [e.id, e])).values());
  // All evidence actually in the prompt and provenance of generated paragraphs stay gated.
  const manifest = Array.from(
    new Map(
      evidence.map((e) => [
        e.reference.entity_kind + e.reference.entity_id,
        e.reference,
      ]),
    ).values(),
  ) as Reference[];
  return {
    task,
    context,
    evidence: evidence as Evidence[],
    requiredIds,
    manifest,
  };
}
async function stableId(planId: string, value: string) {
  const hash = await sha256(planId + "\n" + value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function successful(ctx: PlanContext, task: ModelTask) {
  return ctx.steps
    .filter((s) => s.task === task && s.status === "completed")
    .map((s) => ({ input: s.input, output: s.output, ordinal: s.ordinal }));
}
export function plannedSections(ctx: PlanContext): Row[] {
  const required: Row[] =
      ctx.plan.frozen_context.template.required_sections || [],
    sections = new Map<string, Row>();
  for (const section of required.filter((s) => s.applicable))
    sections.set(section.key, { ...section, requirement_ids: [] });
  for (const step of successful(ctx, "plan_proposal"))
    for (const section of step.output.sections) {
      if (required.some((s) => s.key === section.key && !s.applicable))
        throw new ModelError("TEMPLATE_APPLICABILITY_CONFLICT");
      const existing = sections.get(section.key);
      sections.set(
        section.key,
        existing
          ? {
              ...existing,
              requirement_ids: unique([
                ...existing.requirement_ids,
                ...section.requirement_ids,
              ]),
            }
          : { ...section },
      );
    }
  return [...sections.values()];
}
export function draftedSections(ctx: PlanContext): Row[] {
  return successful(ctx, "draft_section").map((s) => ({
    ...s.output,
    key: s.input.section.key,
    title: s.input.section.title,
    volume: s.input.section.volume,
    ordinal: s.ordinal,
  }));
}
export function splitStep(ctx: PlanContext): Row[] | null {
  const input = ctx.step.input;
  if (ctx.step.depth >= 8) return null;
  if (
    ctx.step.task === "analyze_chunk" ||
    ctx.step.task === "summarize_review"
  ) {
    const size = input.end - input.start;
    if (size < 800) return null;
    const mid = input.start + Math.floor(size / 2);
    return [
      { ...input, end: Math.min(input.end, mid + 100) },
      { ...input, start: Math.max(input.start, mid - 100) },
    ];
  }
  const ids = input.requirement_ids as string[] | undefined;
  if (!ids || ids.length < 2) return null;
  const mid = Math.ceil(ids.length / 2);
  return [ids.slice(0, mid), ids.slice(mid)].map((requirement_ids, i) => ({
    ...input,
    requirement_ids,
    ...(input.section
      ? {
          section: {
            ...input.section,
            key: input.section.key + `-part${i + 1}`,
            requirement_ids,
          },
        }
      : {}),
  }));
}
export async function nextStage(ctx: PlanContext): Promise<{
  next_stage: string;
  requirements: Row[];
  steps: Row[];
  final_result: Row | null;
}> {
  const stage = ctx.plan.stage,
    frozen = ctx.plan.frozen_context,
    output = {
      next_stage: "",
      requirements: [] as Row[],
      steps: [] as Row[],
      final_result: null as Row | null,
    };
  if (stage === "assessment") {
    const result = successful(ctx, "classify_opportunity")[0]?.output;
    if (!result) throw new ModelError("STAGE_INCOMPLETE");
    const annotatedResult = {
      ...result,
      metadata: {
        model_identity: ctx.plan.model_identity || null,
        prompt_version: "tenderdesk-v3",
        rules_version: "fit-50-25-15-10-v1",
        profile_hash: await sha256(JSON.stringify(frozen.knowledge)),
        input_hash: ctx.plan.input_hash,
        deterministic_exclusion: !!result.rule_exclusion,
      },
    };
    output.next_stage = "completed";
    output.final_result = result.rule_exclusion
      ? {
          fit_score: null,
          evidence_coverage: 0,
          routing: "excluded",
          result: annotatedResult,
        }
      : {
          ...fitScore(
            result,
            frozen.notice.text.trim().split("\n").filter(Boolean).length < 3,
          ),
          result: annotatedResult,
        };
    return output;
  }
  if (stage === "analysis") {
    const byIdentity = new Map<string, Row>();
    for (const s of successful(ctx, "analyze_chunk"))
      for (const r of s.output.requirements) {
        const identity =
          r.text.normalize("NFKC").trim().replace(/\s+/g, " ") +
          "\n" +
          JSON.stringify(
            [...r.source_refs].sort(
              (a, b) =>
                a.id.localeCompare(b.id) || a.quote.localeCompare(b.quote),
            ),
          );
        if (!byIdentity.has(identity))
          byIdentity.set(identity, {
            ...r,
            id: await stableId(ctx.plan.id, identity),
          });
      }
    output.requirements = [...byIdentity.values()];
    output.next_stage = "planning";
    output.steps = chunk(output.requirements, 12).map((rs) => ({
      task: "plan_proposal",
      input: { requirement_ids: rs.map((r) => r.id) },
    }));
    if (!output.steps.length)
      output.steps = [
        { task: "plan_proposal", input: { requirement_ids: [] } },
      ];
    return output;
  }
  if (stage === "planning") {
    const sections = plannedSections(ctx);
    output.next_stage = "drafting";
    output.steps = sections.flatMap((section) => {
      const groups = chunk(section.requirement_ids as string[], 8);
      return (groups.length ? groups : [[]]).map((ids, i) => ({
        task: "draft_section",
        input: {
          section: {
            ...section,
            key:
              groups.length > 1 ? section.key + `-part${i + 1}` : section.key,
            requirement_ids: ids,
          },
          requirement_ids: ids,
        },
      }));
    });
    return output;
  }
  if (stage === "drafting") {
    output.next_stage = "commercial";
    const requirements = ctx.requirements.filter((r) =>
      ["commercial", "deliverables", "team", "timeline"].includes(r.category),
    );
    const groups = chunk(requirements, 12);
    output.steps = (groups.length ? groups : [[]]).map((rs) => ({
      task: "plan_commercial",
      input: { requirement_ids: rs.map((r) => r.id) },
    }));
    return output;
  }
  if (stage === "commercial") {
    output.next_stage = "review";
    output.steps = chunk(ctx.requirements, 5).map((rs) => ({
      task: "review_proposal",
      input: { requirement_ids: rs.map((r) => r.id) },
    }));
    return output;
  }
  if (stage !== "review") throw new ModelError("INVALID_STAGE");
  const drafts = draftedSections(ctx),
    questions: Row[] = [];
  for (const s of ctx.steps.filter(
    (s) => s.status === "completed" && s.output?.questions,
  ))
    for (const q of s.output.questions)
      questions.push({ ...q, section_key: s.input.section?.key || null });
  const review = successful(ctx, "review_proposal").map((s) => s.output),
    responses = review.flatMap((r) => r.responses);
  if (
    ctx.requirements.some(
      (r) => !responses.some((x: Row) => x.requirement_id === r.id),
    )
  )
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  for (const r of ctx.requirements) {
    const response = responses.find((x: Row) => x.requirement_id === r.id);
    if (r.mandatory && response?.status !== "answered")
      questions.push({
        question: `[INPUT REQUIRED: ${r.text}]`,
        blocking_level: "finalization",
        reason: response?.rationale || "Mandatory coverage is unresolved.",
      });
  }
  for (const s of drafts) {
    for (const assumption of s.assumptions)
      questions.push({
        question: `Confirm assumption: ${assumption}`,
        blocking_level: "finalization",
        section_key: s.key,
      });
  }
  const commercial = successful(ctx, "plan_commercial").map((s) => s.output);
  if (!frozen.knowledge.some((x: Row) => x.kind === "company" && x.verified))
    questions.push({
      question: "[INPUT REQUIRED: Verify company capabilities and evidence.]",
      blocking_level: "finalization",
    });
  if (ctx.requirements.length === 0)
    questions.push({
      question:
        "[INPUT REQUIRED: Confirm the complete requirement inventory; none could be extracted.]",
      blocking_level: "finalization",
    });
  const separate =
    frozen.template.volume_mode === "separate" ||
    successful(ctx, "analyze_chunk").some((s) => s.output.separate_volumes);
  const sections: Row[] = drafts.map((s) => ({
    ...s,
    body: s.content_blocks
      .map((b: Row) =>
        b.type === "table"
          ? [b.headers, ...b.rows]
              .map((r: string[]) => r.join(" | "))
              .join("\n")
          : b.type === "bullet"
            ? `• ${b.text}`
            : b.text,
      )
      .join("\n\n"),
  }));
  for (const fixed of frozen.template.fixed_blocks || [])
    sections.push({
      key: "fixed-" + fixed.key,
      title: fixed.title,
      volume: fixed.volume,
      body: fixed.body,
      content_blocks: [{ type: "paragraph", text: fixed.body }],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
      fixed: true,
    });
  if (separate)
    for (const s of sections)
      if (
        s.volume !== "financial" &&
        /(?:\b(?:SAR|USD|AED|EUR)\s*[\d.,]+|[\d.,]+\s*(?:ريال|دولار))/i.test(
          s.body,
        )
      )
        questions.push({
          question:
            "[INPUT REQUIRED: Remove monetary pricing from the technical volume.]",
          blocking_level: "finalization",
          section_key: s.key,
        });
  for (const s of sections)
    if (s.body.includes("[INPUT REQUIRED"))
      questions.push({
        question: `Resolve the missing-input markers in ${s.title}.`,
        blocking_level: "finalization",
        section_key: s.key,
      });
  for (const finding of review
    .flatMap((r) => r.findings)
    .filter((f: Row) => f.severity === "blocking"))
    questions.push({
      question: finding.detail,
      blocking_level: "finalization",
      section_key: finding.section_ids?.[0] || null,
    });
  output.next_stage = "completed";
  output.final_result = {
    sections,
    questions: Array.from(
      new Map(
        questions.map((q) => [q.question + "|" + q.section_key, q]),
      ).values(),
    ),
    review: { responses, findings: review.flatMap((r) => r.findings) },
    commercial: {
      lines: commercial.flatMap((c) => c.lines),
      tasks: commercial.flatMap((c) => c.tasks),
      confirmed: false,
    },
    separate_volumes: separate,
  };
  return output;
}
export async function processGeneration(
  backend: Backend,
  env: BackendEnvironment,
  job: Row,
  fetcher: typeof fetch,
) {
  let ctx: PlanContext | undefined;
  try {
    ctx = await backend.internal("generation_context", {
      job_id: job.id,
      lease: job.lease_token,
    });
    if (!ctx) throw new ModelError("GENERATION_NOT_ACTIVE");
    if (ctx.step.task === "advance_plan") {
      const next = await nextStage(ctx);
      await backend.internal("advance_generation", {
        job_id: job.id,
        lease: job.lease_token,
        ...next,
      });
      return;
    }
    const input = taskInput(ctx);
    if (input.task === "classify_opportunity") {
      const match = exactExclusion(
        ctx.plan.frozen_context.notice.text,
        ctx.plan.frozen_context.knowledge
          .filter((x: Row) => x.category === "exclusion")
          .map((x: Row) => ({
            ...x,
            text: x.text.slice(x.text.indexOf("\n") + 1),
          })),
      );
      if (match) {
        await backend.internal("complete_generation_step", {
          job_id: job.id,
          lease: job.lease_token,
          result: {
            rule_exclusion: match,
            reason_summary:
              "An exact verified exclusion phrase matches the notice.",
            missing_information: [],
            risk_flags: [],
          },
        });
        return;
      }
    }
    const ledger = modelLedger(
      backend,
      { id: job.id, lease_token: job.lease_token, attempts: job.attempts },
      `step:${ctx.step.id}`,
    );
    const result = await executeModel(
      input.task,
      input.context,
      input.evidence,
      input.requiredIds,
      input.manifest,
      env.models,
      ledger,
      ctx.plan.frozen_context.language,
      ctx.step.repair_count === 1,
      fetcher,
    );
    // Revalidate quotations against whole immutable source blocks; excerpt separators cannot become fabricated quotes.
    validateModelResult(
      input.task,
      result,
      allEvidence(ctx) as Evidence[],
      input.requiredIds,
    );
    if (
      input.task === "draft_section" &&
      result.key !== ctx.step.input.section.key
    )
      throw new ModelError("MODEL_OUTPUT_INVALID");
    if (input.task === "review_proposal") {
      const sectionKeys = new Set(
        (input.context.sections || []).map((s: Row) => s.key),
      );
      if (
        result.responses.some((r: Row) =>
          r.section_ids.some((key: string) => !sectionKeys.has(key)),
        ) ||
        result.findings.some((f: Row) =>
          f.section_ids.some((key: string) => !sectionKeys.has(key)),
        )
      )
        throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    }
    if (input.task === "plan_commercial") {
      const sectionKeys = new Set(
        (input.context.section_titles || []).map((s: Row) => s.key),
      );
      const rateIds = new Set(
        input.evidence.filter((e) => e.kind === "rate").map((e) => e.id),
      );
      if (
        result.lines.some(
          (l: Row) =>
            l.section_ids.some((key: string) => !sectionKeys.has(key)) ||
            l.requirement_ids.some(
              (id: string) => !input.requiredIds.includes(id),
            ) ||
            (l.rate_id && !rateIds.has(l.rate_id)),
        )
      )
        throw new ModelError("EVIDENCE_REFERENCE_INVALID");
    }
    await backend.internal("complete_generation_step", {
      job_id: job.id,
      lease: job.lease_token,
      result,
    });
    await ledger
      .cleanup?.()
      .catch(() => console.warn("provider_request_cleanup_pending"));
  } catch (error) {
    if (error instanceof ModelDeferred) return;
    let error_code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "GENERATION_HANDLER_FAILED";
    const splitting =
      ctx &&
      ["MODEL_CONTEXT_TOO_LARGE", "MODEL_OUTPUT_TRUNCATED"].includes(
        error_code,
      );
    const split_inputs = splitting ? splitStep(ctx!) : null;
    if (splitting && !split_inputs) error_code = "MANUAL_REDUCTION_REQUIRED";
    await backend.internal("fail_generation", {
      job_id: job.id,
      lease: job.lease_token,
      error_code,
      retry_after: error instanceof ModelError ? error.retryAfter : null,
      split_inputs,
    });
  }
}
