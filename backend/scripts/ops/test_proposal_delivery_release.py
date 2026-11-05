"""Exact source, real SQL rollback/replay, private row and authority invariants."""
import copy
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('tested_delivery_release',Path(__file__).with_name('proposal-delivery-release.py'))
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)

class DeliveryReleaseTests(unittest.TestCase):
    def setUp(self):
        # This is an isolated source-binding fixture, not an executed gateway
        # qualification receipt. Production freeze always reads its fixed files.
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.gateway_root=Path(temporary.name)
        baseline=(p.ROOT/p.GATEWAY_BEFORE).read_text()
        self.gateway_image='docker.io/nginxinc/nginx-unprivileged:1.29.5-alpine@sha256:99e7cb7bee644b244b2b5e7bb737e972e54dbaa150cabc7ae0598731cdeb7ac8'
        self.gateway_storage=baseline+'\n# Synthetic prior target; no runtime qualification asserted.\n'
        self.gateway_after=self.gateway_storage.replace('worker_processes auto;', 'worker_processes 1;')+'# Synthetic combined target.\n'
        self.qualification={'passed':True,'actual_binary_exercised':True,'production_calls':0,'customer_calls':0,
          'gateway_resumable_denial_qualified':True,'signed_tus_bypass_confirmed':True,
          'gateway_config_source_sha256':hashlib.sha256(self.gateway_storage.encode()).hexdigest(),
          'gateway_image':self.gateway_image,'fixture':'synthetic-only'}
        self.batch_qualification={'passed':True,'actual_binary_exercised':True,'production_calls':0,'customer_calls':0,
          'legacy_rpc_denial_qualified':True,'gateway_resumable_denial_qualified':True,'ordinary_routing_preserved':True,
          'restart_denial_qualified':True,'cleanup_confirmed':True,'postgrest_error_envelope_qualified':True,'gateway_image':self.gateway_image,
          'gateway_before_source_sha256':hashlib.sha256(self.gateway_storage.encode()).hexdigest(),
          'gateway_config_source_sha256':hashlib.sha256(self.gateway_after.encode()).hexdigest(),
          'storage_qualification_sha256':hashlib.sha256(json.dumps(self.qualification).encode()).hexdigest()}
        self.stream_qualification={'fixture':'synthetic-only',**dict.fromkeys(('passed','actual_binary_exercised','cleanup_confirmed','exact_delivery_qualified','cancellation_qualified','temporary_budget_qualified','gateway_memory_qualified'),True),
          'gateway_image':self.gateway_image,'gateway_config_source_sha256':hashlib.sha256(self.gateway_after.encode()).hexdigest(),
          'production_calls':0,'customer_calls':0,'payload_bytes':412758765,'running_gateway_worker_count':1,'actual_gateway_tmp_filesystem_magic':'794c7630',
          'envelope':{'gateway_worker_processes':1,'gateway_memory_bytes':67108864,'gateway_cpu_millicores':200,'tmp_budget_bytes':67108864,'tmp_medium':'disk','census_includes_open_unlinked_files':True}}
        self.batch_qualification['api_proxy_streaming_receipt_sha256']=hashlib.sha256(json.dumps(self.stream_qualification).encode()).hexdigest()
        for name,text in ((p.GATEWAY_BEFORE,baseline),(p.GATEWAY_AFTER,self.gateway_after),
          (p.GATEWAY_QUALIFICATION,json.dumps(self.qualification)),(p.GATEWAY_STREAM_QUALIFICATION,json.dumps(self.stream_qualification)),
          (p.GATEWAY_STORAGE_QUALIFIED,self.gateway_storage),(p.GATEWAY_BATCH_QUALIFICATION,json.dumps(self.batch_qualification)),
          ('deploy/kubernetes/render.py','NGINX_IMAGE = '+repr(self.gateway_image)+'\n')):
            path=self.gateway_root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)

        self.https_image='registry.digitalocean.com/tenderdesk-a6093a76/https@sha256:'+'b'*64
        config=(p.ROOT/p.https_capacity.CONFIG).read_text()
        flags=('passed','actual_binary_exercised','exact_delivery_qualified','cancellation_qualified','temporary_budget_qualified','resource_envelope_qualified','tls_streaming_qualified','cleanup_confirmed','source_unchanged','synthetic_only','https_is_deployed_registry_image')
        self.https_qualification={**dict.fromkeys(flags,True),'fixture':'synthetic-only',
          'production_calls':0,'customer_calls':0,'model_calls':0,'images':{'https':self.https_image},
          'image_binding':{'kind':'exact_deployed_registry_digest','repo_digest':self.https_image,'local_image_id':'sha256:'+'c'*64},
          'resources':{'https_memory_bytes':134217728,'https_cpu_millicores':300,'tmp_budget_per_service_bytes':67108864,'gateway_workers':1,'gateway_worker_count_basis':'exact production directive, no worker-count transform'},
          'payload':{'bytes':412758765},'mount_filesystems':{name:{'statfs_magic':{'/tmp':'794c7630'}} for name in ('https','gateway')},
          'tls':{'verification_enabled':True,'actual_handshake_verified':True},'qualified_encodings':['identity','gzip','zstd'],
          'source_hashes':{'backend/'+p.https_capacity.CONFIG:hashlib.sha256(config.encode()).hexdigest(),
           'backend/'+p.https_capacity.GATEWAY:hashlib.sha256(self.gateway_after.encode()).hexdigest()}}
        for name,text in [(p.https_capacity.CONFIG,config),(p.https_capacity.QUALIFICATION,json.dumps(self.https_qualification))]:
            path=self.gateway_root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)

        # Explicitly synthetic publication fixture: no image is published here.
        runtime_receipt={'version':1,'qualified_image':{'id':'sha256:176bcf738676421ebc58d26cd7bc2a29910d0242635de6084129a06701a9e4f8'},'fixture':'synthetic-only'}
        runtime_bytes=json.dumps(runtime_receipt).encode()
        runtime_helper="QUALIFIED_ID = "+repr(runtime_receipt['qualified_image']['id'])+"\nREGISTRY = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime'\nRECEIPT_SHA256 = "+repr(hashlib.sha256(runtime_bytes).hexdigest())+'\n'
        self.runtime_publication={'version':1,'qualified_image_id':runtime_receipt['qualified_image']['id'],'reference':'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'d'*64,'fixture':'synthetic-only'}
        for name,data in [(p.RUNTIME_HELPER,runtime_helper.encode()),(p.RUNTIME_QUALIFICATION,runtime_bytes),(p.RUNTIME_PUBLICATION,json.dumps(self.runtime_publication).encode())]:
            target=self.gateway_root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)

    def verify(self,manifest,**kwargs):
        return p.verify_source(manifest,gateway_root=self.gateway_root,https_root=self.gateway_root,runtime_root=self.gateway_root,**kwargs)

    def inventory(self):
        return {'version':1,'namespace':'tenderdesk-dev','ready_workloads':10,'inventory':'captured',
          'bootstrap_run':False,'business_mutations':0,'schema_mutations':0,'models_called':0,'temporary_client_cleanup_verified':True,
          'workloads':[{'name':name,'image':self.gateway_image if name=='gateway' else self.https_image if name=='https' else 'registry.example/runtime@sha256:'+'a'*64} for name in ('api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https')],
          'native_schedules':[{'name':name,'image':'registry.digitalocean.com/tenderdesk-a6093a76/'+name.removeprefix('native-')+'@sha256:'+'a'*64,'schedule':'*/10 * * * *','container_identity_recognized':True,'concurrency_policy':'Forbid','concurrency_policy_explicit':True,'suspended':False,'suspend_explicit':True,'active_deadline_seconds':600,'backoff_limit':0,'effective_backoff_limit':0,'resources':{'requests':None,'limits':None},'generation':1} for name in ('native-browser','native-ocr')],
          'schema':{'routine_catalog_sha256':'0'*64,'canonical_migrations':None,'release_history':[
            {'release':'prior-release-'+str(i),'migration_sha256':str(i)*64} for i in range(1,7)]}}

    def manifest(self):
        return p.freeze(self.inventory(),gateway_root=self.gateway_root,https_root=self.gateway_root,runtime_root=self.gateway_root)

    def test_every_final_contract_is_required_before_freezing(self):
        manifest=self.manifest()
        self.assertEqual(len(p.REQUIRED),24)
        self.assertEqual({key:manifest[key] for key in p.CAPABILITIES},p.CAPABILITIES)
        with self.assertRaises(p.ReleaseError):p.freeze({'receipt':self.inventory()})
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            for row in manifest['migrations']:
                (folder/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            for name in p.REQUIRED:
                path=folder/name;data=path.read_bytes();path.unlink()
                with self.subTest(name=name),self.assertRaisesRegex(p.ReleaseError,'MIGRATION_MISSING'):
                    p.freeze(self.inventory(),migrations=folder,gateway_root=self.gateway_root,https_root=self.gateway_root,runtime_root=self.gateway_root)
                path.write_bytes(data)

    def test_final_capabilities_cannot_be_downgraded_or_coerced(self):
        for key,value in (('executor_max',3),('minimum_worker_executor',0),('renderer_versions',[1,2]),
          ('ordinary_renderer_version','ordinary-1'),('current_proposal_issuance_contract',True),
          ('issuance_file_capacity_version',0),('global_renderer_limit',2),
          ('storage_write_intents_version',False),('storage_retirement_version',0),('storage_gateway_guard_version',True),('application_auth_read_version',0),
          ('command_batch_transport_version',0),('command_batch_chunk_bytes',1048576),('legacy_batch_insert_fence_version',True),('legacy_batch_gateway_fence_version',False)):
            manifest=self.manifest();manifest[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'CAPABILITY_SOURCE_MISMATCH'):
                self.verify(manifest)

    def test_source_set_and_bytes_are_frozen(self):
        manifest=self.manifest();self.assertGreaterEqual(len(self.verify(manifest)),6)
        for mutate in (lambda m:m['migrations'].pop(),lambda m:m['migrations'][0].update(sha256='f'*64),
          lambda m:m['migrations'][0].update(name='../unexpected.sql'),lambda m:m.update(release='another'),lambda m:m['baseline_native_schedules'].pop()):
            changed=copy.deepcopy(manifest);mutate(changed)
            with self.assertRaises(p.ReleaseError):self.verify(changed)
        with tempfile.TemporaryDirectory() as directory:
            for row in manifest['migrations']:
                (Path(directory)/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            (Path(directory)/'20261104999999_unreviewed.sql').write_text('select 1;')
            with self.assertRaisesRegex(p.ReleaseError,'SET_CHANGED'):self.verify(manifest,migrations=Path(directory))

    def test_platform_auth_source_is_frozen_and_atomic_after_early_auth_lock(self):
        manifest=self.manifest();self.verify(manifest)
        self.assertEqual(manifest['application_auth_read']['version'],1)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name in p.auth_read.contract()['sources']:
                destination=root/name;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes((p.ROOT/name).read_bytes())
            self.verify(manifest,auth_root=root)
            changed=root/p.auth_read.TEMPLATE;changed.write_text(changed.read_text()+'-- changed\n')
            with self.assertRaisesRegex(p.ReleaseError,'AUTH_SOURCE_CHANGED'):self.verify(manifest,auth_root=root)
        altered=copy.deepcopy(manifest);altered['application_auth_read']['version']=2
        with self.assertRaisesRegex(p.ReleaseError,'AUTH_SOURCE_CHANGED'):self.verify(altered)
        sql=p.migration_script(manifest,sources=self.verify(manifest))
        self.assertLess(sql.index('LOCK TABLE auth.users,auth.identities'),sql.index('SELECT pg_advisory_xact_lock'))
        self.assertLess(sql.index('END $delivery_release$;'),sql.index('DO $auth_read_preflight$'))
        self.assertLess(sql.index('END $auth_read_policy$;'),sql.index('NOTIFY pgrst'))
        self.assertEqual(sql.count('COMMIT;'),1)

    def test_legacy_batch_lock_precedes_first_snapshot_and_any_migration(self):
        manifest=self.manifest();sql=p.migration_script(manifest,sources=self.verify(manifest))
        self.assertLess(sql.index("SET LOCAL lock_timeout='15s'"),sql.index(p.BATCH_EARLY_LOCK_SQL))
        self.assertLess(sql.index(p.BATCH_EARLY_LOCK_SQL),sql.index(p.BATCH_ZERO_CHECK_SQL))
        self.assertLess(sql.index(p.BATCH_ZERO_CHECK_SQL),sql.index('SELECT pg_advisory_xact_lock'))
        self.assertLess(sql.index(p.BATCH_ZERO_CHECK_SQL),sql.index('EXECUTE $delivery_release_payload$'))
        self.assertNotIn('expires_at',p.BATCH_ZERO_CHECK_SQL)

    def test_gateway_manifest_binds_raw_and_rendered_config_receipt_and_image(self):
        manifest=self.manifest();value=manifest['gateway_configuration']
        self.assertEqual(value['version'],2)
        self.assertEqual(value['before_source_sha256'],p.GATEWAY_BASELINE_SHA256)
        self.assertEqual(value['after_source_sha256'],hashlib.sha256(self.gateway_after.encode()).hexdigest())
        self.assertEqual(value['after_data_sha256'],hashlib.sha256(json.dumps(
          {'nginx.conf':self.gateway_after.replace('__NAMESPACE__','tenderdesk-dev')},sort_keys=True).encode()).hexdigest())
        self.assertNotEqual(value['after_source_sha256'],value['after_data_sha256'])
        self.assertEqual(value['qualification_sha256'],hashlib.sha256((self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION).read_bytes()).hexdigest())
        self.assertEqual(value['storage_qualification_sha256'],hashlib.sha256((self.gateway_root/p.GATEWAY_QUALIFICATION).read_bytes()).hexdigest())
        self.assertEqual(value['gateway_image'],self.gateway_image)
        self.verify(manifest)
        for key in value:
            changed=copy.deepcopy(manifest)
            changed['gateway_configuration'][key]=True if key=='version' else 'f'*64
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_CHANGED'):
                self.verify(changed)
        for mutation in ('remove','extra'):
            changed=copy.deepcopy(manifest)
            if mutation=='remove':del changed['gateway_configuration']
            else:changed['gateway_configuration']['unreviewed']=True
            with self.subTest(mutation=mutation),self.assertRaises(p.ReleaseError):self.verify(changed)
        bad=self.inventory();next(row for row in bad['workloads'] if row['name']=='gateway')['image']='registry.example/nginx@sha256:'+'f'*64
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_IMAGE_CHANGED'):
            p.freeze(bad,gateway_root=self.gateway_root,https_root=self.gateway_root,runtime_root=self.gateway_root)

    def test_streaming_proof_requires_exact_disk_envelope_and_transitive_receipt(self):
        manifest=self.manifest();path=self.gateway_root/p.GATEWAY_STREAM_QUALIFICATION;raw=path.read_bytes()
        for key,value in [('passed',False),('actual_binary_exercised',1),('cleanup_confirmed',False),('production_calls',True),
          ('customer_calls',1),('gateway_image','wrong'),('gateway_config_source_sha256','f'*64)]:
            changed={**self.stream_qualification,key:value};path.write_text(json.dumps(changed))
            with self.subTest(key=key),self.assertRaises(p.ReleaseError):self.verify(manifest)
        # Rebinding an altered proof does not allow tmpfs, incomplete census or
        # weaker resource/payload evidence to masquerade as the qualified disk run.
        batch_path=self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION;batch_raw=batch_path.read_bytes()
        for key,value in [('actual_gateway_tmp_filesystem_magic','1021994'),('actual_gateway_tmp_filesystem_magic','unknown'),('payload_bytes',True),
          ('envelope',{'gateway_memory_bytes':67108864,'gateway_cpu_millicores':200,'tmp_budget_bytes':67108864,'tmp_medium':'disk','census_includes_open_unlinked_files':False})]:
            changed={**self.stream_qualification,key:value};path.write_text(json.dumps(changed))
            batch_path.write_text(json.dumps({**self.batch_qualification,'api_proxy_streaming_receipt_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}))
            with self.subTest(key=key,value=value),self.assertRaisesRegex(p.ReleaseError,'STREAM_ENVELOPE_INVALID'):self.manifest()
        path.write_bytes(raw);batch_path.write_bytes(batch_raw)
        path.write_text(json.dumps({**self.stream_qualification,'receipt_revision':2}))
        with self.assertRaisesRegex(p.ReleaseError,'STREAM_QUALIFICATION_INVALID'):self.verify(manifest)

    def test_gateway_declared_and_running_worker_counts_are_exact(self):
        path=self.gateway_root/p.GATEWAY_STREAM_QUALIFICATION;batch_path=self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION
        for field in ('gateway_worker_processes','running_gateway_worker_count'):
            for value in (None,True,0,2,'1'):
                changed=copy.deepcopy(self.stream_qualification)
                (changed['envelope'] if field=='gateway_worker_processes' else changed)[field]=value
                path.write_text(json.dumps(changed))
                batch_path.write_text(json.dumps({**self.batch_qualification,'api_proxy_streaming_receipt_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}))
                with self.subTest(field=field,value=value),self.assertRaisesRegex(p.ReleaseError,'STREAM_ENVELOPE_INVALID'):self.manifest()
        path.write_text(json.dumps(self.stream_qualification));batch_path.write_text(json.dumps(self.batch_qualification))
        target=self.gateway_root/p.GATEWAY_AFTER
        for replacement in ('worker_processes auto;','worker_processes 2;','worker_processes 1;\nworker_processes 1;'):
            target.write_text(self.gateway_after.replace('worker_processes 1;',replacement))
            with self.subTest(replacement=replacement),self.assertRaisesRegex(p.ReleaseError,'WORKER_SOURCE_INVALID'):self.manifest()

    def test_release_and_gateway_helper_bind_the_same_final_proof_chain(self):
        spec=importlib.util.spec_from_file_location('gateway_parity',Path(__file__).with_name('storage-gateway-update.py'))
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        self.assertEqual(helper.BATCH_QUALIFICATION.name,Path(p.GATEWAY_BATCH_QUALIFICATION).name)
        self.assertEqual(helper.STREAM_QUALIFICATION.name,Path(p.GATEWAY_STREAM_QUALIFICATION).name)
        paths={'BASELINE':p.GATEWAY_BEFORE,'TARGET':p.GATEWAY_AFTER,'QUALIFICATION':p.GATEWAY_QUALIFICATION,
          'STORAGE_QUALIFIED':p.GATEWAY_STORAGE_QUALIFIED,'BATCH_QUALIFICATION':p.GATEWAY_BATCH_QUALIFICATION,'STREAM_QUALIFICATION':p.GATEWAY_STREAM_QUALIFICATION}
        driver=SimpleNamespace(NAMESPACE='tenderdesk-dev',renderer=SimpleNamespace(NGINX_IMAGE=self.gateway_image))
        with ExitStack() as stack:
            for name,path in paths.items():stack.enter_context(patch.object(helper,name,self.gateway_root/path))
            self.assertEqual(helper.source_contract(driver)[0],p.gateway_configuration(self.gateway_root))
            stream_path=self.gateway_root/p.GATEWAY_STREAM_QUALIFICATION;batch_path=self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION
            for key,value in [('running_gateway_worker_count',True),('running_gateway_worker_count',2),('actual_gateway_tmp_filesystem_magic','1021994')]:
                changed={**self.stream_qualification,key:value};stream_path.write_text(json.dumps(changed))
                batch_path.write_text(json.dumps({**self.batch_qualification,'api_proxy_streaming_receipt_sha256':hashlib.sha256(stream_path.read_bytes()).hexdigest()}))
                with self.subTest(key=key,value=value),self.assertRaises(helper.GatewayError):helper.source_contract(driver)
                with self.assertRaises(p.ReleaseError):p.gateway_configuration(self.gateway_root)

    def test_https_source_manifest_identity_and_changed_proof_refuse(self):
        manifest=self.manifest();contract=manifest['https_configuration'];self.verify(manifest)
        self.assertEqual(contract['image'],self.https_image)
        self.assertEqual(contract['minimum_memory_bytes'],134217728)
        self.assertEqual(contract['qualification_sha256'],hashlib.sha256((self.gateway_root/p.https_capacity.QUALIFICATION).read_bytes()).hexdigest())
        for key in contract:
            changed=copy.deepcopy(manifest);changed['https_configuration'][key]=None
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'HTTPS_SOURCE_CHANGED'):self.verify(changed)
        changed=copy.deepcopy(manifest);del changed['https_configuration']
        with self.assertRaisesRegex(p.ReleaseError,'MANIFEST_INVALID'):self.verify(changed)
        changed=self.inventory();next(row for row in changed['workloads'] if row['name']=='https')['image']=self.https_image[:-1]+'f'
        with self.assertRaisesRegex(p.ReleaseError,'HTTPS_IMAGE_CHANGED'):p.freeze(changed,gateway_root=self.gateway_root,https_root=self.gateway_root,runtime_root=self.gateway_root)
        path=self.gateway_root/p.https_capacity.QUALIFICATION
        path.write_text(json.dumps({**self.https_qualification,'receipt_revision':2}))
        with self.assertRaisesRegex(p.ReleaseError,'HTTPS_SOURCE_CHANGED'):self.verify(manifest)

    def test_runtime_qualification_manifest_binds_all_operational_inputs(self):
        manifest=self.manifest();value=manifest['runtime_qualification'];self.verify(manifest)
        self.assertEqual(value['published_reference'],self.runtime_publication['reference'])
        for key in value:
            changed=copy.deepcopy(manifest);changed['runtime_qualification'][key]=None
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'RUNTIME_SOURCE_CHANGED'):self.verify(changed)
        for filename in (p.RUNTIME_HELPER,p.RUNTIME_PUBLICATION):
            path=self.gateway_root/filename;raw=path.read_bytes();path.write_bytes(raw+b'\n')
            with self.subTest(filename=filename),self.assertRaisesRegex(p.ReleaseError,'RUNTIME_SOURCE_CHANGED'):self.verify(manifest)
            path.write_bytes(raw)
        receipt=self.gateway_root/p.RUNTIME_QUALIFICATION;receipt.write_bytes(receipt.read_bytes()+b'\n')
        with self.assertRaisesRegex(p.ReleaseError,'RUNTIME_QUALIFICATION_INVALID'):self.verify(manifest)

    def test_pending_or_wrong_runtime_publication_cannot_freeze(self):
        path=self.gateway_root/p.RUNTIME_PUBLICATION
        for field,value in [('reference',None),('reference','registry.other/runtime@sha256:'+'d'*64),('qualified_image_id','sha256:'+'f'*64),('version',True)]:
            path.write_text(json.dumps({**self.runtime_publication,field:value}))
            with self.subTest(field=field,value=value),self.assertRaisesRegex(p.ReleaseError,'RUNTIME_PUBLICATION_REQUIRED'):self.manifest()
        path.unlink()
        with self.assertRaisesRegex(p.ReleaseError,'RUNTIME_QUALIFICATION_UNAVAILABLE'):self.manifest()

    def test_gateway_qualification_is_strict_and_current(self):
        path=self.gateway_root/p.GATEWAY_QUALIFICATION;raw=path.read_bytes()
        for key,value in (('passed',False),('actual_binary_exercised',1),('gateway_resumable_denial_qualified',False),
          ('signed_tus_bypass_confirmed',False),('production_calls',True),('customer_calls',1),
          ('gateway_config_source_sha256','f'*64),('gateway_image',self.gateway_image[:-1]+'f')):
            changed={**self.qualification,key:value};path.write_text(json.dumps(changed))
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):
                self.manifest()
            path.write_bytes(raw)
        manifest=self.manifest();path=self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION;raw=path.read_bytes();path.write_text(json.dumps({**self.batch_qualification,'receipt_revision':2}))
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_CHANGED'):self.verify(manifest)
        path.write_bytes(raw)
        after=self.gateway_root/p.GATEWAY_AFTER;after.write_text(self.gateway_after+'# unreviewed change\n')
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):self.verify(manifest)

    def test_gateway_missing_symlink_and_unreviewed_baseline_fail_closed(self):
        for name in (p.GATEWAY_BEFORE,p.GATEWAY_AFTER,p.GATEWAY_QUALIFICATION,p.GATEWAY_BATCH_QUALIFICATION,p.GATEWAY_STREAM_QUALIFICATION,p.GATEWAY_STORAGE_QUALIFIED,'deploy/kubernetes/render.py'):
            path=self.gateway_root/name;raw=path.read_bytes();path.unlink()
            with self.subTest(name=name),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_UNAVAILABLE'):self.manifest()
            other=path.with_name(path.name+'.copied');other.write_bytes(raw);path.symlink_to(other)
            with self.subTest(name=name,symlink=True),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_UNAVAILABLE'):self.manifest()
            path.unlink();path.write_bytes(raw)
        baseline=self.gateway_root/p.GATEWAY_BEFORE;baseline.write_text(baseline.read_text()+'# changed\n')
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_BASELINE_CHANGED'):self.manifest()

    def test_combined_gateway_proof_cannot_borrow_prior_storage_qualification(self):
        path=self.gateway_root/p.GATEWAY_BATCH_QUALIFICATION;raw=path.read_bytes()
        for key,value in [('passed',False),('actual_binary_exercised',1),('legacy_rpc_denial_qualified',False),
          ('gateway_resumable_denial_qualified',False),('ordinary_routing_preserved',False),('restart_denial_qualified',False),
          ('cleanup_confirmed',False),('postgrest_error_envelope_qualified',False),('gateway_before_source_sha256','f'*64),('storage_qualification_sha256','f'*64),
          ('production_calls',True),('customer_calls',1)]:
            path.write_text(json.dumps({**self.batch_qualification,key:value}))
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):self.manifest()
        path.write_bytes(raw)
        prior=self.gateway_root/p.GATEWAY_STORAGE_QUALIFIED;prior.write_text(prior.read_text()+'# changed\n')
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):self.manifest()

    def test_managed_atomic_batch_replay_drift_and_fault_rollback(self):
        self.managed_atomic_batch_cases()

    def test_storage_columns_reject_direct_service_and_public_grants(self):
        self.managed_atomic_batch_cases(column_acl_only=True)

    def test_late_platform_auth_failure_rolls_back_entire_application_batch(self):
        self.managed_atomic_batch_cases(auth_only=True)

    def managed_atomic_batch_cases(self,column_acl_only=False,auth_only=False,batch_contract_only=False):
        manifest=self.manifest();sources=self.verify(manifest)
        def script(sources=sources):return p.migration_script(manifest,sources).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
        cases=[
          ('UPDATE public.release_preserved_fixture SET attempts=0;','DELIVERY_RELEASE_EXISTING_ROWS_CHANGED'),
          ('DELETE FROM app_private.release_private_fixture;','DELIVERY_RELEASE_EXISTING_ROWS_CHANGED'),
          ('GRANT SELECT ON public.release_preserved_fixture TO tdp_app_authenticated;','DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED'),
          ('GRANT SELECT(id) ON public.release_preserved_fixture TO tdp_app_authenticated;','DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED'),
          ('DROP FUNCTION public.export_render_context(uuid,uuid);','DELIVERY_RELEASE_FINAL_RPC_MISSING'),
          ('GRANT EXECUTE ON FUNCTION public.export_render_context(uuid,uuid) TO tdp_app_authenticated;','DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID'),
          ('REVOKE EXECUTE ON FUNCTION public.export_package_context(uuid) FROM tdp_app_authenticated;','DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.ensure_issuance_file_capacity(uuid,uuid) TO tdp_app_anon;','DELIVERY_RELEASE_FINAL_PRIVATE_AUTHORITY_INVALID'),
          ('DROP FUNCTION app_private.app_command_before_current_issuance_contract(text,jsonb,text);','DELIVERY_RELEASE_FINAL_PRIVATE_CONTRACT_MISSING'),
          ('GRANT SELECT(id) ON public.export_packages TO tdp_app_authenticated;','DELIVERY_RELEASE_EXPORT_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.export_package_volumes DISABLE ROW LEVEL SECURITY;','DELIVERY_RELEASE_EXPORT_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.proposal_issuance_requests ALTER COLUMN reserved_file_bytes DROP NOT NULL;','DELIVERY_RELEASE_CAPACITY_CONTRACT_INVALID'),
          ('ALTER TABLE public.proposal_issuance_requests DISABLE TRIGGER issuance_capacity_guard;','DELIVERY_RELEASE_CAPACITY_CONTRACT_INVALID'),
          ('DROP FUNCTION app_private.document_render_slot_available();','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.document_render_slot_available() TO tdp_app_service;','DELIVERY_RELEASE_RENDER_ADMISSION_AUTHORITY_INVALID'),
          ('DROP INDEX public.jobs_active_document_render;','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ('DROP INDEX public.one_active_non_render_job_per_workspace;','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ("DELETE FROM public.storage_write_intents WHERE storage_key='synthetic/census-pending';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("INSERT INTO public.storage_write_intents(workspace_id,storage_key,state) VALUES('00000000-0000-4000-8000-000000000099','synthetic/extra','legacy_unfenced');",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET storage_key='synthetic/forged' WHERE storage_key='synthetic/census-pending';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='unstarted';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET revision=2;",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET expected_hash=repeat('a',64),expected_size=1;",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='unknown',expected_hash=repeat('a',64),expected_size=1,started_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET observed_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET send_closed_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='quiesced',retirement_receipt='{}';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET created_at='2000-01-01';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("CREATE TABLE app_private.forbidden_release_seed(value integer);INSERT INTO app_private.forbidden_release_seed VALUES(1);",'DELIVERY_RELEASE_UNREQUESTED_NEW_ROWS'),
          ("INSERT INTO app_private.storage_retirement_batches(operation_nonce,workspace_id,actor_id,scope,scope_sha256) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'[]',repeat('a',64));",'DELIVERY_RELEASE_UNREQUESTED_NEW_ROWS'),
          ('DROP FUNCTION public.begin_render_storage_write(uuid,uuid,text,text,bigint);','DELIVERY_RELEASE_STORAGE_RPC_MISSING'),
          ('GRANT EXECUTE ON FUNCTION public.begin_render_storage_write(uuid,uuid,text,text,bigint) TO tdp_app_authenticated;','DELIVERY_RELEASE_STORAGE_RPC_AUTHORITY_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.finish_storage_write_retirement(uuid,uuid,jsonb) TO tdp_app_service;','DELIVERY_RELEASE_STORAGE_PRIVATE_AUTHORITY_INVALID'),
          ('GRANT SELECT(storage_key) ON public.storage_write_intents TO tdp_app_authenticated;','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE app_private.storage_retirement_keys DISABLE ROW LEVEL SECURITY;','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.proposal_delivery_artifacts DISABLE TRIGGER register_delivery_storage_write;','DELIVERY_RELEASE_STORAGE_CONTRACT_INVALID'),
          ('DROP FUNCTION public.app_batch_result_chunk(uuid,integer,integer);','DELIVERY_RELEASE_BATCH_RPC_MISSING'),
          ('GRANT EXECUTE ON FUNCTION public.app_batch_prepare(jsonb,text) TO tdp_app_anon;','DELIVERY_RELEASE_BATCH_RPC_AUTHORITY_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.command_batch_access(uuid) TO tdp_app_service;','DELIVERY_RELEASE_BATCH_PRIVATE_AUTHORITY_INVALID'),
          ('GRANT SELECT(data) ON app_private.command_batch_chunks TO PUBLIC;','DELIVERY_RELEASE_BATCH_TABLE_AUTHORITY_INVALID'),
          ('GRANT SELECT ON app_private.command_batch_receipts TO tdp_app_authenticated;','DELIVERY_RELEASE_BATCH_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE app_private.command_batch_results DISABLE ROW LEVEL SECURITY;','DELIVERY_RELEASE_BATCH_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE app_private.idempotency_records DISABLE TRIGGER reject_legacy_batch_insert;','DELIVERY_RELEASE_BATCH_CONTRACT_INVALID'),
          ('ALTER TABLE app_private.command_batch_chunks DROP CONSTRAINT command_batch_chunks_data_check;','DELIVERY_RELEASE_BATCH_CONTRACT_INVALID'),
          ('DROP TRIGGER reject_legacy_batch_insert ON app_private.idempotency_records;CREATE TRIGGER reject_legacy_batch_insert BEFORE INSERT ON app_private.idempotency_records FOR EACH ROW WHEN(false) EXECUTE FUNCTION app_private.reject_legacy_batch_insert();','DELIVERY_RELEASE_BATCH_CONTRACT_INVALID'),
          ('ALTER TABLE app_private.command_batch_chunks DROP CONSTRAINT command_batch_chunks_data_check;ALTER TABLE app_private.command_batch_chunks ADD CONSTRAINT command_batch_chunks_data_check CHECK(octet_length(data) between 1 and 262144 OR true);','DELIVERY_RELEASE_BATCH_CONTRACT_INVALID'),

        ]
        if column_acl_only:
            cases=[
              (f'GRANT SELECT({column}) ON {table} TO {role};','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID')
              for table,column in (('public.storage_write_intents','storage_key'),
                ('app_private.storage_retirement_batches','operation_nonce'),
                ('app_private.storage_retirement_keys','storage_key'))
              for role in ('tdp_app_service','PUBLIC')]
        if auth_only:cases=[]
        if batch_contract_only:cases=[case for case in cases if case[1]=='DELIVERY_RELEASE_BATCH_CONTRACT_INVALID']
        program="process.on('uncaughtException',e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\nconst release="+json.dumps(script())+';const variants='+json.dumps([(script(sources[:-1]+[sources[-1]+'\n'+s]),code) for s,code in cases])+';const guardKinds='+json.dumps(['auth'] if auth_only else ['catalog','ledger','partial','database'])+';\n'
        program+='const baseline='+json.dumps(manifest['baseline_releases'])+';const catalogQuery='+json.dumps(p.CATALOG.replace(' INTO catalog_hash',''))+';\n'
        program+=r"""
import {databaseWithMigrations} from './tests/backend/databaseFixture.ts';
const one=async(db,q)=>Object.values((await db.query(q)).rows[0])[0];
async function fixture(){
 const db=await databaseWithMigrations('20261103032000_model_admission_fairness.sql');
 await db.exec(`insert into public.workspaces(id,name) values('00000000-0000-4000-8000-000000000099','Synthetic retained storage census');
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason,status,attempts)
 values('00000000-0000-4000-8000-000000000099','synthetic/census-pending',123,'synthetic historical pending','pending',3),
 ('00000000-0000-4000-8000-000000000099','synthetic/census-done',17,'synthetic historical done','done',2);
 create table public.release_preserved_fixture(id int primary key,attempts int,receipt jsonb);
 insert into public.release_preserved_fixture values(1,7,'{"usage":null,"frozen":true,"budget":1}');
 create table app_private.release_private_fixture(id int primary key,receipt jsonb);
 insert into app_private.release_private_fixture values(1,'{"accepted_sibling":true}');
 create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz default now());
 alter table app_private.application_release_history enable row level security;
 revoke all on app_private.application_release_history from public;
 create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 create role tdp_app_authadmin nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema auth owner to tdp_app_authadmin;
 alter table auth.users owner to tdp_app_authadmin;alter table auth.identities owner to tdp_app_authadmin;
 alter table auth.users enable row level security;alter table auth.identities enable row level security;
 comment on database postgres is 'tenderdesk-managed-kubernetes:tenderdesk_app:tdp_app';
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
 FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);END LOOP;
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);END LOOP;
 END $ownership$;
 ALTER ROLE anon RENAME TO tdp_app_anon;ALTER ROLE authenticated RENAME TO tdp_app_authenticated;
 ALTER ROLE service_role RENAME TO tdp_app_service;ALTER ROLE tdp_app_service NOBYPASSRLS;GRANT tdp_app_owner TO tdp_app_service;`);
 for(const [key,value] of Object.entries(baseline))await db.query('insert into app_private.application_release_history(release,migration_sha256) values($1,$2)',[key,value]);
 const hash=await one(db,catalogQuery);return {db,sql:s=>s.replace("catalog_hash<>'"+'0'.repeat(64)+"'","catalog_hash<>'"+hash+"'")};
}
const f=await fixture();
await f.db.exec(f.sql(release));await f.db.exec(f.sql(release));
if(await one(f.db,'select count(*)::int from app_private.application_release_history')!==8)throw Error('REPLAY_LEDGER');
if(await one(f.db,'select attempts from public.release_preserved_fixture')!==7)throw Error('OLD_ROW_CHANGED');
if(await one(f.db,'select count(*)::int from public.storage_write_intents')!==2)throw Error('LEGACY_CENSUS_MISSING');
if(await one(f.db,"select count(*)::int from public.storage_write_intents where state='legacy_unfenced' and revision=1 and expected_hash is null and expected_size is null and started_at is null and observed_at is null and send_closed_at is null and retirement_receipt is null")!==2)throw Error('LEGACY_CENSUS_FORGED');
await f.db.exec("update public.storage_write_intents set state='unknown',revision=2,expected_hash=repeat('a',64),expected_size=123,started_at=clock_timestamp() where storage_key='synthetic/census-pending'");
await f.db.exec("insert into app_private.storage_retirement_batches(operation_nonce,workspace_id,actor_id,scope,scope_sha256) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'[]',repeat('a',64))");

await f.db.exec("insert into public.release_preserved_fixture values(2,4,'{\"post_release\":true}')");
await f.db.exec(f.sql(release));
if(await one(f.db,'select count(*)::int from public.release_preserved_fixture')!==2)throw Error('REPLAY_NEW_ROW_CHANGED');
if(await one(f.db,"select state from public.storage_write_intents where storage_key='synthetic/census-pending'")!=='unknown')throw Error('REPLAY_OPERATIONAL_STATE_CHANGED');
if(await one(f.db,'select count(*)::int from app_private.storage_retirement_batches')!==1)throw Error('REPLAY_RETIREMENT_HISTORY_CHANGED');

await f.db.exec("comment on function public.delivery_package(uuid) is 'does not affect function catalog';");
await f.db.exec(f.sql(release));
await f.db.exec("grant execute on function public.delivery_export_context(uuid,uuid) to tdp_app_authenticated");
let rejected=false;try{await f.db.exec(f.sql(release));}catch(e){rejected=e.message==='DELIVERY_RELEASE_POST_CATALOG_CHANGED';await f.db.exec('rollback');if(!rejected)throw e;}
if(!rejected)throw Error('POST_CATALOG_DRIFT_ACCEPTED');await f.db.close();
for(const [source,expected] of variants){
 const f=await fixture();let rejected=false;
 try{await f.db.exec(f.sql(source));}catch(e){rejected=e.message===expected;await f.db.exec('rollback');if(!rejected)throw e;}
 if(!rejected)throw Error('FAULT_ACCEPTED '+expected);
 if(await one(f.db,'select attempts from public.release_preserved_fixture')!==7)throw Error('FAULT_ROW_ESCAPED');
 if(await one(f.db,"select to_regclass('public.proposal_delivery_snapshots')")!==null)throw Error('FAULT_SCHEMA_ESCAPED');
 if(await one(f.db,'select count(*)::int from app_private.application_release_history')!==6)throw Error('FAULT_LEDGER_ESCAPED');
 await f.db.close();
}
for(const kind of guardKinds){
 const f=await fixture();let source=f.sql(release);let expected;
 if(kind==='catalog'){source=release;expected='DELIVERY_RELEASE_BASELINE_CHANGED';}
 if(kind==='ledger'){await f.db.exec("update app_private.application_release_history set migration_sha256=repeat('f',64) where release='prior-release-1'");expected='DELIVERY_RELEASE_LEDGER_CHANGED';}
 if(kind==='partial'){await f.db.exec("insert into app_private.application_release_history(release,migration_sha256) values('proposal-delivery-reliability-v1',repeat('f',64))");expected='DELIVERY_RELEASE_PARTIAL_RECEIPT';}
 if(kind==='database'){source=source.replace("current_database()<>'postgres'","current_database()<>'tenderdesk_app'");expected='DELIVERY_RELEASE_DATABASE_MISMATCH';}
 if(kind==='auth'){await f.db.exec("set role tdp_app_authadmin;create policy retained_auth_restriction on auth.users for select to tdp_app_owner using(false);reset role;");expected='APPLICATION_AUTH_POLICY_CONFLICT';}
 let denied=false;try{await f.db.exec(source);}catch(e){denied=e.message===expected;await f.db.exec('rollback');if(!denied)throw e;}
 if(!denied)throw Error('GUARD_ACCEPTED '+kind);
 if(kind==='auth'){
  if(await one(f.db,"select to_regclass('public.proposal_delivery_snapshots')")!==null)throw Error('AUTH_FAILURE_SCHEMA_ESCAPED');
  if(await one(f.db,'select count(*)::int from app_private.application_release_history')!==6)throw Error('AUTH_FAILURE_LEDGER_ESCAPED');
  if(await one(f.db,"select count(*)::int from pg_policy where polname='tenderdesk_application_identity_read'")!==0)throw Error('AUTH_FAILURE_POLICY_ESCAPED');
  if(await one(f.db,"select count(*)::int from pg_policy where polname='retained_auth_restriction'")!==1)throw Error('AUTH_FAILURE_OLD_POLICY_LOST');
  if(await one(f.db,'select attempts from public.release_preserved_fixture')!==7)throw Error('AUTH_FAILURE_OLD_ROW_CHANGED');
 }
 await f.db.close();
}
"""
        result=subprocess.run(['node','--experimental-strip-types','--input-type=module'],input=program,text=True,capture_output=True,cwd=p.ROOT,timeout=240)
        self.assertEqual(result.returncode,0,result.stderr[-8000:])

if __name__=='__main__':unittest.main()
