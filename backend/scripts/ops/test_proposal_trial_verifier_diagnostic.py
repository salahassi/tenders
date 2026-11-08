"""Content-free verifier diagnostics: synthetic fixtures, no external calls."""
import copy
import importlib.util
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    'trial_verifier_diagnostic_test_target', HERE / 'proposal-trial-request.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)

W = m.auth.access.WORKSPACE
O, P, J, R, C, C2 = [
    '00000000-0000-4000-8000-%012d' % n for n in range(301, 307)]


def fixture():
    return {
        'version': 1,
        'kind': 'proposal_trial_usage_diagnostic',
        'selection': {'version': 1, 'workspace_id': W, 'opportunity_id': O},
        'rows': [], 'total': 0, 'truncated': False,
        'reserved_count': 0, 'unknown_count': 0,
        'routing_count': 1, 'routing_enabled': True,
        'modern_execution': {
            'enabled': True, 'revision': 2, 'max_parallel_requests': 2,
            'admitted_after': '2026-01-01T00:00:00+00:00'},
        'verifier_diagnostics': {
            'plan_id': P, 'report_count': 1, 'reports_truncated': False,
            'attempt_count': 1, 'attempts_truncated': False,
            'attempts': [{
                'attempt_id': '41', 'job_id': J, 'model': 'fixture-verifier',
                'model_config_id': C,
                'code': 'EVIDENCE_REFERENCE_INVALID'}],
            'reports': [{
                'report_id': R, 'job_id': J, 'model': 'fixture-verifier',
                'code': 'EVIDENCE_REFERENCE_INVALID',
                'diagnostics_truncated': False,
                'diagnostics': [{
                    'code': 'EVIDENCE_REFERENCE_INVALID',
                    'reason': 'source_quote_mismatch',
                    'paths': ['$.claims[0].source_refs[1].quote']}]}]},
        'verifier_routes': [{
            'task': 'verify_grounding', 'revision': 3,
            'inherit_default': False, 'strategy': 'priority', 'next_position': 0,
            'profile': None,
            'models': [{
                'position': 1, 'id': C, 'model': 'fixture-verifier',
                'enabled': True, 'revision': 1,
                'connection_enabled': True, 'connection_revision': 2}]}]}


def set_at(value, path, replacement):
    for key in path[:-1]:
        value = value[key]
    value[path[-1]] = replacement


REPORT = ('verifier_diagnostics', 'reports', 0)
ATTEMPT = ('verifier_diagnostics', 'attempts', 0)
DIAGNOSTIC = REPORT + ('diagnostics', 0)
ROUTE = ('verifier_routes', 0)
CONFIG = ROUTE + ('models', 0)


