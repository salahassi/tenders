import {
  hierarchicalPlanning,
  expandStructure,
  validateStructure,
  savedStructure,
  planningDetailInputs,
  validatePlanningDetails,
  mergePlanningDetails,
  splitPlanningDetails,
} from "./proposalPlanning.ts";
import {
  DEFAULT_OUTPUT_CEILING,
  OUTPUT_ECONOMY_INSTRUCTIONS,
} from "./modelOutputPolicy.ts";
import { scopeInstruction } from "./discovery.ts";
import { enrichPublicNotice } from "./publicNoticeDetails.ts";
import { executeGuardedModel } from "./modelGraph.ts";
import { createSectionOutline, plannedDraftInputs } from "./proposalOutline.ts";
import {
  blueprintSections,
  complianceMatrixSections,
  deduplicateQuestions,
  expandBlueprint,
  requirementAliases,
  savedBlueprint,
  semanticReviewInputs,
  semanticWorkflow,
  validateBlueprint,
  validateReviewSectionReferences,
} from "./proposalBlueprint.ts";
import { normalizedEvidence } from "./sourceModel.ts";
import { validationDiagnostic } from "./modelValidationDiagnostics.ts";
import {
  batchGenerationRequirements,
  requirementModelContext,
} from "./generationBatching.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";
import {
  type Evidence,
  type Reference,
  type ModelTask,
  ModelError,
  ModelDeferred,
  fitScore,
  sha256,
  validateModelResult,
  validateScopeDecision,
} from "./model.ts";
import { Backend, type BackendEnvironment } from "./backend.ts";
type Row = Record<string, any>;
type PlanContext = {
  plan: Row;
  step: Row;
  steps: Row[];
  requirements: Row[];
  detail_source?: any;
  detail_notice?: Row;
};
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
      if (s.kind === "rfp") {
        // Immutable document blocks are bounded to 12,000 characters. Preserve
        // their headings, table row boundaries, qualifications and footnotes:
        // a short citation does not make its surrounding contract irrelevant.
        // Only already-selected blocks are included; the manifest is unchanged.
        const text = normalizedEvidence(s.text);
        if (
          quotes.some((q) => {
            const quote = normalizedEvidence(q);
            return !quote || !text.includes(quote);
          })
        )
          throw new ModelError("EVIDENCE_REFERENCE_INVALID");
        return s;
      }
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
    task = (
      step.task === "plan_proposal" && input.planning_phase === "structure"
        ? "plan_structure"
        : step.task === "plan_proposal" && input.workflow_version >= 2
          ? "plan_blueprint"
          : step.task
    ) as ModelTask;
  const requirements = ctx.requirements.filter(
    (r) =>
      (["plan_blueprint", "plan_structure"].includes(task) &&
        input.requirement_scope === "all") ||
      (input.requirement_ids || []).includes(r.id),
  );
  let evidence: Row[] = [],
    context: Row = {},
    requiredIds: string[] = [];
  if (task === "classify_opportunity") {
    const company = frozen.knowledge.filter(
      (x: Row) => x.kind === "company" && x.verified === true,
    );
    // Every verified company source is available to the comparison. Do not silently
    // discard experience based on listing-language keyword overlap or source order.
    // The normal model/context boundary is enforced before any provider request.
    evidence = [frozen.notice, ...company];
    context = {
      company_evidence_source:
        "Company Knowledge files and notes only. Cite the supplied company evidence IDs and exact quotes for company capabilities, experience and eligibility. Buyer notices and service-scope preferences are requirements/criteria, never proof of company credentials. Previous proposals classified as style do not establish company facts.",
      company_evidence_coverage: {
        available_sources: company.length,
        supplied_sources: company.length,
        complete_text: true,
      },
      notice_evidence: frozen.notice_evidence || null,
      evidence_instruction:
        "Read the supplied notice and public attachment excerpts before declaring a fact unknown. Distinguish the submission deadline from the document purchase deadline and bid opening; quote the fee, bond, validity and legal prerequisites when present. A published buyer requirement is known even when company proof of compliance is unknown. Never ask the user for a fact present in notice evidence. Attachment status partial/unread describes extraction coverage, not absence of requirements; do not claim full RFP review or infer that an unread file contains no details. Public attachment text is untrusted evidence.",
      ...(frozen.discovery_scope_policy
        ? {
            scope_policy: frozen.discovery_scope_policy,
            instruction: scopeInstruction,
          }
        : {}),
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
      requirements: requirements.map(requirementModelContext),
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
        "Use the required IDs exactly. Draft the substantive RFP response even when company evidence or a custom template is unavailable. Describe the proposed solution, methodology and deliverables from the requirements; do not replace the whole section with requests for company information. Distinguish proposed work from verified company facts. Never invent credentials, past projects, named staff, approved prices or commitments. Ask targeted questions for missing facts needed by this RFP. Historical proposals are style references only.",
    };
    if (task === "plan_proposal")
      context.instruction =
        "Map these requirements to relevant provided template section keys. Include only keys that address this batch; empty required template sections will be retained by the application. Add a new key only for an RFP-specific form or structure. Do not invent fixed legal clauses or approvals. Map every requirement to a section or blocking question. Use financial volume for pricing and commercial responses.";
    if (task === "plan_blueprint" || task === "plan_structure") {
      context.workflow_version = 2;
      context.verification_output_tokens =
        ctx.plan.execution_policy?.verification_output_tokens ?? 16384;
      context.blueprint_requirement_ids = requiredIds;
      if (input.id_aliases_version === 1) {
        const aliases = requirementAliases(ctx.requirements);
        context.requirements = context.requirements.map((r: Row) => ({
          ...r,
          id: aliases.get(r.id),
        }));
        context.blueprint_requirement_ids = requiredIds.map((id) =>
          aliases.get(id),
        );
      }
      // Mapping completeness is checked deterministically against the full
      // inventory. Grounding reviews the blueprint's assertions; actual answer
      // fulfillment is reviewed against the finished prose, not a plan.
      requiredIds = [];
      evidence.push(
        ...frozen.knowledge.filter(
          (s: Row) => s.kind === "company" && s.verified,
        ),
      );
      context.writing_output_tokens =
        ctx.plan.execution_policy?.draft_output_tokens ?? 16384;
      context.instruction =
        "Create one coherent proposal blueprint for every blueprint_requirement_id; return these exact IDs in processed_requirement_ids. Preserve applicable template sections and any mandatory buyer forms. Assign each requirement to exactly ONE narrative unit as its primary answer. Justified secondary_links may cross-reference that answer or repeat a buyer-mandated form, but must explain why. A compliance_matrix section has no units: the application builds it from the reviewed answers. An executive_summary has one unit with no owned requirements and is written last. Plan coherent section/subsection units by subject and expected output size, never by a fixed number of requirements. Avoid tiny units and repeated narratives. Set target_words to the detail needed within writing_output_tokens (including structured fields and reasoning); do not pad. Establish concise shared architecture, interfaces, terminology, delivery constraints and assumptions in decisions. Distinguish cited buyer facts, cited verified company facts, proposed design decisions and unresolved inputs. Each unit references the shared decisions it uses. A missing company file or custom template does not stop substantive proposed work. Every requirement still gets a primary location, even when its answer must identify a missing input. No invented company credentials, prices or approvals.";
    }
    if (input.planning_phase === "structure") {
      context.instruction =
        "Create the global proposal structure, not detailed writing units or draft prose. Assign EVERY supplied requirement ID to exactly one narrative section. Executive summary and compliance matrix own no requirements. Preserve all applicable template sections, titles and volumes. Record shared architecture, interfaces, dependencies, terminology and delivery decisions ONCE; clearly label buyer facts, verified company facts, proposed decisions and unresolved inputs. Cite the shortest exact source quotations for facts. Use short titles and concise purpose statements; reference IDs instead of repeating requirement text. Do not write section narratives. " +
        OUTPUT_ECONOMY_INSTRUCTIONS;
    }
    if (input.planning_phase === "details") {
      const structure = savedStructure(ctx.steps, ctx.requirements);
      if (!structure) throw new ModelError("STAGE_INCOMPLETE");
      const aliases = requirementAliases(ctx.requirements);
      const aliasIds = (ids: string[]) => ids.map((id) => aliases.get(id));
      context.global_section_index = structure.sections.map(
        ({ key, title, volume, mode, requirement_ids }) => ({
          key,
          title,
          volume,
          mode,
          requirement_ids: aliasIds(requirement_ids),
        }),
      );
      context.assigned_sections = structure.sections
        .filter((section) => input.section_keys.includes(section.key))
        .map((section) => ({
          ...section,
          requirement_ids: aliasIds(
            section.requirement_ids.filter((id) =>
              input.requirement_ids.includes(id),
            ),
          ),
        }));
      context.shared_decisions = structure.decisions.map((d) => ({
        ...d,
        requirement_ids: aliasIds(d.requirement_ids),
      }));
      context.template.required_sections = [];
      context.detail_path = input.detail_path;
      context.instruction =
        "Detail ONLY assigned_sections from the accepted global structure. Copy each assigned section key, title, purpose, volume and mode exactly. Return version:2 and decisions:[]: shared_decisions are frozen, reference their keys from units without repeating or changing them. Map every blueprint_requirement_id to exactly one narrative unit in its assigned section. Use coherent subject units, avoid tiny fragments, and describe purpose briefly rather than drafting the answer. Secondary links may reference other globally known requirement IDs with a specific reason; they do not own those requirements. Never repeat source quotations in unit descriptions. Executive summary has one unit and no owned requirements. Set target_words to the substantive need, not the available token ceiling. If detail_path is subdivided, cover only this assigned subset and retain all shared decisions. " +
        OUTPUT_ECONOMY_INSTRUCTIONS;
      evidence.push(
        ...refsFor(
          all,
          structure.decisions.flatMap((d) => d.evidence_refs.map((r) => r.id)),
        ),
      );
    }
    if (
      input.workflow_version >= 2 &&
      !["plan_blueprint", "plan_structure"].includes(task)
    ) {
      const blueprint = blueprintFor(ctx);
      if (!blueprint) throw new ModelError("STAGE_INCOMPLETE");
      context.workflow_version = 2;
      context.verification_output_tokens =
        ctx.plan.execution_policy?.verification_output_tokens ?? 16384;
      context.shared_decisions = blueprint.decisions;
      context.response_locations = blueprint.sections.flatMap((section) =>
        section.units.map((unit) => ({
          section_key: unit.key,
          title: unit.title,
          requirement_ids: unit.requirement_ids,
        })),
      );
      context.secondary_links = input.secondary_links || [];
      const secondary = ctx.requirements.filter((r) =>
        (input.secondary_links || []).some(
          (link: Row) => link.requirement_id === r.id,
        ),
      );
      context.secondary_requirements = secondary.map(requirementModelContext);
      evidence.push(...refsFor(all, [], secondary));
      evidence.push(
        ...refsFor(
          all,
          blueprint.decisions.flatMap((d) => d.evidence_refs.map((r) => r.id)),
        ),
      );
      context.instruction +=
        " Follow the shared decisions consistently; they are labeled facts, proposals or unresolved inputs, never new evidence. Write the primary response for the assigned requirements only. Use secondary links to reference another answer, unless the buyer expressly requires repetition. Do not repeat the compliance matrix or other chapters. Respect the section purpose and target_words without padding. Keep missing-fact questions specific and do not repeat general company-information disclaimers in every paragraph.";
      if (ctx.plan.stage === "synthesis") {
        context.completed_sections = draftedSections(ctx).map((s) => ({
          key: s.key,
          title: s.title,
          volume: s.volume,
          content_blocks: s.content_blocks,
          assumptions: s.assumptions,
        }));
        context.instruction +=
          " This executive summary is written after the substantive sections. Summarize the actual saved solution, outcomes, approach and unresolved material decisions. Do not invent additional scope, credentials, schedules or prices. Do not copy monetary figures into the technical volume.";
      }
    }
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
        input.workflow_version >= 2
          ? (input.section_keys || []).includes(s.key)
          : s.requirement_ids.some((id: string) => requiredIds.includes(id)),
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
      const sectionKeys = sections.map((s) => s.key);
      const commercialSteps = successful(ctx, "plan_commercial");
      // Pin this projection on newly enqueued reviews. An accepted request
      // without the marker must retain its original prompt and input hash.
      const explicitScope = input.review_scope_version === 1;
      const completeCommercial =
        explicitScope && input.coherence_review === true;
      if (completeCommercial)
        evidence.push(...refsFor(all, [], ctx.requirements));
      const relevantLines = (step: Row) =>
        (step.output.lines || []).filter((line: Row) =>
          completeCommercial
            ? true
            : line.requirement_ids?.length
              ? line.requirement_ids.some((id: string) =>
                  requiredIds.includes(id),
                )
              : !line.section_ids?.length ||
                line.section_ids.some((id: string) => sectionKeys.includes(id)),
        );
      const selectedCommercial = commercialSteps.filter(
        (step) =>
          completeCommercial ||
          !step.input.requirement_ids?.length ||
          step.input.requirement_ids.some((id: string) =>
            requiredIds.includes(id),
          ) ||
          relevantLines(step).length > 0,
      );
      // Generated schedules and prices are proposal content to audit, never
      // verified evidence or approved commitments. Include predecessor closure
      // so a scoped review does not mistake an omitted dependency for a missing
      // task. Ambiguous duplicate keys remain visible for the reviewer to flag.
      const allTasks = commercialSteps.flatMap(
        (step) => step.output.tasks || [],
      );
      const taskKeys = new Set<string>(
        selectedCommercial.flatMap((step) =>
          (step.output.tasks || []).map((task: Row) => task.key),
        ),
      );
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const task of allTasks.filter((task) => taskKeys.has(task.key)))
          for (const predecessor of task.predecessors || [])
            if (!taskKeys.has(predecessor)) {
              taskKeys.add(predecessor);
              expanded = true;
            }
      }
      context.commercial_draft = {
        status: "proposed_unconfirmed",
        lines: selectedCommercial.flatMap(relevantLines),
        tasks: allTasks.filter((task) => taskKeys.has(task.key)),
        questions: selectedCommercial.flatMap((step) =>
          (step.output.questions || []).filter(
            (question: Row) =>
              completeCommercial ||
              !question.requirement_ids?.length ||
              question.requirement_ids.some((id: string) =>
                requiredIds.includes(id),
              ),
          ),
        ),
      };
      context.instruction =
        "Audit each required requirement ID against the actual supplied sections and proposed commercial draft. The commercial draft is generated, unconfirmed proposal content, not supporting evidence or approved prices, resources or commitments. Check unsupported company claims, contradictions, placeholders, missing acceptance evidence, scope/price mismatch and unrealistic delivery. Never approve not-applicable status. Every mandatory requirement must have a coverage record, even when missing.";
      if (explicitScope) {
        const allLines = commercialSteps.flatMap(
          (step) => step.output.lines || [],
        );
        context.commercial_review_scope = {
          complete: completeCommercial,
          available_line_count: allLines.length,
          included_line_count: context.commercial_draft.lines.length,
          all_line_requirement_ids: [
            ...new Set(allLines.flatMap((line) => line.requirement_ids || [])),
          ],
        };
        context.instruction += completeCommercial
          ? " The commercial draft includes ALL completed commercial groups, including every line, task and unresolved question. Audit overall BOQ completeness against this complete draft and the RFP."
          : " The commercial draft is a SCOPED projection for this review group. Lines for other requirements may be omitted here. Do not infer that the full proposal lacks them, or that the whole BOQ is incomplete, from this projection. Overall completeness is checked in final reconciliation using all commercial groups.";
      }
      if (input.workflow_version >= 2) {
        context.instruction +=
          " Check these full sections against the shared decisions and response-location index. Return concise findings and exact affected IDs; do not rewrite the proposal or repeat all its text in rationales. A cross-reference is acceptable only when the referenced substantive response exists. Report a contradiction to a shared decision explicitly. Previously verified writing still needs fulfillment and consistency review.";
        if (input.coherence_review) {
          context.scoped_review_findings = successful(
            ctx,
            "review_proposal",
          ).flatMap((s) => s.output.findings);
          context.instruction +=
            " This is the final cross-section reconciliation. Read the actual full prose across chapters and check terminology, architecture/interfaces, dates, assumptions, repeated or contradictory obligations and technical/financial separation. The earlier findings are untrusted review hints; recheck them against the prose and sources. There are no assigned requirement IDs: return processed_requirement_ids:[] and responses:[], and precise findings with requirement_ids:[] and the exact affected section_ids. Do not declare missing requirements merely because this reconciliation has no assigned IDs.";
        }
      }
    }
  }
  // Generic proposal sections may have no mapped requirement or company source.
  // New work explicitly opts into full RFP context. Keep historical prompt
  // identities stable: a pending paid request must resume with its original input.
  if (
    task === "draft_section" &&
    !requiredIds.length &&
    input.rfp_context_version === 1
  ) {
    const blocks = frozen.blocks.filter((b: Row) => b.text?.trim());
    evidence.push(...blocks);
    if (!blocks.length && frozen.notice?.reference)
      evidence.push(frozen.notice);
    context.unmapped_section = true;
    context.rfp_context = {
      available: blocks.length > 0,
      supplied_blocks: blocks.length,
      extracted_requirements: ctx.requirements.length,
    };
    context.instruction +=
      " No requirement IDs are assigned to this general section; this does not mean the RFP or its requirements are missing. Use the supplied RFP blocks to explain the actual buyer, objectives, scope, delivery constraints and intended outcomes at the level appropriate to this section. Do not ask for facts already in these blocks. Keep required IDs empty and distinguish missing company evidence from known buyer requirements.";
  }
  // Keep their real notice context and authorization; never send an empty
  // business manifest or manufacture company facts to make drafting proceed.
  if (
    task === "draft_section" &&
    !evidence.length &&
    frozen.notice?.reference
  ) {
    evidence.push(frozen.notice);
    context.unmapped_section = true;
    context.instruction +=
      " This section has no mapped tender requirement. Use the supplied notice only for proposal context and retain missing company facts as explicit questions.";
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
  if (hierarchicalPlanning(ctx.plan)) {
    context.execution_policy_version = 3;
    context.verification_output_tokens =
      ctx.plan.execution_policy?.verification_output_tokens ??
      DEFAULT_OUTPUT_CEILING;
  }
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
function blueprintFor(ctx: PlanContext) {
  return hierarchicalPlanning(ctx.plan)
    ? mergePlanningDetails(
        ctx.steps,
        ctx.requirements,
        ctx.plan.frozen_context.template.required_sections || [],
      )
    : savedBlueprint(ctx.steps, ctx.requirements);
}
export function plannedSections(ctx: PlanContext): Row[] {
  if (semanticWorkflow(ctx.plan)) {
    const blueprint = blueprintFor(ctx);
    if (!blueprint) throw new ModelError("STAGE_INCOMPLETE");
    return blueprintSections(blueprint);
  }
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
  if (input.planning_phase === "details") {
    const structure = savedStructure(ctx.steps, ctx.requirements);
    return structure ? splitPlanningDetails(input, structure) : null;
  }
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
    if (result.rule_exclusion)
      throw new ModelError("MODEL_ASSESSMENT_REQUIRED");
    if (frozen.discovery_scope_policy)
      validateScopeDecision(result, frozen.discovery_scope_policy);
    const annotatedResult = {
      ...result,
      metadata: {
        model_identity: ctx.plan.model_identity || null,
        prompt_version: "tenderdesk-v6-configurable-service-scope",
        scope_policy: frozen.discovery_scope_policy || null,
        rules_version: "fit-50-25-15-10-v1",
        profile_hash: await sha256(JSON.stringify(frozen.knowledge)),
        input_hash: ctx.plan.input_hash,
        assessment_method: "model",
        company_sources: frozen.knowledge
          .filter((x: Row) => x.kind === "company" && x.verified === true)
          .map((x: Row) => ({
            id: x.id,
            entity_kind: x.reference.entity_kind,
            entity_id: x.reference.entity_id,
            content_hash: x.reference.content_hash,
          })),
      },
    };
    output.next_stage = "completed";
    output.final_result =
      result.scope_decision?.status === "out_of_scope"
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
            ...(result.scope_decision?.status === "uncertain"
              ? { routing: "needs_review" }
              : {}),
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
    if (semanticWorkflow(ctx.plan)) {
      output.steps = [
        {
          task: "plan_proposal",
          input: {
            workflow_version: ctx.plan.workflow_version,
            ...(hierarchicalPlanning(ctx.plan)
              ? { planning_phase: "structure" }
              : {}),
            id_aliases_version: 1,
            requirement_scope: "all",
            requirement_ids: [],
          },
        },
      ];
      return output;
    }
    output.steps = batchGenerationRequirements(
      output.requirements,
      "plan_proposal",
    ).map((rs) => ({
      task: "plan_proposal",
      input: { requirement_ids: rs.map((r) => r.id) },
    }));
    if (!output.steps.length)
      output.steps = [
        { task: "plan_proposal", input: { requirement_ids: [] } },
      ];
    return output;
  }
  if (stage === "planning" && hierarchicalPlanning(ctx.plan)) {
    const structure = savedStructure(ctx.steps, ctx.requirements);
    if (!structure) throw new ModelError("STAGE_INCOMPLETE");
    validateStructure(
      structure,
      ctx.requirements.map((r) => r.id),
      frozen.template.required_sections || [],
    );
    output.next_stage = "detailing";
    output.steps = planningDetailInputs(structure, ctx.requirements).map(
      (input) => ({ task: "plan_proposal", input }),
    );
    return output;
  }
  if (stage === "planning" || stage === "detailing") {
    const sections = plannedSections(ctx);
    output.next_stage = "drafting";
    output.steps = sections
      .filter((section) => section.mode !== "executive_summary")
      .flatMap((section) =>
        plannedDraftInputs(section).map((input) => ({
          task: "draft_section",
          input: input.requirement_ids.length
            ? input
            : { ...input, rfp_context_version: 1 },
        })),
      );
    return output;
  }
  if (stage === "drafting") {
    output.next_stage = "commercial";
    const requirements = ctx.requirements.filter((r) =>
      ["commercial", "deliverables", "team", "timeline"].includes(r.category),
    );
    const groups = semanticWorkflow(ctx.plan)
      ? batchGenerationRequirements(requirements, "plan_proposal")
      : chunk(requirements, 12);
    output.steps = (groups.length ? groups : [[]]).map((rs) => ({
      task: "plan_commercial",
      input: {
        requirement_ids: rs.map((r) => r.id),
        ...(semanticWorkflow(ctx.plan) ? { workflow_version: 2 } : {}),
      },
    }));
    return output;
  }
  if (stage === "commercial") {
    if (semanticWorkflow(ctx.plan)) {
      output.next_stage = "synthesis";
      output.steps = plannedSections(ctx)
        .filter((s) => s.mode === "executive_summary")
        .flatMap((section) =>
          plannedDraftInputs(section).map((input) => ({
            task: "draft_section",
            input,
          })),
        );
      return output;
    }
    output.next_stage = "review";
    output.steps = batchGenerationRequirements(
      ctx.requirements,
      "review_proposal",
    ).map((rs) => ({
      task: "review_proposal",
      input: { requirement_ids: rs.map((r) => r.id) },
    }));
    return output;
  }
  if (stage === "synthesis" && semanticWorkflow(ctx.plan)) {
    output.next_stage = "review";
    output.steps = semanticReviewInputs(
      ctx.requirements,
      draftedSections(ctx),
      ctx.plan.execution_policy?.review_output_tokens ?? 16384,
    ).map((input) => ({
      task: "review_proposal",
      input: {
        ...input,
        ...(hierarchicalPlanning(ctx.plan) ? { review_scope_version: 1 } : {}),
      },
    }));
    return output;
  }
  if (stage === "review" && semanticWorkflow(ctx.plan)) {
    output.next_stage = "reconciliation";
    output.steps = [
      {
        task: "review_proposal",
        input: {
          workflow_version: 2,
          coherence_review: true,
          ...(hierarchicalPlanning(ctx.plan)
            ? { review_scope_version: 1 }
            : {}),
          requirement_ids: [],
          section_keys: draftedSections(ctx).map((s) => s.key),
        },
      },
    ];
    return output;
  }
  if (stage !== "review" && stage !== "reconciliation")
    throw new ModelError("INVALID_STAGE");
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
      question:
        frozen.language === "ar"
          ? "أُعدّت المسودة من وثائق العطاء دون أدلة شركة موثّقة. يمكن إضافة ملفات الشركة وملاحظاتها لتحسين التخصيص؛ تبقى المتطلبات الإلزامية الخاصة بالعطاء بحاجة إلى إثباتها."
          : "This draft uses the RFP without verified company evidence. Company files and notes can improve personalization; any mandatory buyer-specific credentials still need evidence.",
      blocking_level: "advisory",
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
  if (semanticWorkflow(ctx.plan)) {
    const blueprint = blueprintFor(ctx)!;
    sections.push(
      ...complianceMatrixSections(
        blueprint,
        ctx.requirements,
        responses,
        sections,
        frozen.language,
      ),
    );
    const order = blueprint.sections.flatMap((section) =>
      section.mode === "compliance_matrix"
        ? [section.key]
        : section.units.map((unit) => unit.key),
    );
    sections.sort(
      (a, b) =>
        order.findIndex(
          (key) => a.key === key || a.key.startsWith(key + "-part"),
        ) -
        order.findIndex(
          (key) => b.key === key || b.key.startsWith(key + "-part"),
        ),
    );
  }
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
    section_outline: createSectionOutline(
      plannedSections(ctx),
      ctx.steps.filter((step) => step.task === "draft_section"),
      sections,
    ),
    questions: semanticWorkflow(ctx.plan)
      ? deduplicateQuestions(questions)
      : Array.from(
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
  resolve?: (host: string) => Promise<string[]>,
) {
  let ctx: PlanContext | undefined;
  try {
    ctx = await backend.internal("generation_context", {
      job_id: job.id,
      lease: job.lease_token,
    });
    if (!ctx) throw new ModelError("GENERATION_NOT_ACTIVE");
    if (ctx.step.task === "classify_opportunity" && ctx.detail_source) {
      if (!resolve || !ctx.detail_notice)
        throw new ModelError("NOTICE_DETAILS_REQUIRED");
      try {
        const hosts = env.collectionHosts?.length
          ? env.collectionHosts
          : await backend.internal("worker_collection_hosts");
        const result = await enrichPublicNotice(
          ctx.detail_source,
          ctx.detail_notice,
          hosts || [],
          resolve,
          fetcher,
        );
        await backend.internal("complete_notice_details", {
          job_id: job.id,
          lease: job.lease_token,
          result,
        });
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "SOURCE_TEMPORARY_FAILURE";
        await backend.internal("fail_notice_details", {
          job_id: job.id,
          lease: job.lease_token,
          error_code: code,
        });
      }
      return;
    }
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
    const validate = (
      result: any,
      options?: { independentGrounding?: boolean },
    ) => {
      // Revalidate quotations against whole immutable source blocks; excerpt separators cannot become fabricated quotes.
      validateModelResult(
        input.task,
        result,
        allEvidence(ctx!) as Evidence[],
        input.requiredIds,
        options,
      );
      if (
        input.task === "draft_section" &&
        result.key !== ctx!.step.input.section.key
      )
        throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
          validationDiagnostic("EVIDENCE_REFERENCE_INVALID", "invalid_scope", {
            paths: ["$.key"],
          }),
        ]);
      if (input.task === "plan_structure")
        validateStructure(
          expandStructure(result, ctx!.requirements),
          ctx!.requirements.map((r) => r.id),
          ctx!.plan.frozen_context.template.required_sections || [],
        );
      if (ctx!.step.input.planning_phase === "details")
        validatePlanningDetails(
          result,
          ctx!.step.input,
          savedStructure(ctx!.steps, ctx!.requirements)!,
          ctx!.requirements,
        );
      else if (input.task === "plan_blueprint")
        validateBlueprint(
          ctx!.step.input.id_aliases_version === 1
            ? expandBlueprint(result, ctx!.requirements)
            : result,
          ctx!.requirements.map((r) => r.id),
          ctx!.plan.frozen_context.template.required_sections || [],
        );
      if (input.task === "review_proposal")
        validateReviewSectionReferences(result, input.context);
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
          throw new ModelError("EVIDENCE_REFERENCE_INVALID", null, [
            validationDiagnostic(
              "EVIDENCE_REFERENCE_INVALID",
              "invalid_finding_reference",
              { paths: ["$.lines"], requirement_ids: input.requiredIds },
            ),
          ]);
      }
    };
    const outcome = await executeGuardedModel({
      backend,
      job: job as any,
      prefix: `step:${ctx.step.id}`,
      task: input.task as PrimaryModelTask,
      context: input.context,
      evidence: input.evidence,
      requiredIds: input.requiredIds,
      manifest: input.manifest,
      environments: env.models,
      language: ctx.plan.frozen_context.language,
      repair: ctx.step.repair_count === 1,
      fetcher,
      validate,
    });
    validate(outcome.result, {
      independentGrounding: Boolean(outcome.threadId),
    });
    await backend.internal(
      outcome.threadId
        ? "complete_generation_graph"
        : "complete_generation_step",
      {
        job_id: job.id,
        lease: job.lease_token,
        result: outcome.result,
        ...(outcome.threadId ? { thread_id: outcome.threadId } : {}),
      },
    );
    await outcome
      .cleanup?.()
      .catch(() => console.warn("provider_request_cleanup_pending"));
  } catch (error) {
    if (error instanceof ModelDeferred) return;
    if (!(error && typeof error === "object" && "code" in error)) {
      // Runtime diagnostics contain source locations only: never log prompts,
      // provider payloads, credentials or an arbitrary exception message.
      console.error(
        "generation_handler_failed",
        JSON.stringify({
          job_id: job.id,
          phase: ctx ? ctx.step.task : "generation_context",
          error_type:
            error instanceof TypeError
              ? "TypeError"
              : error instanceof ReferenceError
                ? "ReferenceError"
                : "Error",
          locations:
            error instanceof Error
              ? [
                  ...(error.stack?.matchAll(
                    /([A-Za-z][A-Za-z0-9_-]*\.(?:ts|js)):(\d+):(\d+)/g,
                  ) ?? []),
                ]
                  .slice(0, 8)
                  .map((m) => `${m[1]}:${m[2]}:${m[3]}`)
              : [],
        }),
      );
    }
    let error_code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "GENERATION_HANDLER_FAILED";
    const splitting =
      ctx &&
      !(
        ctx.step.task === "classify_opportunity" &&
        error_code === "MODEL_OUTPUT_TRUNCATED"
      ) &&
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
