import copy
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('tested_commercial_inspection',HERE/'proposal-commercial-inspection.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
W,O,P,J=['00000000-0000-4000-8000-%012d'%n for n in range(1,5)]
SELECTION={'version':1,'workspace_id':W,'opportunity_id':O}


def candidate():
    return {'lines':[{'description':'Private commercial line 1.','quantity':None,'unit':'package','rate_id':None,
        'period_count':None,'included_in_base':True,'charge_group':'one_time','tax_category':'unconfirmed',
        'requirement_ids':[],'section_ids':[],'deliverable':'Proposed delivery.','basis':'Unconfirmed estimate.'}],
        'tasks':[],'questions':[{'question':'Confirm quantity.','blocking_level':'generation','requirement_ids':[]}]}


def report():
    return {'checked_candidate_hash':'a'*64,'reviewed_all_content':True,'processed_content_ids':['content-0'],
        'claims':[{'id':'claim-1','claim':'Commercial line 1.','candidate_quote':'Private commercial line 1.',
            'kind':'commercial_commitment','status':'supported','source_refs':[{'id':'source-1','quote':'Exact private source quote.'}],
            'finding':'Review the numeric support.'}],'processed_requirement_ids':[],'requirement_checks':[],'findings':[]}


class CommercialInspectionTests(unittest.TestCase):
    def test_read_only_selection_and_private_projection_execute_against_postgres(self):
        schema='''CREATE ROLE tdp_app_owner;GRANT ALL ON SCHEMA public TO tdp_app_owner;
CREATE SCHEMA app_private AUTHORIZATION tdp_app_owner;SET ROLE tdp_app_owner;
CREATE TABLE generation_plans(id uuid,workspace_id uuid,opportunity_id uuid,kind text,created_at timestamptz,frozen_context jsonb);
CREATE TABLE jobs(id uuid,workspace_id uuid,entity_id uuid,type text,status text,error_code text,checkpoint jsonb,created_at timestamptz);
CREATE TABLE generation_steps(job_id uuid,workspace_id uuid,plan_id uuid,repair_count int);
CREATE TABLE app_private.model_graph_threads(id text,workspace_id uuid,job_id uuid,status text,candidate_count int,budget_version int,created_at timestamptz);
CREATE TABLE app_private.model_graph_results(id uuid DEFAULT gen_random_uuid(),thread_id text,workspace_id uuid,result_key text,value jsonb,created_at timestamptz DEFAULT now());
RESET ROLE;'''
        script='''import {PGlite} from '@electric-sql/pglite';
let raw='';for await(const c of process.stdin)raw+=c;const x=JSON.parse(raw),d=new PGlite();await d.exec(x.schema);
const old='00000000-0000-4000-8000-000000000091',other='00000000-0000-4000-8000-000000000092';
for(const [id,opp,stamp] of [[x.p,x.o,'2026-11-08'],[old,x.o,'2026-11-07'],[other,other,'2026-11-09']])
 await d.query("insert into generation_plans values($1,$2,$3,'proposal',$4,$5)",[id,x.w,opp,stamp,{private:'forbidden-full-frozen-context'}]);
for(const [id,plan,kind,stamp] of [[x.j,x.p,'plan_commercial','2026-11-08'],[old,x.p,'plan_commercial','2026-11-07'],[other,other,'plan_commercial','2026-11-09']])
 await d.query("insert into jobs values($1,$2,$3,$4,'running',null,$5,$6)",[id,x.w,plan,kind,{graph_thread:'c'.repeat(64),model_operation:{task:'verify_grounding'},model_routing:{round_attempts:3}},stamp]);
await d.query('insert into generation_steps values($1,$2,$3,1)',[x.j,x.w,x.p]);
for(const [thread,job,stamp] of [['c',x.j,'2026-11-08'],['d',x.j,'2026-11-09'],['e',other,'2026-11-09']])
 await d.query("insert into app_private.model_graph_threads values($1,$2,$3,'running',2,2,$4)",[thread.repeat(64),x.w,job,stamp]);
async function add(thread,key,value,seconds){await d.query("insert into app_private.model_graph_results(thread_id,workspace_id,result_key,value,created_at) values($1,$2,$3,$4,'2026-11-08'::timestamptz+make_interval(secs=>$5))",[thread.repeat(64),x.w,key,value,seconds]);}
for(let i=0;i<3;i++)await add('c','candidate-'+i,{result:i?{target_task:'plan_commercial',result:x.candidate,changes:['Private correction.']}:x.candidate,producer:{key:'forbidden-provider-secret',project:'forbidden-project'},frozen_context:'forbidden-full-context'},i);
for(let i=0;i<4;i++){
 await add('c','verification-v3-'+('a'.repeat(64))+'-content-'+i,{result:x.report,producer:{key:'forbidden-provider-secret'}},10+i);
 await add('c','invalid-report-'+String(i).repeat(64),{result:x.report,code:'EVIDENCE_REFERENCE_INVALID',verification_key:'verification-v3-'+('a'.repeat(64))+'-content-'+i,validation_diagnostics:[{code:'EVIDENCE_REFERENCE_INVALID',reason:'numeric_evidence_mismatch',paths:['$.claims[0].candidate_quote'],numeric_literals:['1']}],producer:{key:'forbidden-provider-secret'}},20+i);
}
await add('c','verification-batches-'+('a'.repeat(64)),{version:6,context_format:4,partition:{version:4,policy:{version:2,outputTokens:40000}}},30);
for(const thread of ['d','e'])await add(thread,'candidate-0',{result:{private:'forbidden-other-thread'}},40);
async function read(){const values=await d.exec(x.sql);return values.flatMap(r=>r.rows??[]).find(r=>r.jsonb_build_object)?.jsonb_build_object;}
const normal=await read();
const huge=structuredClone(x.candidate);huge.lines=Array.from({length:100},()=>({...huge.lines[0],description:'x'.repeat(3000),deliverable:'y'.repeat(3000),basis:'z'.repeat(3000)}));
await d.query("update app_private.model_graph_results set value=$1 where thread_id=$2 and result_key like 'candidate-%'",[{result:huge},'c'.repeat(64)]);
const oversized=await read();await d.query('delete from jobs where id=$1',[x.j]);const missing=await read();
console.log(JSON.stringify({normal,oversized,missing}));await d.close();'''
        completed=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps({'schema':schema,'sql':m.sql(SELECTION),
            'w':W,'o':O,'p':P,'j':J,'candidate':candidate(),'report':report()}),text=True,capture_output=True,cwd=HERE.parent.parent,timeout=35)
        self.assertEqual(completed.returncode,0,completed.stderr)
        values=json.loads(completed.stdout);normal=m.validate(values['normal'],SELECTION)
        self.assertEqual(normal['job']['id'],J);self.assertEqual(normal['thread']['id'],'c'*64)
        self.assertEqual(normal['counts'],{'candidate':3,'report':4,'invalid_report':4})
        self.assertEqual(len(normal['records']),9);self.assertEqual(normal['pins'][0]['policy']['outputTokens'],40000)
        self.assertTrue(any(r['category']=='invalid_report' and r['diagnostics'][0]['numeric_literals']==['1'] for r in normal['records']))
        aggregate=copy.deepcopy(normal)
        next(r for r in aggregate['records'] if r['category']=='report')['body']['claims']*=129
        m.validate(aggregate,SELECTION)
        serialized=json.dumps(normal)
        self.assertIn('Private commercial line 1.',serialized);self.assertIn('Exact private source quote.',serialized)
        for private in ('forbidden-provider-secret','forbidden-project','forbidden-full-context','forbidden-full-frozen-context','forbidden-other-thread','producer'):
            self.assertNotIn(private,serialized)
        self.assertEqual(m.validate(values['oversized'],SELECTION)['status'],'oversized')
        self.assertEqual(values['oversized']['records'],[])
        self.assertEqual(m.validate(values['missing'],SELECTION)['job']['id'],'00000000-0000-4000-8000-000000000091')
        for change in ('selection','producer','extra_records'):
            bad=copy.deepcopy(normal)
            if change=='selection':bad['selection']=dict(SELECTION,opportunity_id=P)
            elif change=='producer':bad['records'][0]['producer']={'key':'secret'}
            else:bad['records']*=2
            with self.assertRaises(ValueError):m.validate(bad,SELECTION)
        query=m.sql(SELECTION)
        self.assertIn('READ ONLY',query);self.assertIn("statement_timeout='10s'",query)
        self.assertTrue(query.rstrip().endswith('ROLLBACK;'))
        self.assertNotRegex(query,r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|for update')
        self.assertNotIn('frozen_context',query)

    def test_failure_is_fixed_and_selection_is_checked_before_query(self):
        request=SimpleNamespace(validate_selection=Mock(),read=Mock(side_effect=RuntimeError('private failure')))
        value=m.capture(object(),SELECTION,request)
        self.assertEqual(value['status'],'unavailable');self.assertNotIn('private failure',json.dumps(value))
        request.read.assert_called_once();request.validate_selection.assert_called_once_with(SELECTION)
        request.validate_selection.side_effect=ValueError('invalid selection');request.read.reset_mock()
        with self.assertRaises(ValueError):m.capture(object(),dict(SELECTION,opportunity_id="'; delete"),request)
        request.read.assert_not_called()
        with self.assertRaises(ValueError):m.sql(dict(SELECTION,opportunity_id="'; delete"))

    def test_complete_private_envelope_replaces_large_snapshot_with_explicit_status(self):
        value={'selection':SELECTION,'commercial_snapshot':{'plan_id':P,'private':'x'*m.MAX_BYTES},'metadata':'safe'}
        m.fit_report(value)
        self.assertEqual(value['commercial_snapshot']['status'],'oversized')
        self.assertEqual(value['commercial_snapshot']['records'],[])
        self.assertLess(len(json.dumps(value).encode()),m.MAX_BYTES)


if __name__=='__main__':unittest.main()