class VerifierDiagnosticTests(unittest.TestCase):
    def reject(self, value):
        with self.assertRaisesRegex(
                m.TrialRequestError, 'PROPOSAL_TRIAL_USAGE_DIAGNOSTIC_INVALID'):
            m.validate_verifier_diagnostic(value)

    def test_exact_projection_is_validated_on_readback_without_mutation(self):
        value = fixture()
        before = copy.deepcopy(value)
        with patch.object(m, 'read', return_value=value) as read:
            self.assertIs(m.diagnostic('fixture-db', value['selection']), value)
        self.assertEqual(value, before)
        self.assertEqual(read.call_args.kwargs, {'max_bytes': 256 * 1024})
        self.assertTrue(read.call_args.args[1].startswith(m.PREFIX))

    def test_empty_history_and_no_execution_settings_are_valid(self):
        value = fixture()
        value['modern_execution'] = None
        value['verifier_routes'] = []
        value['verifier_diagnostics'] = {
            'plan_id': None, 'report_count': 0, 'reports_truncated': False,
            'attempt_count': 0, 'attempts_truncated': False,
            'attempts': [], 'reports': []}
        m.validate_verifier_diagnostic(value)

    def test_nullable_historical_producer_and_empty_diagnostics_are_valid(self):
        value = fixture()
        value['verifier_diagnostics']['reports'][0].update(
            model=None, diagnostics=[], diagnostics_truncated=True)
        m.validate_verifier_diagnostic(value)

    def test_private_or_unexpected_nested_fields_are_rejected(self):
        additions = [
            (('verifier_diagnostics',), 'raw_value'),
            (REPORT, 'result'), (REPORT, 'producer'),
            (ATTEMPT, 'prompt'), (ATTEMPT, 'remote_request_id'),
            (DIAGNOSTIC, 'candidate_quote'), (DIAGNOSTIC, 'source_refs'),
            (DIAGNOSTIC, 'numeric_literals'), (DIAGNOSTIC, 'evidence_ids'),
            (ROUTE, 'profile'), (CONFIG, 'project_ref'),
            (CONFIG, 'credential_alias'),
            (('modern_execution',), 'credential')]
        for path, key in additions:
            with self.subTest(path=path, key=key):
                value = fixture()
                node = value
                for part in path:
                    node = node[part]
                node[key] = 'PRIVATE FIXTURE CONTENT'
                self.reject(value)

    def test_codes_reasons_and_paths_are_application_owned(self):
        cases = [
            (ATTEMPT + ('code',), 'MODEL_NETWORK_UNCERTAIN'),
            (REPORT + ('code',), 'PRIVATE SOURCE TEXT'),
            (DIAGNOSTIC + ('code',), 'MODEL_NETWORK_UNCERTAIN'),
            (DIAGNOSTIC + ('reason',), 'source_quote_mismatch: private quote'),
            (DIAGNOSTIC + ('paths',), ['$.claims[0].quote: private quote']),
            (DIAGNOSTIC + ('paths',), ['$["private source"]']),
            (DIAGNOSTIC + ('paths',), ['$.claims[-1]']),
            (DIAGNOSTIC + ('paths',), ['$.claims[1000000]']),
            (DIAGNOSTIC + ('paths',), ['$.claims[01]']),
            (DIAGNOSTIC + ('paths',), ['$.UPPER']),
            (DIAGNOSTIC + ('paths',), ['$.' + 'a' * 239]),
            (DIAGNOSTIC + ('paths',), [1]),
            (DIAGNOSTIC + ('paths',), '$.claims'),
            (DIAGNOSTIC + ('paths',), ['$'] * 5)]
        for path, replacement in cases:
            with self.subTest(path=path, replacement=replacement):
                value = fixture()
                set_at(value, path, replacement)
                self.reject(value)

    def test_allowed_reason_and_path_boundary(self):
        for reason in m.VALIDATION_REASONS:
            with self.subTest(reason=reason):
                value = fixture()
                set_at(value, DIAGNOSTIC + ('reason',), reason)
                set_at(value, DIAGNOSTIC + ('paths',), [
                    '$', '$.claims[999999]', '$.a_1[0].quote', '$.' + 'a' * 238])
                m.validate_verifier_diagnostic(value)

    def test_models_and_record_identities_reject_free_text(self):
        for path in [ATTEMPT + ('model',), REPORT + ('model',), CONFIG + ('model',)]:
            for replacement in ['', 'private source text', 'bad\nmodel', 'x' * 121, 7]:
                with self.subTest(path=path, replacement=replacement):
                    value = fixture()
                    set_at(value, path, replacement)
                    self.reject(value)
        cases = [
            (ATTEMPT + ('model',), None), (ATTEMPT + ('attempt_id',), 41),
            (ATTEMPT + ('attempt_id',), '0'), (ATTEMPT + ('attempt_id',), '01'),
            (ATTEMPT + ('attempt_id',), '9' * 21),
            (ATTEMPT + ('job_id',), 'private-id'),
            (ATTEMPT + ('model_config_id',), 'private-config'),
            (REPORT + ('report_id',), 'private-report'),
            (('verifier_diagnostics', 'plan_id'), 'private-plan')]
        for path, replacement in cases:
            with self.subTest(path=path, replacement=replacement):
                value = fixture()
                set_at(value, path, replacement)
                self.reject(value)

    def test_known_model_identifier_punctuation_is_preserved(self):
        # Same public identifier grammar as commandSchemas model.configuration.save.
        for model in ['fixture-verifier', 'org/fixture_model.v1', 'org/model:free']:
            value = fixture()
            for path in [ATTEMPT + ('model',), REPORT + ('model',), CONFIG + ('model',)]:
                set_at(value, path, model)
            with self.subTest(model=model):
                m.validate_verifier_diagnostic(value)

    def test_successful_verifier_model_identity_and_legacy_null_config(self):
        for configuration in [C, None]:
            value = fixture()
            value['verifier_diagnostics']['attempts'][0].update(
                code='SUCCEEDED', model_config_id=configuration)
            m.validate_verifier_diagnostic(value)

    def test_history_truncation_must_match_count_and_limit(self):
        for name, count_key, limit in [('reports', 'report_count', 8), ('attempts', 'attempt_count', 32)]:
            for count in [limit, limit + 1, 100]:
                value = fixture()
                report = value['verifier_diagnostics']
                report[name] *= limit
                report[count_key] = count
                report[name + '_truncated'] = count > limit
                with self.subTest(name=name, count=count):
                    m.validate_verifier_diagnostic(value)
                    report[name + '_truncated'] = not report[name + '_truncated']
                    self.reject(value)
            for replacement in [-1, True, '1', 9007199254740992]:
                value = fixture()
                value['verifier_diagnostics'][count_key] = replacement
                with self.subTest(name=name, count=replacement):
                    self.reject(value)
            value = fixture()
            value['verifier_diagnostics'][count_key] = 2
            self.reject(value)
            value = fixture()
            value['verifier_diagnostics'][name] *= limit + 1
            value['verifier_diagnostics'][count_key] = limit + 1
            value['verifier_diagnostics'][name + '_truncated'] = True
            self.reject(value)

    def test_nested_diagnostic_bounds_and_boolean_are_enforced(self):
        for count, truncated in [(8, False), (8, True), (0, True)]:
            value = fixture()
            report = value['verifier_diagnostics']['reports'][0]
            report['diagnostics'] *= count
            report['diagnostics_truncated'] = truncated
            m.validate_verifier_diagnostic(value)
        for replacement in [None, 0, 1, 'true']:
            value = fixture()
            set_at(value, REPORT + ('diagnostics_truncated',), replacement)
            self.reject(value)
        value = fixture()
        value['verifier_diagnostics']['reports'][0]['diagnostics'] *= 9
        self.reject(value)

    def test_route_order_and_shape_cannot_misrepresent_target_priority(self):
        value = fixture()
        second = copy.deepcopy(value['verifier_routes'][0]['models'][0])
        second.update(position=2, id=C2, model='fixture-fallback')
        value['verifier_routes'][0]['models'].append(second)
        m.validate_verifier_diagnostic(value)
        value['verifier_routes'][0]['models'].reverse()
        self.reject(value)
        for path, replacement in [
                (ROUTE + ('task',), 'analyze_chunk'),
                (ROUTE + ('strategy',), 'arbitrary'),
                (ROUTE + ('inherit_default',), 0),
                (ROUTE + ('revision',), True),
                (ROUTE + ('next_position',), -1),
                (CONFIG + ('position',), True),
                (CONFIG + ('position',), 0),
                (CONFIG + ('id',), 'private-id'),
                (CONFIG + ('enabled',), 'true'),
                (CONFIG + ('connection_enabled',), 1),
                (CONFIG + ('revision',), -1),
                (CONFIG + ('connection_revision',), True)]:
            with self.subTest(path=path, replacement=replacement):
                value = fixture()
                set_at(value, path, replacement)
                self.reject(value)
        value = fixture()
        value['verifier_routes'] *= 2
        self.reject(value)
        value = fixture()
        value['verifier_routes'][0]['models'] *= 33
        self.reject(value)

    def test_execution_settings_reject_ambiguous_or_unbounded_values(self):
        for parallel in [1, 4]:
            value = fixture()
            value['modern_execution']['max_parallel_requests'] = parallel
            m.validate_verifier_diagnostic(value)
        for key, replacement in [
                ('enabled', 1), ('revision', True), ('revision', -1),
                ('max_parallel_requests', 0), ('max_parallel_requests', 5),
                ('max_parallel_requests', True), ('max_parallel_requests', '2'),
                ('admitted_after', 123)]:
            with self.subTest(key=key, replacement=replacement):
                value = fixture()
                value['modern_execution'][key] = replacement
                self.reject(value)

    def test_route_profile_has_exact_configuration_shape_and_bounds(self):
        profile = {'revision': 1, 'max_output_tokens': 40000,
                   'reasoning': 'low', 'require_native_strict': False}
        for reasoning in ['none', 'minimal', 'low', 'medium', 'high']:
            for maximum in [1024, 131072]:
                value = fixture()
                value['verifier_routes'][0]['profile'] = dict(
                    profile, reasoning=reasoning, max_output_tokens=maximum)
                m.validate_verifier_diagnostic(value)
        for key, replacement in [
                ('revision', 0), ('revision', True),
                ('max_output_tokens', 1023), ('max_output_tokens', 131073),
                ('max_output_tokens', True), ('reasoning', 'private text'),
                ('require_native_strict', 1), ('credential', 'private-fixture')]:
            with self.subTest(key=key, replacement=replacement):
                value = fixture()
                value['verifier_routes'][0]['profile'] = dict(profile, **{key: replacement})
                self.reject(value)

    def test_missing_projection_fields_fail_closed(self):
        for path in [('verifier_diagnostics',), ('verifier_routes',),
                     REPORT + ('diagnostics',), DIAGNOSTIC + ('paths',),
                     CONFIG + ('connection_enabled',)]:
            with self.subTest(path=path):
                value = fixture()
                node = value
                for part in path[:-1]:
                    node = node[part]
                del node[path[-1]]
                self.reject(value)

    def test_sql_is_read_only_bounded_and_scoped_to_selected_latest_plan(self):
        sql = m.diagnostic_sql(fixture()['selection'])
        self.assertTrue(sql.startswith(m.PREFIX))
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertNotRegex(sql.upper(), r'\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|CALL)\b')
        latest = sql.split('latest AS MATERIALIZED (', 1)[1].split('), selected_jobs', 1)[0]
        self.assertIn("workspace_id='%s'" % W, latest)
        self.assertIn("opportunity_id='%s'" % O, latest)
        self.assertIn("kind='proposal'", latest)
        self.assertIn('ORDER BY created_at DESC,id DESC LIMIT 1', latest)
        self.assertIn("JOIN latest p ON p.id=j.entity_id WHERE j.workspace_id='%s'" % W, sql)
        self.assertIn('t.id=r.thread_id AND t.workspace_id=r.workspace_id', sql)
        self.assertIn('JOIN selected_jobs j ON j.id=t.job_id', sql)
        self.assertIn("WHERE r.workspace_id='%s' AND r.result_key LIKE 'invalid-report-%%'" % W, sql)
        self.assertIn('JOIN selected_jobs j ON j.id=a.job_id', sql)
        self.assertIn("WHERE a.workspace_id='%s' AND a.operation='verify_grounding'" % W, sql)
        self.assertIn('ORDER BY created_at DESC,id DESC LIMIT 8', sql)
        self.assertIn('ORDER BY id DESC LIMIT 32', sql)
        self.assertIn('WHERE pn<=4', sql)
        self.assertIn('WHERE dn<=8', sql)

    def test_sql_projection_does_not_export_raw_reports_or_private_producer_fields(self):
        sql = m.diagnostic_sql(fixture()['selection'])
        projection = sql.split("SELECT jsonb_build_object('version'", 1)[1]
        for private in ['project_ref', 'credential_alias', 'numeric_literals',
                        'candidate_quote', 'source_refs', 'system_instruction']:
            self.assertNotIn(private, projection)
        self.assertNotRegex(projection, r"['\"](?:value|result|prompt|findings|producer|project|connectionId)['\"]\s*,")
        self.assertNotRegex(projection, r'to_jsonb\(r\)|jsonb_agg\(r\.value\)')
        self.assertEqual(re.findall(r"producer,[^}]+", projection), ['producer,model'])
        self.assertIn("n.workspace_id=c.workspace_id AND n.id=c.connection_id", projection)
        self.assertIn("c.workspace_id=r.workspace_id AND c.id=ids.id", projection)
        self.assertIn("r.workspace_id='%s' AND r.task IN ('default','verify_grounding')" % W, projection)
        self.assertIn('ORDER BY ids.n', projection)


if __name__ == '__main__':
    unittest.main()
