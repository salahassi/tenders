#!/usr/bin/env python3
"""Run the frozen SQL in a rollback-only transaction; never deploy or issue work."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import re
import sys

SPEC = importlib.util.spec_from_file_location('delivery_schema_diagnosis_update', Path(__file__).with_name('proposal-delivery-update.py'))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


def rollback_script(script):
    suffix = "NOTIFY pgrst,'reload schema';COMMIT;\n"
    if not script.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ;\n') or not script.endswith(suffix) or script.upper().count('COMMIT;') != 1:
        raise ValueError('SCHEMA_DIAGNOSIS_TRANSACTION_UNPROVEN')
    return script[:-len(suffix)] + 'ROLLBACK;\n'


sql_failure = p.sql_failure_diagnostic


def authority_notice(script):
    guard="IF authority_before IS DISTINCT FROM authority THEN RAISE EXCEPTION 'DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED';END IF;"
    if script.count(guard)!=1:raise ValueError('SCHEMA_DIAGNOSIS_AUTHORITY_GUARD_UNPROVEN')
    notice="""IF authority_before IS DISTINCT FROM authority THEN
 RAISE NOTICE 'DELIVERY_AUTHORITY_DIFF %', jsonb_build_object(
  'sections',(SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(authority_before) k WHERE authority_before->k IS DISTINCT FROM authority->k),
  'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('signature',k,
    'fields',(SELECT jsonb_agg(f ORDER BY f) FROM jsonb_object_keys(authority_before->'functions'->k) f
      WHERE authority_before->'functions'->k->f IS DISTINCT FROM authority->'functions'->k->f),
    'before_acl',authority_before->'functions'->k->'acl','after_acl',authority->'functions'->k->'acl') ORDER BY k),'[]'::jsonb)
   FROM jsonb_object_keys(authority_before->'functions') k WHERE authority_before->'functions'->k IS DISTINCT FROM authority->'functions'->k));
 RAISE EXCEPTION 'DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED';END IF;"""
    return script.replace(guard,notice)


def authority_diagnostic(stderr):
    # Only baseline-catalog function identifiers and fixed application-role ACLs;
    # never configuration values, role IDs, policy bodies or customer rows.
    match=re.search(r'NOTICE:\s+(?:[A-Z0-9]{5}:\s+)?DELIVERY_AUTHORITY_DIFF (\{[^\r\n]{1,65536}\})',stderr)
    if not match:return None
    try:
        value=json.loads(match[1]);sections=value['sections'];functions=value['functions']
        if not isinstance(sections,list) or not set(sections)<={'functions','tables','columns','policies','roles','memberships'} or not isinstance(functions,list) or len(functions)>100:return None
        result=[]
        role=r'(?:tdp_app_owner|tdp_app_anon|tdp_app_authenticated|tdp_app_service|anon|authenticated|service_role)'
        def acl(items):
            if items is None:return None
            if not isinstance(items,list) or len(items)>30:raise ValueError()
            return [item if isinstance(item,str) and re.fullmatch(role+r'?=[X*]*/'+role,item) else 'unreviewed_acl' for item in items]
        for item in functions:
            signature=item['signature'];fields=item['fields']
            if not isinstance(signature,str) or len(signature)>300 or not re.fullmatch(r'(?:(?:public|app_private)\.)?[a-z_][a-z0-9_]*\([a-z0-9_., \[\]]*\)',signature) or not isinstance(fields,list) or not set(fields)<={'owner','acl','definer','config'}:return None
            result.append({'signature':signature,'fields':fields,'before_acl':acl(item['before_acl']),'after_acl':acl(item['after_acl'])})
        return {'sections':sections,'functions':result}
    except (ValueError,TypeError,KeyError):return None


def main():
    capture = io.StringIO()
    stage = 'source'
    before = after = None
    cleanup = False
    error = False
    codes = set()
    authority_difference = None
    authority_notice_seen = False
    try:
        with redirect_stdout(capture), redirect_stderr(io.StringIO()):
            manifest = json.loads(p.release.MANIFEST.read_text())
            p.release.verify_source(manifest)
            script = authority_notice(rollback_script(p.release.migration_script(manifest)))
            script = script.replace('BEGIN ISOLATION LEVEL REPEATABLE READ;\n',"BEGIN ISOLATION LEVEL REPEATABLE READ;\nSET LOCAL client_min_messages='notice';\n",1)
            codes = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]{1,99})'", script))
            stage = 'cluster'
            p.d.probe.validate_cluster()
            client = p.inventory.observer.Client(1800)
            client.labels['app.kubernetes.io/managed-by'] = p.OWNER
            p.save_client(client)
            try:
                stage = 'client'
                client.prepare()
                query = (p.HERE/'digitalocean-inventory.sql').read_text()
                def catalog():
                    return p.inventory.public_schema(json.loads(p.d.sql(client.pod, query)))['routine_catalog_sha256']
                stage = 'catalog_before'
                before = catalog()
                try:
                    stage = 'rollback_migration'
                    def diagnostic(stderr):
                        nonlocal authority_difference,authority_notice_seen
                        authority_notice_seen='DELIVERY_AUTHORITY_DIFF ' in stderr
                        authority_difference=authority_diagnostic(stderr)
                    p.d.sql(client.pod, script, diagnostic_codes=codes,diagnostic_callback=diagnostic)
                finally:
                    after = catalog()
            finally:
                client.cleanup()
                p.journal_path().unlink(missing_ok=True)
                cleanup = True
    except Exception:
        error = True
    unchanged = before is not None and after == before
    passed = not error and unchanged and cleanup
    print(json.dumps({'schema_diagnosis': 'passed_rolled_back' if passed else 'blocked', 'stage': stage,
                      'sql_failure': sql_failure(capture.getvalue(),codes), 'catalog_unchanged': unchanged,
                      'authority_difference':authority_difference,
                      'authority_notice_seen':authority_notice_seen,
                      'before_catalog_sha256': before, 'after_catalog_sha256': after,
                      'owned_client_cleanup': cleanup, 'deployment_performed': False,
                      'model_calls': 0}), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
