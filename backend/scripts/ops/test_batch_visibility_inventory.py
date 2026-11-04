import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('batch_visibility_inventory_test', HERE/'digitalocean-inventory.py')
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


class BatchVisibilityInventoryTests(unittest.TestCase):
 def test_only_exact_read_only_observer_runs_and_success_does_not_claim_a_drain(self):
  value={'marker':'2026-11-04T22:00:00.000000+00:00','visibility_verified':True,'old_transactions':4}
  client=Mock(pod='synthetic-client')
  with patch.object(p.d,'sql',return_value=json.dumps(value)) as sql, patch.object(p.cutover,'drain_transactions') as drain, patch.object(p.cutover,'GatewayDrain') as fence:
   actual=p.batch_visibility_observation(client)
  statement=p.cutover.transaction_observation_sql()
  sql.assert_called_once_with('synthetic-client',statement)
  drain.assert_not_called();fence.assert_not_called()
  self.assertEqual(actual['observer_sql_sha256'],hashlib.sha256(statement.encode()).hexdigest())
  self.assertEqual(actual['old_transactions'],4)
  self.assertEqual(actual['authority_basis'],'existing_set_authority_to_exact_login_role')
  self.assertFalse(actual['transactions_drained']);self.assertFalse(actual['admission_fence_changed'])
  self.assertEqual(actual['sessions_terminated'],0);self.assertEqual(actual['authority_grants_changed'],0)
  self.assertIn('BEGIN READ ONLY',statement)
  self.assertIn('SET LOCAL ROLE tdp_app_authenticator',statement)
  self.assertIn('pg_backend_pid()',statement)
  self.assertTrue(statement.rstrip().endswith('ROLLBACK;'))
  for forbidden in ('pg_terminate_backend(', 'pg_cancel_backend(', 'GRANT ', 'UPDATE ', 'DELETE ', 'INSERT '):
   self.assertNotIn(forbidden,statement)

 def test_hidden_unknown_malformed_or_private_projection_cannot_become_zero(self):
  good={'marker':'2026-11-04T22:00:00.000000+00:00','visibility_verified':True,'old_transactions':0}
  variants=[dict(good,visibility_verified=False),dict(good,old_transactions=None),dict(good,old_transactions=True),dict(good,old_transactions=-1),dict(good,query='private query'),dict(good,marker='private value')]
  for value in variants:
   with self.subTest(value=value),patch.object(p.d,'sql',return_value=json.dumps(value)):
    with self.assertRaisesRegex(p.InventoryError,'INVENTORY_BATCH_VISIBILITY_UNPROVEN'):
     p.batch_visibility_observation(Mock(pod='synthetic-client'))

 def test_transport_or_authority_error_has_no_private_diagnostic(self):
  with patch.object(p.d,'sql',side_effect=RuntimeError('private role/session/credential')):
   with self.assertRaises(p.InventoryError) as error:
    p.batch_visibility_observation(Mock(pod='synthetic-client'))
  self.assertEqual(str(error.exception),'INVENTORY_BATCH_VISIBILITY_UNPROVEN')

 def test_inventory_still_cleans_client_when_visibility_is_unproved(self):
  fixture_spec=importlib.util.spec_from_file_location('batch_visibility_inventory_fixture',HERE/'test_digitalocean_inventory.py')
  fixture=importlib.util.module_from_spec(fixture_spec);fixture_spec.loader.exec_module(fixture)
  values,pods=fixture.workloads()
  with patch.dict(p.os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=fixture.responses(values,pods)),patch.object(p.observer,'Client') as client,patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',side_effect=fixture.sql_response),patch.object(p,'batch_visibility_observation',side_effect=p.InventoryError('INVENTORY_BATCH_VISIBILITY_UNPROVEN')):
   with self.assertRaisesRegex(p.InventoryError,'INVENTORY_BATCH_VISIBILITY_UNPROVEN'):p.inventory()
   client.return_value.cleanup.assert_called_once()


if __name__ == '__main__':unittest.main()
