"""Stage the existing Node OCR parent import graph and its installed dependencies.

No npm install or product function executes. The final offline Node import must
also pass; this inventory alone does not prove dynamic import compatibility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--installed-backend',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    root=args.root.resolve();installed=args.installed_backend.resolve();out=args.output.resolve()
    assert not out.exists()
    for name in ['package.json','package-lock.json']:
        assert (root/'backend'/name).read_bytes()==(installed/name).read_bytes(), 'Installed parent lock differs'
    lock=json.loads((root/'backend/package-lock.json').read_text())['packages']
    pending=[root/'backend/scripts/backend/uploaded-document-ocr-worker.ts'];seen=set();bare=set()
    while pending:
        path=pending.pop()
        if path in seen:continue
        assert path.is_file() and not path.is_symlink() and path.is_relative_to(root)
        seen.add(path)
        text=path.read_text()
        specs=re.findall(r'''\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']''',text)
        for alternatives in specs:
            spec=next(x for x in alternatives if x)
            if spec.startswith('node:'):continue
            if spec.startswith('.'):
                target=(path.parent/spec).resolve();assert target.is_file(),spec;pending.append(target)
            else:
                parts=spec.split('/');bare.add('/'.join(parts[:2]) if spec.startswith('@') else parts[0])
    assert bare=={'cheerio','decimal.js','fast-xml-parser','zod'}, 'Review changed actual parent imports'
    def resolve(name,start):
        for parent in [start,*start.parents]:
            if not parent.is_relative_to(installed):break
            candidate=parent/'node_modules'/name
            if candidate.is_dir():return candidate
        raise ValueError('Missing installed dependency '+name)
    packages={};todo=[resolve(name,installed) for name in sorted(bare)]
    while todo:
        path=todo.pop()
        if path in packages:continue
        assert not path.is_symlink()
        metadata=json.loads((path/'package.json').read_text());relative=path.relative_to(installed).as_posix()
        assert lock[relative]['version']==metadata['version'], 'Installed package version differs from lock'
        packages[path]={'name':metadata['name'],'version':metadata['version'],'path':relative,
                        'lock_integrity':lock[relative].get('integrity'),'package_json_sha256':sha(path/'package.json')}
        for name in metadata.get('dependencies',{}):todo.append(resolve(name,path))
        for name in metadata.get('optionalDependencies',{}):
            try:todo.append(resolve(name,path))
            except ValueError:pass
    out.mkdir(parents=True,exist_ok=False);app=out/'app';app.mkdir()
    for path in sorted(seen | {root/'backend/package.json',root/'backend/package-lock.json'}):
        target=app/path.relative_to(root);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    for path in sorted(packages,key=lambda p:len(p.parts)):
        target=app/'backend'/path.relative_to(installed)
        if not target.exists():shutil.copytree(path,target,symlinks=True)
    inventory={}
    for path in sorted(app.rglob('*')):
        name=path.relative_to(app).as_posix()
        if path.is_symlink():
            assert path.resolve().is_relative_to(app.resolve()), 'Dependency link escapes staged graph'
            inventory[name]={'type':'symlink','target':str(path.readlink())}
        elif path.is_file():inventory[name]={'type':'file','bytes':path.stat().st_size,'sha256':sha(path)}
    result={'version':1,'scope':'actual_uploaded_ocr_module_import_closure_only','root_source_revision':
        __import__('subprocess').check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
        'entrypoint':'backend/scripts/backend/uploaded-document-ocr-worker.ts','source_files':{p.relative_to(root).as_posix():sha(p) for p in sorted(seen)},
        'bare_imports':sorted(bare),'packages':sorted(packages.values(),key=lambda r:r['path']),
        'staged_files':inventory,'npm_install_executed':False,'product_function_invoked':False,
        'node_import_verified':False,'ocr_executed':False}
    (out/'parent-source-manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'source_files':len(seen),'packages':len(packages),'staged_files':len(inventory),
                      'file_bytes':sum(r.get('bytes',0) for r in inventory.values()),'output':str(out)}))


if __name__=='__main__':main()
