#!/usr/bin/env python3
"""Publish/reuse exactly three immutable images from the runner source revision."""
import importlib.util
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('delivery_image_contract',HERE/'proposal-delivery-release.py')
release=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=release;SPEC.loader.exec_module(release)
QSPEC=importlib.util.spec_from_file_location('runtime_qualification',HERE/'runtime-qualification.py')
qualification=importlib.util.module_from_spec(QSPEC);sys.modules[QSPEC.name]=qualification;QSPEC.loader.exec_module(qualification)
REGISTRY='registry.digitalocean.com/tenderdesk-a6093a76/'
IMAGES={'runtime':('backend/deploy/Dockerfile','.'),'frontend':('frontend/Dockerfile','.'),'ocr':('backend/deploy/Dockerfile.ocr','.')}
class ImageError(Exception):pass
_RAW_CONFIG_CACHE={}

def raw_image_config(value):
    """Read the config bytes whose SHA-256 is the observed immutable image ID.

    Docker inspect adds engine/API-specific container defaults. Those are not
    part of the image config, so they cannot define promotion compatibility.
    No archive member is extracted, and all runtime config fields stay bound.
    """
    identifier=value.get('Id','')
    if not isinstance(identifier,str) or not re.fullmatch('sha256:[a-f0-9]{64}',identifier):
        raise ImageError('DELIVERY_IMAGE_RAW_ID_INVALID')
    if identifier not in _RAW_CONFIG_CACHE:
        try:
            directory=Path(os.environ['DOKS_WORKDIR'])
            if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():raise ValueError()
            with tempfile.TemporaryDirectory(prefix='image-config-',dir=directory) as temp:
                archive=Path(temp)/'image.tar';archive.touch(mode=0o600)
                result=subprocess.run(['docker','image','save','--output',str(archive),identifier],
                    stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=180)
                if result.returncode:raise ValueError()
                digest=identifier[7:]
                with tarfile.open(archive) as saved:
                    members=[m for m in saved.getmembers() if m.name in (digest+'.json','blobs/sha256/'+digest)]
                    if len(members)!=1 or not members[0].isfile() or not 0<members[0].size<=1048576:raise ValueError()
                    raw=saved.extractfile(members[0]).read(1048577)
                if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError()
                decoded=json.loads(raw)
                if not isinstance(decoded,dict) or not isinstance(decoded.get('config'),dict):raise ValueError()
                _RAW_CONFIG_CACHE[identifier]=decoded
        except (KeyError,OSError,ValueError,TypeError,tarfile.TarError,subprocess.TimeoutExpired):
            raise ImageError('DELIVERY_IMAGE_RAW_CONFIG_UNVERIFIED') from None
    decoded=_RAW_CONFIG_CACHE[identifier]
    rootfs=decoded.get('rootfs',{})
    if (decoded.get('os')!=value.get('Os') or decoded.get('architecture')!=value.get('Architecture')
      or decoded.get('variant','')!=value.get('Variant','') or not isinstance(rootfs,dict)
      or {'Type':rootfs.get('type'),'Layers':rootfs.get('diff_ids')}!=value.get('RootFS')):
        # Fixed non-secret metadata only; never print environment/config values.
        observed_rootfs=value.get('RootFS',{})
        safe_variant=lambda v:v if isinstance(v,str) and re.fullmatch('[a-zA-Z0-9_.-]{0,16}',v) else 'unrecognized'
        print(json.dumps({'image':'raw_identity_mismatch',
          'raw_kind':'image_manifest' if decoded.get('schemaVersion')==2 and isinstance(decoded.get('config',{}).get('digest'),str) else 'image_config',
          'observed_id':identifier,
          'config_digest':decoded.get('config',{}).get('digest') if re.fullmatch('sha256:[a-f0-9]{64}',str(decoded.get('config',{}).get('digest',''))) else None,
          'os_matches':decoded.get('os')==value.get('Os'),
          'architecture_matches':decoded.get('architecture')==value.get('Architecture'),
          'raw_variant':safe_variant(decoded.get('variant','')),
          'inspect_variant':safe_variant(value.get('Variant','')),
          'rootfs_type_matches':isinstance(rootfs,dict) and rootfs.get('type')==observed_rootfs.get('Type'),
          'layer_digests_match':isinstance(rootfs,dict) and rootfs.get('diff_ids')==observed_rootfs.get('Layers')}),flush=True)
        raise ImageError('DELIVERY_IMAGE_RAW_IDENTITY_MISMATCH')
    return copy.deepcopy(decoded['config'])

