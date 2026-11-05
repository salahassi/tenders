"""Synthetic accepted-version SQL fixture; no model or semantic qualification.

The records model a previously accepted graph result solely to exercise database
publication/issuance/lease races. They do not prove provider output correctness.
"""
import hashlib,json,uuid
from postgres_races import OWNER,literal

def uid():return str(uuid.uuid4())
def setup(f, remaining_seconds=600):
 if not 0 < remaining_seconds <= 600: raise ValueError("Synthetic remaining deadline must be within600seconds")
 o=f.opportunity('Provide a workflow in 30 days.')
 base=f.command('delivery.snapshot.prepare',{'opportunity_id':o['id'],'expected_revision':o['revision']})
 f.sql("update public.jobs set status='canceled' where type='render_delivery' and status='queued'")
 frozen=f.value(f"select app_private.delivery_input({literal(f.workspace)},{literal(o['id'])})")
 frozen.update(generated_delivery_version=3,source_contract_version=1,proposal_consistency_version=1)
 p,v,step,j,receipt,verification,projection=(uid() for _ in range(7))
 body='Configure the workflow in 30 days. Deliver the tested workflow and manual.'
 blocks=[{'type':'paragraph','text':body}]
 candidate={'key':'approach','title':'Approach','content_blocks':blocks,'requirement_ids':[],'evidence_refs':[],'company_claims':[],'assumptions':[],'questions':[]}
 h=hashlib.sha256(json.dumps(candidate).encode()).hexdigest();thread=hashlib.sha256(j.encode()).hexdigest()
 w=literal(f.workspace);actor=literal(OWNER)
 f.sql(f"insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,workflow_version) select {literal(p)},id,{literal(o['id'])},{literal(base['proposal_id'])},'proposal','completed','completed',evidence_revision,repeat('b',64),{literal(frozen)}::jsonb,{actor},1 from public.workspaces where id={w};")
 f.sql(f"insert into public.jobs(id,workspace_id,type,entity_id,input_hash,status,created_by) values({literal(j)},{w},'draft_section',{literal(p)},repeat('b',64),'succeeded',{actor});")
 f.sql(f"insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values({literal(step)},{w},{literal(p)},{literal(j)},'draft_section','drafting',1,'{{}}',{literal(candidate)}::jsonb,'completed',{actor});")
 f.sql(f"insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values({literal(thread)},{w},{literal(j)},repeat('b',64),'draft_section','committed');")
 checked={'result':{'checked_candidate_hash':h,'reviewed_all_content':True,'claims':[],'findings':[]},'coverage':'aggregate'}
 f.sql(f"insert into app_private.model_graph_results(id,thread_id,result_key,value,content_hash) values({literal(receipt)},{literal(thread)},'accepted',{literal(candidate)}::jsonb,{literal(h)}),({literal(verification)},{literal(thread)},'chosen-verification',{literal(checked)}::jsonb,repeat('d',64));update app_private.model_graph_threads set result_id={literal(receipt)} where id={literal(thread)};")
 checkpoint={'channel_values':{'reportRef':verification}}
 f.sql(f"insert into app_private.model_graph_checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values({literal(thread)},'0001',{literal(checkpoint)}::jsonb,'{{}}');update public.jobs set checkpoint=jsonb_build_object('graph_thread',{literal(thread)},'model_executor',2) where id={literal(j)};")
 f.sql(f"insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,created_by,plan_id,evidence_revision,section_outline) select {literal(v)},id,{literal(base['proposal_id'])},1,repeat('c',64),{actor},{literal(p)},evidence_revision,jsonb_build_object('version',1,'groups','[]'::jsonb) from public.workspaces where id={w};")
 f.sql(f"insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,evidence_refs,created_by,content_blocks,requirement_ids,volume,fixed,company_claims) values({w},{literal(v)},'approach','Approach',{literal(body)},0,'[]',{actor},{literal(blocks)}::jsonb,'[]','technical',false,'[]');update public.proposals set active_version_id={literal(v)},state='draft' where id={literal(base['proposal_id'])};")
 issuance=f.scalar(f"insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at) select {w},{literal(p)},{actor},'proposal.generate',{literal(uid())},accepted,accepted+interval '600 seconds' from (select clock_timestamp()-make_interval(secs=>{600-remaining_seconds}) accepted) t returning id")
 f.sql(f"update public.generation_plans set issuance_request_id={literal(issuance)} where id={literal(p)};")
 checkpoint={'model_executor':4,'minimum_worker_executor':4,'generated_version_id':v,'generated_version_hash':'c'*64}
 f.sql(f"insert into public.jobs(id,workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values({literal(projection)},{w},'prepare_generated_delivery',{literal(p)},repeat('b',64),'queued',{actor},{literal(checkpoint)}::jsonb)")
 job=f.value("select public.claim_backend_local_job_v5()")
 assert job['id']==projection,job
 ctx=f.value(f"select public.generated_delivery_context({literal(projection)},{literal(job['lease_token'])})")
 assert len(ctx['accepted_receipts'])==1
 payload={'version':3,'title':frozen['title'],'language':'en','template':frozen['template'],'separate_volumes':False,'input_state':'available','content_state':'generated_review_draft','assurance_state':'source_review_required','substantive_complete':False,'approval_state':'draft','notice':'Synthetic SQL structural publication fixture; not semantic qualification.','source_manifest':ctx['source_manifest'],'input_materials':frozen['input_materials'],'sections':[{'section_key':'approach','title':'Approach','volume':'technical','kind':'accepted_unit','content_blocks':blocks,'source_ids':[],'provenance':None}],'gaps':[],'generation':{'proposal_version_id':v,'plan_id':p,'version_content_hash':'c'*64,'plan_input_hash':'b'*64,'machine_validation':{'policy':'generated-delivery-v1','version':1,'passed':True,'machine_eligible':True,'blockers':[],'substantive_complete':False},'machine_validation_hash':'e'*64,'receipt_pins':[{'step_id':step,'receipt_id':receipt,'verification_receipt_id':verification,'candidate_hash':h}]}}
 sql=f"begin;set local role service_role;select public.publish_generated_delivery({literal(projection)},{literal(job['lease_token'])},{literal(ctx['context_hash'])},{literal(payload)}::jsonb);commit;"
 return o,p,sql
