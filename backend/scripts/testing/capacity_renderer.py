#!/usr/bin/env python3
"""Bounded offline renderer measurement; no hosted/model calls or mutable image tag.

Generate the three synthetic model files using proposalCapacity.integration.test.ts.
An existing cached application image supplies Deno/dependencies; the exact current
renderer sources/fonts are staged read-only with hashes in the output receipt.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
IMAGE = 'sha256:08eeb4ffa1c2'  # Prefix is resolved to one full local image identity.

def docker(*args, timeout=60):
    env = dict(os.environ)
    for key in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'):
        env.pop(key, None)
    return subprocess.run(['docker','--host=unix:///var/run/docker.sock',*args],capture_output=True,text=True,timeout=timeout,env=env)

def run(models, image, mode='standard', artifacts=None, verifier_source=None, renderer_source=None):
    if not re.fullmatch(r'sha256:[a-f0-9]{12,64}',image):
        raise ValueError('Pass an immutable local image ID')
    inspected=docker('image','inspect','--format','{{.Id}}',image)
    if inspected.returncode: raise RuntimeError('Required cached Deno application image is unavailable')
    identity=inspected.stdout.strip()
    inputs=Path(models).resolve()
    names=('dense-minimal-sparse-body-limit-authored.json','dense-direction-runs-authored.json','dense-ragged-authored.json','dense-empty-body-limit-authored.json','dense-paragraph-authored.json','dense-short-authored.json','dense-body-limit-authored.json') if mode=='final-capacity' else ('dense-minimal-sparse-body-limit-authored.json',) if mode=='worker-capacity' else ('dense-authored.json',) if mode=='dense-heap-matrix' else ('dense-short-authored.json','dense-body-limit-authored.json') if mode in ('streamed-capacity','streamed-render-only','concurrent-capacity') else ('dense-empty-body-limit-authored.json','dense-paragraph-authored.json') if mode in ('density-edges','density-render-only') else ('dense-sparse-body-limit-authored.json',) if mode.startswith('sparse-') else ('dense-direction-runs-authored.json',) if mode.startswith('direction-') else ('en-4000.json','en-100000.json','ar-1000000.json')
    if any(not (inputs/name).is_file() for name in names): raise ValueError('Expected frozen synthetic model files for the selected mode')
    with tempfile.TemporaryDirectory(prefix='tenderdesk-capacity-') as temp:
        stage=Path(temp); app=stage/'app'; staged_inputs=stage/'inputs'; staged_inputs.mkdir(); staged_outputs=stage/'outputs'; staged_outputs.mkdir()
        paths=['backend/supabase/functions','frontend/src/lib/renderDocx.ts','frontend/src/lib/docxTableStream.ts','frontend/public/fonts','backend/scripts/testing/capacity_renderer.ts','backend/scripts/testing/capacity_renderer.py','frontend/package.json','frontend/package-lock.json','backend/package.json','backend/package-lock.json']
        hashes={}
        for relative in paths:
            source=ROOT/relative; target=app/relative; target.parent.mkdir(parents=True,exist_ok=True)
            if source.is_dir(): shutil.copytree(source,target)
            else: shutil.copyfile(source,target)
        if renderer_source:
            shutil.copyfile(renderer_source/'frontend/src/lib/renderDocx.ts',app/'frontend/src/lib/renderDocx.ts')
        if verifier_source:
            for name in ('export.ts','boundedDocx.ts','boundedDocxArchive.ts','boundedXml.ts'):
                shutil.copyfile(verifier_source/'backend/supabase/functions/_shared'/name,app/'backend/supabase/functions/_shared'/name)
        for name in names: shutil.copyfile(inputs/name,staged_inputs/name)
        for path in stage.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
            if path.is_file(): hashes[str(path.relative_to(stage))]=hashlib.sha256(path.read_bytes()).hexdigest()
        stage.chmod(0o755)
        staged_outputs.chmod(0o777)
        container='tdp-capacity-'+os.urandom(6).hex()
        started=time.monotonic()
        try:
            result=docker('run','--rm','--name',container,'--network','none','--memory','640m','--cpus','1','--pids-limit','128','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--entrypoint','/bin/sh',
                '--mount',f'type=bind,src={app},dst=/app,readonly','--mount',f'type=bind,src={staged_inputs},dst=/inputs,readonly','--mount',f'type=bind,src={staged_outputs},dst=/outputs',identity,
                '-c', '/bin/deno run --cached-only --frozen --config=/app/backend/supabase/functions/deno.json --allow-read=/app,/deno-dir,/inputs --allow-write=/outputs --allow-run=/bin/deno /app/backend/scripts/testing/capacity_renderer.ts /inputs "$1"; result=$?; cat /sys/fs/cgroup/memory.peak > /outputs/cgroup_memory_peak_bytes; cat /sys/fs/cgroup/memory.max > /outputs/cgroup_memory_limit_bytes; exit "$result"', 'capacity', mode, timeout=360)
            if result.returncode:
                raise RuntimeError('Offline capacity renderer failed: '+result.stderr[-1500:])
            lines=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if len(lines)!=1: raise RuntimeError('Unexpected renderer receipt')
            receipt=lines[0]
            receipt.update({key:int((staged_outputs/key).read_text().strip()) for key in ('cgroup_memory_peak_bytes','cgroup_memory_limit_bytes')})
            if artifacts: shutil.copytree(staged_outputs,artifacts)
            receipt.update(image_id=identity,container_limits={'memory_bytes':640*1024*1024,'cpus':1,'pids':128,'network':'none','read_only_root':True,'tmpfs_bytes':64*1024*1024},elapsed_ms=round((time.monotonic()-started)*1000),source_and_input_sha256=hashes)
            return receipt
        finally:
            # Own exact random container only; cleanup on timeout or failed output.
            docker('rm','-f',container)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--models',type=Path,required=True);parser.add_argument('--image',default=IMAGE);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--verifier-source',type=Path);parser.add_argument('--renderer-source',type=Path);parser.add_argument('--mode',choices=('final-capacity','worker-capacity','standard','dense-heap-matrix','streamed-capacity','streamed-render-only','concurrent-capacity','density-edges','density-render-only','sparse-capacity','sparse-render-only','direction-capacity','direction-render-only'),default='standard');args=parser.parse_args()
    if args.output.exists(): raise RuntimeError('Choose a new receipt path; existing evidence is immutable')
    artifacts=args.output.with_suffix('')
    if artifacts.exists(): raise RuntimeError('Choose a new artifact path')
    receipt=run(args.models,args.image,args.mode,artifacts,args.verifier_source,args.renderer_source);args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'scope':receipt['scope'],'cases':len(receipt['cases']),'bounded_errors':sum(c['outcome']=='bounded_error' for c in receipt['cases']),'output':str(args.output)}))
