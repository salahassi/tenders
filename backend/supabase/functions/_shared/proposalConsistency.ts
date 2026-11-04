import { Decimal } from "decimal.js";

export const PROPOSAL_CONSISTENCY_VERSION = 1;
export type ConsistencySource = {
  id: string; text: string; kind?: string; verified?: boolean;
  reference?: { entity_kind: string; entity_id: string; content_hash: string };
};
export type RequirementSemantics = {
  version: 1; source_span_ids: string[]; authority_role: string;
  authority_status: string; modality: string; actor: string | null;
  negated: boolean | null; conditions: string[]; exceptions: string[];
  consequences: string[]; quantities: { value: string; unit: string }[];
  review_status: string; review_id: string | null;
};
export type ConsistencyRequirement = {
  id: string; text: string; mandatory?: boolean; category?: string;
  source_refs?: { id: string; quote: string }[];
  source_semantics?: RequirementSemantics;
};
export type ConsistencySection = {
  key: string; title?: string; volume?: string; requirement_ids?: string[];
  content_blocks: ({ type: string; text?: string; headers?: string[]; rows?: string[][] })[];
};
export type ConsistencyFact = {
  /** Shared meaning, not a label guessed from similar-looking prose. */
  key: string; kind: "quantity" | "money" | "date" | "decision";
  value: string | null; unit: string | null; currency: string | null;
  quote: string; decision_id?: string;
};
export type RequirementFulfillment = {
  requirement_id: string; response_section_key: string; response_excerpt: string;
  method: string; deliverable: string; acceptance_evidence: string;
  conditions_preserved: string[];
  exceptions_preserved?: string[]; consequences_preserved?: string[];
  facts?: ConsistencyFact[];
};
export type ConsistencyInput = {
  requirements: ConsistencyRequirement[]; sections: ConsistencySection[];
  fulfillment: RequirementFulfillment[]; sources: ConsistencySource[];
  confirmed_shared_decisions?: { id: string; statement: string; facts?: ConsistencyFact[] }[];
  /** Only a server-authorized human action may supply this provenance. */
  human_review?: { review_id: string; actor_id: string; requirement_ids: string[]; confirmed: boolean } | null;
  separate_volumes?: boolean;
  input_complete?: boolean;
};
export type ConsistencyDiagnostic = {
  id: string; code: string; severity: "blocking" | "advisory";
  paths: string[]; requirement_ids: string[]; section_keys: string[];
  decision_ids: string[]; detail: string;
};
export type ProposalConsistencyReport = {
  version: 1; policy: "proposal-consistency-v1"; input_hash: string;
  coverage: { requirement_id: string; status: "answered" | "gap" | "unreviewed"; section_keys: string[]; missing_fields: string[] }[];
  diagnostics: ConsistencyDiagnostic[]; substantive_complete: boolean;
  semantic_review_required: boolean;
};
export function consistencyText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x660))
    .replace(/[\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) - 0x6f0))
    .replace(/\u066b/g, ".").replace(/\u066c/g, ",").replace(/\s+/g, " ").trim();
}
const present = (text: string, quote: string) => !!quote.trim() && consistencyText(text).includes(consistencyText(quote));
export function sectionContent(section: ConsistencySection): string {
  return section.content_blocks.map(b => b.type === "table" ? [b.headers || [], ...(b.rows || [])].map(r => r.join(" | ")).join("\n") : b.text || "").join("\n");
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
};
export async function consistencyHash(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(b => b.toString(16).padStart(2,"0")).join("");
}
const unitAliases: Record<string,string> = {
  day:"day",days:"day",يوم:"day",أيام:"day",ايام:"day",يوما:"day",
  month:"month",months:"month",شهر:"month",أشهر:"month",اشهر:"month",
  year:"year",years:"year",سنة:"year",سنوات:"year",
  workshop:"workshop",workshops:"workshop",ورشة:"workshop",ورش:"workshop",
  user:"user",users:"user",مستخدم:"user",مستخدمين:"user",
};
const unit = (value: string | null) => value === null ? null : unitAliases[consistencyText(value).toLowerCase()] || consistencyText(value).toLowerCase();
function factValue(fact: ConsistencyFact): string | null {
  if (fact.value === null) return null; // Unknown is never zero.
  const value = consistencyText(fact.value);
  if (fact.kind === "quantity" || fact.kind === "money") {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("INVALID_DECIMAL");
    return new Decimal(value).toFixed();
  }
  if (fact.kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0,10) !== value) throw new Error("INVALID_DATE");
  }
  return value;
}
function hasFactValue(fact: ConsistencyFact, value: string | null): boolean {
  try { return factValue(fact) === value; } catch { return false; }
}

/** Deterministic integrity/consistency gates, followed by explicit semantic
 * review. A matching quote proves text identity, never the adequacy of a plan.
 * Prices are compared as Decimal strings; this module calculates no totals. */
