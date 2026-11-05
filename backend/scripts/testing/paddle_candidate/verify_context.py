"""Verify every closed offline build input without importing candidate packages."""
import hashlib
import json
from pathlib import Path
import sys

root=Path(sys.argv[1])
manifest=json.loads((root/'context-manifest.json').read_text())
expected=manifest['files']
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()}
assert actual==set(expected)|{'context-manifest.json'}, 'Offline context census changed'
for name,item in expected.items():
    p=root/name
    assert not p.is_symlink(), 'Unexpected context symlink'
    assert p.stat().st_size==item['bytes'], name
    assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'], name
print(json.dumps({'verified_files':len(expected),'context_manifest_sha256':hashlib.sha256((root/'context-manifest.json').read_bytes()).hexdigest()}))
