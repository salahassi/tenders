"""Inventory installed metadata and ELF dependencies; no Paddle/cv2 imports."""
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

dest=Path('/provenance')
def run(args,env=None):
    result=subprocess.run(args,capture_output=True,text=True,timeout=60,env=env)
    return {'argv':args,'returncode':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
def save(name,data):
    (dest/name).write_text(json.dumps(data,indent=2)+'\n')
packages=sorted([{'name':d.metadata['Name'],'version':d.version} for d in metadata.distributions()],key=lambda p:p['name'].lower())
save('python-installed.json',packages)
save('interpreter.json',{'version':sys.version,'executable':sys.executable,'libc':platform.libc_ver(),'machine':platform.machine()})
checks={name:run(argv) for name,argv in {
 'pip_check':[sys.executable,'-m','pip','check'],
 'pip_version':[sys.executable,'-m','pip','--version'],
 'node_version':['/usr/local/bin/node','--version'],
 'node_parent_import':['/usr/local/bin/node','--experimental-transform-types','--input-type=module','-e',"const m=await import('/app/backend/scripts/backend/uploaded-document-ocr-worker.ts'); if(typeof m.processUploadedDocumentOcr!=='function')throw Error('missing actual parent'); console.log('actual parent import verified; no invocation');"],
 'dpkg_inventory':['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'],
 'dpkg_audit':['dpkg','--audit'],
 'poppler_version':['pdftoppm','-v'],
}.items()}
save('checks.json',checks)
print(json.dumps({'checks':{k:v for k,v in checks.items() if v['returncode']!=0}}),flush=True)
assert all(x['returncode']==0 for x in checks.values()), 'Installed dependency/import check failed'
assert checks['dpkg_audit']['stdout']=='', 'Unconfigured Debian packages'
native=[]
for path in sorted(set([Path('/usr/local/bin/node'),Path('/usr/bin/pdfinfo'),Path('/usr/bin/pdftoppm'),Path(sys.executable).resolve()]+list(Path('/opt/paddle').rglob('*.so'))+list(Path('/opt/paddle').rglob('*.so.*')))):
    if path.is_symlink() or not path.is_file():continue
    with path.open('rb') as source:
        if source.read(4)!=b'\x7fELF':continue
    check=run(['ldd',str(path)])
    native.append({'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),**check})
save('elf-dependencies.json',native)
default_missing=[x for x in native if 'not found' in x['stdout'] or 'not found' in x['stderr']]
scoped=[];missing=[]
site=Path('/opt/paddle/lib/python3.11/site-packages')
for item in default_missing:
    path=Path(item['path']);library=None
    if path.is_relative_to(site/'opencv_contrib_python.libs') or path.is_relative_to(site/'cv2/qt/plugins'):
        library=site/'opencv_contrib_python.libs'
    elif path.is_relative_to(site/'paddle/libs'):
        library=site/'paddle/libs'
    if library is None:
        missing.append(item['path']);continue
    # This checks only availability of each bundle's supplied helper dependencies.
    # It neither modifies the runtime environment nor proves its dlopen behavior.
    environment=os.environ.copy();environment['LD_LIBRARY_PATH']=str(library)
    check=run(['ldd',item['path']],env=environment)
    passed=check['returncode']==0 and 'not found' not in check['stdout'] and 'not found' not in check['stderr']
    scoped.append({'path':item['path'],'scope':'bundled_helper_availability_not_runtime_loading',
        'LD_LIBRARY_PATH_for_this_inspection_only':str(library),'passed':passed,**check})
    if not passed:missing.append(item['path'])
save('elf-scoped-helper-availability.json',scoped)
errors=[x for x in native if x['returncode']!=0]
def unprivileged():
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
read_script="""import {readFile,readdir} from 'node:fs/promises';
await readFile('/experiment/run_parent.mjs'); await readFile('/experiment/run_engine.py');
await readFile('/experiment/experiment-config.json');
for(const m of ['PP-OCRv5_mobile_det','arabic_PP-OCRv5_mobile_rec'])
  for(const n of await readdir('/models/'+m))await readFile('/models/'+m+'/'+n);
const p=await import('/app/backend/scripts/backend/uploaded-document-ocr-worker.ts');
if(typeof p.processUploadedDocumentOcr!=='function')throw Error('Missing parent');
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),model_config_parent_readable:true,paddle_imported:false,ocr_executed:false}));"""
readcheck=subprocess.run(['/usr/local/bin/node','--experimental-transform-types','--input-type=module','-e',read_script],
 capture_output=True,text=True,timeout=60,preexec_fn=unprivileged)
save('runtime-user-read-check.json',{'uid':1000,'returncode':readcheck.returncode,'stdout':readcheck.stdout,'stderr':readcheck.stderr})
save('closure-status.json',{'scope':'offline_install_metadata_and_ELF_resolution_no_candidate_import_or_inference',
 'installed_python_distributions':len(packages),'inspected_elf_files':len(native),'missing_library_paths':missing,
 'default_helper_failures_retained':[x['path'] for x in default_missing],
 'scoped_helper_availability_checks':len(scoped),
 'native_import_and_runtime_dlopen_verified':False,
 'runtime_LD_LIBRARY_PATH_added':False,
 'ldd_error_paths':[x['path'] for x in errors],'runtime_uid1000_read_check_passed':readcheck.returncode==0,
 'paddle_imported':False,'ocr_executed':False,'node_product_function_invoked':False})
print(json.dumps({'unresolved':missing,'default_helper_failures':default_missing,'scoped_helper_checks':scoped,'ldd_errors':errors,'runtime_user_check':{'returncode':readcheck.returncode,'stdout':readcheck.stdout,'stderr':readcheck.stderr}}),flush=True)
assert not missing and not errors, 'Unresolved installed ELF libraries; retain failure before any candidate revision'
assert readcheck.returncode==0, 'Runtime user cannot read/import the frozen parent and model inputs'