def qualification_diagnostic(value,receipt):
    expected=receipt['qualified_image'];actual=value.get('Config',{})
    if not isinstance(actual,dict):actual={}
    actual_labels=actual.get('Labels')
    actual={k:v for k,v in actual.items() if k!='Labels'};baseline=expected['config_without_labels']
    # Field names are fixed Docker configuration names, never payload values.
    names={'User','Env','Cmd','Entrypoint','WorkingDir','ExposedPorts','Volumes','Healthcheck',
      'StopSignal','StopTimeout','Shell','OnBuild','ArgsEscaped','Hostname','Domainname','Image',
      'AttachStdin','AttachStdout','AttachStderr','Tty','OpenStdin','StdinOnce','NetworkDisabled'}
    safe=lambda keys:sorted({key if key in names else 'unknown_field' for key in keys})
    return {'original_id_matches':value.get('Id')==qualification.QUALIFIED_ID,
      'rootfs_matches':value.get('RootFS')==expected['rootfs'],
      'platform_matches':value.get('Os')==expected['os'] and value.get('Architecture')==expected['architecture'] and value.get('Variant','')==expected['variant'],
      'labels_match':actual_labels==expected['labels'],
      'config_fields':{'missing':safe(set(baseline)-set(actual)),'added':safe(set(actual)-set(baseline)),
        'changed':safe(k for k in set(actual)&set(baseline) if actual[k]!=baseline[k])}}

def inspect_qualified():
    manifest=json.loads(release.MANIFEST.read_text());release.verify_source(manifest)
    root=release.ROOT.parent;receipt=qualification.load(root);qualification.verify_checkout(root,receipt)
    reference=qualification.publication(root)
    path=Path(os.environ['DOKS_WORKDIR'])/'qualified-image-inspection.log'
    with path.open('w') as log:
        os.chmod(path,0o600)
        if subprocess.run(['docker','pull',reference],stdout=log,stderr=subprocess.STDOUT,timeout=1200).returncode:
            raise ImageError('DELIVERY_IMAGE_COMMAND_FAILED')
    value=image_metadata(reference,canonical_runtime=True)
    print(json.dumps({'image':'qualified_runtime_inspection','configuration_source':'sha256_verified_image_config_blob',**qualification_diagnostic(value,receipt)}),flush=True)
    qualification.verify_published(value,reference,receipt)

def verify_checkout(revision):
    head=subprocess.run(['git','-C',str(release.ROOT.parent),'rev-parse','HEAD'],capture_output=True,text=True,timeout=30)
    clean=subprocess.run(['git','-C',str(release.ROOT.parent),'diff','--quiet','HEAD','--'],capture_output=True,text=True,timeout=30)
    if head.returncode or head.stdout.strip()!=revision or clean.returncode:raise ImageError('DELIVERY_IMAGE_CHECKOUT_MISMATCH')

def image_metadata(reference,*,canonical_runtime=False):
    result=subprocess.run(['docker','image','inspect',reference,'--format','{{json .}}'],capture_output=True,text=True,timeout=30)
    try:
        if result.returncode or len(result.stdout)>1048576:raise ValueError()
        value=json.loads(result.stdout)
        if not isinstance(value,dict):raise ValueError()
        if canonical_runtime:value['Config']=raw_image_config(value)
        return value
    except (ValueError,TypeError,AttributeError):raise ImageError('DELIVERY_IMAGE_INSPECTION_FAILED') from None

def inspect(reference,revision,name):
    value=image_metadata(reference,canonical_runtime=name=='runtime')
    if name=='runtime':
        qualification.verify_image(value,qualification.load(release.ROOT.parent),revision)
    try:
        if value.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=revision:raise ImageError('DELIVERY_IMAGE_SOURCE_MISMATCH')
        matches=set(v for v in value.get('RepoDigests',[]) if isinstance(v,str) and re.fullmatch(re.escape(REGISTRY+name)+r'@sha256:[a-f0-9]{64}',v))
        if len(matches)!=1 or ('@sha256:' in reference and reference not in matches):raise ImageError('DELIVERY_IMAGE_DIGEST_MISMATCH')
        return matches.pop()
    except (ValueError,TypeError,AttributeError):raise ImageError('DELIVERY_IMAGE_INSPECTION_FAILED') from None

