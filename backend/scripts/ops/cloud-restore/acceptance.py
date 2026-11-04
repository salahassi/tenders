# Appended to the reviewed bootstrap HTTP client in the isolated acceptance Pod.
# All rows and bytes below are synthetic fixtures in the exact disposable DB.
import hashlib
import io
import zipfile
import urllib.parse

RESTORE_CHECKS = {
 'services_migrated_and_application_schema_ready',
 'signup_disabled_and_admin_requires_service_identity',
 'admin_invitation_password_signin_and_distinct_users',
 'synthetic_owner_workspaces_and_disabled_external_processing',
 'authorized_source_reviews_and_dormant_requirement',
 'private_draft_bytes_and_service_boundaries',
 'backup_rows_and_bytes_verified_before_fixture_reset',
 'exact_fixture_reset_and_trigger_restoration',
 'real_restore_preserves_file_hashes_and_changes_storage_keys',
 'restored_review_history_retained_with_current_revocation',
 'restored_requirement_assurance_not_reactivated',
 'restored_package_owner_access_and_old_owner_denial',
 'restore_replay_has_no_duplicate_history_or_model_usage',
}

class RestoreAcceptance(Acceptance):
    def rpc(self,name,body=None,token=None,statuses={200}):
        return expect(self.client.request(self.config.rest_url,'/rpc/'+name,method='POST',token=token or self.config.service_key,data=body or {}),statuses,'RESTORE_RPC_'+name.upper()+'_FAILED').json('RESTORE_RPC_RESPONSE_INVALID')

    def rows(self,table,query,token):
        return expect(self.client.request(self.config.rest_url,'/'+table+'?'+query,token=token),{200},'RESTORE_ROWS_READ_FAILED').json('RESTORE_ROWS_INVALID')

    def command(self,operation,body,token):
        return self.rpc('app_command',{'operation':operation,'input':body,'idempotency_key':str(uuid.uuid4())},token)

    def ready(self,timeout=240):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            responses=[self.client.request(self.config.auth_url,'/health'),self.client.request(self.config.storage_url,'/status'),
              self.client.request(self.config.rest_url,'/proposal_delivery_records?select=id&limit=1',token=self.config.service_key)]
            if all(r.status==200 for r in responses):
                self.passed('services_migrated_and_application_schema_ready');return
            time.sleep(2)
        raise ProbeFailure('RESTORE_SCHEMA_NOT_READY')

    def storage_put(self,key,data,token):
        path='/object/tenderdesk-private/'+urllib.parse.quote(key,safe='/')
        expect(self.client.request(self.config.storage_url,path,method='POST',token=token,raw=data,headers={
          'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','x-upsert':'false'}),{200,201},'RESTORE_STORAGE_UPLOAD_FAILED')

    def storage_get(self,key,token):
        path='/object/authenticated/tenderdesk-private/'+urllib.parse.quote(key,safe='/')
        return expect(self.client.request(self.config.storage_url,path,token=token),{200},'RESTORE_STORAGE_DOWNLOAD_FAILED').body

    def run(self):
        self.ready();a,b=self.auth();source_user,source_token=a;target_user,target_token=b
        identities=self.rpc('cloud_restore_fixture_users',{'source_user':source_user,'target_user':target_user})
        source_w=identities['source_workspace']
        for token in (source_token,):
            settings=self.rows('model_execution_settings','select=enabled',token)
            operations=self.rows('operations','select=scheduler_enabled',token)
            if any(row['enabled'] for row in settings) or not operations or any(row['scheduler_enabled'] for row in operations):raise ProbeFailure('RESTORE_EXTERNAL_PROCESSING_ENABLED')
        self.passed('synthetic_owner_workspaces_and_disabled_external_processing')
        source=self.command('source.create',{'name':'Synthetic cloud restore source','kind':'manual'},source_token)
        opportunity=self.command('opportunity.create',{'source_id':source['id'],'title':'Synthetic cloud restore requirement','reference':'ISOLATED-RESTORE',
          'description':'The supplier must deliver a documented approval workflow.','language':'en','decision':'shortlisted'},source_token)
        context=self.rpc('source_review_context',{'opportunity_id':opportunity['id']},source_token)
        self.command('source.authority.review',{'opportunity_id':opportunity['id'],**context['sources'][0]['reference'],
          'expected_revision':0,'role':'buyer_rfp','status':'confirmed','supersedes':None,'precedence':0,'reason':'Synthetic owner review of the exact original buyer source.'},source_token)
        context=self.rpc('source_review_context',{'opportunity_id':opportunity['id']},source_token)
        span=context['source_evidence']['spans'][0]
        review=self.command('source.obligation.review',{'opportunity_id':opportunity['id'],'review_id':None,'expected_revision':0,'spans':[span],
          'semantics':{'modality':'required','actor':'supplier','negated':False,'conditions':[],'exceptions':[],'consequences':[],'quantities':[],'dates':[]},
          'status':'confirmed','reason':'Synthetic exact original obligation review for isolated restore.'},source_token)
        # Save the manual draft before adding the dormant, job-free requirement.
        current=self.rows('opportunities','id=eq.'+opportunity['id']+'&select=revision',source_token)[0]
        snapshot=self.command('delivery.snapshot.prepare',{'opportunity_id':opportunity['id'],'expected_revision':current['revision']},source_token)
        requirement=self.rpc('cloud_restore_fixture_requirement',{'opportunity_id':opportunity['id'],'review_id':review['review_id']})
        self.passed('authorized_source_reviews_and_dormant_requirement')
        expect(self.client.request(self.config.storage_url,'/bucket',method='POST',token=self.config.service_key,data={'id':'tenderdesk-private','name':'tenderdesk-private','public':False,'file_size_limit':10485760}),{200,201},'RESTORE_PRIVATE_BUCKET_CREATE_FAILED')
        job=self.rpc('claim_backend_job_v4')
        if not job or job['type']!='render_delivery' or job['entity_id']!=snapshot['id']:raise ProbeFailure('RESTORE_LOCAL_FIXTURE_JOB_MISMATCH')
        export=self.rpc('delivery_export_context',{'job_id':job['id'],'lease':job['lease_token']})
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as doc:
            doc.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
            doc.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ISOLATED STORAGE RESTORE FIXTURE; no model-generated proposal.</w:t></w:r></w:p></w:body></w:document>')
        data=stream.getvalue();checksum=hashlib.sha256(data).hexdigest();original={}
        for artifact in export['artifacts']:
            self.storage_put(artifact['storage_key'],data,self.config.service_key)
            if self.storage_get(artifact['storage_key'],self.config.service_key)!=data:raise ProbeFailure('RESTORE_ORIGINAL_STORAGE_BYTES_CHANGED')
            self.rpc('complete_delivery_artifact',{'job_id':job['id'],'lease':job['lease_token'],'artifact_id':artifact['id'],'actual_hash':checksum,'actual_size':len(data)})
            original[artifact['id']]=artifact['storage_key']
        self.rpc('finish_delivery_export',{'job_id':job['id'],'lease':job['lease_token']})
        expect(self.client.request(self.config.rest_url,'/rpc/delivery_artifact_context',method='POST',token=source_token,data={'artifact_id':next(iter(original)),'actor_id':source_user}),{401,403,404},'RESTORE_BROWSER_SERVICE_RPC_ALLOWED')
        expect(self.client.request(self.config.rest_url,'/proposal_delivery_snapshots?select=payload',token=source_token),{401,403},'RESTORE_PRIVATE_PAYLOAD_DIRECT_READ')
        self.passed('private_draft_bytes_and_service_boundaries')
        backup=self.rpc('workspace_backup_manifest',token=source_token);rows=[];files={}
        for i in range(0,len(backup['rows']),10):
            batch=self.rpc('workspace_backup_rows',{'row_keys':[r['key'] for r in backup['rows'][i:i+10]]},source_token)
            for row in batch:
                if hashlib.sha256(row['data'].encode()).hexdigest()!=row['hash']:raise ProbeFailure('RESTORE_BACKUP_ROW_HASH_MISMATCH')
            rows.extend(batch)
        for item in backup['files']:
            file_kind,file_id=item['key'].split('/')
            info=self.rpc('recovery_file_context',{'file_kind':file_kind,'file_id':file_id},source_token)
            content=self.storage_get(info['storage_key'],self.config.service_key)
            if len(content)!=item['size'] or hashlib.sha256(content).hexdigest()!=item['hash']:raise ProbeFailure('RESTORE_BACKUP_FILE_HASH_MISMATCH')
            files[item['key']]=content
        if len(files)!=len(original) or not any(r['key'].startswith('source_obligation_reviews/') for r in rows):raise ProbeFailure('RESTORE_BACKUP_FIXTURE_INCOMPLETE')
        self.passed('backup_rows_and_bytes_verified_before_fixture_reset')
        reset=self.rpc('cloud_restore_reset_source');target_w=reset.get('target_workspace')
        if not target_w or target_w==source_w or reset.get('trigger_fingerprint_preserved') is not True:raise ProbeFailure('RESTORE_FIXTURE_RESET_FAILED')
        self.passed('exact_fixture_reset_and_trigger_restoration')
        session=self.rpc('begin_workspace_restore',{'backup_manifest':backup,'eligibility_attested':True},target_token)
        for i in range(0,len(rows),10):self.rpc('stage_restore_rows',{'restore_id':session['id'],'items':rows[i:i+10]},target_token)
        for file in session['files']:
            content=files[file['row_key']];self.storage_put(file['storage_key'],content,target_token)
            actual=self.storage_get(file['storage_key'],self.config.service_key)
            if actual!=content:raise ProbeFailure('RESTORE_COPIED_STORAGE_BYTES_CHANGED')
            self.rpc('complete_restore_file',{'file_id':file['id'],'actor_id':target_user,'actual_hash':hashlib.sha256(actual).hexdigest(),'actual_size':len(actual)})
        self.rpc('commit_workspace_restore',{'restore_id':session['id']},target_token)
        package=self.rpc('delivery_package',{'snapshot_id':snapshot['id']},target_token)
        if package['status']!='ready':raise ProbeFailure('RESTORE_READY_PACKAGE_LOST')
        for artifact in package['artifacts']:
            info=self.rpc('delivery_artifact_context',{'artifact_id':artifact['id'],'actor_id':target_user})
            value=info['artifact']
            if value['storage_key']==original[artifact['id']] or self.storage_get(value['storage_key'],self.config.service_key)!=data:raise ProbeFailure('RESTORE_READY_BYTES_NOT_PRESERVED')
            self.rpc('authorize_delivery_artifact_download',{'artifact_id':artifact['id'],'actor_id':target_user,'actual_hash':checksum})
        self.passed('real_restore_preserves_file_hashes_and_changes_storage_keys')
        for table in ('source_authority_decisions','source_obligation_reviews'):
            history=self.rows(table,'workspace_id=eq.'+target_w+'&select=*&order=revision.asc',target_token)
            if not any(x['status']=='confirmed' for x in history) or not history or history[-1]['status']!='revoked' or history[-1]['created_by']!=target_user:raise ProbeFailure('RESTORE_IMPORTED_REVIEW_REACTIVATED')
        self.passed('restored_review_history_retained_with_current_revocation')
        req=self.rows('requirements','id=eq.'+requirement+'&select=source_semantics',target_token)[0]['source_semantics']
        if req.get('review_status')!='pending' or req.get('authority_status')!='unconfirmed' or req.get('review_id') is not None:raise ProbeFailure('RESTORE_REQUIREMENT_ASSURANCE_REACTIVATED')
        self.passed('restored_requirement_assurance_not_reactivated')
        expect(self.client.request(self.config.rest_url,'/rpc/delivery_package',method='POST',token=source_token,data={'snapshot_id':snapshot['id']}),{400,401,403,404},'RESTORE_OLD_OWNER_DOWNLOAD_ALLOWED')
        self.passed('restored_package_owner_access_and_old_owner_denial')
        before=self.rows('source_obligation_reviews','workspace_id=eq.'+target_w+'&select=id',target_token)
        self.rpc('commit_workspace_restore',{'restore_id':session['id']},target_token)
        if self.rows('source_obligation_reviews','workspace_id=eq.'+target_w+'&select=id',target_token)!=before or self.rows('provider_usage','select=id',self.config.service_key):raise ProbeFailure('RESTORE_REPLAY_OR_USAGE_CHANGED')
        self.passed('restore_replay_has_no_duplicate_history_or_model_usage')
        if set(self.checks)!=RESTORE_CHECKS:raise ProbeFailure('RESTORE_INCOMPLETE_CHECKS')
        print(json.dumps({'probe':'bootstrap_acceptance','status':'passed','checks':{name:True for name in self.checks},'checks_passed':len(self.checks),
          'scope':'isolated_current_catalog_auth_storage_synthetic_restore_only','production_data_restored':False,'model_calls':0,'actual_application_renderer_exercised':False}),flush=True)

Acceptance=RestoreAcceptance
if __name__=='__main__':raise SystemExit(main())
