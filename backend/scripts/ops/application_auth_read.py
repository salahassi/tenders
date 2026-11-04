"""Render the reviewed platform Auth read policy without executing it."""
import hashlib
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[2]
TEMPLATE='deploy/kubernetes/application-auth-read.sql'
RENDERER='scripts/ops/application_auth_read.py'

def contract(root=ROOT):
 values={}
 for name in (TEMPLATE,RENDERER):
  path=root/name
  if not path.is_file() or path.is_symlink() or not 0<path.stat().st_size<=65536:raise ValueError('APPLICATION_AUTH_SOURCE_INVALID')
  values[name]=hashlib.sha256(path.read_bytes()).hexdigest()
 return {'version':1,'policy':'tenderdesk_application_identity_read','sources':values}

def render(database,role_prefix,*,marker=None,root=ROOT):
 if not re.fullmatch('[a-z][a-z0-9_]{0,62}',database) or not re.fullmatch('[a-z][a-z0-9_]{0,39}',role_prefix):raise ValueError('APPLICATION_AUTH_TARGET_INVALID')
 marker=marker or 'tenderdesk-managed-kubernetes:'+database+':'+role_prefix
 if marker not in ('tenderdesk-managed-kubernetes:'+database+':'+role_prefix,'tenderdesk-isolated-bootstrap:'+database+':'+role_prefix):raise ValueError('APPLICATION_AUTH_MARKER_INVALID')
 contract(root)
 quote=lambda value:"'"+value.replace("'","''")+"'"
 identifiers=lambda value:'"'+value+'"'
 replacements={'__DATABASE__':quote(database),'__MARKER__':quote(marker),
  '__AUTH_ROLE__':quote(role_prefix+'_authadmin'),'__APP_ROLE__':quote(role_prefix+'_owner'),
  '__ANON_ROLE__':quote(role_prefix+'_anon'),'__MEMBER_ROLE__':quote(role_prefix+'_authenticated'),
  '__AUTH_IDENTIFIER__':identifiers(role_prefix+'_authadmin'),'__APP_IDENTIFIER__':identifiers(role_prefix+'_owner')}
 value=(root/TEMPLATE).read_text()
 for key,replacement in replacements.items():value=value.replace(key,replacement)
 if re.search(r'__[A-Z_]+__',value):raise ValueError('APPLICATION_AUTH_TEMPLATE_INVALID')
 return value
