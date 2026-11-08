import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec); sys.modules[name] = value; spec.loader.exec_module(value)
    return value


m = load('draft_copy_tests', 'proposal-draft-copy.py')
requests = load('draft_copy_request_fixture', 'test_proposal_trial_request.py')
downloads = load('draft_copy_transport_fixture', 'test_proposal_trial_download.py')
uid = downloads.uuid


def fixture():
    base = requests.fixture(); base['plan']['stage'] = 'completed'; base['proposal']['active_version_id'] = uid(201)
    base['guards']['usage_ready'] = False
    base['retry_usage'] = {'has_unknown': True, 'has_reserved': False}
    return {'version': 1, 'kind': 'proposal_draft_copy_proof', 'selection': base['selection'], 'actor_id': base['actor_id'], 'base': base,
        'copy': {'observed_at': datetime.now(timezone.utc).isoformat(), 'version': {'id': uid(201), 'revision': 1, 'content_hash': 'a'*64,
            'status': 'draft', 'required_volumes': ['combined'], 'review_hash': 'b'*64, 'review_finding_count': 8, 'blocking_finding_count': 6},
            'preserved': dict.fromkeys(m.PRESERVED, 'c'*64), 'existing': None,
            'guards': dict.fromkeys(('current_target','failed_generated_issuance','draft_version','owner','sources','unique_package'), True)}}


