#!/usr/bin/env python3
"""Registry reads and a local label-only build; no push, cluster or business call."""
import importlib.util,json,os,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent

def load(name,file):
 s=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def main():
 images=load('promotion_inspection_images','proposal-delivery-images.py');runner=load('promotion_inspection_registry','digitalocean-runner.py')
 revision=os.environ['GITHUB_SHA'];images.verify_checkout(revision)
 root=HERE.parents[2];q=images.qualification;receipt=q.load(root);q.verify_checkout(root,receipt);reference=q.publication(root)
 with tempfile.TemporaryDirectory(prefix='promotion-inspection-') as directory:
  directory=Path(directory);registry=directory/'docker';registry.mkdir(mode=0o700)
  runner.write(registry/'config.json',runner.docker_credentials(write_access=False))
  os.environ.update(DOKS_WORKDIR=str(directory),DOCKER_CONFIG=str(registry))
  with (directory/'build.log').open('w') as log:
   def run(*args):subprocess.run(['docker',*args],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
   run('pull',reference);q.verify_published(images.image_metadata(reference,canonical_runtime=True),reference,receipt)
   print(json.dumps({'promotion_inspection':'published_image_verified'}),flush=True)
   context=directory/'context';context.mkdir();recipe=context/'Dockerfile';recipe.write_text(q.promotion_dockerfile(reference,revision));tag='tenderdesk-promotion-inspection:'+revision
   try:
    run('build','--platform=linux/amd64','--network=none','--pull=false','--file',str(recipe),'--tag',tag,str(context))
    q.verify_image(images.image_metadata(tag,canonical_runtime=True),receipt,revision)
    print(json.dumps({'promotion_inspection':'exact_config_and_layers_verified','published':False,'production_calls':0}),flush=True)
   finally:subprocess.run(['docker','image','rm',tag],stdout=log,stderr=subprocess.STDOUT,timeout=60,check=False)
 print(json.dumps({'promotion_inspection':'private_credentials_removed'}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as error:
  import re
  print(json.dumps({'promotion_inspection':'failed','code':str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',str(error)) else 'INSPECTION_FAILED'}));sys.exit(1)
