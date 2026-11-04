"""Offline projection and binding tests; never contacts DO or Kubernetes."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('capacity_inventory_fixture',HERE/'test_digitalocean_inventory.py')
f=importlib.util.module_from_spec(spec);sys.modules[spec.name]=f;spec.loader.exec_module(f)
p=f.p

class CapacityTests(unittest.TestCase):
 def test_actual_deployment_and_ready_pod_resources_remain_distinct(self):
  values,pods=f.workloads()
  rest=next(x for x in values if x['metadata']['name']=='rest')
  container=rest['spec']['template']['spec']['containers'][0]
  container['resources']={'requests':{'cpu':'50m','memory':'32Mi'},'limits':{'cpu':'500m','memory':'128Mi'}}
  container['env']=[{'name':'PGRST_DB_URI','valueFrom':{'secretKeyRef':{'name':'tenderdesk-core','key':'POSTGREST_DATABASE_URL'}}},
   {'name':'PGRST_DB_ANON_ROLE','value':'tdp_app_anon'},{'name':'PGRST_DB_POOL','value':'5'},{'name':'PGRST_DB_MAX_ROWS','value':'1000'},
   {'name':'PRIVATE_PASSWORD','value':'CUSTOMER_CREDENTIAL'}]
  pod=pods[p.NAMES.index('rest')];pod['status']['containerStatuses'][0]['ready']=True
  pod['spec']={'containers':[copy.deepcopy(container)]};pod['spec']['containers'][0]['resources']['limits']['memory']='256Mi'
  before=p.public_workloads(values,pods)
  result=next(x for x in p.capacity_workloads(values,pods,'tdp_app_authenticator') if x['name']=='rest')
  self.assertEqual(result['deployment_resources']['limits']['memory'],'128Mi')
  self.assertEqual(result['ready_pod_observations'][0]['resources']['limits']['memory'],'256Mi')
  self.assertEqual(result['deployment_configuration']['rest_pool'],{'explicit':True,'value':5})
  self.assertTrue(result['deployment_configuration']['rest_authenticator_binding_verified'])
  self.assertEqual(before,p.public_workloads(values,pods))
  self.assertNotIn('CUSTOMER_CREDENTIAL',json.dumps(result));self.assertNotIn('POSTGREST_DATABASE_URL',json.dumps(result))

 def test_roles_are_fixed_allowlists_and_no_environment_or_unknown_value_is_emitted(self):
  container={'env':[{'name':'APP_RUNTIME_SERVICE','value':'worker'},{'name':'PGRST_DB_ANON_ROLE','value':'PRIVATE_CUSTOMER_ROLE'},
   {'name':'PGRST_DB_POOL','value':'postgresql://private:credential@host'}]}
  result=p.capacity_environment(container,'tdp_app_authenticator')
  self.assertEqual(result['runtime_service'],{'explicit':True,'value':'worker'})
  self.assertIsNone(result['rest_anon_role']['value']);self.assertIsNone(result['rest_pool']['value'])
  self.assertIsNone(result['rest_authenticator_role']);self.assertFalse(result['rest_authenticator_binding_verified'])
  self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('credential',json.dumps(result))
  self.assertEqual(p.capacity_environment({},None)['runtime_service'],{'explicit':False,'value':None})

 def test_unknown_and_missing_resource_limits_are_not_replaced_by_repository_defaults(self):
  self.assertEqual(p.capacity_resources({}),{'requests':None,'limits':None})
  with self.assertRaises(p.InventoryError):p.capacity_resources({'resources':{'limits':{'memory':'CUSTOMER_PRIVATE'}}})
  with self.assertRaises(p.InventoryError):p.capacity_environment({'env':[{'name':'APP_RUNTIME_SERVICE','value':'api'},{'name':'APP_RUNTIME_SERVICE','value':'worker'}]},None)

 def test_managed_metadata_does_not_derive_hardware_or_emit_connection_fields(self):
  result=p.d.probe.public_database_capacity({'size':'db-s-1vcpu-1gb','num_nodes':2,'private_connection':{'host':'private-host','password':'SECRET'},'memory':1024,'vcpus':1})
  self.assertEqual(result['size_slug'],'db-s-1vcpu-1gb');self.assertEqual(result['node_count'],2)
  self.assertIsNone(result['ram_mib_per_node']);self.assertIsNone(result['vcpus_per_node'])
  self.assertEqual(result['hardware_basis'],'not_reported_by_database_metadata')
  self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('private-host',json.dumps(result))
  self.assertIsNone(p.d.probe.public_database_capacity({'size':'CUSTOMER_PRIVATE'})['size_slug'])
  self.assertIsNone(p.d.probe.public_database_capacity({})['node_count'])
  with self.assertRaises(p.d.probe.ProbeError):p.d.probe.public_database_capacity({'num_nodes':True})
  self.assertEqual(p.capacity_metadata({'managed_database':result}),{'managed_database':result})
  for bad in ({'host':'SECRET'},{'rest_database_role':'SECRET'},{'managed_database':result|{'host':'SECRET'}}):
   with self.assertRaises(p.InventoryError):p.capacity_metadata(bad)

 def test_optional_capacity_capture_reuses_the_existing_metadata_and_ca_reads(self):
  probe=p.d.probe
  private={'id':probe.DATABASE_ID,'name':'tenderdesk-dev','engine':'pg','region':'sfo3','size':'db-s-1vcpu-1gb','num_nodes':1,
   'private_connection':{'host':'private-synthetic.db.ondigitalocean.com','port':25060,'user':'doadmin','password':'SYNTHETIC_PRIVATE_PASSWORD','database':'defaultdb'}}
  captured={}
  with patch.object(probe,'request_json',side_effect=[{'database':private},{'ca':{'certificate':'-----BEGIN CERTIFICATE-----synthetic-only'}}]) as request,patch.object(probe.ssl,'SSLContext'):
   credentials,certificate=probe.target_credentials('synthetic-token',capacity_metadata=captured)
  self.assertEqual(request.call_count,2)
  self.assertEqual(request.call_args_list[0].args[0],'https://api.digitalocean.com/v2/databases/'+probe.DATABASE_ID)
  self.assertEqual(credentials['PGPASSWORD'],'SYNTHETIC_PRIVATE_PASSWORD')
  self.assertNotIn('SYNTHETIC_PRIVATE_PASSWORD',json.dumps(captured));self.assertNotIn('private-synthetic',json.dumps(captured))
  self.assertEqual(captured['managed_database']['node_count'],1)
  self.assertTrue(certificate.startswith('-----BEGIN CERTIFICATE-----'))

 def test_rest_role_requires_exact_existing_database_and_original_ca_binding(self):
  credentials={'PGHOST':'private-synthetic.db.ondigitalocean.com','PGPORT':'25060'}
  uri='postgresql://tdp_app_authenticator:synthetic-password@private-synthetic.db.ondigitalocean.com:25060/tenderdesk_app?sslmode=verify-full&sslrootcert=%2Frun%2Fdb-ca%2Fca.crt'
  self.assertEqual(p.observer.rest_database_role({'POSTGREST_DATABASE_URL':uri},credentials),'tdp_app_authenticator')
  for bad in (uri.replace('verify-full','require'),uri.replace('tdp_app_authenticator','private_customer'),uri.replace('tenderdesk_app?','other?'),uri.replace('private-synthetic.','private-other.')):
   with self.assertRaises(p.observer.ObserverError):p.observer.rest_database_role({'POSTGREST_DATABASE_URL':bad},credentials)

 def test_query_values_are_labeled_as_observer_and_catalog_not_rest_effective(self):
  value=f.capacity_settings();value['configured_defaults']=[{'scope':'current_database','role':'tdp_app_authenticated','name':'statement_timeout','value':'15s'}]
  self.assertEqual(p.capacity_settings(value),value)
  self.assertEqual(value['observed_login_settings'][1]['setting'],0)
  self.assertEqual(value['query_overrides']['statement_timeout_ms'],20000)
  for mutate in (lambda x:x.update(basis='actual_rest_effective'),lambda x:x['configured_defaults'][0].update(value='CUSTOMER_PRIVATE'),lambda x:x['observed_login_settings'][0].update(source='SECRET'),lambda x:x.update(extra='SECRET')):
   bad=copy.deepcopy(value);mutate(bad)
   with self.assertRaises(p.InventoryError):p.capacity_settings(bad)

 def test_capacity_sql_snapshots_original_settings_before_override_and_reads_no_business_rows(self):
  sql=(HERE/'digitalocean-capacity.sql').read_text()
  self.assertLess(sql.index("set_config('tenderdesk.capacity_settings'"),sql.index("SET LOCAL statement_timeout='20s'"))
  self.assertIn('BEGIN READ ONLY;',sql);self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
  for forbidden in ('SET LOCAL ROLE','INSERT INTO','UPDATE public.','DELETE FROM','public.workspaces','pg_stat_activity','query_text','pg_file_settings'):
   self.assertNotIn(forbidden,sql)

 def test_actual_postgres_query_preserves_original_settings_and_distinct_role_database_defaults(self):
  result=subprocess.run(['node',str(HERE/'test_inventory_capacity.mjs')],input=json.dumps({'sql':(HERE/'digitalocean-capacity.sql').read_text()}),capture_output=True,text=True,timeout=60)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  value=json.loads(result.stdout);self.assertEqual(p.capacity_settings(value),value)

 def test_inventory_new_diagnostic_is_additive_and_cleanup_remains_required(self):
  values,pods=f.workloads()
  with patch.dict(p.os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=f.responses(values,pods)),patch.object(p.observer,'Client') as client,patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',side_effect=f.sql_response):
   client.return_value.labels={};result=p.inventory()
  self.assertEqual(result['schema'],p.public_schema(f.schema()))
  self.assertEqual(result['workloads'],p.public_workloads(values,pods))
  self.assertFalse(result['capacity_observation']['rest_transaction_effective_settings_proved'])
  self.assertIsNone(result['capacity_observation']['managed_database'])
  client.return_value.cleanup.assert_called_once()

if __name__=='__main__':unittest.main()
