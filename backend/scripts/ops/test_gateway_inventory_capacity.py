"""Sanitized observed gateway facts; no cluster access or inferred capacity."""
import copy
import json
import unittest
from test_inventory_capacity import f,p

class GatewayInventoryCapacityTests(unittest.TestCase):
 def test_https_actual_resources_are_projected_without_inferring_declared_envelope(self):
  deployments,pods=f.workloads();dep=next(x for x in deployments if x['metadata']['name']=='https')
  row=next(x for x in p.capacity_workloads(deployments,pods) if x['name']=='https')
  self.assertEqual(row['deployment_resources'],{'requests':None,'limits':None})
  container=dep['spec']['template']['spec']['containers'][0]
  container.update(resources={'requests':{'memory':'32Mi'},'limits':{'memory':'128Mi','cpu':'300m'}},
   env=[{'name':'TLS_PRIVATE_KEY','value':'NEVER_EMIT_TLS_SECRET'}])
  pod=pods[p.NAMES.index('https')];pod['status']['containerStatuses'][0]['ready']=True
  pod['spec']={'containers':[copy.deepcopy(container)]};pod['spec']['containers'][0]['resources']['limits']={'memory':'256Mi','cpu':'500m'}
  row=next(x for x in p.capacity_workloads(deployments,pods) if x['name']=='https')
  self.assertEqual(row['deployment_resources']['limits']['memory'],'128Mi')
  self.assertEqual(row['ready_pod_observations'][0]['resources']['limits']['memory'],'256Mi')
  self.assertNotIn('NEVER_EMIT_TLS_SECRET',json.dumps(row));self.assertNotIn('deployment_gateway_runtime',row)

 def test_gateway_deployment_and_actual_ready_pod_limits_and_tmp_stay_distinct(self):
  deployments,pods=f.workloads();dep=next(x for x in deployments if x['metadata']['name']=='gateway')
  spec=dep['spec']['template']['spec'];container=spec['containers'][0]
  container.update(command=['nginx','-g','daemon off;'],volumeMounts=[{'name':'scratch','mountPath':'/tmp'}],
   resources={'requests':{'memory':'16Mi','cpu':'25m'},'limits':{'memory':'64Mi','cpu':'200m'}},
   env=[{'name':'PRIVATE_PASSWORD','value':'NEVER_EMIT_SECRET'}])
  spec['volumes']=[{'name':'scratch','emptyDir':{'sizeLimit':'64Mi'}},{'name':'private','secret':{'secretName':'NEVER_EMIT_SECRET'}}]
  pod=pods[p.NAMES.index('gateway')];pod['status']['containerStatuses'][0]['ready']=True;pod['spec']=copy.deepcopy(spec)
  pod['spec']['containers'][0]['resources']['limits']={'memory':'128Mi','cpu':'400m'}
  pod['spec']['volumes'][0]['emptyDir']={'sizeLimit':'128Mi','medium':'Memory'}
  baseline=p.public_workloads(deployments,pods)
  row=next(x for x in p.capacity_workloads(deployments,pods) if x['name']=='gateway');ready=row['ready_pod_observations'][0]
  self.assertEqual(row['deployment_resources']['limits']['memory'],'64Mi');self.assertEqual(ready['resources']['limits']['memory'],'128Mi')
  declared=row['deployment_gateway_runtime']['temporary_storage'];observed=ready['gateway_runtime']['temporary_storage']
  self.assertEqual((declared['source_kind'],declared['medium'],declared['size_limit']),('emptyDir','default','64Mi'))
  self.assertEqual((observed['medium'],observed['size_limit']),('Memory','128Mi'))
  self.assertFalse(observed['hard_filesystem_cap_proved']);self.assertEqual(observed['basis'],'observed_kubernetes_spec')
  self.assertTrue(ready['gateway_runtime']['entrypoint_recognized'])
  self.assertNotIn('NEVER_EMIT_SECRET',json.dumps(row));self.assertNotIn('scratch',json.dumps(row))
  self.assertEqual(baseline,p.public_workloads(deployments,pods))

 def test_missing_unknown_and_ambiguous_storage_never_use_repository_defaults(self):
  row=p.gateway_capacity_configuration({},{});self.assertFalse(row['entrypoint_recognized'])
  self.assertEqual(row['temporary_storage']['source_kind'],'missing');self.assertIsNone(row['temporary_storage']['size_limit'])
  container={'volumeMounts':[{'name':'private','mountPath':'/tmp'}]}
  spec={'volumes':[{'name':'private','hostPath':{'path':'NEVER_EMIT_PATH'}}]}
  row=p.gateway_capacity_configuration(spec,container)
  self.assertEqual(row['temporary_storage']['source_kind'],'other');self.assertNotIn('NEVER_EMIT_PATH',json.dumps(row))
  spec['volumes'].append({'name':'private','emptyDir':{'sizeLimit':'64Mi'}})
  self.assertEqual(p.gateway_capacity_configuration(spec,container)['temporary_storage']['source_kind'],'ambiguous')

 def test_subpaths_and_descendant_mounts_are_observed_without_emitting_paths(self):
  container={'volumeMounts':[{'name':'scratch','mountPath':'/tmp','subPath':'NEVER_EMIT_SUBPATH','readOnly':True},
   {'name':'private','mountPath':'/tmp/NEVER_EMIT_PATH'}]}
  row=p.gateway_capacity_configuration({'volumes':[{'name':'scratch','emptyDir':{'sizeLimit':'64Mi'}}]},container)['temporary_storage']
  self.assertEqual(row['mount_count'],1);self.assertEqual(row['descendant_mount_count'],1)
  self.assertTrue(row['read_only']);self.assertTrue(row['subpath_present']);self.assertNotIn('NEVER_EMIT',json.dumps(row))
  container['volumeMounts'].append({'name':'another','mountPath':'/tmp'})
  row=p.gateway_capacity_configuration({},container)['temporary_storage']
  self.assertEqual(row['mount_count'],2);self.assertEqual(row['source_kind'],'ambiguous');self.assertIsNone(row['size_limit'])

 def test_only_qualified_entrypoint_shape_is_recognized_and_bad_quantities_fail_closed(self):
  for change in ({'command':['PRIVATE_COMMAND']},{'command':['nginx','-g','daemon off;'],'args':['PRIVATE_ARGUMENT']}):
   row=p.gateway_capacity_configuration({},change);self.assertFalse(row['entrypoint_recognized']);self.assertNotIn('PRIVATE',json.dumps(row))
  container={'volumeMounts':[{'name':'scratch','mountPath':'/tmp'}]}
  for value in ('PRIVATE_LIMIT',True,{},'64mi'):
   with self.subTest(value=value),self.assertRaises(p.InventoryError):
    p.gateway_capacity_configuration({'volumes':[{'name':'scratch','emptyDir':{'sizeLimit':value}}]},container)

if __name__=='__main__':unittest.main()
