from contextlib import redirect_stdout
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

def result(code=0,stdout='',stderr=''):return subprocess.CompletedProcess([],code,stdout,stderr)
class DeliveryImageTests(unittest.TestCase):
 def test_inspection_requires_exact_source_label_own_repo_and_digest(self):
  ref=p.REGISTRY+'runtime@sha256:'+'b'*64
  good={'Config':{'Labels':{'org.opencontainers.image.revision':REVISION}},'RepoDigests':[ref]}
  with patch.object(p.subprocess,'run',return_value=result(stdout=json.dumps(good))):self.assertEqual(p.inspect(ref,REVISION,'runtime'),ref)
  for value in ({**good,'RepoDigests':['other@sha256:'+'b'*64]}, {**good,'Config':{'Labels':{'org.opencontainers.image.revision':'c'*40}}}, {**good,'RepoDigests':[ref,ref[:-1]+'c']}):
   with patch.object(p.subprocess,'run',return_value=result(stdout=json.dumps(value))),self.assertRaises(p.ImageError):p.inspect(ref,REVISION,'runtime')

 def test_checkout_must_match_declared_revision_and_have_no_tracked_changes(self):
  for head,clean in ((result(stdout='b'*40),result()),(result(stdout=REVISION),result(1))):
   with patch.object(p.subprocess,'run',side_effect=[head,clean]),self.assertRaisesRegex(p.ImageError,'CHECKOUT_MISMATCH'):p.verify_checkout(REVISION)

 def test_retries_reuse_existing_three_images_without_rebuild_and_tls_error_never_means_missing(self):
  for missing,error in ((False,False),(True,False),(False,True)):
   with self.subTest(missing=missing,error=error),tempfile.TemporaryDirectory() as directory:
    manifest=Path(directory)/'manifest';manifest.write_text('{"executor_max":4}')
    envfile=Path(directory)/'env';calls=[]
    def run(args,**kwargs):
     calls.append(args)
     if args[1:3]==['manifest','inspect']:
      if error:return result(1,stderr='TLS certificate verify failed with PRIVATE_PAYLOAD')
      if missing:return result(1,stderr='manifest unknown')
     if args[1:3]==['image','inspect']:
      name=args[3].split('/')[-1].split(':')[0]
      return result(stdout=json.dumps({'Config':{'Labels':{'org.opencontainers.image.revision':REVISION}},'RepoDigests':[p.REGISTRY+name+'@sha256:'+'b'*64]}))
     return result()
    with redirect_stdout(io.StringIO()),patch.dict(os.environ,{'GITHUB_SHA':REVISION,'DOKS_WORKDIR':directory,'GITHUB_ENV':str(envfile)}),patch.object(p.release,'MANIFEST',manifest),patch.object(p.release,'verify_source'),patch.object(p,'verify_checkout'),patch.object(p.subprocess,'run',side_effect=run):
     if error:
      with self.assertRaisesRegex(p.ImageError,'LOOKUP_FAILED'):p.prepare()
      self.assertFalse(envfile.exists())
     else:
      self.assertEqual(set(p.prepare()),{'runtime','frontend','ocr'})
      self.assertEqual(envfile.read_text().count('_IMAGE='),3)
    builds=[c for c in calls if c[1]=='build'];self.assertEqual(len(builds),3 if missing and not error else 0)
    if missing:
     for command in builds:self.assertIn('org.opencontainers.image.revision='+REVISION,command)
    self.assertFalse(any('browser' in c or 'https' in c for c in builds))

if __name__=='__main__':unittest.main()
