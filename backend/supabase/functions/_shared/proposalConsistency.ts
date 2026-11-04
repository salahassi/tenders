import { Decimal } from "decimal.js";

export const PROPOSAL_CONSISTENCY_VERSION = 1;
export type ConsistencySource = {
  id: string;
  text: string;
  kind?: string;
  verified?: boolean;
  reference?: { entity_kind: string; entity_id: string; content_hash: string };
};
export type RequirementSemantics = {
  version: 1;
  source_span_ids: string[];
  authority_role: string;
  authority_status: string;
  modality: string;
  actor: string | null;
  negated: boolean | null;
  conditions: string[];
  exceptions: string[];
  consequences: string[];
  quantities: { value: string; unit: string; currency?: string | null }[];
  dates?: { value: string; event: string }[];
  review_status: string;
  review_id: string | null;
};
export type ConsistencyRequirement = {
  id: string;
  text: string;
  mandatory?: boolean;
  category?: string;
  source_refs?: { id: string; quote: string }[];
  source_semantics?: RequirementSemantics;
  source_review_reason?: string;
  applicability_binding?: string;
};
export type ConsistencySection = {
  key: string;
  title?: string;
  volume?: string;
  requirement_ids?: string[];
  content_blocks: {
    type: string;
    text?: string;
    headers?: string[];
    rows?: string[][];
  }[];
};
export type ConsistencyFact = {
  /** Shared meaning, not a label guessed from similar-looking prose. */
  key: string;
  kind: "quantity" | "money" | "date" | "decision";
  value: string | null;
  unit: string | null;
  currency: string | null;
  quote: string;
  decision_id?: string;
};
export type RequirementFulfillment = {
  requirement_id: string;
  response_section_key: string;
  response_excerpt: string;
  method: string;
  deliverable: string;
  acceptance_evidence: string;
  conditions_preserved: string[];
  exceptions_preserved?: string[];
  consequences_preserved?: string[];
  facts?: ConsistencyFact[];
  qualifier_equivalences?: {
    kind: "conditions" | "exceptions" | "consequences";
    source_index: number;
    source_quote: string;
    source_hash: string;
    response_quote: string;
  }[];
};
export type ConsistencyInput = {
  requirements: ConsistencyRequirement[];
  sections: ConsistencySection[];
  fulfillment: RequirementFulfillment[];
  /** Server-derived from the existing current Owner compliance decision. */
  approved_exclusions?: {
    requirement_id: string;
    approval_id: string;
    actor_id: string;
    approved_by_role: "Owner";
    binding_hash: string;
    reason: string;
  }[];
  sources: ConsistencySource[];
  confirmed_shared_decisions?: {
    id: string;
    statement: string;
    facts?: ConsistencyFact[];
  }[];
  /** Only a server-authorized human action may supply this provenance. */
  human_review?: {
    review_id: string;
    actor_id: string;
    requirement_ids: string[];
    confirmed: boolean;
  } | null;
  section_facts?: { section_key: string; facts: ConsistencyFact[] }[];
  financial_truth?: {
    currency: string;
    values: { key: string; value: string }[];
  } | null;
  separate_volumes?: boolean;
  input_complete?: boolean;
};
export type ConsistencyDiagnostic = {
  id: string;
  code: string;
  severity: "blocking" | "advisory";
  paths: string[];
  requirement_ids: string[];
  section_keys: string[];
  decision_ids: string[];
  detail: string;
};
export type ProposalConsistencyReport = {
  version: 1;
  policy: "proposal-consistency-v1";
  input_hash: string;
  coverage: {
    requirement_id: string;
    status: "answered" | "excluded" | "gap" | "unreviewed";
    classification?:
      "obligation" | "non_obligation" | "approved_not_applicable";
    exclusion_reason?: string;
    section_keys: string[];
    missing_fields: string[];
  }[];
  diagnostics: ConsistencyDiagnostic[];
  substantive_complete: boolean;
  semantic_review_required: boolean;
};
export function consistencyText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}
const present = (text: string, quote: string) =>
  !!quote.trim() && consistencyText(text).includes(consistencyText(quote));
