from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('tested_schema_diagnosis', Path(__file__).with_name('proposal-delivery-schema-diagnosis.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class SchemaDiagnosisTests(unittest.TestCase):
    def test_actual_frozen_script_changes_only_final_notify_commit_to_rollback(self):
        source = m.p.release.migration_script(json.loads(m.p.release.MANIFEST.read_text()))
        converted = m.rollback_script(source)
        self.assertNotIn('COMMIT;', converted.upper())
        self.assertEqual(converted, source.removesuffix("NOTIFY pgrst,'reload schema';COMMIT;\n")+'ROLLBACK;\n')

    def test_unproven_transaction_is_rejected(self):
        for value in ['COMMIT;\n', 'BEGIN;COMMIT;\n', 'BEGIN ISOLATION LEVEL REPEATABLE READ;\nCOMMIT;\nNOTIFY pgrst,\'reload schema\';COMMIT;\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                m.rollback_script(value)

    def test_sql_diagnostic_never_releases_private_fields_or_invalid_values(self):
        value = {'deployment':'tenderdesk-dev','status':'sql_failed','sqlstate':'42501','line':22,'message':'PRIVATE_CUSTOMER'}
        self.assertEqual(m.sql_failure(json.dumps(value)), {'sqlstate':'42501','line':22})
        value.update(sqlstate='PRIVATE_VALUE',line=True)
        self.assertEqual(m.sql_failure(json.dumps(value)), {'sqlstate':'unknown','line':None})

    def test_success_failure_catalog_change_and_cleanup_failure(self):
        for failed, changed, cleanup_failed in [(False,False,False),(True,False,False),(False,True,False),(False,False,True)]:
            with self.subTest(failed=failed,changed=changed,cleanup_failed=cleanup_failed), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                calls=[]
                def sql(_pod, script):
                    calls.append(script)
                    if len(calls)==2:
                        self.assertTrue(script.endswith('ROLLBACK;\n'))
                        if failed:
                            print(json.dumps({'deployment':'tenderdesk-dev','status':'sql_failed','sqlstate':'42501','line':22,'private':'PRIVATE_CUSTOMER'}))
                            raise RuntimeError('PRIVATE_FAILURE')
                        return 'uncommitted receipt ignored'
                    return json.dumps({'routine_catalog_sha256':('b' if changed and len(calls)==3 else 'a')*64})
                stack.enter_context(patch.object(m.p.d.probe,'validate_cluster'))
                stack.enter_context(patch.object(m.p.d,'sql',side_effect=sql))
                stack.enter_context(patch.object(m.p.inventory,'public_schema',side_effect=lambda value:value))
                client=stack.enter_context(patch.object(m.p.inventory.observer,'Client')).return_value
                client.labels={}
                if cleanup_failed:client.cleanup.side_effect=RuntimeError('PRIVATE_CLEANUP')
                stack.enter_context(patch.object(m.p,'save_client'))
                stack.enter_context(patch.object(m.p,'journal_path',return_value=Path(temp)/'journal'))
                output=io.StringIO()
                with redirect_stdout(output):result=m.main()
                self.assertEqual(len(calls),3)
                client.cleanup.assert_called_once()
                self.assertNotIn('PRIVATE',output.getvalue())
                receipt=json.loads(output.getvalue())
                self.assertEqual(result,1 if failed or changed or cleanup_failed else 0)
                self.assertEqual(receipt['catalog_unchanged'],not changed)
                self.assertEqual(receipt['owned_client_cleanup'],not cleanup_failed)
                self.assertFalse(receipt['deployment_performed'])

    def test_workflow_requires_explicit_diagnosis_and_keeps_failure_cleanup(self):
        workflow=(m.p.HERE.parents[2]/'.github/workflows/deploy-proposal-delivery.yml').read_text()
        self.assertIn('inputs.diagnose_schema == true && inputs.inspect_qualified_image != true',workflow)
        self.assertIn('inputs.inspect_qualified_image == true && inputs.diagnose_schema == true',workflow)
        self.assertIn('always() && (inputs.inspect_qualified_image != true || inputs.diagnose_schema == true)',workflow)
