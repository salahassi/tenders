// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fixtures, evaluate, limitsForSuite, validateTargets } from "../../scripts/ops/live-model-evaluation.mjs";
import { semanticCorpus, semanticFixtures } from "../../scripts/ops/live-model-evaluation-semantics.mjs";
import { semanticV2Corpus } from "../../scripts/ops/live-model-evaluation-semantics-v2.mjs";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import observed from "./fixtures/semantic-qualification/adjudicated-synthetic-reports.json";
const findings: Record<string, string> = {
  modality: "The optional workshop was incorrectly strengthened to mandatory.",
  prohibition: "Subcontracting is prohibited, but the candidate permits it.",
  actor: "The source assigns the test accounts to the buyer, not the supplier.",
  trigger: "The phase two approval condition was removed, making delivery unconditional.",
  exception: "The legal retention exception was removed from the deletion obligation.",
  unit_translation: "The source requires 30 days, not 30 months.",
  number_association: "12 reports are required; 36 refers to test accounts, not reports.",
  consequence: "The buyer may choose a deduction; it is not mandatory or automatic.",
};
function reportFor(f: any) {
 const quote=f.context.candidate.requirements[0].text,bad=f.qualification.variant==="mutated";
 const common={candidate_quote:quote,status:bad?"contradicted":"supported",source_refs:[{id:f.required[0],quote:f.evidence[0].text}],finding:bad?findings[f.qualification.family]:"The candidate preserves the source meaning."};
 return {checked_candidate_hash:f.context.candidate_hash,reviewed_all_content:true,processed_content_ids:f.context.content_units.map((u:any)=>u.id),processed_requirement_ids:f.required,claims:[{id:"claim1",claim:quote,kind:"tender_fact",...common}],requirement_checks:[{requirement_id:f.required[0],...common}],findings:[]};
}
const languages=["en","ar"] as const;
const pairs=languages.flatMap(language=>Object.keys(findings).flatMap(family=>["faithful","mutated"].map(variant=>({language,family,variant}))));
afterEach(()=>vi.restoreAllMocks());
it.each(pairs)("v2 preserves the canonical $language $family $variant control",async({language,family,variant})=>{
 const cases=await fixtures(`semantic_v2_${language}`),f=cases.find((x:any)=>x.qualification.family===family&&x.qualification.variant===variant)!;
 expect(cases).toHaveLength(16);
 const report=reportFor(f);expect(()=>f.domainValidate(report)).not.toThrow();expect(()=>f.assert(report)).not.toThrow();
 const prompt=JSON.parse(modelPrompt(f.task,f.context,f.evidence,f.required,f.language,false,f.verificationRevision,f.semanticRevision));
 expect(JSON.stringify(prompt.untrusted_data)).not.toMatch(/oracle_version|defect_term_groups|candidate_path|supporting_source_spans|qualification|expected_field_paths|faithful|mutated|EVAL_SEMANTIC/);
 expect(f.qualification).toMatchObject({corpus_sha256:(await semanticV2Corpus()).sha256,oracle_version:2,split:"development"});
});
it.each(observed.reports)("corrects the scoring defect for $original_case without rewriting v1",async(saved)=>{
 const language=saved.original_case.includes("_en_")?"en":"ar",v1=(await semanticFixtures(language)).find((f:any)=>f.id===saved.original_case)!;
 const v2=(await fixtures(`semantic_v2_${language}`)).find((f:any)=>f.id===saved.original_case.replace("semantic_","semantic_v2_").replace(/_v1$/,"_v2"))!;
 expect(()=>v1.domainValidate(saved.synthetic_candidate)).not.toThrow();
 expect(()=>v1.assert(saved.synthetic_candidate)).toThrow("EVAL_SEMANTIC_FALSE_ACCEPTANCE");
 expect(()=>v2.domainValidate(saved.synthetic_candidate)).not.toThrow();expect(()=>v2.assert(saved.synthetic_candidate)).not.toThrow();
});
it.each(["unrelated_buyer","bare_number","wrong_source","generic","supported","wrong_hash"])("v2 rejects %s without relaxing source or candidate binding",async(mode)=>{
 const f=(await fixtures("semantic_v2_en")).find((x:any)=>x.qualification.family==="number_association"&&x.qualification.variant==="mutated")!,r=reportFor(f);
 if(mode==="unrelated_buyer"||mode==="bare_number")r.claims[0].candidate_quote=r.requirement_checks[0].candidate_quote=mode==="bare_number"?"36":"The buyer must supply 36 test accounts.";
 if(mode==="wrong_source")r.claims[0].source_refs=r.requirement_checks[0].source_refs=[{id:"unrelated-source",quote:f.evidence[0].text}];
 if(mode==="generic")r.claims[0].finding=r.requirement_checks[0].finding="Some unspecified issue.";
 if(mode==="supported")r.claims[0].status=r.requirement_checks[0].status="supported";
 if(mode==="wrong_hash")r.checked_candidate_hash="0".repeat(64);
 expect(()=>{f.domainValidate(r);f.assert(r);}).toThrow();
});
it("requires the source quantity from the affected reports clause",async()=>{
 const f=(await fixtures("semantic_v2_en")).find((x:any)=>x.qualification.family==="number_association"&&x.qualification.variant==="mutated")!,r=reportFor(f);
 r.claims[0].source_refs=r.requirement_checks[0].source_refs=[{id:f.required[0],quote:"The buyer must supply 36 test accounts."}];
 expect(()=>f.domainValidate(r)).not.toThrow();expect(()=>f.assert(r)).toThrow("EVAL_SEMANTIC_FALSE_ACCEPTANCE");
});
it("freezes v1 corpus and scorer bytes while v2 is independently pinned",async()=>{
 expect((await semanticCorpus()).sha256).toBe("698127390ac44cd1e1ba7c0591af7bc3668c0be2fed0cff22079dc4bdba7847b");
 const old=await readFile(new URL("../../scripts/ops/live-model-evaluation-semantics.mjs",import.meta.url),"utf8");
 expect(await sha256(old)).toBe("447a3842fb8e29c69cf18a3d415178415e82f02b3dfd22cec6d891d189045e26");
 const v2=await semanticV2Corpus();expect(v2.corpus).toMatchObject({version:2,oracle_version:2,paired_cases:32});expect(v2.sha256).toBe("b53d46395d713d85e3beb2ac8341cf34bc12b429cd2844a0af033288c0527d9c");
});
it.each(languages)("keeps %s v2 requests bounded, unavailable and independently identified",async language=>{
 vi.spyOn(console,"info").mockImplementation(()=>{});vi.spyOn(console,"warn").mockImplementation(()=>{});
 const targets=["openai","qwencloud"].map(provider=>({provider,model:"synthetic-model",project_ref:"fixture",key:"synthetic-private-key",capabilities:defaultCapabilities(provider as "openai"|"qwencloud")}));
 const suite=`semantic_v2_${language}` as const;expect(limitsForSuite(suite)).toMatchObject({models:4,generations:64});
 const transport=vi.fn(async()=>Response.json({error:{code:"invalid_api_key"}},{status:401}));
 const report=await evaluate(targets,transport as typeof fetch,async()=>{},undefined,suite);
 expect(report.complete).toBe(true);expect(report.passed).toBe(false);expect(report.results).toHaveLength(32);expect(transport).toHaveBeenCalledTimes(32);
 expect(report.results.every((r:any)=>r.case.startsWith(`semantic_v2_${language}_`)&&r.qualification.oracle_version===2&&r.semantic_outcome==="not_scored")).toBe(true);
 expect(JSON.stringify(report)).not.toContain(targets[0].key);
 expect(()=>validateTargets([...targets,...targets],suite)).toThrow("EVAL_DUPLICATE_TARGET");expect(()=>validateTargets([targets[0]],suite)).toThrow("EVAL_BOTH_PROVIDERS_REQUIRED");
});
