from contextlib import redirect_stdout, ExitStack
import copy
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('tested_delivery_images',Path(__file__).with_name('proposal-delivery-images.py'))
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)
REVISION='a'*40
QUALIFIED=p.REGISTRY+'runtime@sha256:'+'c'*64
RECEIPT=p.qualification.load(Path(__file__).resolve().parents[3])


def result(code=0,stdout='',stderr=''):return subprocess.CompletedProcess([],code,stdout,stderr)

def runtime_image(promoted=False):
 r=RECEIPT['qualified_image']
 labels=copy.deepcopy(r['labels'])
 if promoted:labels[p.qualification.REVISION_LABEL]=REVISION
 return {'Id':'sha256:'+'f'*64 if promoted else p.qualification.QUALIFIED_ID,
         'Architecture':r['architecture'],'Os':r['os'],'RootFS':copy.deepcopy(r['rootfs']),
         'Config':{**copy.deepcopy(r['config_without_labels']),'Labels':labels},
         'RepoDigests':[p.REGISTRY+'runtime@sha256:'+('b' if promoted else 'c')*64]}


class DeliveryImageTests(unittest.TestCase):
 def test_diagnostic_reports_only_bound_field_names_and_identity_booleans(self):
  value=runtime_image();value['Config'].pop('ArgsEscaped');value['Config']['Env']=['PRIVATE_SECRET'];value['Config']['PRIVATE_KEY']='PRIVATE_VALUE'
  observed=p.qualification_diagnostic(value,RECEIPT)
  self.assertTrue(observed['original_id_matches']);self.assertTrue(observed['rootfs_matches'])
  self.assertEqual(observed['config_fields'],{'missing':['ArgsEscaped'],'added':['unknown_field'],'changed':['Env']})
  self.assertNotIn('PRIVATE',json.dumps(observed))
  self.assertFalse(p.qualification_diagnostic({**value,'Config':None},RECEIPT)['labels_match'])
 def test_read_only_inspection_pulls_only_qualified_reference_and_never_builds_or_pushes(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'DOKS_WORKDIR':directory}),patch.object(p.subprocess,'run',return_value=result()) as run,patch.object(p,'image_metadata',return_value=runtime_image()),patch.object(p.qualification,'publication',return_value=QUALIFIED),patch.object(p.qualification,'verify_checkout'),redirect_stdout(io.StringIO()) as output:
   p.inspect_qualified()
  self.assertEqual(run.call_count,1);self.assertEqual(run.call_args.args[0],['docker','pull',QUALIFIED])
  self.assertEqual(json.loads(output.getvalue())['config_fields'],{'missing':[],'added':[],'changed':[]})
 def test_inspection_mode_is_separate_from_mandatory_release_gates(self):
  workflow=(Path(__file__).resolve().parents[3]/'.github/workflows/deploy-proposal-delivery.yml').read_text()
  self.assertEqual(workflow.count('if: ${{ inputs.inspect_qualified_image != true }}'),3)
  self.assertIn('if: ${{ inputs.inspect_qualified_image == true }}',workflow)
  self.assertIn('always() && inputs.inspect_qualified_image != true',workflow)
  self.assertIn('default: false',workflow)
  self.assertIn('proposal-delivery-images.py --inspect-qualified',workflow)
 def test_inspection_requires_exact_source_label_own_repo_and_digest(self):
  ref=p.REGISTRY+'runtime@sha256:'+'b'*64
  good=runtime_image(True)
  with patch.object(p.subprocess,'run',return_value=result(stdout=json.dumps(good))):self.assertEqual(p.inspect(ref,REVISION,'runtime'),ref)
  for value in ({**good,'RepoDigests':['other@sha256:'+'b'*64]}, {**good,'Config':{'Labels':{'org.opencontainers.image.revision':'c'*40}}}, {**good,'RepoDigests':[ref,ref[:-1]+'c']}):
   with patch.object(p.subprocess,'run',return_value=result(stdout=json.dumps(value))),self.assertRaises((p.ImageError,p.qualification.QualificationError)):p.inspect(ref,REVISION,'runtime')

 def test_updater_direct_runtime_inspection_also_requires_qualified_filesystem_and_config(self):
  ref=p.REGISTRY+'runtime@sha256:'+'b'*64
  for kind in ['rootfs','config','absent']:
   value=runtime_image(True)
   if kind=='rootfs':value['RootFS']['Layers'].reverse()
   if kind=='config':value['Config']['Cmd']=['run','unqualified.ts']
   if kind=='absent':del value['RootFS']
   with self.subTest(kind=kind),patch.object(p.subprocess,'run',return_value=result(stdout=json.dumps(value))),self.assertRaises(p.qualification.QualificationError):
    p.inspect(ref,REVISION,'runtime')

 def test_checkout_must_match_declared_revision_and_have_no_tracked_changes(self):
  for head,clean in ((result(stdout='b'*40),result()),(result(stdout=REVISION),result(1))):
   with patch.object(p.subprocess,'run',side_effect=[head,clean]),self.assertRaisesRegex(p.ImageError,'CHECKOUT_MISMATCH'):p.verify_checkout(REVISION)

 def exercise(self, missing=False, lookup_error=False, mutation=None, source_error=False, unpublished=False):
  with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
   manifest=Path(directory)/'manifest';manifest.write_text('{"executor_max":5,"renderer_versions":[1,2,3],"minimum_worker_executor":5}')
   envfile=Path(directory)/'env';calls=[];recipes=[]
   def run(args,**kwargs):
    calls.append(args)
    if args[1:3]==['manifest','inspect']:
     if lookup_error:return result(1,stderr='TLS certificate verify failed with PRIVATE_PAYLOAD')
     if missing:return result(1,stderr='manifest unknown')
    if args[1]=='build' and '--network=none' in args:
     context=Path(args[-1]);self.assertEqual([f.name for f in context.iterdir()],['Dockerfile'])
     recipes.append((context/'Dockerfile').read_text())
    if args[1:3]==['image','inspect']:
     ref=args[3]
     if ref==QUALIFIED:value=runtime_image()
     elif '/runtime:' in ref:value=runtime_image(True)
     else:
      name=ref.split('/')[-1].split(':')[0]
      value={'Config':{'Labels':{'org.opencontainers.image.revision':REVISION}},'RepoDigests':[p.REGISTRY+name+'@sha256:'+'b'*64]}
     if mutation:mutation(ref,value)
     return result(stdout=json.dumps(value))
    return result()
   stack.enter_context(redirect_stdout(io.StringIO()))
   stack.enter_context(patch.dict(os.environ,{'GITHUB_SHA':REVISION,'DOKS_WORKDIR':directory,'GITHUB_ENV':str(envfile)}))
   stack.enter_context(patch.object(p.release,'MANIFEST',manifest))
   stack.enter_context(patch.object(p.release,'verify_source'))
   stack.enter_context(patch.object(p,'verify_checkout'))
   stack.enter_context(patch.object(p.qualification,'load',return_value=RECEIPT))
   stack.enter_context(patch.object(p.qualification,'verify_checkout',side_effect=p.qualification.QualificationError('SOURCE') if source_error else None))
   stack.enter_context(patch.object(p.qualification,'publication',side_effect=p.qualification.QualificationError('PUBLICATION_PENDING') if unpublished else None,return_value=QUALIFIED))
   stack.enter_context(patch.object(p.subprocess,'run',side_effect=run))
   error=None
   try:selected=p.prepare()
   except (p.ImageError,p.qualification.QualificationError) as caught:error=caught;selected=None
   return selected,error,calls,recipes,envfile.read_text() if envfile.exists() else None

 def test_retries_reuse_three_images_only_after_runtime_identity_check(self):
  selected,error,calls,recipes,env=self.exercise()
  self.assertIsNone(error);self.assertEqual(set(selected),{'runtime','frontend','ocr'})
  self.assertEqual(env.count('_IMAGE='),3);self.assertFalse(recipes)
  self.assertFalse(any(c[1] in ('build','push') for c in calls))
  self.assertEqual(calls[0],['docker','pull',QUALIFIED])

 def test_missing_runtime_promotes_exact_image_only_and_verifies_before_push(self):
  selected,error,calls,recipes,env=self.exercise(missing=True)
  self.assertIsNone(error);self.assertEqual(set(selected),{'runtime','frontend','ocr'})
  self.assertEqual(recipes,[f'FROM {QUALIFIED}\nLABEL org.opencontainers.image.revision={REVISION}\n'])
  builds=[c for c in calls if c[1]=='build'];self.assertEqual(len(builds),3)
  self.assertIn('--network=none',builds[0]);self.assertIn('--pull=false',builds[0])
  self.assertNotIn('backend/deploy/Dockerfile',builds[0])
  for command in builds[1:]:self.assertIn('org.opencontainers.image.revision='+REVISION,command)
  build_index=calls.index(builds[0]);push_index=next(i for i,c in enumerate(calls) if c[1]=='push')
  self.assertTrue(any(c[1:3]==['image','inspect'] for c in calls[build_index+1:push_index]))
  self.assertEqual(env.count('_IMAGE='),3)

 def test_tls_lookup_failure_is_not_a_missing_image(self):
  _,error,calls,_,env=self.exercise(lookup_error=True)
  self.assertRegex(str(error),'LOOKUP_FAILED');self.assertIsNone(env)
  self.assertFalse(any(c[1] in ('build','push') for c in calls))

 def test_source_or_unpublished_qualification_blocks_before_docker(self):
  for options in [{'source_error':True},{'unpublished':True}]:
   with self.subTest(options=options):
    _,error,calls,_,env=self.exercise(**options)
    self.assertIsNotNone(error);self.assertFalse(calls);self.assertIsNone(env)

 def test_published_baseline_with_same_registry_name_but_wrong_image_is_refused(self):
  def mutation(ref,value):
   if ref==QUALIFIED:value['Id']='sha256:'+'d'*64
  _,error,calls,_,env=self.exercise(missing=True,mutation=mutation)
  self.assertRegex(str(error),'IMAGE_ID');self.assertIsNone(env)
  self.assertFalse(any(c[1] in ('build','push') for c in calls))

 def test_revision_label_cannot_disguise_changed_filesystem_or_configuration(self):
  for missing in [False,True]:
   for field in ['RootFS','Config','Labels']:
    with self.subTest(missing=missing,field=field):
     def mutation(ref,value):
      if '/runtime:' not in ref:return
      if field=='RootFS':value['RootFS']['Layers'].append('sha256:'+'d'*64)
      if field=='Config':value['Config']['Env'].append('SURPRISE=1')
      if field=='Labels':value['Config']['Labels']['extra']='unqualified'
     _,error,calls,_,env=self.exercise(missing=missing,mutation=mutation)
     self.assertIsNotNone(error);self.assertIsNone(env)
     self.assertFalse(any(c[1]=='push' for c in calls))

if __name__=='__main__':unittest.main()
