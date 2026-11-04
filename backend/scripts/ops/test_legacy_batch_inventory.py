"""Synthetic, offline metadata-only BATCH exposure census qualification."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('legacy_inventory_fixture',HERE/'test_digitalocean_inventory.py')
f=importlib.util.module_from_spec(spec);sys.modules[spec.name]=f;spec.loader.exec_module(f)
p=f.p

class LegacyBatchInventoryTests(unittest.TestCase):
 def test_empty_and_all_sql_null_buckets_are_explicit_without_invented_sizes(self):
  self.assertEqual(p.legacy_batch_observation(f.legacy_batch()),f.legacy_batch())
  value=f.legacy_batch();value.update(total_rows=1,active_rows=1,buckets=[{'expiry':'active','compression':'none','row_count':1,'null_result_count':1,
   'stored_bytes_sum':0,'stored_bytes_max':None,'stored_bytes_le_64k_count':0,'stored_bytes_le_1m_count':0,'stored_bytes_gt_1m_count':0}])
  self.assertEqual(p.legacy_batch_observation(value),value)

 def test_arbitrary_labels_identifiers_extra_fields_and_inconsistent_totals_are_rejected(self):
  base=f.legacy_batch();base.update(total_rows=1,active_rows=1,buckets=[{'expiry':'active','compression':'pglz','row_count':1,'null_result_count':0,
   'stored_bytes_sum':500,'stored_bytes_max':500,'stored_bytes_le_64k_count':1,'stored_bytes_le_1m_count':1,'stored_bytes_gt_1m_count':0}])
  self.assertEqual(p.legacy_batch_observation(base),base)
  for mutate in (lambda x:x.update(actor='PRIVATE'),lambda x:x.update(logical_or_wire_size_proved=True),lambda x:x.update(purged_state_not_inspected=False),
   lambda x:x['buckets'][0].update(compression='PRIVATE'),lambda x:x['buckets'][0].update(expiry='purged'),lambda x:x['buckets'][0].update(row_count=-1),
   lambda x:x['buckets'][0].update(stored_bytes_max=None),lambda x:x['buckets'][0].update(stored_bytes_le_1m_count=0),
   lambda x:x.update(total_rows=2),lambda x:x['buckets'].append(copy.deepcopy(x['buckets'][0]))):
   value=copy.deepcopy(base);mutate(value)
   with self.assertRaises(p.InventoryError):p.legacy_batch_observation(value)

 def test_query_preserves_original_readonly_timeouts_and_never_expands_results(self):
  sql=(HERE/'digitalocean-legacy-batch.sql').read_text()
  for required in ("SET LOCAL ROLE tdp_app_owner", "SET LOCAL statement_timeout='20s'", "SET LOCAL lock_timeout='5s'", "WHERE method='BATCH' AND route='commands'",'pg_column_size(result)','pg_column_compression(result)','result IS NULL','grouped AS MATERIALIZED'):
   self.assertIn(required,sql)
  self.assertTrue(sql.startswith('-- Global metadata census'));self.assertIn('REPEATABLE READ READ ONLY',sql);self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
  for forbidden in ('result::text','jsonb_typeof','jsonb_array','jsonb_path','->','workspace_id','actor_id','body_hash','hash(','INSERT INTO','DELETE FROM','UPDATE ','SELECT *','measured AS MATERIALIZED'):
   self.assertNotIn(forbidden,sql)

 def test_new_observation_is_additive_and_census_failure_still_cleans_up(self):
  deployments,pods=f.workloads()
  for fail in (False,True):
   def execute(pod,script):
    if fail and 'legacy_batch_commands' in script:raise RuntimeError('PRIVATE_QUERY_ERROR')
    return f.sql_response(pod,script)
   with patch.dict(p.os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=f.responses(deployments,pods)),patch.object(p.observer,'Client') as client,patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',side_effect=execute):
    client.return_value.labels={}
    if fail:
     with self.assertRaises(RuntimeError):p.inventory()
    else:
     value=p.inventory();self.assertEqual(value['legacy_batch_observation'],f.legacy_batch());self.assertEqual(value['schema'],p.public_schema(f.schema()))
     self.assertEqual(value['workloads'],p.public_workloads(deployments,pods))
    client.return_value.cleanup.assert_called_once()

 def test_actual_postgres_metadata_census_distinguishes_expiry_and_compression_without_payload_output(self):
  result=subprocess.run(['node',str(HERE/'test_legacy_batch_inventory.mjs')],input=json.dumps({'sql':(HERE/'digitalocean-legacy-batch.sql').read_text()}),text=True,capture_output=True,timeout=60)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  value=json.loads(result.stdout);self.assertEqual(p.legacy_batch_observation(value),value)

if __name__=='__main__':unittest.main()