export function sectionContent(section: ConsistencySection): string {
  return section.content_blocks
    .map((b) =>
      b.type === "table"
        ? [b.headers || [], ...(b.rows || [])]
            .map((r) => r.join(" | "))
            .join("\n")
        : b.text || "",
    )
    .join("\n");
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
export async function consistencyHash(value: unknown): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const unitAliases: Record<string, string> = {
  day: "day",
  days: "day",
  يوم: "day",
  أيام: "day",
  ايام: "day",
  يوما: "day",
  month: "month",
  months: "month",
  شهر: "month",
  أشهر: "month",
  اشهر: "month",
  year: "year",
  years: "year",
  سنة: "year",
  سنوات: "year",
  workshop: "workshop",
  workshops: "workshop",
  ورشة: "workshop",
  ورش: "workshop",
  user: "user",
  users: "user",
  مستخدم: "user",
  مستخدمين: "user",
};
const unit = (value: string | null) =>
  value === null
    ? null
    : unitAliases[consistencyText(value).toLowerCase()] ||
      consistencyText(value).toLowerCase();
function factValue(fact: ConsistencyFact): string | null {
  if (fact.value === null) return null; // Unknown is never zero.
  const value = consistencyText(fact.value);
  if (fact.kind === "quantity" || fact.kind === "money") {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("INVALID_DECIMAL");
    return new Decimal(value).toFixed();
  }
  if (fact.kind === "date") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new Error("INVALID_DATE");
  }
  return value;
}
export async function qualifierHash(text: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const numericLiterals = (text: string): string[] =>
  consistencyText(text).match(/\d{4}-\d{2}-\d{2}|[+-]?\d+(?:[,.]\d+)*/g) || [];
function numericLiteralValue(text: string): string | null {
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  try {
    return new Decimal(text.replaceAll(",", "")).toFixed();
  } catch {
    return null;
  }
}
function literalWord(text: string, word: string): boolean {
  const escaped = consistencyText(word)
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    !!escaped &&
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(
      consistencyText(text).toLowerCase(),
    )
  );
}
function unitInQuote(quote: string, declared: string): boolean {
  const expected = unit(declared);
  return (
    literalWord(quote, declared) ||
    Object.entries(unitAliases).some(
      ([alias, canonical]) =>
        canonical === expected && literalWord(quote, alias),
    )
  );
}
const currencyAliases: Record<string, string[]> = {
  SAR: ["SAR", "Saudi riyal", "Saudi riyals", "ريال سعودي", "ريالات سعودية"],
  USD: ["USD", "US dollar", "US dollars", "دولار أمريكي", "دولارات أمريكية"],
  AED: ["AED", "UAE dirham", "درهم إماراتي"],
  EUR: ["EUR", "euro", "euros", "يورو"],
  GBP: ["GBP", "pound sterling", "جنيه إسترليني"],
};
function factInQuote(fact: ConsistencyFact, value: string | null): boolean {
  if (value === null) return true;
  if (fact.kind === "decision") return present(fact.quote, value);
  return numericLiterals(fact.quote).some((token) =>
    fact.kind === "date"
      ? token === value
      : numericLiteralValue(token) === value,
  );
}
export function sourceQuantityInQuote(
  quote: string,
  quantity: { value: string; unit: string; currency?: string | null },
): boolean {
  const value = numericLiteralValue(consistencyText(quantity.value));
  return (
    value !== null &&
    factInQuote(
      {
        key: "source",
        kind: quantity.currency ? "money" : "quantity",
        value,
        unit: quantity.unit,
        currency: quantity.currency || null,
        quote,
      },
      value,
    ) &&
    (quantity.currency
      ? (currencyAliases[quantity.currency] || [quantity.currency]).some(
          (alias) => literalWord(quote, alias),
        )
      : unitInQuote(quote, quantity.unit))
  );
}
function hasFactValue(fact: ConsistencyFact, value: string | null): boolean {
  try {
    return factValue(fact) === value;
  } catch {
    return false;
  }
}

/** Deterministic integrity/consistency gates, followed by explicit semantic
 * review. A matching quote proves text identity, never the adequacy of a plan.
 * Prices are compared as Decimal strings; this module calculates no totals. */
