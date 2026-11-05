"""Stage a closed, hash-verified offline context; never install or infer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prepared',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--native-supplement',type=Path,required=True)
parser.add_argument('--native-supplement-receipt-sha256',required=True)
args=parser.parse_args()
source=Path(__file__).resolve().parent
prep=args.prepared.resolve();out=args.output.resolve()
assert not out.exists()
manifest=json.loads((prep/'prepared-inputs.json').read_text())
assert hashlib.sha256((prep/'prepared-inputs.json').read_bytes()).hexdigest()=='cd19a7f58998d4a126ec026dbb08214872d18aa1d5bd0ec04cb0c206873c8d84'
out.mkdir()
def stage(path,target,expected=None,hardlink=False):
    assert path.is_file() and not path.is_symlink()
    data=path.read_bytes()
    if expected:
        assert len(data)==expected['bytes'] and hashlib.sha256(data).hexdigest()==expected['sha256'], str(path)
    target.parent.mkdir(parents=True,exist_ok=True)
    if hardlink:os.link(path,target)
    else:shutil.copy2(path,target)
for name,item in manifest['input_files'].items():
    if name.startswith('apt/archives/'):target=out/'debs'/Path(name).name
    elif name.startswith('frozen-lock/'):target=out/Path(name).name
    elif name=='seed-manifest.json':target=out/'provenance'/name
    else:target=out/name
    stage(prep/name,target,item,hardlink=True)
assert (out/'requirements.lock').is_file()
supplement=args.native_supplement.resolve()
supplement_receipt=supplement/'apt/apt-download-receipt.json'
assert hashlib.sha256(supplement_receipt.read_bytes()).hexdigest()==args.native_supplement_receipt_sha256
additional=json.loads(supplement_receipt.read_text())
assert additional['passed'] and additional['packages_installed']==0 and additional['base_dpkg_unchanged']
assert additional['requested_roots']==['libsm6','libice6']
assert additional['signature_verification_enabled'] and additional['tls_verification_enabled']
for item in additional['debs']:
    src=supplement/'apt/archives'/item['filename'];target=out/'debs'/item['filename']
    if target.exists():assert target.read_bytes()==src.read_bytes()
    else:stage(src,target,item,hardlink=True)
stage(supplement_receipt,out/'provenance/native-supplement-receipt.json')
stage(prep/'static-elf-declarations.json',out/'provenance/static-elf-declarations.json')
node=prep/'node-parent/node'
assert hashlib.sha256(node.read_bytes()).hexdigest()=='e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'
stage(node,out/'node')
parent=json.loads((prep/'parent-closure/parent-source-manifest.json').read_text())
for name,item in parent['staged_files'].items():
    assert item['type']=='file', 'Review any parent symlinks before staging'
    stage(prep/'parent-closure/app'/name,out/'app'/name,item)
for name in ['experiment-config.json','run_engine.py','run_parent.mjs']:
    stage(source/name,out/'experiment'/name)
for name in ['Dockerfile','verify_context.py','native_inventory.py','install_offline.sh']:
    stage(source/name,out/name)
for name in ['prepared-inputs.json','verified-wheel-receipt.json','model-download-receipt.json',
             'parent-closure/parent-source-manifest.json','node-parent/receipt.json']:
    stage(prep/name,out/'provenance'/name.replace('/','-'))
files={p.relative_to(out).as_posix():{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(out.rglob('*')) if p.is_file()}
receipt={'version':1,'files':files,'candidate_imported':False,'ocr_executed':False}
(out/'context-manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'files':len(files),'file_bytes':sum(p['bytes'] for p in files.values()),'context_manifest_sha256':hashlib.sha256((out/'context-manifest.json').read_bytes()).hexdigest(),'output':str(out)}))
