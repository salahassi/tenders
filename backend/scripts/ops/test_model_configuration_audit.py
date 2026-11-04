import importlib.util
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('tested_model_audit',HERE/'model-configuration-audit.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def row(provider='gemini_free',alias='APP_MODEL_GEMINI_KEY'):
 return {'provider':provider,'credential_alias':alias,'project_ref':'synthetic-project','model':'synthetic-model'}

class ModelConfigurationAuditTests(unittest.TestCase):
 def test_default_alias_and_legacy_provider_binding_match_runtime_resolution(self):
  for bindings,present in [({},False),({'APP_MODEL_GEMINI_KEY':'synthetic-secret'},True),
   ({'APP_MODEL_KEY':'synthetic-legacy','APP_MODEL_PROVIDER':'gemini_free'},True),
   ({'APP_MODEL_KEY':'synthetic-legacy','APP_MODEL_PROVIDER':'openai'},False)]:
   result=m.public_binding_audit([row()],bindings)
   self.assertEqual(result,[{'provider':'gemini_free','model':'synthetic-model','key_configured':present,'project_configured':True}])
   self.assertNotIn('synthetic-secret',json.dumps(result));self.assertNotIn('synthetic-legacy',json.dumps(result))
 def test_custom_alias_does_not_fall_back_to_another_account(self):
  self.assertFalse(m.public_binding_audit([row(alias='APP_MODEL_CUSTOM_KEY')],{'APP_MODEL_GEMINI_KEY':'synthetic','APP_MODEL_PROVIDER':'gemini_free','APP_MODEL_KEY':'synthetic'})[0]['key_configured'])
  self.assertTrue(m.public_binding_audit([row(alias='APP_MODEL_CUSTOM_KEY')],{'APP_MODEL_CUSTOM_KEY':'synthetic'})[0]['key_configured'])
 def test_catalog_is_bounded_and_unexpected_fields_or_aliases_cannot_escape(self):
  for value in [[row()]*101,[{**row(),'key':'private'}],[{**row(),'model':'secret\nvalue'}],[row(alias='KUBECONFIG')],[row(provider='invented')]]:
   with self.assertRaises(m.AuditError):m.public_binding_audit(value,{})
  self.assertEqual(m.public_binding_audit([],{}),[])
 def test_cleanup_occurs_even_if_private_catalog_parsing_fails(self):
  client=Mock();client.labels={}
  with patch.dict(m.os.environ,{'GITHUB_SHA':'a'*40}),patch.object(m.inventory.d.probe,'validate_cluster'),patch.object(m.inventory.observer,'Client',return_value=client),patch.object(m.inventory,'save_client'),patch.object(m.inventory,'clear_client') as clear,patch.object(m.inventory.d,'sql',return_value='private invalid bytes'):
   with self.assertRaises(ValueError):m.run()
   client.cleanup.assert_called_once();clear.assert_called_once()
 def test_private_errors_and_outputs_never_reach_public_receipt(self):
  def failed():print('synthetic-private-key');raise ValueError('private SQL connection')
  out=io.StringIO()
  with patch.object(m,'run',side_effect=failed),redirect_stdout(out):self.assertEqual(m.main(),1)
  self.assertEqual(json.loads(out.getvalue()),{'model_configuration_audit':'blocked','code':'MODEL_AUDIT_FAILED'})
 def test_selected_mode_does_not_activate_bootstrap_restore_or_evaluation(self):
  workflow=(HERE.parents[2]/'.github/workflows/doks-access.yml').read_text()
  self.assertIn('options: [inventory, bootstrap, restore, models]',workflow)
  self.assertIn("inputs.mode == 'inventory' || inputs.mode == 'models'",workflow)
  self.assertIn("github.event_name == 'push' || inputs.mode == 'bootstrap'",workflow)
  self.assertIn("github.event_name == 'workflow_dispatch' && inputs.mode == 'restore'",workflow)
  self.assertNotIn('live-model-evaluation.py',workflow)
 def test_prefix_table_matches_application_provider_aliases(self):
  backend=(HERE.parents[1]/'supabase/functions/_shared/backend.ts').read_text()
  for provider,prefix in m.PREFIX.items():self.assertIn(f'{provider}: "{prefix}"',backend)

if __name__=='__main__':unittest.main()
