"""Build the closed candidate offline and retain every attempt. Never run OCR."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,required=True)
parser.add_argument('--context',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--tag',required=True)
args=parser.parse_args()
root=args.root.resolve();context=args.context.resolve();out=args.output.resolve()
assert not out.exists()
assert re.fullmatch(r'a06-paddle-offline:20261105-[a-z0-9._-]+',args.tag)
assert shutil.disk_usage('/workspace').free>4*1024**3, 'Insufficient disk before offline build'
env=os.environ.copy()
for key in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']:env.pop(key,None)
docker=['docker','--host=unix:///var/run/docker.sock']
def command(argv,timeout=60):return subprocess.check_output(argv,env=env,text=True,timeout=timeout)
def save(name,data):(out/name).write_text(json.dumps(data,indent=2)+'\n')
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def snapshot():
    return {'head':command(['git','-C',str(root),'rev-parse','HEAD']).strip(),
     'status':command(['git','-C',str(root),'status','--porcelain']),
     'source_hashes':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root/'backend/scripts/testing/paddle_candidate').glob('*')) if p.is_file()},
     'disk_free':shutil.disk_usage('/workspace').free}
subprocess.run(['python3',str(root/'backend/scripts/testing/paddle_candidate/verify_context.py'),str(context)],check=True)
out.mkdir();before=snapshot();save('source-before.json',before)
argv=docker+['build','--platform=linux/amd64','--pull=false','--network=none','--progress=plain','--tag',args.tag,str(context)]
save('command.json',{'argv':argv,'no_candidate_import_or_inference':True,'started_at':now(),
 'context_manifest_sha256':hashlib.sha256((context/'context-manifest.json').read_bytes()).hexdigest(),
 'build_helper_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
start=time.monotonic()
with (out/'build.log').open('x') as log:
    try:code=subprocess.run(argv,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1200).returncode
    except subprocess.TimeoutExpired:code=124
receipt={'exit_code':code,'elapsed_seconds':time.monotonic()-start,'finished_at':now(),'disk_free':shutil.disk_usage('/workspace').free}
save('build-receipt.json',receipt);after=snapshot();save('source-after.json',after)
if code==0:
    inspected=json.loads(command(docker+['image','inspect',args.tag]));save('image-inspect.json',inspected)
    image=inspected[0];receipt['image_id']=image['Id'];receipt['image_size_bytes']=image['Size']
    assert before['source_hashes']==after['source_hashes'] and before['head']==after['head'], 'Source changed during build'
    # VFS can need two full mutable filesystem copies even for docker cp.
    # Export only the metadata tree with a COPY-only scratch stage instead.
    export=out/'metadata-export-context';export.mkdir()
    dockerfile=f'FROM {args.tag} AS candidate\nFROM scratch\nCOPY --from=candidate /provenance/ /\n'
    (export/'Dockerfile').write_text(dockerfile)
    export_command=docker+['build','--pull=false','--network=none','--progress=plain',
        '--output','type=local,dest='+str(out/'image-provenance'),str(export)]
    save('metadata-export-command.json',{'argv':export_command,'source_image_id':image['Id'],
        'Dockerfile_sha256':hashlib.sha256(dockerfile.encode()).hexdigest(),'no_RUN_or_container_start':True})
    with (out/'metadata-export.log').open('x') as log:
        exported=subprocess.run(export_command,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120)
    receipt['metadata_export_exit_code']=exported.returncode
    save('build-receipt.json',receipt)
    assert exported.returncode==0, 'Metadata COPY-only export failed'
    assert json.loads(command(docker+['image','inspect',args.tag]))[0]['Id']==image['Id'], 'Image tag changed during metadata export'
    assert (out/'image-provenance/context-manifest.json').read_bytes()==(context/'context-manifest.json').read_bytes()
    receipt['metadata_export_without_container_start']=True
    receipt['disk_free_after_metadata_cleanup']=shutil.disk_usage('/workspace').free
    save('build-receipt.json',receipt)
print(json.dumps(receipt))
raise SystemExit(code)
