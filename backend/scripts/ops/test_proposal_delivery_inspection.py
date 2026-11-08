import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('delivery_inspection_tested',HERE/'proposal-delivery-inspection.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
W,O,A,P,V,PROP,J,I=['00000000-0000-4000-8000-'+str(i).zfill(12) for i in range(1,9)]
SELECTION={'version':1,'workspace_id':W,'opportunity_id':O}
PROOF={'actor_id':A,'plan':{'id':P},'proposal':{'id':PROP,'active_version_id':V}}


class DeliveryInspectionTests(unittest.TestCase):
    def test_actual_sql_proves_typed_checkpoint_link_and_rejects_bad_envelopes(self):
        setup="""
create role tdp_app_owner;alter schema public owner to tdp_app_owner;create schema app_private authorization tdp_app_owner;
set role tdp_app_owner;
create table workspaces(id uuid);
create table memberships(workspace_id uuid,user_id uuid,active boolean,role text);
create table identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);
create table restore_sessions(workspace_id uuid,state text);
create table opportunities(id uuid,workspace_id uuid,archived boolean);
create table generation_plans(id uuid,workspace_id uuid,opportunity_id uuid,proposal_id uuid,kind text,created_at timestamptz,
 status text,frozen_context jsonb,input_hash text,issuance_request_id uuid,workflow_version int,stage text,error_code text,revision int,updated_at timestamptz);
create table proposals(id uuid,workspace_id uuid,opportunity_id uuid,active_version_id uuid);
create table proposal_versions(id uuid,workspace_id uuid,plan_id uuid,content_hash text,section_outline jsonb default '[]');
create table proposal_sections(id uuid,workspace_id uuid,proposal_version_id uuid,section_key text,ordinal int);
create table source_obligation_reviews(workspace_id uuid,review_id uuid,reason text,revision int);
create table jobs(id uuid,workspace_id uuid,entity_id uuid,type text,checkpoint jsonb,created_at timestamptz,status text,error_code text,
 lease_token uuid,lease_until timestamptz,input_hash text,created_by uuid,cancel_requested boolean default false,next_attempt_at timestamptz,revision int default 1,updated_at timestamptz);
create table proposal_issuance_requests(id uuid,workspace_id uuid,plan_id uuid,outcome text,error_code text,completed_at timestamptz,deadline_at timestamptz,accepted_at timestamptz,requested_by uuid);
create table audit_events(workspace_id uuid,actor_id uuid,action text,entity_type text,entity_id uuid,details jsonb);
create table generation_steps(id uuid,job_id uuid,workspace_id uuid,plan_id uuid,task text,ordinal int,status text,output jsonb);
create table requirements(id uuid,workspace_id uuid,plan_id uuid,source_semantics jsonb,source_refs jsonb);
create table model_attempts(id bigint,workspace_id uuid,job_id uuid,provider text,model text,operation text,usage_id uuid,execution_metadata jsonb,sent boolean,status text);
create table app_private.model_graph_threads(id text,workspace_id uuid,job_id uuid,status text,result_id uuid,input_hash text default repeat('a',64));
create table app_private.model_graph_results(id uuid,thread_id text,value jsonb,content_hash text,result_key text default 'synthetic-result');
create table app_private.model_graph_checkpoints(thread_id text,namespace text,checkpoint_id text,checkpoint jsonb);
create table app_private.inspection_source_guard(deny boolean);insert into app_private.inspection_source_guard values(false);
create function app_private.assert_plan_source_resolution(uuid) returns void language plpgsql stable as $$begin
 if exists(select 1 from app_private.inspection_source_guard where deny) then raise exception 'SOURCE_RESOLUTION_STALE';end if;end$$;
create function app_private.delivery_actor(uuid,uuid,boolean) returns void language plpgsql stable as $$begin return;end$$;
create function app_private.check_delivery_sources(uuid,jsonb) returns void language plpgsql stable as $$begin return;end$$;
create function app_private.check_delivery_materials(uuid,jsonb) returns void language plpgsql stable as $$begin return;end$$;
create function app_private.delivery_input(uuid,uuid) returns jsonb language sql stable as $$select '{"input_materials":{"documents":[]}}'::jsonb$$;
create function app_private.check_source_semantics(uuid,jsonb,jsonb) returns boolean language sql stable as $$select true$$;
create function app_private.delivery_input_review_complete(uuid,jsonb) returns boolean language sql stable as $$select true$$;
"""
        # Execute the actual production failure chain; do not invent the
        # terminal plan state that the inspector is supposed to diagnose.
        deadlines=(m.ROOT/'backend/supabase/migrations/20261104142525_proposal_issuance_deadline.sql').read_text()
        generated=m.SOURCE.read_text()
        for source,marker in ((deadlines,'create function app_private.issuance_deadline_reached('),
            (deadlines,'create function app_private.fail_proposal_issuance('),
            (generated,'create function public.fail_generated_delivery(')):
            setup+=marker+source.split(marker,1)[1].split('$$;',1)[0]+'$$;'
        program=r"""
import{PGlite}from'@electric-sql/pglite';let raw='';for await(const p of process.stdin)raw+=p;const x=JSON.parse(raw),d=new PGlite();
await d.exec(x.setup);const q=(s,a=[])=>d.query(s,a),uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
await q('insert into workspaces values($1)',[x.w]);await q("insert into memberships values($1,$2,true,'Owner')",[x.w,x.a]);await q("insert into identity_allowlist values($1,$2,'active','Owner')",[x.w,x.a]);
await q('insert into opportunities values($1,$2,false)',[x.o,x.w]);
await q("insert into generation_plans values($1,$2,$3,$4,'proposal',now(),'completed',$5,'input',$6,2,'completed',null,1,now())",[x.p,x.w,x.o,x.prop,{generated_delivery_version:3,source_resolution_version:1,private:'FORBIDDEN_CONTEXT'},x.i]);
await q('insert into proposals values($1,$2,$3,$4)',[x.prop,x.w,x.o,x.v]);await q("insert into proposal_versions(id,workspace_id,plan_id,content_hash) values($1,$2,$3,'version')",[x.v,x.w,x.p]);
await q("insert into jobs(id,workspace_id,entity_id,type,checkpoint,created_at,status,error_code,lease_token,lease_until,input_hash,created_by) values($1,$2,$3,'prepare_generated_delivery',$4,now(),'running',null,'00000000-0000-4000-8000-000000000099',now()+interval '1 minute','input',$5)",[x.j,x.w,x.p,{generated_version_id:x.v,generated_version_hash:'version',issuance_request_id:x.i},x.a]);
await q("insert into proposal_issuance_requests values($1,$2,$3,'active',null,null,now()+interval '10 minutes',now(),$4)",[x.i,x.w,x.p,x.a]);
await q("select public.fail_generated_delivery($1,'00000000-0000-4000-8000-000000000099','GENERATED_DELIVERY_VALIDATION_FAILED')",[x.j]);
const failed=(await q('select status,stage,error_code from generation_plans where id=$1',[x.p])).rows[0];
if(failed.status!=='failed'||failed.stage!=='completed'||failed.error_code!=='GENERATED_DELIVERY_VALIDATION_FAILED')throw Error('ACTUAL_FAILURE_STATE');
const kinds=['valid','raw','malformed','oversized','other_thread','repair_only','bad_hash','output_mismatch','missing','extra_field'];
for(let n=0;n<kinds.length;n++){
 const kind=kinds[n],step=uid(100+n),job=uid(200+n),report=uid(300+n),accepted=uid(400+n),thread='t'+n,output={private:'FORBIDDEN_CANDIDATE'};
 await q("insert into jobs(id,workspace_id,entity_id,type,checkpoint,created_at,status,error_code,lease_token,lease_until,input_hash,created_by) values($1,$2,$3,'draft_section',$4,now(),'succeeded',null,null,null,'input',$5)",[job,x.w,x.p,{graph_thread:thread},x.a]);
 await q("insert into generation_steps values($1,$2,$3,$4,'draft_section',$5,'completed',$6)",[step,job,x.w,x.p,n,kind==='output_mismatch'?{}:output]);
 await q("insert into app_private.model_graph_threads values($1,$2,$3,'accepted',$4)",[thread,x.w,job,accepted]);
 await q("insert into app_private.model_graph_results values($1,$2,$3,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex'))",[accepted,thread,output]);
 await q("insert into app_private.model_graph_results values($1,$2,$3,case when $4 then 'bad' else encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex') end)",[report,kind==='other_thread'?'different':thread,{coverage:kind==='repair_only'?'repair_only':'full',private:'FORBIDDEN_REPORT'},kind==='bad_hash']);
 if(kind==='missing')continue;
 const state={channel_values:{reportRef:report,private:'FORBIDDEN_CHECKPOINT'}};
 let checkpoint={type:'json',data:Buffer.from(JSON.stringify(state)).toString('base64')};
 if(kind==='raw')checkpoint=state;if(kind==='malformed')checkpoint.data='!!!=';
 if(kind==='oversized')checkpoint.data='A'.repeat(262148);if(kind==='extra_field')checkpoint.unexpected=true;
 await q("insert into app_private.model_graph_checkpoints values($1,'','0002',$2)",[thread,checkpoint]);
 // A newer checkpoint in a different namespace must never replace the selected one.
 await q("insert into app_private.model_graph_checkpoints values($1,'other','9999',$2)",[thread,{channel_values:{reportRef:uid(999)}}]);
}
const execute=async(sql=x.sql)=>{let result;try{result=await d.exec(sql);}catch(e){throw Error(e.message);}return result.flatMap(r=>r.rows??[]).find(r=>Object.hasOwn(r,'current_setting')).current_setting;};
const normal=await execute();const prospective=await execute(x.context_sql);
await q('update app_private.inspection_source_guard set deny=true');const blocked=await execute(x.context_sql);await q('update app_private.inspection_source_guard set deny=false');
if((await q('select status from generation_plans where id=$1',[x.p])).rows[0].status!=='failed')throw Error('INSPECTION_CHANGED_PLAN');
await q("update proposal_issuance_requests set error_code='OTHER_FAILURE'");let mismatch=false;try{await execute();}catch(e){mismatch=e.message==='PRIVATE_DELIVERY_SELECTION';await d.exec('rollback');}
if(!mismatch)throw Error('ISSUANCE_MISMATCH_ACCEPTED');await q("update proposal_issuance_requests set error_code='GENERATED_DELIVERY_VALIDATION_FAILED'");
await q("update memberships set active=false");let refused=false;try{await execute();}catch(e){refused=e.message==='PRIVATE_DELIVERY_SELECTION';await d.exec('rollback');}
console.log(JSON.stringify({normal,prospective,blocked,refused}));await d.close();
"""
        query=m.sql(SELECTION,PROOF).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
        result=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps({'setup':setup,'sql':query,'context_sql':m.sql(SELECTION,PROOF,include_context=True).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"),'w':W,'o':O,'a':A,'p':P,'v':V,'prop':PROP,'j':J,'i':I}),text=True,capture_output=True,cwd=m.ROOT/'backend',timeout=35)
        self.assertEqual(result.returncode,0,result.stderr[-6000:])
        values=json.loads(result.stdout);value=m.validate(values['normal'],SELECTION)
        self.assertTrue(values['refused']);self.assertEqual(value['stored_plan_status'],'failed');self.assertEqual(value['stored_plan_stage'],'completed');self.assertEqual(value['workflow_version'],2);self.assertEqual(value['requirements_count'],0)
        self.assertEqual(value['completed_steps'],10);self.assertEqual(value['task_counts'],{'draft_section':10})
        rows=value['steps'];self.assertFalse(rows[0]['direct_receipt_eligible']);self.assertTrue(rows[0]['decoded_receipt_eligible'])
        self.assertTrue(rows[0]['decoded_report_hash_bound']);self.assertEqual(rows[1]['decode_status'],'unsupported')
        self.assertEqual(rows[2]['decode_status'],'malformed');self.assertEqual(rows[3]['decode_status'],'oversized')
        self.assertFalse(rows[4]['decoded_report_exists']);self.assertFalse(rows[5]['decoded_receipt_eligible'])
        self.assertFalse(rows[6]['decoded_report_hash_bound']);self.assertFalse(rows[7]['decoded_receipt_eligible'])
        self.assertEqual(rows[8]['decode_status'],'missing');self.assertEqual(rows[9]['decode_status'],'unsupported')
        serialized=json.dumps(value)
        for forbidden in ('FORBIDDEN_CONTEXT','FORBIDDEN_CANDIDATE','FORBIDDEN_REPORT','FORBIDDEN_CHECKPOINT','channel_values','lease_token'):
            self.assertNotIn(forbidden,serialized)
        self.assertEqual(value['context_status'],'not_requested');self.assertIsNone(value['prospective_context'])
        prospective=m.validate(values['prospective'],SELECTION,include_context=True)
        self.assertEqual(prospective['context_status'],'available')
        self.assertEqual(prospective['stored_plan_status'],'failed')
        self.assertEqual(prospective['prospective_context']['plan']['status'],'completed')
        self.assertIsNone(prospective['prospective_context']['plan']['error_code'])
        self.assertEqual(len(prospective['prospective_context']['accepted_receipts']),2)
        self.assertIn('FORBIDDEN_CANDIDATE',json.dumps(prospective['prospective_context']))
        # Exceed the previous raw1.25MB threshold without omitting any field.
        prospective['prospective_context']['private_large']='source prose '*140000
        expected=copy.deepcopy(prospective['prospective_context'])
        packed=m.validate(m.pack_context(prospective),SELECTION,include_context=True,packed=True)
        envelope=packed['prospective_context'];decoded=gzip.decompress(base64.b64decode(envelope['data'],validate=True))
        self.assertEqual(json.loads(decoded),expected)
        self.assertGreater(envelope['raw_bytes'],1_250_000)
        self.assertEqual(len(decoded),envelope['raw_bytes'])
        self.assertEqual(hashlib.sha256(decoded).hexdigest(),envelope['raw_sha256'])
        self.assertLess(len(json.dumps(packed).encode()),m.MAX_BYTES)
        for field in ('raw_bytes','raw_sha256'):
            bad=copy.deepcopy(packed)
            bad['prospective_context'][field]=1 if field=='raw_bytes' else '0'*64
            with self.assertRaises(ValueError):m.validate(bad,SELECTION,include_context=True,packed=True)

        blocked=m.validate(values['blocked'],SELECTION,include_context=True)
        self.assertEqual(blocked['context_status'],'source_guard_failed');self.assertIsNone(blocked['prospective_context'])
        for change in ('extra','selection','count'):
            bad=copy.deepcopy(value)
            if change=='extra':bad['steps'][0]['raw']='customer-content'
            elif change=='selection':bad['selection']['opportunity_id']=P
            else:bad['receipt_counts']['decoded_receipt_eligible']+=1
            with self.assertRaises(ValueError):m.validate(bad,SELECTION)

    def test_no_lease_mutation_or_provider_rpc_and_private_failure_is_fixed(self):
        query=m.sql(SELECTION,PROOF)
        self.assertIn('READ ONLY',query);self.assertTrue(query.rstrip().endswith('ROLLBACK;'))
        self.assertIn("statement_timeout='10s'",query)
        self.assertNotRegex(query,r'(?i)\b(insert|update|delete|truncate|grant|revoke|create|alter)\b')
        self.assertNotIn('generated_delivery_job(',query);self.assertNotIn('generated_delivery_context(',query)
        self.assertNotIn('claim_backend',query)
        request=SimpleNamespace(validate_selection=Mock(),validate_proof=Mock(),read=Mock(side_effect=ValueError('private customer text')))
        result=m.capture(object(),SELECTION,request,PROOF)
        self.assertEqual(result['status'],'unavailable');self.assertNotIn('private customer',json.dumps(result))
        request.read.assert_called_once();request.validate_selection.assert_called_once_with(SELECTION)
        request.validate_selection.side_effect=ValueError('bad selection');request.read.reset_mock()
        with self.assertRaises(ValueError):m.capture(object(),SELECTION,request,PROOF)
        request.read.assert_not_called()

    def test_optional_projection_keeps_exact_read_checks_and_never_leases(self):
        query=m.sql(SELECTION,PROOF,include_context=True)
        self.assertNotIn('app_private.generated_delivery_job(',query)
        for check in ('app_private.delivery_actor','app_private.check_delivery_sources','app_private.check_delivery_materials','app_private.current_document_extraction','app_private.assert_plan_source_resolution'):
            self.assertIn(check,query)
        self.assertIn('accepted.value=s.output',query)
        self.assertIn("p.status:='completed';p.error_code:=NULL;",query)
        self.assertIn("'stored_plan_status',p.status",query)
        self.assertIn("coalesce(checked.value->>'coverage','')<>'repair_only'",query)
        self.assertIn('jsonb_array_elements(decoded_refs)',query)
        self.assertIn(str(m.CONTEXT_BYTES),query)
        self.assertNotRegex(query,r'(?i)\b(insert|update|delete|truncate|grant|revoke|create|alter)\b')

if __name__=='__main__':unittest.main()