export async function assessProposalConsistency(input: ConsistencyInput): Promise<ProposalConsistencyReport> {
  const diagnostics: ConsistencyDiagnostic[] = [];
  const add = (code: string, detail: string, paths: string[], requirements: string[] = [], sections: string[] = [], decisions: string[] = []) => {
    diagnostics.push({id:`consistency-${diagnostics.length + 1}`,code,severity:"blocking",paths,requirement_ids:requirements,section_keys:sections,decision_ids:decisions,detail});
  };
  const ids = new Set(input.requirements.map(r => r.id));
  const sectionIds = new Set(input.sections.map(s => s.key));
  if (ids.size !== input.requirements.length || sectionIds.size !== input.sections.length) add("DUPLICATE_IDENTITY","Requirement and section identities must be unique.",["$.requirements","$.sections"]);
  if (!input.requirements.length) add("REQUIREMENT_INVENTORY_EMPTY","A complete source-backed inventory is required.",["$.requirements"]);
  if (input.input_complete === false) add("INPUT_COVERAGE_INCOMPLETE","Unread or omitted input remains unresolved.",["$.input_complete"]);
  const seenFacts = new Map<string,{value:string|null;unit:string|null;currency:string|null;path:string;requirement:string;section:string}[]>();
  for (const [fi,f] of input.fulfillment.entries()) {
    if (!ids.has(f.requirement_id) || !sectionIds.has(f.response_section_key)) add("FULFILLMENT_IDENTITY_INVALID","The response binding names an unknown requirement or section.",[`$.fulfillment[${fi}]`],[f.requirement_id],[f.response_section_key]);
    const section = input.sections.find(s => s.key === f.response_section_key);
    if (!section) continue;
    const text = sectionContent(section);
    if (!present(text,f.response_excerpt)) add("RESPONSE_EXCERPT_MISMATCH","The reviewed response must occur in the actual section, not only its title.",[`$.fulfillment[${fi}].response_excerpt`],[f.requirement_id],[section.key]);
    for (const [index,fact] of (f.facts || []).entries()) {
      const path = `$.fulfillment[${fi}].facts[${index}]`;
      if (!present(f.response_excerpt,fact.quote)) add("FACT_QUOTE_MISMATCH","The declared fact is not anchored in the response excerpt.",[path],[f.requirement_id],[section.key]);
      let value: string | null;
      try { value = factValue(fact); } catch { add("FACT_VALUE_INVALID","Quantity, amount or date is not an unambiguous canonical value.",[path],[f.requirement_id],[section.key]); continue; }
      if (value !== null && fact.kind !== "decision" && !present(fact.quote,fact.value!)) add("FACT_VALUE_NOT_IN_QUOTE","The canonical fact value must be visible in its exact quotation.",[path],[f.requirement_id],[section.key]);
      if (fact.kind === "money" && (fact.currency === null || !/^[A-Z]{3}$/.test(fact.currency))) add("CURRENCY_UNKNOWN","A monetary assertion requires an explicit currency.",[path],[f.requirement_id],[section.key]);
      if (fact.kind === "quantity" && fact.unit === null) add("QUANTITY_UNIT_UNKNOWN","A numeric obligation requires an explicit unit.",[path],[f.requirement_id],[section.key]);
      const key = `${fact.kind}:${fact.key}`;
      const record = {value,unit:unit(fact.unit),currency:fact.currency,path,requirement:f.requirement_id,section:section.key};
      const prior = seenFacts.get(key) || [];
      for (const other of prior) if (other.value !== record.value || other.unit !== record.unit || other.currency !== record.currency) add("SHARED_FACT_CONFLICT","Sections disagree on the same explicitly identified quantity, currency, date or decision; unknown is distinct from zero.",[other.path,path],[other.requirement,f.requirement_id],[other.section,section.key],fact.decision_id ? [fact.decision_id] : []);
      seenFacts.set(key,[...prior,record]);
      if (fact.decision_id) {
        const decision = input.confirmed_shared_decisions?.find(d => d.id === fact.decision_id);
        if (!decision) add("SHARED_DECISION_UNCONFIRMED","The response references a shared decision without a confirmed binding.",[path],[f.requirement_id],[section.key],[fact.decision_id]);
        else {
          const expected = decision.facts?.find(x => x.key === fact.key && x.kind === fact.kind);
          if (expected && (!hasFactValue(expected,value) || unit(expected.unit) !== unit(fact.unit) || expected.currency !== fact.currency)) add("SHARED_DECISION_CHANGED","The response changes a confirmed shared decision.",[path],[f.requirement_id],[section.key],[decision.id]);
        }
      }
    }
  }
  const coverage = input.requirements.map((r,ri) => {
    const forms = input.fulfillment.filter(f => f.requirement_id === r.id);
    const missing = new Set<string>();
    if (forms.length !== 1) missing.add(forms.length ? "unique_primary_response" : "response");
    const semantics = r.source_semantics;
    if (!semantics || semantics.review_status !== "confirmed" || !semantics.review_id || semantics.authority_status !== "confirmed" || !["buyer_rfp","buyer_addendum"].includes(semantics.authority_role)) missing.add("confirmed_source_semantics");
    if (!r.source_refs?.length || r.source_refs.some(ref => !input.sources.some(s => s.id === ref.id && present(s.text,ref.quote) && !!s.reference?.content_hash))) missing.add("current_source_binding");
    for (const f of forms) {
      const section = input.sections.find(s => s.key === f.response_section_key);
      const text = section ? sectionContent(section) : "";
      if (!section?.requirement_ids?.includes(r.id)) missing.add("section_requirement_binding");
      if (present(r.text,f.response_excerpt) || input.sources.some(source => present(source.text,f.response_excerpt)) || new Set([f.method,f.deliverable,f.acceptance_evidence].map(consistencyText)).size < 3) {
        missing.add("substantive_proposal");
        add("SOURCE_RESTATEMENT_ONLY","Repeating source instructions or the same phrase in three fields does not supply an implementation method, deliverable and acceptance evidence.",[`$.fulfillment[${input.fulfillment.indexOf(f)}]`],[r.id],[f.response_section_key]);
      }
      for (const field of ["method","deliverable","acceptance_evidence"] as const) if (!present(f.response_excerpt,f[field]) || !present(text,f[field])) missing.add(field);
      // Exact preservation is deliberately conservative. A faithful paraphrase
      // requires an explicit reviewed semantic equivalence, not a string score.
      for (const [field,declared] of [["conditions",f.conditions_preserved],["exceptions",f.exceptions_preserved || []],["consequences",f.consequences_preserved || []]] as const)
        for (const qualifier of semantics?.[field] || []) if (!declared.some(q => consistencyText(q) === consistencyText(qualifier)) || !present(f.response_excerpt,qualifier)) missing.add(field);
      for (const quantity of semantics?.quantities || []) {
        let expected: string; try { expected = new Decimal(consistencyText(quantity.value)).toFixed(); } catch { missing.add("source_quantity"); continue; }
        if (!(f.facts || []).some(fact => fact.kind === "quantity" && fact.value !== null && hasFactValue(fact,expected) && unit(fact.unit) === unit(quantity.unit))) missing.add("source_quantity");
      }
      if (/\[INPUT REQUIRED|\[مطلوب|\bTBD\b|\?\s*$/i.test(f.response_excerpt)) missing.add("unresolved_response");
    }
    const human = input.human_review;
    const reviewed = human?.confirmed === true && !!human.actor_id && !!human.review_id && human.requirement_ids.includes(r.id);
    if (!reviewed) missing.add("authorized_semantic_review");
    if (missing.size) add("REQUIREMENT_RESPONSE_INCOMPLETE","This obligation needs substantive response or explicit review; text length and a generic question do not establish completion.",[`$.requirements[${ri}]`],[r.id],forms.map(f => f.response_section_key));
    return {requirement_id:r.id,status:missing.size ? (missing.has("authorized_semantic_review") || missing.has("confirmed_source_semantics") ? "unreviewed" as const : "gap" as const) : "answered" as const,section_keys:forms.map(f => f.response_section_key),missing_fields:[...missing].sort()};
  });
  if (input.separate_volumes) for (const [i,s] of input.sections.entries()) if (s.volume !== "financial" && /(?:\b(?:SAR|USD|AED|EUR|GBP)\s*\d|\d[\d.,]*\s*(?:ريال|دولار|SAR|USD|AED|EUR|GBP))/iu.test(consistencyText(sectionContent(s)))) add("TECHNICAL_VOLUME_PRICE","Monetary pricing appears in the technical/shared volume.",[`$.sections[${i}].content_blocks`],s.requirement_ids || [],[s.key]);
  return {version:1,policy:"proposal-consistency-v1",input_hash:await consistencyHash(input),coverage,diagnostics,substantive_complete:coverage.length>0 && coverage.every(c => c.status === "answered") && diagnostics.length===0,semantic_review_required:coverage.some(c => c.missing_fields.includes("authorized_semantic_review") || c.missing_fields.includes("confirmed_source_semantics"))};
}
export function requireProposalAcceptance(report: ProposalConsistencyReport): void {
  if (report.version !== 1 || !report.substantive_complete || report.diagnostics.some(d => d.severity === "blocking") || !report.coverage.length || report.coverage.some(c => c.status !== "answered")) throw new Error("PROPOSAL_CONSISTENCY_REQUIRED");
}