def prepare():
    manifest=json.loads(release.MANIFEST.read_text());release.verify_source(manifest)
    if manifest['executor_max']!=5 or manifest['renderer_versions']!=[1,2,3] or manifest['minimum_worker_executor']!=5:raise ImageError('DELIVERY_FINAL_RUNTIME_CONTRACT_REQUIRED')
    revision=os.environ.get('GITHUB_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',revision):raise ImageError('DELIVERY_IMAGE_SOURCE_INVALID')
    verify_checkout(revision)
    source_root=release.ROOT.parent
    receipt=qualification.load(source_root)
    qualification.verify_checkout(source_root,receipt)
    qualified_reference=qualification.publication(source_root)
    selected={}
    for name,(dockerfile,context) in IMAGES.items():
        reference=REGISTRY+name+':'+revision
        log_path=Path(os.environ['DOKS_WORKDIR'])/('delivery-'+name+'-build.log')
        with log_path.open('w') as log:
            os.chmod(log_path,0o600)
            def run(command):
                if subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=1200).returncode:raise ImageError('DELIVERY_IMAGE_COMMAND_FAILED')
            if name=='runtime':
                run(['docker','pull',qualified_reference])
                qualification.verify_published(image_metadata(qualified_reference,canonical_runtime=True),qualified_reference,receipt)
            lookup=subprocess.run(['docker','manifest','inspect',reference],capture_output=True,text=True,timeout=90)
            if lookup.returncode==0:
                run(['docker','pull',reference]);reused=True
                if name=='runtime':qualification.verify_image(image_metadata(reference,canonical_runtime=True),receipt,revision)
            elif re.search(r'manifest unknown|no such manifest',lookup.stderr,re.I):
                if name=='runtime':
                    # The only build instructions are FROM the exact published
                    # qualified image and its new revision LABEL. Never rebuild
                    # application sources, caches or filesystem layers.
                    with tempfile.TemporaryDirectory(prefix='runtime-promotion-',dir=os.environ['DOKS_WORKDIR']) as directory:
                        promotion=Path(directory)/'Dockerfile'
                        promotion.write_text(qualification.promotion_dockerfile(qualified_reference,revision))
                        run(['docker','build','--platform=linux/amd64','--network=none','--pull=false',
                             '--file',str(promotion),'--tag',reference,directory])
                    qualification.verify_image(image_metadata(reference,canonical_runtime=True),receipt,revision)
                else:
                    run(['docker','build','--platform=linux/amd64','--file',dockerfile,'--label','org.opencontainers.image.revision='+revision,'--tag',reference,context])
                run(['docker','push',reference]);reused=False
            else:raise ImageError('DELIVERY_IMAGE_LOOKUP_FAILED')
            if name=='runtime':qualification.verify_image(image_metadata(reference,canonical_runtime=True),receipt,revision)
            selected[name]=inspect(reference,revision,name)
        print(json.dumps({'image':name,'status':'published','reference':selected[name],'source_revision':revision,'existing_candidate_reused':reused}),flush=True)
    verify_checkout(revision)
    qualification.verify_checkout(source_root,receipt)
    with open(os.environ['GITHUB_ENV'],'a') as output:
        for name,value in selected.items():output.write('TENDERDESK_'+name.upper()+'_IMAGE='+value+'\n')
    return selected

def main(inspect_only=False):
    try:
        if inspect_only:inspect_qualified()
        else:prepare()
        return 0
    except Exception as error:
        print(json.dumps({'image':'delivery_release','status':'blocked','code':str(error) if isinstance(error,(ImageError,qualification.QualificationError)) else 'DELIVERY_IMAGE_FAILED'}));return 1
if __name__=='__main__':
    if sys.argv[1:] not in ([],['--inspect-qualified']):raise SystemExit('DELIVERY_IMAGE_ARGUMENTS_INVALID')
    sys.exit(main(inspect_only=bool(sys.argv[1:])))
