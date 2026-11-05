#!/usr/bin/env python3
"""Real isolated PostgreSQL retirement state tests. Process/PVC evidence is synthetic.

This suite tests SQL validation and authorization, never claims actual Kubernetes
quiescence or StorageAPI behavior. The pinned-container suite owns those facts.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid
from postgres_races import PostgresFixture, OWNER, literal, docker

IMAGE='docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799'

def run(repository,container):
 f=PostgresFixture(repository,container=container)
 results=[]
 role="tdp_retirement_"+uuid.uuid4().hex[:12]
 try:
  f.start()
  # Only the two retirement functions run as this non-superuser application
  # owner. Storage stays separately owned and its schema USAGE is absent.
  f.sql(f"""create role {role} nologin nosuperuser nobypassrls;
   grant usage on schema public,app_private to {role};
   grant execute on all functions in schema app_private to {role};
   do $$declare r record;begin for r in select n.nspname,c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private')
    and c.relkind in ('r','p') loop
    execute format('alter table %I.%I owner to {role}',r.nspname,r.relname);end loop;end$$;
   alter function app_private.prepare_storage_write_retirement(uuid,uuid,jsonb) owner to {role};
   alter function app_private.finish_storage_write_retirement(uuid,uuid,jsonb) owner to {role};
  """)
  def ok(name,condition):
   if not condition:raise AssertionError(name)
   results.append(name)
  def blocked(sql,code):
   r=f.sql(sql,False)
   if r.returncode and code not in r.stderr:raise RuntimeError(r.stderr)
   return r.returncode!=0 and code in r.stderr
  def seed(state='legacy_unfenced',done=False):
   key=f.workspace+'/retirement-fixture/'+str(uuid.uuid4())
   f.sql(f"insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason,status) values({literal(f.workspace)},{literal(key)},10485760,'isolated_fixture',{literal('done' if done else 'blocked')});")
   if state!='legacy_unfenced':
    f.sql(f"update public.storage_write_intents set state={literal(state)},expected_hash=repeat('a',64),expected_size=123,started_at=clock_timestamp(),observed_at=case when {literal(state)}='observed' then clock_timestamp() end where storage_key={literal(key)}")
   return f.value(f"select jsonb_build_object('id',id,'storage_key',storage_key,'retirement_nonce',retirement_nonce,'revision',revision) from public.storage_write_intents where storage_key={literal(key)}")
  def prepare(item,nonce):return f.value(f"select app_private.prepare_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal([item])}::jsonb)")
  def finish(batch,proof):return f.value(f"select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(batch['operation_nonce'])},{literal(proof)}::jsonb)")
  def proof(batch):
   return {'version':1,'operation_nonce':batch['operation_nonce'],'scope_sha256':batch['scope_sha256'],
    'source_revision':'a'*40,'run_id':'1','run_attempt':'1','namespace_uid':str(uuid.uuid4()),
    'cluster_id':'a6093a76-a2d6-47fd-8697-579d41ed316f','storage_image':IMAGE,
    'physical_helper_sha256':'b'*64,'fence_sha256':f.scalar("set search_path='';select encode(sha256(convert_to(pg_get_functiondef('public.guard_retired_storage_write()'::regprocedure)||pg_get_triggerdef(oid),'UTF8')),'hex') from pg_trigger where tgname='tenderdesk_retired_storage_write'"),
    'quiescence':[{'name':name,'deployment_uid':str(uuid.uuid4()),'image':IMAGE if name=='storage' else 'example.invalid/synthetic@sha256:'+'a'*64,
     'original_replicas':1,'pods':[{'uid':str(uuid.uuid4()),'containers':[{'name':name,'container_id':'containerd://'+'b'*64,
      'finished_at':datetime.now(timezone.utc).isoformat(),'exit_code':0}]}]} for name in ('worker','gateway','storage')],
    'keys':[{'id':i['id'],'retirement_nonce':i['retirement_nonce'],'storage_key_sha256':hashlib.sha256(i['storage_key'].encode()).hexdigest(),
     'before_manifest_sha256':'d'*64,'after_manifest_sha256':'e'*64,'remaining_count':0,'metadata_remaining':0,'removed_count':0,'removed_bytes':0} for i in batch['scope']]}
  ok('managed_owner_has_no_storage_usage',f.scalar(f"select has_schema_privilege({literal(role)},'storage','USAGE')")=='f')
  ok('managed_owner_not_superuser_or_bypassrls',f.scalar(f"select rolsuper or rolbypassrls from pg_roles where rolname={literal(role)}")=='f')
  item=seed();nonce=str(uuid.uuid4())
  ok('prepare_requires_installed_fence',blocked(f"select app_private.prepare_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal([item])}::jsonb)",'STORAGE_RETIREMENT_FENCE_REQUIRED'))
  f.sql('create trigger tenderdesk_retired_storage_write before insert or update on storage.objects for each row execute function public.guard_retired_storage_write()')
  batch=prepare(item,nonce)
  ok('prepare_saved_exact_scope',batch['scope'][0]['storage_key']==item['storage_key'] and batch['state']=='prepared')
  ok('fenced_future_insert',blocked(f"insert into storage.objects(bucket_id,name) values('tenderdesk-private',{literal(item['storage_key'])})",'STORAGE_KEY_RETIRED'))
  for suffix in ('.info','/00000000-0000-4000-8000-000000000001.info','-$v-00000000-0000-4000-8000-000000000001'):
   ok('fenced_alias_'+suffix,blocked(f"insert into storage.objects(bucket_id,name) values('tenderdesk-private',{literal(item['storage_key']+suffix)})",'STORAGE_KEY_RETIRED'))
  ok('different_nonce_cannot_adopt_fence',blocked(f"select app_private.prepare_storage_write_retirement({literal(OWNER)},{literal(str(uuid.uuid4()))},{literal([item])}::jsonb)",'STORAGE_RETIREMENT_KEY_CONFLICT'))
  p=proof(batch);bad=json.loads(json.dumps(p));bad['keys'][0]['remaining_count']=1
  ok('physical_remaining_rejected',blocked(f"select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal(bad)}::jsonb)",'STORAGE_RETIREMENT_PROOF_INVALID'))
  bad=json.loads(json.dumps(p));bad['quiescence'][2]['image']='other@sha256:'+'f'*64
  ok('binary_proof_contradiction_rejected',blocked(f"select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal(bad)}::jsonb)",'STORAGE_RETIREMENT_PROOF_INVALID'))
  ok('failed_proof_keeps_allowance',f.scalar(f"select status from public.storage_cleanup_queue where storage_key={literal(item['storage_key'])}")=='blocked')
  complete=finish(batch,p)
  ok('proof_releases_real_allowance',complete['state']=='complete' and f.scalar(f"select status from public.storage_cleanup_queue where storage_key={literal(item['storage_key'])}")=='done')
  ok('lost_finish_ack_exact_replay',finish(batch,p)==complete)
  ok('lost_finish_ack_prepare_original_replay',prepare(item,nonce)==complete)
  bad=json.loads(json.dumps(p));bad['run_attempt']='2'
  ok('different_completion_proof_rejected',blocked(f"select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal(bad)}::jsonb)",'STORAGE_RETIREMENT_EVIDENCE_CONFLICT'))
  unknown=seed('unknown');b=prepare(unknown,str(uuid.uuid4()))
  f.sql(f"select app_private.observe_render_storage_write({literal(unknown['storage_key'])},repeat('a',64),123)")
  ok('single_positive_read_during_drain_allowed',finish(b,proof(b))['state']=='complete')
  observed=seed('observed');b=prepare(observed,str(uuid.uuid4()))
  ok('uncertain_delete_can_retire',finish(b,proof(b))['state']=='complete')
  changed=seed();b=prepare(changed,str(uuid.uuid4()));p=proof(b)
  f.sql(f"update public.storage_write_intents set revision=revision+2 where id={literal(changed['id'])}")
  ok('unrelated_revision_drift_fails_closed',blocked(f"select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(b['operation_nonce'])},{literal(p)}::jsonb)",'REVISION_CONFLICT'))
  done=seed(done=True);b=prepare(done,str(uuid.uuid4()));finish(b,proof(b))
  ok('historical_done_census_never_creates_hold',f.scalar(f"select status||':'||attempts from public.storage_cleanup_queue where storage_key={literal(done['storage_key'])}")=='done:0')
  f.sql(f"delete from public.storage_cleanup_queue where storage_key={literal(done['storage_key'])};delete from public.storage_write_intents where id={literal(done['id'])}")
  ok('fence_survives_artifact_intent_cleanup_deletion',blocked(f"insert into storage.objects(bucket_id,name) values('tenderdesk-private',{literal(done['storage_key'])})",'STORAGE_KEY_RETIRED'))
  ok('permanent_tables_have_no_cascading_workspace_fk',f.scalar("select count(*) from pg_constraint where contype='f' and conrelid in ('app_private.storage_retirement_batches'::regclass,'app_private.storage_retirement_keys'::regclass)")=='0')
  ok('retirement_not_in_tenant_backup',f.scalar("select not ('storage_retirement_keys'=any(app_private.backup_tables()) or 'storage_retirement_batches'=any(app_private.backup_tables()) or 'storage_write_intents'=any(app_private.backup_tables()))")=='t')
  ok('authenticated_cannot_assert_quiescence',blocked(f"begin;set local role authenticated;select app_private.finish_storage_write_retirement({literal(OWNER)},{literal(nonce)},{literal(p)}::jsonb);commit",'permission denied'))
  alias=seed();alias_nonce=str(uuid.uuid4())
  f.sql(f"insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values({literal(f.workspace)},{literal(alias['storage_key']+'.info')},1,'isolated_alias')")
  ok('known_application_alias_blocks_before_fence',blocked(f"select app_private.prepare_storage_write_retirement({literal(OWNER)},{literal(alias_nonce)},{literal([alias])}::jsonb)",'STORAGE_RETIREMENT_NAMESPACE_COLLISION'))
  ok('known_alias_leaves_no_permanent_fence',f.scalar(f"select count(*) from app_private.storage_retirement_keys where operation_nonce={literal(alias_nonce)}")=='0')
  demote=seed();demote_nonce=str(uuid.uuid4())
  race=f.race([f"select app_private.prepare_storage_write_retirement({literal(OWNER)},{literal(demote_nonce)},{literal([demote])}::jsonb)"],before_release=f"update public.memberships set role='Reviewer' where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
  ok('owner_demotion_while_waiting_rechecked_after_lock',race[0].returncode!=0 and 'ROLE_FORBIDDEN' in race[0].stderr)
  f.sql(f"update public.memberships set role='Owner' where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)}")
  return {'version':1,'result':'passed','tests':results,'count':len(results),'database':'isolated_postgresql','synthetic_process_evidence':True,'actual_storage_or_kubernetes_proof':False,'migrations':f.migrations}
 finally:
  if not f.owns_container:docker('exec',f.container,'dropdb','-U','postgres','--if-exists',f.database)
  f.close()
  if not f.owns_container:docker("exec",f.container,"psql","-U","postgres","-c",f"drop role if exists {role}")

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--repository',type=Path,default=Path(__file__).resolve().parents[3]);p.add_argument('--container',default=None);a=p.parse_args();print(json.dumps(run(a.repository,a.container),sort_keys=True))