export async function assessProposalConsistency(
  input: ConsistencyInput,
): Promise<ProposalConsistencyReport> {
  const diagnostics: ConsistencyDiagnostic[] = [];
  const add = (
    code: string,
    detail: string,
    paths: string[],
    requirements: string[] = [],
    sections: string[] = [],
    decisions: string[] = [],
  ) => {
    diagnostics.push({
      id: `consistency-${diagnostics.length + 1}`,
      code,
      severity: "blocking",
      paths,
      requirement_ids: requirements,
      section_keys: sections,
      decision_ids: decisions,
      detail,
    });
  };
  const ids = new Set(input.requirements.map((r) => r.id));
  const sectionIds = new Set(input.sections.map((s) => s.key));
  if (
    ids.size !== input.requirements.length ||
    sectionIds.size !== input.sections.length
  )
    add(
      "DUPLICATE_IDENTITY",
      "Requirement and section identities must be unique.",
      ["$.requirements", "$.sections"],
    );
  if (!input.requirements.length)
    add(
      "REQUIREMENT_INVENTORY_EMPTY",
      "A complete source-backed inventory is required.",
      ["$.requirements"],
    );
  if (input.input_complete !== true)
    add(
      "INPUT_COVERAGE_INCOMPLETE",
      "Unread or omitted input remains unresolved.",
      ["$.input_complete"],
    );
  const seenFacts = new Map<
    string,
    {
      value: string | null;
      unit: string | null;
      currency: string | null;
      path: string;
      requirement: string;
      section: string;
    }[]
  >();
  for (const [fi, f] of input.fulfillment.entries()) {
    if (!ids.has(f.requirement_id) || !sectionIds.has(f.response_section_key))
      add(
        "FULFILLMENT_IDENTITY_INVALID",
        "The response binding names an unknown requirement or section.",
        [`$.fulfillment[${fi}]`],
        [f.requirement_id],
        [f.response_section_key],
      );
    const section = input.sections.find(
      (s) => s.key === f.response_section_key,
    );
    if (!section) continue;
    const text = sectionContent(section);
    if (!present(text, f.response_excerpt))
      add(
        "RESPONSE_EXCERPT_MISMATCH",
        "The reviewed response must occur in the actual section, not only its title.",
        [`$.fulfillment[${fi}].response_excerpt`],
        [f.requirement_id],
        [section.key],
      );
  }
  const bindings = [
    ...input.fulfillment.map((f, i) => ({
      facts: f.facts || [],
      excerpt: f.response_excerpt,
      requirement: f.requirement_id,
      section: f.response_section_key,
      path: `$.fulfillment[${i}]`,
    })),
    ...(input.section_facts || []).map((f, i) => ({
      facts: f.facts,
      excerpt: input.sections.find((s) => s.key === f.section_key)
        ? sectionContent(input.sections.find((s) => s.key === f.section_key)!)
        : "",
      requirement: "",
      section: f.section_key,
      path: `$.section_facts[${i}]`,
    })),
  ];
  for (const binding of bindings) {
    if (!sectionIds.has(binding.section))
      add(
        "FACT_SECTION_INVALID",
        "A fact binding names an unknown section.",
        [binding.path],
        [],
        [binding.section],
      );
    for (const [index, fact] of binding.facts.entries()) {
      const path = `${binding.path}.facts[${index}]`;
      if (!present(binding.excerpt, fact.quote))
        add(
          "FACT_QUOTE_MISMATCH",
          "The declared fact is not anchored in the response excerpt.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      let value: string | null;
      try {
        value = factValue(fact);
      } catch {
        add(
          "FACT_VALUE_INVALID",
          "Quantity, amount or date is not an unambiguous canonical value.",
          [path],
          [binding.requirement],
          [binding.section],
        );
        continue;
      }
      if (value !== null && !factInQuote(fact, value))
        add(
          "FACT_VALUE_NOT_IN_QUOTE",
          "The canonical fact value must be visible in its exact quotation.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      if (
        fact.kind === "money" &&
        (fact.currency === null || !/^[A-Z]{3}$/.test(fact.currency))
      )
        add(
          "CURRENCY_UNKNOWN",
          "A monetary assertion requires an explicit currency.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      if (fact.kind === "quantity" && fact.unit === null)
        add(
          "QUANTITY_UNIT_UNKNOWN",
          "A numeric obligation requires an explicit unit.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      if (
        fact.kind === "quantity" &&
        fact.unit !== null &&
        !unitInQuote(fact.quote, fact.unit)
      )
        add(
          "FACT_UNIT_NOT_IN_QUOTE",
          "The declared unit does not occur in the cited response.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      if (
        fact.kind === "money" &&
        fact.currency !== null &&
        !(currencyAliases[fact.currency] || [fact.currency]).some((alias) =>
          literalWord(fact.quote, alias),
        )
      )
        add(
          "FACT_CURRENCY_NOT_IN_QUOTE",
          "The declared currency is not explicit in the cited response.",
          [path],
          [binding.requirement],
          [binding.section],
        );
      if (fact.kind === "money" && input.financial_truth) {
        const truth = input.financial_truth.values.find(
          (v) => v.key === fact.key,
        );
        if (
          !truth ||
          !hasFactValue({ ...fact, value: truth.value }, value) ||
          fact.currency !== input.financial_truth.currency
        )
          add(
            "FINANCIAL_TRUTH_CONFLICT",
            "A monetary assertion must match its explicitly bound Decimal calculation and currency.",
            [path],
            [binding.requirement],
            [binding.section],
          );
      }
      const key = `${fact.kind}:${fact.key}`;
      const record = {
        value,
        unit: unit(fact.unit),
        currency: fact.currency,
        path,
        requirement: binding.requirement,
        section: binding.section,
      };
      const prior = seenFacts.get(key) || [];
      for (const other of prior)
        if (
          other.value !== record.value ||
          other.unit !== record.unit ||
          other.currency !== record.currency
        )
          add(
            "SHARED_FACT_CONFLICT",
            "Sections disagree on the same explicitly identified quantity, currency, date or decision; unknown is distinct from zero.",
            [other.path, path],
            [other.requirement, binding.requirement],
            [other.section, binding.section],
            fact.decision_id ? [fact.decision_id] : [],
          );
      seenFacts.set(key, [...prior, record]);
      if (fact.decision_id) {
        const decision = input.confirmed_shared_decisions?.find(
          (d) => d.id === fact.decision_id,
        );
        if (!decision)
          add(
            "SHARED_DECISION_UNCONFIRMED",
            "The response references a shared decision without a confirmed binding.",
            [path],
            [binding.requirement],
            [binding.section],
            [fact.decision_id],
          );
        else {
          const expected = decision.facts?.find(
            (x) => x.key === fact.key && x.kind === fact.kind,
          );
          if (
            expected &&
            (!hasFactValue(expected, value) ||
              unit(expected.unit) !== unit(fact.unit) ||
              expected.currency !== fact.currency)
          )
            add(
              "SHARED_DECISION_CHANGED",
              "The response changes a confirmed shared decision.",
              [path],
              [binding.requirement],
              [binding.section],
              [decision.id],
            );
        }
      }
    }
  }
  // This detects unbound numeric text, never its meaning. Explicit bindings and
  // scoped human review remain necessary even when every literal is accounted for.
  for (const [i, section] of input.sections.entries()) {
    const literals =
      consistencyText(sectionContent(section)).match(
        /\d{4}-\d{2}-\d{2}|-?\d+(?:[,.]\d+)*/g,
      ) || [];
    const facts = bindings
      .filter((b) => b.section === section.key)
      .flatMap((b) => b.facts);
    for (const literal of new Set(literals)) {
      const normalized =
        literal.includes("-") && /^\d{4}-/.test(literal)
          ? literal
          : literal.replaceAll(",", "");
      if (
        !facts.some(
          (f) =>
            f.value !== null &&
            (f.kind === "date"
              ? consistencyText(f.value) === normalized
              : hasFactValue(
                  f,
                  (() => {
                    try {
                      return new Decimal(normalized).toFixed();
                    } catch {
                      return normalized;
                    }
                  })(),
                )) &&
            numericLiterals(f.quote).includes(literal),
        )
      )
        add(
          "NUMERIC_ASSERTION_UNBOUND",
          "A number or date in the actual proposal has no explicit reviewed meaning/value binding.",
          [`$.sections[${i}].content_blocks`],
          section.requirement_ids || [],
          [section.key],
        );
    }
  }
  const qualifierHashes = new Map<string, string>();
  await Promise.all(
    input.requirements.flatMap((r) =>
      (["conditions", "exceptions", "consequences"] as const).flatMap((kind) =>
        (r.source_semantics?.[kind] || []).map(async (quote, index) =>
          qualifierHashes.set(
            `${r.id}:${kind}:${index}`,
            await qualifierHash(quote),
          ),
        ),
      ),
    ),
  );
  const coverage = input.requirements.map((r, ri) => {
    const forms = input.fulfillment.filter((f) => f.requirement_id === r.id);
    const missing = new Set<string>();
    const semantics = r.source_semantics;
    const nonObligation =
      !!semantics &&
      (semantics.modality === "informational" ||
        ["supplier_proposal", "company_evidence", "reference"].includes(
          semantics.authority_role,
        ));
    if (
      !semantics ||
      semantics.review_status !== "confirmed" ||
      !semantics.review_id ||
      semantics.authority_status !== "confirmed" ||
      (!nonObligation &&
        !["buyer_rfp", "buyer_addendum"].includes(semantics.authority_role))
    )
      missing.add("confirmed_source_semantics");
    if (
      semantics &&
      (semantics.modality === "unknown" ||
        (semantics.actor === null && !nonObligation) ||
        semantics.negated === null)
    )
      missing.add("source_obligation_meaning");
    if (
      !r.source_refs?.length ||
      r.source_refs.some(
        (ref) =>
          !input.sources.some(
            (s) =>
              s.id === ref.id &&
              present(s.text, ref.quote) &&
              !!s.reference?.content_hash,
          ),
      )
    )
      missing.add("current_source_binding");
    const exclusions = (input.approved_exclusions || []).filter(
      (e) => e.requirement_id === r.id,
    );
    const approved =
      exclusions.length === 1 &&
      exclusions[0].approved_by_role === "Owner" &&
      !!exclusions[0].actor_id &&
      !!exclusions[0].approval_id &&
      exclusions[0].reason.trim().length >= 10 &&
      /^[a-f0-9]{64}$/.test(exclusions[0].binding_hash) &&
      exclusions[0].binding_hash === r.applicability_binding;
    if (
      !missing.size &&
      (approved || (nonObligation && !!r.source_review_reason?.trim()))
    )
      return {
        requirement_id: r.id,
        status: "excluded" as const,
        classification: approved
          ? ("approved_not_applicable" as const)
          : ("non_obligation" as const),
        exclusion_reason: approved
          ? exclusions[0].reason
          : r.source_review_reason!,
        section_keys: [] as string[],
        missing_fields: [] as string[],
      };
    if (nonObligation && !r.source_review_reason?.trim())
      missing.add("source_classification_reason");
    if (forms.length !== 1)
      missing.add(forms.length ? "unique_primary_response" : "response");
    for (const f of forms) {
      const section = input.sections.find(
        (s) => s.key === f.response_section_key,
      );
      const text = section ? sectionContent(section) : "";
      if (!section?.requirement_ids?.includes(r.id))
        missing.add("section_requirement_binding");
      if (
        present(r.text, f.response_excerpt) ||
        input.sources.some((source) =>
          present(source.text, f.response_excerpt),
        ) ||
        new Set(
          [f.method, f.deliverable, f.acceptance_evidence].map(consistencyText),
        ).size < 3
      ) {
        missing.add("substantive_proposal");
        add(
          "SOURCE_RESTATEMENT_ONLY",
          "Repeating source instructions or the same phrase in three fields does not supply an implementation method, deliverable and acceptance evidence.",
          [`$.fulfillment[${input.fulfillment.indexOf(f)}]`],
          [r.id],
          [f.response_section_key],
        );
      }
      for (const field of [
        "method",
        "deliverable",
        "acceptance_evidence",
      ] as const)
        if (!present(f.response_excerpt, f[field]) || !present(text, f[field]))
          missing.add(field);
      // A paraphrase is accepted only through an exact source-index/hash to
      // exact response-quote mapping covered by this authorized human review.
      const human = input.human_review;
      const humanReviewed =
        human?.confirmed === true &&
        !!human.actor_id &&
        !!human.review_id &&
        human.requirement_ids.includes(r.id);
      for (const [field, declared] of [
        ["conditions", f.conditions_preserved],
        ["exceptions", f.exceptions_preserved || []],
        ["consequences", f.consequences_preserved || []],
      ] as const)
        for (const [index, qualifier] of (semantics?.[field] || []).entries()) {
          const exact =
            declared.some(
              (q) => consistencyText(q) === consistencyText(qualifier),
            ) && present(f.response_excerpt, qualifier);
          const equivalent =
            humanReviewed &&
            (f.qualifier_equivalences || []).some(
              (q) =>
                q.kind === field &&
                q.source_index === index &&
                q.source_quote === qualifier &&
                q.source_hash ===
                  qualifierHashes.get(`${r.id}:${field}:${index}`) &&
                present(f.response_excerpt, q.response_quote),
            );
          if (!exact && !equivalent) missing.add(field);
        }
      for (const equivalence of f.qualifier_equivalences || [])
        if (
          equivalence.source_quote !==
            semantics?.[equivalence.kind]?.[equivalence.source_index] ||
          equivalence.source_hash !==
            qualifierHashes.get(
              `${r.id}:${equivalence.kind}:${equivalence.source_index}`,
            ) ||
          !present(f.response_excerpt, equivalence.response_quote) ||
          !humanReviewed
        )
          missing.add("qualifier_equivalence_review");
      for (const quantity of semantics?.quantities || []) {
        let expected: string;
        try {
          expected = new Decimal(consistencyText(quantity.value)).toFixed();
        } catch {
          missing.add("source_quantity");
          continue;
        }
        if (
          !(f.facts || []).some(
            (fact) =>
              fact.kind === (quantity.currency ? "money" : "quantity") &&
              fact.value !== null &&
              hasFactValue(fact, expected) &&
              unit(fact.unit) === unit(quantity.unit) &&
              (!quantity.currency || fact.currency === quantity.currency),
          )
        )
          missing.add("source_quantity");
      }
      for (const date of semantics?.dates || [])
        if (
          !(f.facts || []).some(
            (fact) => fact.kind === "date" && fact.value === date.value,
          )
        )
          missing.add("source_date");
      if (/\[INPUT REQUIRED|\[مطلوب|\bTBD\b|\?\s*$/i.test(f.response_excerpt))
        missing.add("unresolved_response");
    }
    const human = input.human_review;
    const reviewed =
      human?.confirmed === true &&
      !!human.actor_id &&
      !!human.review_id &&
      human.requirement_ids.includes(r.id);
    if (!reviewed) missing.add("authorized_semantic_review");
    if (missing.size)
      add(
        "REQUIREMENT_RESPONSE_INCOMPLETE",
        "This obligation needs substantive response or explicit review; text length and a generic question do not establish completion.",
        [`$.requirements[${ri}]`],
        [r.id],
        forms.map((f) => f.response_section_key),
      );
    return {
      requirement_id: r.id,
      status: missing.size
        ? missing.has("authorized_semantic_review") ||
          missing.has("confirmed_source_semantics")
          ? ("unreviewed" as const)
          : ("gap" as const)
        : ("answered" as const),
      section_keys: forms.map((f) => f.response_section_key),
      missing_fields: [...missing].sort(),
    };
  });
  if (input.separate_volumes)
    for (const [i, s] of input.sections.entries())
      if (
        s.volume !== "financial" &&
        /(?:\b(?:SAR|USD|AED|EUR|GBP)\s*\d|\d[\d.,]*\s*(?:ريال|دولار|SAR|USD|AED|EUR|GBP))/iu.test(
          consistencyText(sectionContent(s)),
        )
      )
        add(
          "TECHNICAL_VOLUME_PRICE",
          "Monetary pricing appears in the technical/shared volume.",
          [`$.sections[${i}].content_blocks`],
          s.requirement_ids || [],
          [s.key],
        );
  return {
    version: 1,
    policy: "proposal-consistency-v1",
    input_hash: await consistencyHash(input),
    coverage,
    diagnostics,
    substantive_complete:
      coverage.length > 0 &&
      coverage.every(
        (c) => c.status === "answered" || c.status === "excluded",
      ) &&
      diagnostics.length === 0,
    semantic_review_required: coverage.some(
      (c) =>
        c.missing_fields.includes("authorized_semantic_review") ||
        c.missing_fields.includes("confirmed_source_semantics"),
    ),
  };
}
export function requireProposalAcceptance(
  report: ProposalConsistencyReport,
): void {
  if (
    report.version !== 1 ||
    !report.substantive_complete ||
    report.diagnostics.some((d) => d.severity === "blocking") ||
    !report.coverage.length ||
    report.coverage.some(
      (c) => c.status !== "answered" && c.status !== "excluded",
    )
  )
    throw new Error("PROPOSAL_CONSISTENCY_REQUIRED");
}
