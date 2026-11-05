"""Offline failure-location and public-redaction controls; no cluster calls."""
from contextlib import redirect_stdout
import io
import json
import os
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_cloud_retirement_runner as fixture

m=fixture.m;r=m.r;c=m.c

class CommandDiagnostics(unittest.TestCase):
 def setUp(self):
  self.environment=patch.dict(os.environ,{'KUBECTL':'/private/kubectl','KUBECONFIG':'/private/kubeconfig'})
  self.environment.start();self.addCleanup(self.environment.stop)
  r.phase('canonical_fixture_write');self.addCleanup(r.phase,'not_started')
 def failure(self,stderr,stdout='private-password customer-id bearer-token'):
  result=SimpleNamespace(returncode=1,stdout=stdout,stderr=stderr)
  with patch.object(r.subprocess,'run',return_value=result):
   try:r.command(['exec','private-pod','-n','private-namespace','--','python3','private-script'],payload='private-sql-password')
   except c.FixtureError as error:return error
  self.fail('nonzero subprocess must fail')
 def test_remote_failure_keeps_location_without_private_command_or_output(self):
  error=self.failure('private-customer command terminated with exit code 1')
  value=r.failure_diagnostic(error)
  self.assertEqual(value,{'command_diagnostic':{'phase':'canonical_fixture_write','command':'exec','resource_class':'other','exit_code':1,'category':'remote_exit','child_code':None,'child_http_status':None,'sqlstate':None}})
  self.assertEqual(str(error),'RETIREMENT_FIXTURE_COMMAND_FAILED')
  self.assertNotIn('private',json.dumps(vars(error)))
  self.assertNotIn('bearer',json.dumps(vars(error)))
 def test_only_exact_known_writer_failure_envelope_can_publish_code_and_status(self):
  known={'failed':True,'code':'RETIREMENT_FIXTURE_RPC_APP_COMMAND_FAILED','http_status':400}
  value=r.failure_diagnostic(self.failure('',json.dumps(known)))['command_diagnostic']
  self.assertEqual((value['child_code'],value['child_http_status']),(known['code'],400))
  for changed in ({**known,'code':'PRIVATE_CUSTOMER_ERROR'},{**known,'private_token':'secret'},
    {**known,'failed':False},{**known,'http_status':True}):
   value=r.failure_diagnostic(self.failure('',json.dumps(changed)))['command_diagnostic']
   self.assertIsNone(value['child_code']);self.assertIsNone(value['child_http_status'])
 def test_sqlstate_requires_exact_psql_mode_and_excludes_private_error_text(self):
  for stderr,expected in [('ERROR:  42501\ncommand terminated with exit code 3\n','42501'),
    ('ERROR:  42703\n','42703'),('ERROR:  SECRET\n',None),
    ('ERROR:  42501: private-name\n',None),('ERROR:  42501\nERROR:  P0001\n',None)]:
   result=SimpleNamespace(returncode=3,stdout='private row',stderr=stderr)
   args=['exec','private-pod','--','psql','-v','VERBOSITY=sqlstate']
   value=r.failure_diagnostic(r.command_failure('RETIREMENT_FIXTURE_COMMAND_FAILED',args,result=result))
   self.assertEqual(value['command_diagnostic']['sqlstate'],expected)
   self.assertNotIn('private',json.dumps(value))
  self.assertIsNone(r.failure_diagnostic(self.failure('ERROR:  42501\n'))['command_diagnostic']['sqlstate'])
 def test_client_start_failure_is_distinct_from_timeout_without_exception_text(self):
  with patch.object(r.subprocess,'run',side_effect=OSError('private executable path')):
   with self.assertRaises(c.FixtureError) as result:r.command(['get','secret','private-name'])
  self.assertEqual(r.failure_diagnostic(result.exception)['command_diagnostic']['category'],'client_start')
  self.assertNotIn('private',json.dumps(vars(result.exception)))
 def test_error_categories_are_fixed_not_extracted_diagnostic_text(self):
  for stderr,expected in (('Error from server (Forbidden): private','forbidden'),
    ('Error from server (NotFound): private','resource_missing'),
    ('x509: certificate signed by unknown authority private','tls_verification'),
    ('private arbitrary SQL stack trace','nonzero_exit')):
   with self.subTest(category=expected):
    self.assertEqual(r.failure_diagnostic(self.failure(stderr))['command_diagnostic']['category'],expected)
 def test_timeout_never_retains_subprocess_command_or_partial_output(self):
  failure=subprocess.TimeoutExpired(['private-command'],1,output='private-output',stderr='private-secret')
  with patch.object(r.subprocess,'run',side_effect=failure):
   with self.assertRaises(c.FixtureError) as result:r.command(['exec','private-pod'])
  self.assertEqual(r.failure_diagnostic(result.exception)['command_diagnostic']['category'],'timeout')
  self.assertNotIn('private',json.dumps(vars(result.exception)))
 def test_malformed_or_unrecognized_metadata_is_not_published(self):
  error=self.failure('unknown')
  for field,value in (('phase','private-phase'),('category','private-message'),('command',{}),('exit_code',True)):
   changed=c.FixtureError('RETIREMENT_FIXTURE_COMMAND_FAILED')
   changed.public_command_diagnostic={**error.public_command_diagnostic,field:value}
   with self.subTest(field=field):self.assertEqual(r.failure_diagnostic(changed),{})
 def test_main_emits_only_allowlisted_failure_and_preserves_cleanup(self):
  error=self.failure('private-customer command terminated with exit code 1')
  with patch.object(m,'prepare_access'),patch.object(m,'prepare',side_effect=error),patch.object(c.restore.inventory,'cleanup_saved_client') as cleanup,redirect_stdout(io.StringIO()) as out:
   self.assertEqual(m.main(['prepare']),1)
  cleanup.assert_called_once()
  value=json.loads(out.getvalue())
  self.assertEqual(value['code'],'RETIREMENT_FIXTURE_COMMAND_FAILED')
  self.assertEqual(value['command_diagnostic']['phase'],'canonical_fixture_write')
  self.assertNotIn('private',out.getvalue())
 def test_success_preserves_private_output_and_reviewed_transport_arguments(self):
  with patch.object(r.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='private result',stderr='')) as command:
   self.assertEqual(r.command(['get','secret','private-name'],payload='private body',timeout=17),'private result')
  self.assertEqual(command.call_args.args[0],['/private/kubectl','--request-timeout=30s','get','secret','private-name'])
  self.assertEqual(command.call_args.kwargs,{'input':'private body','capture_output':True,'text':True,'timeout':17})

if __name__=='__main__':unittest.main()
