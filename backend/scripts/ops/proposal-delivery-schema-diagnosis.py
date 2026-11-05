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


def main():
    capture = io.StringIO()
    stage = 'source'
    before = after = None
    cleanup = False
    error = False
    codes = set()
    try:
        with redirect_stdout(capture), redirect_stderr(io.StringIO()):
            manifest = json.loads(p.release.MANIFEST.read_text())
            p.release.verify_source(manifest)
            script = rollback_script(p.release.migration_script(manifest))
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
                    p.d.sql(client.pod, script, diagnostic_codes=codes)
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
                      'before_catalog_sha256': before, 'after_catalog_sha256': after,
                      'owned_client_cleanup': cleanup, 'deployment_performed': False,
                      'model_calls': 0}), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
