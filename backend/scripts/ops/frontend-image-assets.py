#!/usr/bin/env python3
"""Read and browser-test exact static assets from a never-started frontend image."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import uuid

class AssetError(Exception):pass

def require(ok,code):
    if not ok:raise AssetError('FRONTEND_IMAGE_'+code)

def extract(stream,directory):
    seen=set();total=0;count=0
    with tarfile.open(fileobj=stream,mode='r|*') as archive:
        for member in archive:
            name=member.name
            while name.startswith('./'):name=name[2:]
            name=name.rstrip('/') or '.';path=PurePosixPath(name)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in name and path.as_posix()==name and name not in seen,'ARCHIVE_PATH_INVALID')
            seen.add(name);require(member.isdir() or member.isreg(),'ARCHIVE_TYPE_INVALID')
            if member.isdir():
                (directory/name).mkdir(parents=True,exist_ok=True);continue
            total+=member.size;count+=1
            require(0<=member.size<=16*1024*1024 and total<=128*1024*1024 and count<=2000,'ARCHIVE_SIZE_INVALID')
            target=directory/name;target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(member) as content,target.open('xb') as output:
                value=content.read(16*1024*1024+1);require(len(value)==member.size,'ARCHIVE_SIZE_INVALID');output.write(value)
    require((directory/'index.html').is_file(),'INDEX_REQUIRED')

def verified_assets(reference,revision,images,frontend):
    require(images.inspect(reference,revision,'frontend')==reference,'IDENTITY_MISMATCH')
    name='td-frontend-assets-'+uuid.uuid4().hex[:16]
    with tempfile.TemporaryDirectory(prefix='frontend-assets-',dir=os.environ['DOKS_WORKDIR']) as temporary:
        directory=Path(temporary);assets=directory/'html';assets.mkdir();created=False
        with (directory/'inspection.log').open('w') as log:
            def docker(*args,**kwargs):
                return subprocess.run(['docker',*args],stderr=log,check=True,timeout=120,**kwargs)
            try:
                docker('create','--name',name,'--network','none','--read-only',reference,stdout=log);created=True
                state=json.loads(docker('inspect','--format','{{json .State}}',name,capture_output=False,stdout=subprocess.PIPE).stdout)
                require(state.get('Status')=='created' and state.get('Running') is False,'CONTAINER_STARTED')
                with (directory/'assets.tar').open('w+b') as archive:
                    docker('cp',name+':/usr/share/nginx/html/.','-',stdout=archive);archive.seek(0);extract(archive,assets)
            finally:
                if created:docker('rm',name,stdout=log)
            expected=frontend.build_assets(assets)
            env=dict(os.environ,TENDERDESK_BROWSER_DIST=str(assets))
            result=subprocess.run(['node',str(frontend.REPOSITORY/'frontend/deploy/verify-workspace-boot.mjs')],
                env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180,check=False)
            require(result.returncode==0,'WORKSPACE_BROWSER_FAILED')
            return expected,{'index_sha256':hashlib.sha256(expected['index']).hexdigest(),
                'code_assets':len(expected['assets']),'source':'immutable_frontend_image',
                'container_never_started':True,'inspection_container_removed':True,'workspace_browser_fixture_passed':True}

@contextmanager
def reference_directory(expected):
    """Supply the same verified bytes to the public PDF worker browser probe."""
    with tempfile.TemporaryDirectory(prefix='frontend-reference-',dir=os.environ['DOKS_WORKDIR']) as temporary:
        directory=Path(temporary)
        (directory/'index.html').write_bytes(expected['index'])
        for name,content in expected['assets'].items():
            path=PurePosixPath(name)
            require(name.startswith('/assets/') and '..' not in path.parts and path.as_posix()==name,'REFERENCE_PATH_INVALID')
            target=directory/name[1:];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
        yield directory