class DraftCopyTests(unittest.TestCase):
    def setUp(self):
        m._ATTEMPTED.clear(); self.proof = fixture(); self.prepared = m.prepare(self.proof)

    def target(self):
        start = datetime.now(timezone.utc) - timedelta(seconds=2)
        return m._target(self.proof, {'package_id': uid(301), 'job_id': uid(302), 'accepted_at': start.isoformat(), 'deadline_at': (start+timedelta(seconds=600)).isoformat()})

    def value(self, target=None):
        target = target or self.target()
        return {'observed_at': datetime.now(timezone.utc).isoformat(), 'preserved': target['preserved'].copy(),
            'package': {'id': target['package_id'], 'status': 'ready', 'error_code': None, 'mode': 'draft', 'renderer_version': 'ordinary-2',
                'proposal_version_id': target['proposal_version_id'], 'version_revision': target['version_revision'], 'current_job_id': target['job_id'],
                'accepted_at': target['accepted_at'], 'deadline_at': target['deadline_at'], 'required_volumes': ['combined'], 'updated_at': datetime.now(timezone.utc).isoformat()},
            'job': {'id': target['job_id'], 'type': 'render_export', 'entity_id': target['package_id'], 'status': 'succeeded', 'error_code': None},
            'findings': [{'severity': 'blocking' if i<6 else 'advisory', 'detail': 'Synthetic review finding '+str(i)} for i in range(8)],
            'artifacts': [{'id':uid(401),'export_id':uid(402),'volume':'combined','status':'ready','content_hash':'d'*64,'expected_size':1000,'original_name':'proposal_v2_combined_draft.docx','mime_type':m.files.DOCX_MIME}],
            'guards': dict.fromkeys(('source','owner','version','latest_plan','failed_issuance','no_restore','snapshot_reviews'), True)}

    def test_one_exact_canonical_draft_command_and_stable_replay_identity(self):
        self.assertEqual(self.prepared['body'], {'commands':[{'operation':'export.package.prepare','input':{'proposal_version_id':uid(201),'expected_revision':1,'mode':'draft'}}]})
        changed = copy.deepcopy(self.proof); changed['copy']['observed_at'] = '2025-01-01T00:00:00+00:00'
        self.assertEqual(m.prepare(changed)['prepared_object'], self.prepared['prepared_object'])
        self.assertEqual(self.prepared['command_key'], hashlib.sha256(('batch:'+self.prepared['idempotency_key']+':1').encode()).hexdigest())
        bad = copy.deepcopy(self.prepared); bad['body']['commands'][0]['input']['mode'] = 'final'
        with self.assertRaises(m.DraftCopyError): m.validate_prepared(bad)

    def test_nonowner_source_restore_lease_and_stale_version_fail_before_send(self):
        for guard in m.REQUEST.GUARDS-{'usage_ready'}:
            proof=fixture(); proof['base']['guards'][guard]=False
            with self.subTest(base=guard),self.assertRaises((m.DraftCopyError,m.REQUEST.TrialRequestError)):m.prepare(proof)
        for guard in self.proof['copy']['guards']:
            proof=fixture(); proof['copy']['guards'][guard]=False
            with self.subTest(copy=guard),self.assertRaises(m.DraftCopyError):m.prepare(proof)
        for key,value in [('id',uid(999)),('status','approved'),('revision',True),('review_hash','bad')]:
            proof=fixture();proof['copy']['version'][key]=value
            with self.subTest(key=key),self.assertRaises(m.DraftCopyError):m.prepare(proof)

    def test_existing_package_is_observe_only(self):
        target=self.target(); self.proof['copy']['existing']={k:target[k] for k in ('package_id','job_id','accepted_at','deadline_at')}
        prepared=m.prepare(self.proof);self.assertEqual(prepared['mode'],'observe_existing')
        client=Mock()
        with self.assertRaisesRegex(m.DraftCopyError,'OBSERVE_ONLY'):m.send(client,{},prepared,Mock())
        client.request.assert_not_called()

    def test_unknown_response_persists_once_and_never_resubmits(self):
        client=Mock();client.request.return_value=Mock(status=0,body=b'')
        session={'user':{'id':self.proof['actor_id']},'access_token':'synthetic-token'}
        persist=Mock(side_effect=lambda p:hashlib.sha256(m.encoded(p)).hexdigest())
        result=m.send(client,session,self.prepared,persist)
        self.assertTrue(result['unknown']);self.assertFalse(result['accepted'])
        with self.assertRaisesRegex(m.DraftCopyError,'ALREADY_ATTEMPTED'):m.send(client,session,self.prepared,persist)
        client.request.assert_called_once();persist.assert_called_once()
        self.assertEqual(client.request.call_args.kwargs['data'],self.prepared['body'])

    def test_bad_persistence_session_or_post_persistence_mutation_never_posts(self):
        client=Mock();session={'user':{'id':self.proof['actor_id']},'access_token':'synthetic-token'}
        with self.assertRaises(m.DraftCopyError):m.send(client,session,self.prepared,lambda _: '0'*64)
        with self.assertRaises(m.DraftCopyError):m.send(client,{'user':{'id':uid(999)},'access_token':'x'},self.prepared,Mock())
        with self.assertRaises(m.DraftCopyError):m.send(client,session,self.prepared,lambda p:hashlib.sha256(m.encoded(p)).hexdigest(),lambda:self.prepared['body']['commands'][0]['input'].update(mode='final'))
        client.request.assert_not_called()

    def test_unrelated_usage_change_is_ignored_but_selected_history_is_exact(self):
        fresh=copy.deepcopy(self.proof);fresh['base']['retry_usage']={'has_reserved':True,'has_unknown':False};fresh['base']['guards']['usage_ready']=True
        with patch.object(m,'inspect',return_value=fresh):m.recheck(None,self.proof['selection'],self.prepared)
        fresh['copy']['preserved']['usage']='e'*64
        with patch.object(m,'inspect',return_value=fresh),self.assertRaisesRegex(m.DraftCopyError,'CHANGED_BEFORE_SEND'):m.recheck(None,self.proof['selection'],self.prepared)

    def test_sql_is_scoped_readonly_and_does_not_call_mutating_package_context(self):
        target=self.target()
        for sql in (m.inspection_sql(self.proof['base']),m.observation_sql(target),m.acceptance_sql(self.prepared)):
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',sql)
            self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
            self.assertNotRegex(sql,r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|for update|app_command\(|export_package_context\(')
        sql=m.observation_sql(target)
        self.assertIn("r.outcome='failed'",sql);self.assertIn("r.id='"+target['failed_issuance_request_id'],sql)
        self.assertIn("and id='"+target['plan_id']+"' and kind='proposal'",sql)

    def test_ready_sample_preserves_failed_issuance_and_all_eight_findings(self):
        target=self.target();value=self.value(target)
        with patch.object(m.REQUEST,'read',return_value=value):result=m.sample(None,target)
        self.assertEqual(result['outcome'],'ready');self.assertFalse(result['generated_issuance_passed'])
        public=m.public_receipt(result)
        self.assertEqual(public['review_finding_count'],8);self.assertEqual(public['blocking_finding_count'],6)
        self.assertFalse(public['generated_issuance_issued']);self.assertFalse(public['approval_granted'])
        self.assertNotIn('Synthetic review finding',json.dumps(public));self.assertNotIn(uid(201),json.dumps(public))
        for guard in value['guards']:
            changed=copy.deepcopy(value);changed['guards'][guard]=False
            with patch.object(m.REQUEST,'read',return_value=changed),self.subTest(guard=guard),self.assertRaises(m.DraftCopyError):m.sample(None,target)
        value['preserved']['approvals']='e'*64
        with patch.object(m.REQUEST,'read',return_value=value),self.assertRaisesRegex(m.DraftCopyError,'HISTORY_CHANGED'):m.sample(None,target)



if __name__=='__main__':unittest.main()
