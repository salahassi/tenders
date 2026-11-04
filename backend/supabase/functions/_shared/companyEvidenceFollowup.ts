import type { Evidence, Reference } from "./model.ts";
import { encodedSize, retrieveCompanyEvidence, COMPANY_EVIDENCE_BYTE_LIMIT } from "./companyEvidenceRetrieval.ts";

type Source = Evidence & { reference: Reference };
type Requirement = { id: string; text: string; source_refs?: { id: string; quote: string }[] };
const aliases = [
  ["workflow","approval","approvals","سير العمل","الموافقات","اعتماد"],
  ["security","cybersecurity","cyber","أمن","امن","سيبراني","حماية"],
  ["integration","interface","interfaces","api","تكامل","واجهات","ربط"],
  ["training","workshop","workshops","تعليم","تدريب","ورش","ورشة"],
  ["backup","recovery","restore","استعادة","نسخ احتياطي","تعافي"],
  ["migration","transfer","ترحيل","نقل"],
  ["cloud","hosting","سحاب","استضافة"],
];
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[أإآ]/g,"ا");
function terms(text: string): string[] {
  const normalized = normalize(text);
  const expanded = aliases.filter(group => group.some(word => normalized.includes(normalize(word)))).flat();
  return [...new Set([...(normalized.match(/[\p{L}\p{N}]{3,}/gu) || []),...expanded.map(normalize)])];
}
const qualifier = /\b(?:unless|except|only|subject to|provided that|conditional|exclud|not|never|without|valid until|expires)\b|بشرط|باستثناء|إلا|الا|فقط|غير|لا\s|لم\s|ينتهي|ساري/iu;
export const COMPANY_FOLLOWUP_INSTRUCTION =
  "Requirement-specific follow-up scans the entire frozen verified source pool locally. Exact selected spans retain parent hashes and coordinates; lexical/bilingual aliases are retrieval hints only. " +
  "A partial source is discovery context, not sufficient proof for any company claim. Never infer absence of capability from selection, an empty search, permission exclusion, or budget overflow. " +
  "Every omitted source/span remains an explicit unresolved retrieval gap. A partial source needs full-context authorized review before asserting company facts.";

/** Actual bounded second pass after whole-source admission misses evidence.
 * It never upgrades a fragment into full source/semantic coverage. Full source
 * authorization is still enforced by the normal exact manifest preflight. */
