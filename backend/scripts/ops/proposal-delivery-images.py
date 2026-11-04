#!/usr/bin/env python3
"""Publish/reuse exactly three immutable images from the runner source revision."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('delivery_image_contract',HERE/'proposal-delivery-release.py')
release=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=release;SPEC.loader.exec_module(release)
REGISTRY='registry.digitalocean.com/tenderdesk-a6093a76/'
IMAGES={'runtime':('backend/deploy/Dockerfile','.'),'frontend':('frontend/Dockerfile','frontend'),'ocr':('backend/deploy/Dockerfile.ocr','.')}
class ImageError(Exception):pass

def verify_checkout(revision):
    head=subprocess.run(['git','-C',str(release.ROOT.parent),'rev-parse','HEAD'],capture_output=True,text=True,timeout=30)
    clean=subprocess.run(['git','-C',str(release.ROOT.parent),'diff','--quiet','HEAD','--'],capture_output=True,text=True,timeout=30)
    if head.returncode or head.stdout.strip()!=revision or clean.returncode:raise ImageError('DELIVERY_IMAGE_CHECKOUT_MISMATCH')

def inspect(reference,revision,name):
    result=subprocess.run(['docker','image','inspect',reference,'--format','{{json .}}'],capture_output=True,text=True,timeout=30)
    try:
        if result.returncode or len(result.stdout)>1048576:raise ValueError()
        value=json.loads(result.stdout)
        if value.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=revision:raise ImageError('DELIVERY_IMAGE_SOURCE_MISMATCH')
        matches=set(v for v in value.get('RepoDigests',[]) if isinstance(v,str) and re.fullmatch(re.escape(REGISTRY+name)+r'@sha256:[a-f0-9]{64}',v))
        if len(matches)!=1 or ('@sha256:' in reference and reference not in matches):raise ImageError('DELIVERY_IMAGE_DIGEST_MISMATCH')
        return matches.pop()
    except (ValueError,TypeError,AttributeError):raise ImageError('DELIVERY_IMAGE_INSPECTION_FAILED') from None

def prepare():
    manifest=json.loads(release.MANIFEST.read_text());release.verify_source(manifest)
    if manifest['executor_max']!=4 or manifest['renderer_versions']!=[1,2,3] or manifest['minimum_worker_executor']!=4:raise ImageError('DELIVERY_FINAL_RUNTIME_CONTRACT_REQUIRED')
    revision=os.environ.get('GITHUB_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',revision):raise ImageError('DELIVERY_IMAGE_SOURCE_INVALID')
    verify_checkout(revision)
    selected={}
    for name,(dockerfile,context) in IMAGES.items():
        reference=REGISTRY+name+':'+revision
        log_path=Path(os.environ['DOKS_WORKDIR'])/('delivery-'+name+'-build.log')
        with log_path.open('w') as log:
            os.chmod(log_path,0o600)
            def run(command):
                if subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=1200).returncode:raise ImageError('DELIVERY_IMAGE_COMMAND_FAILED')
            lookup=subprocess.run(['docker','manifest','inspect',reference],capture_output=True,text=True,timeout=90)
            if lookup.returncode==0:
                run(['docker','pull',reference]);reused=True
            elif re.search(r'manifest unknown|no such manifest',lookup.stderr,re.I):
                run(['docker','build','--platform=linux/amd64','--file',dockerfile,'--label','org.opencontainers.image.revision='+revision,'--tag',reference,context])
                run(['docker','push',reference]);reused=False
            else:raise ImageError('DELIVERY_IMAGE_LOOKUP_FAILED')
            selected[name]=inspect(reference,revision,name)
        print(json.dumps({'image':name,'status':'published','reference':selected[name],'source_revision':revision,'existing_candidate_reused':reused}),flush=True)
    with open(os.environ['GITHUB_ENV'],'a') as output:
        for name,value in selected.items():output.write('TENDERDESK_'+name.upper()+'_IMAGE='+value+'\n')
    return selected

def main():
    try:prepare();return 0
    except Exception as error:
        print(json.dumps({'image':'delivery_release','status':'blocked','code':str(error) if isinstance(error,ImageError) else 'DELIVERY_IMAGE_FAILED'}));return 1
if __name__=='__main__':sys.exit(main())
