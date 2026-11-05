import { expect, it } from "vitest";
import {
  canonicalSourceSpanId,
  materializeSourceCandidate,
} from "../../supabase/functions/_shared/sourceEvidence.ts";
import {
  sourceResolutionContext,
  retiredSourceUnit,
  reviewedSourceRequirement,
  assertCurrentSourceRequirements,
  validateSourceResolution,
} from "../../supabase/functions/_shared/sourceResolution.ts";
import {
  taskInput,
  nextStage,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency.ts";
import { assessGeneratedDelivery } from "../../supabase/functions/_shared/generatedProposalConsistency.ts";
import { assembledResolutionFixture } from "./sourceResolutionFixture.ts";
import {
  validateModelResult,
  ModelError,
} from "../../supabase/functions/_shared/model.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const meaning = (value: string, unit: string) => ({
  modality: "required",
  actor: "supplier",
  negated: false,
  conditions: [],
  exceptions: [],
  consequences: [],
  quantities: [{ value, unit, currency: null }],
  dates: [],
});
export async function fixture(language = "en") {
  const oldClause =
    language === "ar"
      ? "يجب أن يسلم المورد 9 أجهزة مراقبة."
      : "Supplier shall deliver 9 observation terminals.";
  const cabinetClause =
    language === "ar"
      ? "يجب أن يسلم المورد 3 خزائن ترحيل."
      : "Supplier shall deliver 3 relay cabinets.";
  const newClause =
    language === "ar"
      ? "يجب أن يسلم المورد 14 أجهزة مراقبة."
      : "Supplier shall deliver 14 observation terminals.";
  const terminal = language === "ar" ? "أجهزة مراقبة" : "observation terminals",
    cabinet = language === "ar" ? "خزائن ترحيل" : "relay cabinets";
  const oldText = `${oldClause} ${cabinetClause}`,
    newText = newClause;
  const blocks: any[] = [];
  for (const [i, text] of [oldText, newText].entries()) {
    const hash = await qualifierHash(text);
    blocks.push({
      id: id(i + 1),
      text,
      kind: "rfp",
      verified: false,
      reference: {
        entity_kind: "document",
        entity_id: id(i + 1),
        content_hash: hash,
      },
      block_hash: hash,
      extraction_version: "offline-v1",
      locator: { kind: "extracted_character_range" },
      authority: {
        version: 1,
        decision_id: id(i + 10),
        revision: 1,
        role: i ? "buyer_addendum" : "buyer_rfp",
        status: "confirmed",
        precedence: i,
        supersedes: i
          ? { entity_id: id(1), content_hash: blocks[0].block_hash }
          : null,
      },
    });
  }
  const span = (block: any, start: number, end: number) => {
    const value: any = {
      version: 1,
      id: "pending",
      entity_kind: "document",
      entity_id: block.reference.entity_id,
      content_hash: block.reference.content_hash,
      extraction_version: block.extraction_version,
      block_id: block.id,
      block_hash: block.block_hash,
      coordinate: "unicode_code_point",
      start,
      end,
      quote: Array.from(block.text).slice(start, end).join(""),
      locator: block.locator,
      authority: block.authority,
    };
    value.id = canonicalSourceSpanId(value);
    return value;
  };
  const old = span(blocks[0], 0, Array.from(oldClause).length),
    raw = span(blocks[0], 0, Array.from(oldText).length),
    cab = span(
      blocks[0],
      Array.from(oldClause).length + 1,
      Array.from(oldText).length,
    ),
    replacement = span(blocks[1], 0, Array.from(newText).length);
  const review = (n: number, s: any, tuple: any) => ({
    version: 1,
    id: id(n),
    revision: 1,
    opportunity_id: id(100),
    spans: [s],
    semantics: tuple,
    reason: "Current source-bound human interpretation.",
    status: "confirmed",
  });
  const predecessor = review(20, old, meaning("9", terminal)),
    current = review(21, replacement, meaning("14", terminal)),
    cabinets = review(22, cab, meaning("3", cabinet));
  const frozen: any = {
    language,
    title: "Observation system",
    notice: { ...blocks[0], id: id(100), kind: "notice", text: "" },
    blocks,
    knowledge: [],
    reviews: [],
    rates: [],
    template: {
      id: id(101),
      required_sections: [],
      fixed_blocks: [],
      volume_mode: "combined",
    },
    proposal_consistency_version: 1,
    source_contract_version: 1,
    repair_contract_version: 1,
    source_resolution_version: 1,
    source_evidence: {
      version: 1,
      spans: [raw, cab, replacement],
      reviews: [current, cabinets],
    },
    source_resolution: {
      version: 1,
      active_reviews: [current, cabinets],
      supersessions: [{ predecessor, replacement: current }],
      unresolved_edges: [],
    },
    input_materials: {
      documents: [
        { used_for_draft: true, extraction_coverage: { complete: true } },
      ],
    },
  };
  const pending = {
    ...reviewedSourceRequirement(predecessor as any),
    source_refs: [{ id: raw.id, quote: raw.quote }],
    text: raw.quote,
    source_semantics: {
      ...reviewedSourceRequirement(predecessor as any).source_semantics,
      source_span_ids: [raw.id],
      review_status: "pending",
      review_id: null,
    },
  };
  const rows = [
    pending,
    reviewedSourceRequirement(cabinets as any),
    reviewedSourceRequirement(current as any),
  ];
  const steps = blocks.map((block, index) => ({
    id: id(200 + index),
    task: "analyze_chunk",
    stage: "analysis",
    ordinal: index,
    status: "completed",
    input: { block_id: block.id, start: 0, end: Array.from(block.text).length },
    output: {
      processed_block_ids: [block.id],
      requirements: index ? [rows[2]] : rows.slice(0, 2),
      questions: [],
      summary: block.text,
      separate_volumes: false,
    },
  }));
  // source_review_reason is SQL-only metadata, not a model output field.
  for (const step of steps)
    for (const r of step.output.requirements)
      delete (r as any).source_review_reason;
  const ctx: any = {
    plan: {
      id: id(300),
      kind: "proposal",
      workflow_version: 3,
      stage: "analysis",
      frozen_context: frozen,
    },
    step: steps[0],
    steps,
    requirements: [],
  };
  return {
    frozen,
    ctx,
    rows,
    pending,
    predecessor,
    current,
    cabinets,
    raw,
    old,
    cab,
    replacement,
    blocks,
    terminal,
    cabinet,
  };
}
function deepFreeze(value: any): any {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
it.each(["en", "ar"])(
  "retires only the reviewed %s old9 unit, preserves raw source/accepted outputs and seeds current14+unchanged3",
  async (language) => {
    const f = await fixture(language),
      before = JSON.stringify(f.ctx);
    for (const step of f.ctx.steps) {
      const ctx = { ...f.ctx, step },
        scope = taskInput(ctx);
      expect(scope.context.source_resolution_version).toBe(1);
      const candidate = materializeSourceCandidate(
        "analyze_chunk",
        step.output,
        scope.context,
        scope.evidence,
      );
      validateGenerationResult(ctx, scope, candidate);
    }
    deepFreeze(f.ctx);
    const output = await nextStage(f.ctx);
    expect(
      output.requirements.map((r) => r.source_semantics.quantities[0].value),
    ).toEqual(["14", "3"]);
    expect(
      output.requirements.every(
        (r) => r.source_semantics.review_status === "confirmed",
      ),
    ).toBe(true);
    expect(output.final_result?.source_resolution_dispositions.retired).toEqual(
      [
        {
          step_id: id(200),
          requirement_index: 0,
          predecessor_review_id: id(20),
          predecessor_revision: 1,
          replacement_review_id: id(21),
          replacement_revision: 1,
        },
      ],
    );
    expect(JSON.stringify(f.ctx)).toBe(before);
    const again = await nextStage(f.ctx);
    expect(again).toEqual(output);
    const other = await nextStage({
      ...f.ctx,
      plan: { ...f.ctx.plan, id: id(301) },
    });
    expect(other.requirements.map((r) => r.id)).not.toEqual(
      output.requirements.map((r) => r.id),
    );
  },
);
it.each(["en", "ar"])(
  "makes the correct %s14/3 response machine-eligible after canonical inventory reconciliation",
  async (language) => {
    const f = await fixture(language),
      fixed = (await nextStage(f.ctx)).requirements;
    const body =
      language === "ar"
        ? "سنركب ونهيئ 14 أجهزة مراقبة متصلة مع 3 خزائن ترحيل. سيتحقق فريق التسليم من التوصيلات ويجري اختبارات التشغيل ويسجل نتائجها ويحصل على قبول المشتري للتركيب المكتمل."
        : "We will install and configure 14 observation terminals connected to 3 relay cabinets. Our delivery team will verify wiring, execute operational checks, record results and obtain buyer acceptance of the completed installation.";
    const result = await assessGeneratedDelivery(
      await assembledResolutionFixture(f.frozen, fixed, body),
    );
    expect(result.blockers).toEqual([]);
    expect(result.machine_eligible).toBe(true);
    expect(result.substantive_complete).toBe(false);
    const planning = taskInput({
      ...f.ctx,
      plan: { ...f.ctx.plan, stage: "planning" },
      requirements: fixed,
      step: {
        task: "plan_proposal",
        input: {
          planning_phase: "structure",
          workflow_version: 3,
          requirement_scope: "all",
          requirement_ids: [],
        },
      },
    });
    expect(planning.context.source_resolution).toEqual(
      f.frozen.source_resolution,
    );
  },
);
it("seeds active units even when an analysis candidate omits them without manufacturing response approval", async () => {
  const f = await fixture();
  f.ctx.steps.forEach((step: any) => (step.output.requirements = []));
  const output = await nextStage(f.ctx);
  expect(output.requirements).toHaveLength(2);
  expect(
    output.requirements.every((r) => r.id !== r.source_semantics.review_id),
  ).toBe(true);
  expect(
    output.final_result?.source_resolution_dispositions.seeded,
  ).toHaveLength(2);
});
it("keeps one operation snapshot across asynchronous stable-ID hashing", async () => {
  const f = await fixture();
  const pending = nextStage(f.ctx);
  f.ctx.plan.id = id(999);
  f.ctx.steps[0].id = id(998);
  f.ctx.steps[0].output.requirements = [];
  f.frozen.source_resolution.active_reviews = [];
  const result = await pending;
  expect(
    result.requirements.map((r) => r.source_semantics.quantities[0].value),
  ).toEqual(["14", "3"]);
  expect(
    result.final_result?.source_resolution_dispositions.retired[0].step_id,
  ).toBe(id(200));
});
it("preserves distinct unaffected candidate metadata instead of silently deduplicating it before SQL audit", async () => {
  const f = await fixture();
  const unrelated = structuredClone(f.pending);
  unrelated.source_semantics.quantities = [
    { value: "4", unit: "sensors", currency: null },
  ];
  const second = {
    ...structuredClone(unrelated),
    category: "deliverables",
    acceptance_evidence: "A separate signed inspection.",
  };
  f.ctx.steps[0].output.requirements.push(
    unrelated,
    second,
    structuredClone(unrelated),
  );
  const before = JSON.stringify(f.ctx.steps);
  const output = await nextStage(f.ctx);
  const kept = output.requirements.filter(
    (r) => r.source_semantics.review_status === "pending",
  );
  expect(kept).toHaveLength(2);
  expect(kept.map(({ id, ...r }) => r)).toEqual([unrelated, second]);
  expect(JSON.stringify(f.ctx.steps)).toBe(before);
});
it.each(["mixed", "partial", "extra_span"])(
  "preserves accepted %s source input but refuses its ambiguous active inventory",
  async (kind) => {
    const f = await fixture(),
      before = JSON.stringify(f.ctx);
    if (kind === "mixed")
      f.pending.source_semantics.quantities.push(
        f.cabinets.semantics.quantities[0],
      );
    if (kind === "partial") f.pending.source_semantics.actor = null;
    if (kind === "extra_span") {
      f.pending.source_semantics.source_span_ids.push(f.replacement.id);
      f.pending.source_refs.push({
        id: f.replacement.id,
        quote: f.replacement.quote,
      });
      f.pending.text = f.pending.source_refs
        .map((r: any) => r.quote)
        .join("\n[Separate source passage]\n");
    }
    const changed = JSON.stringify(f.ctx);
    expect(changed).not.toBe(before);
    await expect(nextStage(f.ctx)).rejects.toThrow(
      "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
    );
    expect(JSON.stringify(f.ctx)).toBe(changed);
  },
);
it("preserves distinct unreviewed units in the same broad source chunk", async () => {
  const f = await fixture();
  f.pending.source_semantics.quantities = [
    { value: "3", unit: f.cabinet, currency: null },
  ];
  f.frozen.source_resolution.active_reviews =
    f.frozen.source_resolution.active_reviews.filter(
      (r: any) => r.id !== f.cabinets.id,
    );
  expect(retiredSourceUnit(f.pending, f.frozen)).toBeNull();
});
it.each(["unit", "currency"])(
  "does not equate identical numerals with a different typed %s",
  async (field) => {
    const f = await fixture();
    f.pending.source_semantics.quantities[0] = {
      value: "9",
      unit: field === "unit" ? "engineers" : f.terminal,
      currency: field === "currency" ? "USD" : null,
    };
    expect(retiredSourceUnit(f.pending, f.frozen)).toBeNull();
  },
);
it("current reviewed cabinet unit wins over a shared generic condition; no-slot pending units stay unresolved", async () => {
  const f = await fixture();
  f.predecessor.semantics.conditions = ["after acceptance"];
  f.cabinets.semantics.conditions = ["after acceptance"];
  f.rows[1].source_semantics.conditions = ["after acceptance"];
  expect(retiredSourceUnit(f.rows[1], f.frozen)).toBeNull();
  f.predecessor.semantics.quantities = [];
  f.predecessor.semantics.conditions = [];
  f.pending.source_semantics.quantities = [];
  expect(() => retiredSourceUnit(f.pending, f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it("does not retire ambiguous same-tuple units sharing source provenance", async () => {
  const f = await fixture();
  const additional = { ...structuredClone(f.predecessor), id: id(23) };
  f.frozen.source_resolution.active_reviews.push(additional);
  expect(() => retiredSourceUnit(f.pending, f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it.each([
  "PREDECESSOR_REVISION_UNPINNED",
  "PREDECESSOR_REVISION_CHANGED",
  "SUPERSESSION_AUTHORITY_INCOMPLETE",
  "REVIEW_SOURCE_STALE",
  "SUPERSESSION_CONFLICT",
])(
  "refuses authoritative unresolved edge %s before constructing a request",
  async (reason) => {
    const f = await fixture();
    f.frozen.source_resolution.unresolved_edges.push({
      predecessor_review_id: id(20),
      replacement_review_id: id(21),
      replacement_revision: 1,
      reason,
    });
    expect(() => taskInput(f.ctx)).toThrow(
      "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
    );
  },
);
it("rejects cycles and inconsistent review revision snapshots", async () => {
  const f = await fixture();
  f.frozen.source_resolution.active_reviews = [f.cabinets];
  f.frozen.source_resolution.supersessions.push({
    predecessor: f.current,
    replacement: f.predecessor,
  });
  expect(() => sourceResolutionContext(f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
  const g = await fixture();
  g.frozen.source_resolution.supersessions[0].replacement = {
    ...g.current,
    revision: 2,
  };
  expect(() => sourceResolutionContext(g.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it.each(["content_hash", "block_hash", "extraction_version", "authority"])(
  "rejects changed immutable predecessor %s before using a resolution",
  async (field) => {
    const f = await fixture();
    const s = f.predecessor.spans[0];
    s[field] =
      field === "authority"
        ? { ...s.authority, revision: 2 }
        : field === "extraction_version"
          ? "changed"
          : "f".repeat(64);
    expect(() => taskInput(f.ctx)).toThrow(
      field === "content_hash"
        ? "SOURCE_OBLIGATION_RESOLUTION_REQUIRED"
        : "SOURCE_SPAN_STALE",
    );
  },
);
it("legacy contexts retain exact behavior and repair contexts cannot bypass the new requirement guard", async () => {
  const f = await fixture();
  const legacy = structuredClone(f.ctx);
  delete legacy.plan.frozen_context.source_resolution_version;
  delete legacy.plan.frozen_context.source_resolution;
  expect((await nextStage(legacy)).requirements).toHaveLength(3);
  expect(() => assertCurrentSourceRequirements(f.frozen, [f.pending])).toThrow(
    "SOURCE_OBLIGATION_SUPERSEDED",
  );
  expect(() =>
    validateSourceResolution(
      "repair_result",
      { target_task: "draft_section", result: {} },
      { original_context: { ...f.frozen, source_requirements: [f.pending] } },
    ),
  ).toThrow("SOURCE_OBLIGATION_SUPERSEDED");
});
it("reports mixed-unit ambiguity before candidate acceptance with a bounded requirement repair path", async () => {
  const f = await fixture();
  f.pending.source_semantics.quantities.push({
    ...f.cabinets.semantics.quantities[0],
  });
  const input = taskInput(f.ctx);
  let error: any;
  try {
    validateModelResult(
      "analyze_chunk",
      f.ctx.step.output,
      input.evidence,
      input.requiredIds,
      { sourceContext: input.context },
    );
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ModelError);
  expect(
    error.validationDiagnostics.some((d: any) =>
      d.paths?.includes("$.requirements[0].source_semantics"),
    ),
  ).toBe(true);
  expect(
    error.validationDiagnostics.every(
      (d: any) =>
        !(d.paths || []).some((p: string) => p.includes("requirements[1]")),
    ),
  ).toBe(true);
});
it("preserves a broad paragraph and its separate cabinet fact instead of subtracting a retired source range", async () => {
  const f = await fixture();
  f.predecessor.spans = [structuredClone(f.raw)];
  const before = JSON.stringify(f.frozen.blocks);
  const output = await nextStage(f.ctx);
  expect(
    output.requirements.map((r) => r.source_semantics.quantities[0].value),
  ).toEqual(["14", "3"]);
  expect(JSON.stringify(f.frozen.blocks)).toBe(before);
  expect(
    output.requirements.find(
      (r) => r.source_semantics.review_id === f.cabinets.id,
    )?.source_refs[0].quote,
  ).toBe(f.cab.quote);
});
it("keeps an explicit current review distinct even when its generic tuple shares the retired source span", async () => {
  const f = await fixture();
  f.predecessor.semantics.quantities = [];
  const other = { ...structuredClone(f.predecessor), id: id(24) };
  f.frozen.source_resolution.active_reviews.push(other);
  const requirement = reviewedSourceRequirement(other as any);
  f.frozen.source_evidence.spans.push(other.spans[0]);
  expect(retiredSourceUnit(requirement, f.frozen)).toBeNull();
  const pending = {
    ...requirement,
    source_semantics: {
      ...requirement.source_semantics,
      review_id: null,
      review_status: "pending",
    },
  };
  expect(() => retiredSourceUnit(pending, f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it("follows a pinned A→B→C chain and restores B only after authoritative removal of its revoked C edge", async () => {
  const f = await fixture();
  const latest = structuredClone(f.current);
  latest.id = id(25);
  latest.spans[0].entity_id = id(3);
  latest.spans[0].authority.supersedes = {
    entity_id: f.current.spans[0].entity_id,
    content_hash: f.current.spans[0].content_hash,
  };
  latest.semantics.quantities[0].value = "18";
  f.frozen.source_resolution.active_reviews = [latest, f.cabinets];
  f.frozen.source_resolution.supersessions.push({
    predecessor: f.current,
    replacement: latest,
  });
  expect(retiredSourceUnit(f.pending, f.frozen)?.predecessor.id).toBe(
    f.predecessor.id,
  );
  const restored = structuredClone(f.frozen);
  restored.source_resolution.active_reviews = [f.current, f.cabinets];
  restored.source_resolution.supersessions =
    restored.source_resolution.supersessions.slice(0, 1);
  expect(
    sourceResolutionContext(restored)?.active_reviews.some(
      (r) => r.id === f.current.id,
    ),
  ).toBe(true);
  latest.status = "revoked";
  expect(() => sourceResolutionContext(f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it("rejects multi-source replacement authority covering only one predecessor document", async () => {
  const f = await fixture();
  const additional = structuredClone(f.old);
  additional.entity_id = id(9);
  additional.block_id = id(9);
  additional.id = canonicalSourceSpanId(additional);
  f.predecessor.spans.push(additional);
  expect(() => sourceResolutionContext(f.frozen)).toThrow(
    "SOURCE_OBLIGATION_RESOLUTION_REQUIRED",
  );
});
it("uses half-open Unicode codepoint ranges and does not overlap adjacent reviewed units", async () => {
  const f = await fixture("ar");
  expect(f.old.end).toBe(Array.from(f.old.quote).length);
  const adjacent = structuredClone(f.pending);
  adjacent.source_refs = [{ id: f.cab.id, quote: f.cab.quote }];
  adjacent.source_semantics.source_span_ids = [f.cab.id];
  adjacent.text = f.cab.quote;
  expect(retiredSourceUnit(adjacent, f.frozen)).toBeNull();
});
it("retains the explicit false-verifier semantic boundary after fixing the inventory; digit9 alone is not banned", async () => {
  const f = await fixture(),
    fixed = (await nextStage(f.ctx)).requirements;
  for (const body of [
    "We will deliver exactly 9 observation terminals for this system. We will also deliver exactly 14 observation terminals for the same system. We will install 3 relay cabinets, verify the wiring and record operational acceptance tests.",
    "We will deliver 14 observation terminals, replacing the superseded quantity of 9 observation terminals. We will install 3 relay cabinets, verify the wiring and record operational acceptance tests.",
  ]) {
    const report = await assessGeneratedDelivery(
      await assembledResolutionFixture(f.frozen, fixed, body),
    );
    expect(report.machine_eligible).toBe(true);
    expect(report.approval_state).toBe("draft");
    expect(report.substantive_complete).toBe(false);
  }
});