export function followupCompanyEvidence(sources: Source[], requirements: Requirement[], byteLimit = COMPANY_EVIDENCE_BYTE_LIMIT, priorityIds: string[] = []) {
  const budget = Number.isFinite(byteLimit) ? Math.max(0,Math.min(COMPANY_EVIDENCE_BYTE_LIMIT,Math.floor(byteLimit))) : 0;
  const eligible = sources.filter(s => s.kind === "company" && s.verified === true && s.text.trim());
  const queries = requirements.map(r => ({...r,terms:terms(r.text)}));
  // Expanded terms change ranking only. Exact real requirements remain the
  // downstream contract and semantic authority is not assigned by this score.
  const first = retrieveCompanyEvidence(eligible,queries.map(r => ({...r,text:r.text+" "+r.terms.join(" ")})),budget,priorityIds);
  if (first.coverage.selection_complete) return {evidence:first.evidence,claimEligibleIds:first.evidence.map(s => s.id),coverage:{...first.coverage,version:2,followup_performed:false,spans:[],unresolved_requirement_ids:[] as string[]}};
  const selected: Source[] = [];
  const selectedIds = new Set(first.evidence.map(s => s.id));
  const claimEligibleIds: string[] = [];
  let remaining = budget;
  const spans: { source_id:string;content_hash:string;start:number;end:number;coordinate:"unicode_code_point";requirement_ids:string[];source_complete:false;claim_eligible:false }[] = [];
  const candidates = eligible.filter(s => !selectedIds.has(s.id)).map(source => {
    const points = Array.from(source.text);
    const paragraphs: {start:number;end:number;text:string}[] = [];
    let start=0;
    // Keep paragraphs intact; an overlong paragraph is an explicit gap, never
    // silently cropped at a convenient character/token boundary.
    for(let i=0;i<=points.length;i++) if(i===points.length || (points[i]==="\n" && points[i+1]==="\n")) {
      if(i>start) paragraphs.push({start,end:i,text:points.slice(start,i).join("")});
      if(i<points.length){i++;start=i+1;}
    }
    const matches = queries.map(r => ({id:r.id,indexes:paragraphs.flatMap((p,i) => r.terms.some(t => normalize(p.text).includes(t)) ? [i] : [])}));
    const required = new Set<number>();
    for(const match of matches) for(const i of match.indexes) for(const n of [i-1,i,i+1]) if(n>=0 && n<paragraphs.length) required.add(n);
    // A late suffix qualifier can govern an earlier claim; retain all detected
    // source qualifiers, not just the nearest search hit.
    paragraphs.forEach((p,i) => {if(qualifier.test(p.text)) required.add(i);});
    const picked = [...required].sort((a,b)=>a-b).map(i => paragraphs[i]);
    const evidence = {...source,verified:false,text:picked.map(p=>p.text).join("\n[… omitted source text …]\n")};
    return {source,evidence,picked,requirements:matches.filter(m=>m.indexes.length).map(m=>m.id)};
  }).filter(c=>c.requirements.length && c.picked.length).sort((a,b)=>b.requirements.length-a.requirements.length || a.source.id.localeCompare(b.source.id));
  for(const candidate of candidates) {
    const cost=encodedSize(candidate.evidence);
    if(cost>remaining) continue;
    selected.push(candidate.evidence);remaining-=cost;
    for(const p of candidate.picked) spans.push({source_id:candidate.source.id,content_hash:candidate.source.reference.content_hash,start:p.start,end:p.end,coordinate:"unicode_code_point",requirement_ids:candidate.requirements,source_complete:false,claim_eligible:false});
  }
  const partialParents = new Set(selected.map(s=>JSON.stringify(s.reference)));
  const complete = retrieveCompanyEvidence(eligible.filter(s=>!partialParents.has(JSON.stringify(s.reference))),queries.map(r=>({...r,text:r.text+" "+r.terms.join(" ")})),remaining,priorityIds);
  selected.push(...complete.evidence);claimEligibleIds.push(...complete.evidence.map(s=>s.id));
  remaining-=complete.coverage.supplied_bytes;
  const parentKey = (s: Source) => JSON.stringify([s.reference.entity_kind,s.reference.entity_id,s.reference.content_hash]);
  const completeParents = new Set(complete.evidence.map(parentKey));
  const availableParents = new Set(eligible.map(parentKey));
  return {evidence:selected,claimEligibleIds,coverage:{...first.coverage,version:2,followup_performed:true,
    supplied_sources:completeParents.size, omitted_sources:availableParents.size-completeParents.size,
    partial_sources:partialParents.size,
    cited_source_coverage_complete:priorityIds.every(id=>claimEligibleIds.includes(id)),
    requirement_coverage:requirements.map(r=>({requirement_id:r.id,semantic_support:"not_evaluated",retrieval_gap:true,
      discovery_span_source_ids:spans.filter(s=>s.requirement_ids.includes(r.id)).map(s=>s.source_id)})),
    supplied_blocks:selected.length,supplied_bytes:budget-remaining,selection_complete:false,supplied_sources_complete:spans.length===0,
    capability_absence_proven:false,spans,unresolved_requirement_ids:requirements.map(r=>r.id),
    gap:"context_capacity",semantic_support:"not_evaluated",
    scanned_sources:eligible.length,partial_source_ids:[...new Set(spans.map(s=>s.source_id))],
    omitted_source_ids:eligible.filter(s=>!selected.some(e=>e.id===s.id)).map(s=>s.id)}};
}
