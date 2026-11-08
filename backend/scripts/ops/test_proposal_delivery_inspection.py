import copy
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
create table memberships(workspace_id uuid,user_id uuid,active boolean,role text);
create table identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);
create table restore_sessions(workspace_id uuid,state text);
create table opportunities(id uuid,workspace_id uuid,archived boolean);
create table generation_plans(id uuid,workspace_id uuid,opportunity_id uuid,proposal_id uuid,kind text,created_at timestamptz,
 status text,frozen_context jsonb,input_hash text,issuance_request_id uuid,workflow_version int);
create table proposals(id uuid,workspace_id uuid,opportunity_id uuid,active_version_id uuid);
create table proposal_versions(id uuid,workspace_id uuid,plan_id uuid,content_hash text);
create table jobs(id uuid,workspace_id uuid,entity_id uuid,type text,checkpoint jsonb,created_at timestamptz,status text,error_code text,
 lease_token uuid,lease_until timestamptz,input_hash text,created_by uuid);
create table generation_steps(id uuid,job_id uuid,workspace_id uuid,plan_id uuid,task text,ordinal int,status text,output jsonb);
create table requirements(id uuid,workspace_id uuid,plan_id uuid);
create table app_private.model_graph_threads(id text,workspace_id uuid,job_id uuid,status text,result_id uuid);
create table app_private.model_graph_results(id uuid,thread_id text,value jsonb,content_hash text);
create table app_private.model_graph_checkpoints(thread_id text,namespace text,checkpoint_id text,checkpoint jsonb);
create function app_private.assert_plan_source_resolution(uuid) returns void language plpgsql stable as $$begin return;end$$;
"""
        program=r"""
import{PGlite}from'@electric-sql/pglite';let raw='';for await(const p of process.stdin)raw+=p;const x=JSON.parse(raw),d=new PGlite();
await d.exec(x.setup);const q=(s,a=[])=>d.query(s,a),uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
await q("insert into memberships values($1,$2,true,'Owner')",[x.w,x.a]);await q("insert into identity_allowlist values($1,$2,'active','Owner')",[x.w,x.a]);
await q('insert into opportunities values($1,$2,false)',[x.o,x.w]);
await q("insert into generation_plans values($1,$2,$3,$4,'proposal',now(),'completed',$5,'input',$6,2)",[x.p,x.w,x.o,x.prop,{generated_delivery_version:3,source_resolution_version:1,private:'FORBIDDEN_CONTEXT'},x.i]);
await q('insert into proposals values($1,$2,$3,$4)',[x.prop,x.w,x.o,x.v]);await q("insert into proposal_versions values($1,$2,$3,'version')",[x.v,x.w,x.p]);
await q("insert into jobs values($1,$2,$3,'prepare_generated_delivery',$4,now(),'failed','GENERATED_DELIVERY_VALIDATION_FAILED',null,null,'input',$5)",[x.j,x.w,x.p,{generated_version_id:x.v,generated_version_hash:'version',issuance_request_id:x.i},x.a]);
const kinds=['valid','raw','malformed','oversized','other_thread','repair_only','bad_hash','output_mismatch','missing','extra_field'];
for(let n=0;n<kinds.length;n++){
 const kind=kinds[n],step=uid(100+n),job=uid(200+n),report=uid(300+n),accepted=uid(400+n),thread='t'+n,output={private:'FORBIDDEN_CANDIDATE'};
 await q("insert into jobs values($1,$2,$3,'draft_section',$4,now(),'succeeded',null,null,null,'input',$5)",[job,x.w,x.p,{graph_thread:thread},x.a]);
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
const execute=async()=>{const result=await d.exec(x.sql);return result.flatMap(r=>r.rows??[]).find(r=>Object.hasOwn(r,'current_setting')).current_setting;};
const normal=await execute();await q("update memberships set active=false");let refused=false;try{await execute();}catch(e){refused=e.message==='PRIVATE_DELIVERY_SELECTION';await d.exec('rollback');}
console.log(JSON.stringify({normal,refused}));await d.close();
"""
        query=m.sql(SELECTION,PROOF).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
        result=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps({'setup':setup,'sql':query,'w':W,'o':O,'a':A,'p':P,'v':V,'prop':PROP,'j':J,'i':I}),text=True,capture_output=True,cwd=m.ROOT/'backend',timeout=35)
        self.assertEqual(result.returncode,0,result.stderr[-6000:])
        values=json.loads(result.stdout);value=m.validate(values['normal'],SELECTION)
        self.assertTrue(values['refused']);self.assertEqual(value['workflow_version'],2);self.assertEqual(value['requirements_count'],0)
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
        self.assertIn("coalesce(checked.value->>'coverage','')<>'repair_only'",query)
        self.assertIn('jsonb_array_elements(decoded_refs)',query)
        self.assertIn(str(m.CONTEXT_BYTES),query)
        self.assertNotRegex(query,r'(?i)\b(insert|update|delete|truncate|grant|revoke|create|alter)\b')

if __name__=='__main__':unittest.main()
