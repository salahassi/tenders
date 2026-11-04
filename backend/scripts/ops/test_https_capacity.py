"""Pure HTTPS release-guard faults; no Kubernetes, Docker or network access.

All source text, receipts and runtime objects below are synthetic temporary
fixtures. Their flags exercise binding logic and never assert native capacity.
"""
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


h = load('tested_https_capacity', 'https-capacity.py')
updater = load('https_capacity_real_resource_parser', 'proposal-delivery-update.py')
source_contract = h.source_contract
IMAGE = 'registry.digitalocean.com/tenderdesk-a6093a76/https@sha256:' + 'a' * 64
IMAGE_ID = 'sha256:' + 'b' * 64
FLAGS = ('passed', 'actual_binary_exercised', 'exact_delivery_qualified', 'cancellation_qualified',
         'temporary_budget_qualified', 'resource_envelope_qualified', 'tls_streaming_qualified',
         'cleanup_confirmed', 'source_unchanged', 'synthetic_only', 'https_is_deployed_registry_image')
CONFIG_TEXT = '# Synthetic Caddy fixture; no native qualification is asserted.\n'
GATEWAY_TEXT = '# Synthetic gateway fixture; no native qualification is asserted.\n'


def digest(value):
    return hashlib.sha256(value).hexdigest()


class ReadOnlyDriver:
    NAMESPACE = 'tenderdesk-dev'

    def __init__(self, contract):
        self.calls = []

        def meta(name):
            return {'name': name, 'namespace': self.NAMESPACE, 'uid': name + '-synthetic-uid',
                    'resourceVersion': '1', 'labels': {'app.kubernetes.io/managed-by': 'tenderdesk-deployment'}}

        resources = {'requests': {'cpu': '25m', 'memory': '32Mi'}, 'limits': {'cpu': '300m', 'memory': '128Mi'}}
        pod_spec = {'containers': [{'name': 'https', 'image': IMAGE,
                      'command': ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
                      'env': [{'name': 'PUBLIC_HOST', 'value': 'synthetic.example.test'},
                              {'name': 'XDG_DATA_HOME', 'value': '/data'},
                              {'name': 'XDG_CONFIG_HOME', 'value': '/config'}],
                      'resources': resources,
                      'volumeMounts': [{'name': 'public-config', 'mountPath': '/etc/caddy/Caddyfile',
                                        'subPath': 'Caddyfile', 'readOnly': True},
                                       {'name': 'scratch', 'mountPath': '/tmp'},
                                       {'name': 'https-state', 'mountPath': '/data'},
                                       {'name': 'https-config-state', 'mountPath': '/config'}]}],
                    'volumes': [{'name': 'public-config', 'configMap': {'name': 'https-config'}},
                                {'name': 'scratch', 'emptyDir': {'sizeLimit': '64Mi'}},
                                {'name': 'https-state', 'persistentVolumeClaim': {'claimName': 'https-state'}},
                                {'name': 'https-config-state', 'emptyDir': {'sizeLimit': '16Mi'}}]}
        annotations = {h.CHECKSUM: contract['config_data_sha256']}
        self.config = {'metadata': meta('https-config'), 'data': {'Caddyfile': CONFIG_TEXT}}
        self.deployment = {'metadata': meta('https'), 'spec': {'replicas': 1,
                           'selector': {'matchLabels': {'app': 'https'}},
                           'template': {'metadata': {'annotations': annotations}, 'spec': pod_spec}}}
        pod_meta = meta('https-synthetic-pod')
        pod_meta.update(labels={'app': 'https'}, annotations=copy.deepcopy(annotations))
        self.pods = [{'metadata': pod_meta, 'spec': copy.deepcopy(pod_spec),
                     'status': {'phase': 'Running', 'conditions': [{'type': 'Ready', 'status': 'True'}],
                                'containerStatuses': [{'name': 'https', 'ready': True,
                                   'image': IMAGE, 'imageID': 'docker-pullable://' + IMAGE,
                                   'containerID': 'containerd://' + 'c' * 64,
                                   'state': {'running': {'startedAt': '2026-11-04T00:00:00Z'}}}]}}]
        self.mounted = {'https-synthetic-pod': CONFIG_TEXT}
        self.pods_response = None

    def get(self, kind, name):
        self.calls.append(('get', kind, name))
        if (kind, name) == ('configmap', 'https-config'):
            return copy.deepcopy(self.config)
        if (kind, name) == ('deployment', 'https'):
            return copy.deepcopy(self.deployment)
        raise AssertionError('Forbidden object read or mutation: ' + repr((kind, name)))

    def command(self, args):
        self.calls.append(tuple(args))
        if args == ['get', 'pods', '-n', self.NAMESPACE, '-o', 'json']:
            return self.pods_response if self.pods_response is not None else json.dumps({'items': self.pods})
        for pod_name, text in self.mounted.items():
            if args == ['exec', pod_name, '-n', self.NAMESPACE, '--', 'cat', '/etc/caddy/Caddyfile']:
                return text
        # This intentionally refuses Secret reads, shell execution, TLS private
        # files and every write even if a helper change tries to introduce one.
        raise AssertionError('Forbidden command: ' + repr(args))


class HttpsCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for relative, text in ((h.CONFIG, CONFIG_TEXT), (h.GATEWAY, GATEWAY_TEXT)):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.receipt = {key: True for key in FLAGS}
        self.receipt.update(production_calls=0, customer_calls=0, model_calls=0,
            images={'https': IMAGE},
            image_binding={'kind': 'exact_deployed_registry_digest', 'repo_digest': IMAGE, 'local_image_id': IMAGE_ID},
            resources={'https_memory_bytes': 134217728, 'https_cpu_millicores': 300,'tmp_budget_per_service_bytes':67108864},
            payload={'bytes':412758765},
            mount_filesystems={name:{'statfs_magic':{'/tmp':'794c7630'}} for name in ('https','gateway')},
            tls={'verification_enabled': True, 'actual_handshake_verified': True},
            qualified_encodings=['identity', 'gzip', 'zstd'],
            source_hashes={'backend/' + h.CONFIG: digest(CONFIG_TEXT.encode()),
                           'backend/' + h.GATEWAY: digest(GATEWAY_TEXT.encode())})
        self.receipt_path = self.root / h.QUALIFICATION
        self.receipt_path.parent.mkdir(parents=True)
        self.write_receipt()
        self.contract = source_contract(self.root)
        self.driver = ReadOnlyDriver(self.contract)
        stack = self.enterContext(ExitStack())
        stack.enter_context(patch.object(h, 'ROOT', self.root))

    def write_receipt(self, mutate=None):
        value = copy.deepcopy(self.receipt)
        if mutate:
            mutate(value)
        self.receipt_path.write_text(json.dumps(value))

    def preflight(self, driver=None):
        return h.preflight(driver or self.driver, self.contract, updater.resource_envelope)

    def verify(self, state):
        return h.verify(self.driver, state, updater.resource_envelope)

    def fault(self, mutate, code='DELIVERY_HTTPS_'):
        self.driver = ReadOnlyDriver(self.contract)
        mutate(self.driver)
        with self.assertRaisesRegex((h.HttpsError, updater.UpdateError), code):
            self.preflight()

    def test_source_contract_freezes_exact_public_bytes_receipt_image_and_floors(self):
        self.assertEqual(self.contract, {
            'version': 1, 'image': IMAGE, 'image_id': IMAGE_ID,
            'config_source_sha256': digest(CONFIG_TEXT.encode()),
            'config_data_sha256': digest(json.dumps({'Caddyfile': CONFIG_TEXT}, sort_keys=True).encode()),
            'gateway_source_sha256': digest(GATEWAY_TEXT.encode()),
            'qualification_sha256': digest(self.receipt_path.read_bytes()),
            'minimum_memory_bytes': 134217728, 'minimum_cpu_millicores': 300})

    def test_each_qualification_flag_requires_literal_true(self):
        for flag in FLAGS:
            for invalid in (False, 1, 'true', None):
                with self.subTest(flag=flag, invalid=invalid):
                    self.write_receipt(lambda value: value.update({flag: invalid}))
                    with self.assertRaisesRegex(h.HttpsError, 'QUALIFICATION_REQUIRED'):
                        source_contract(self.root)

    def test_external_call_counters_require_integer_zero(self):
        for field in ('production_calls', 'customer_calls', 'model_calls'):
            for invalid in (False, True, 1, '0', None):
                with self.subTest(field=field, invalid=invalid):
                    self.write_receipt(lambda value: value.update({field: invalid}))
                    with self.assertRaisesRegex(h.HttpsError, 'QUALIFICATION_INVALID'):
                        source_contract(self.root)

    def test_image_requires_exact_qualified_registry_digest_and_local_id(self):
        changes = [lambda v: v['images'].update(https=IMAGE.replace('https@', 'runtime@')),
                   lambda v: v['images'].update(https=IMAGE.split('@')[0] + ':latest'),
                   lambda v: v['image_binding'].update(kind='local_rebuild'),
                   lambda v: v['image_binding'].update(repo_digest=IMAGE[:-1] + 'f'),
                   lambda v: v['image_binding'].update(local_image_id='sha256:short'),
                   lambda v: v['image_binding'].update(local_image_id=None)]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.write_receipt(change)
                with self.assertRaisesRegex(h.HttpsError, 'IMAGE_UNQUALIFIED'):
                    source_contract(self.root)

    def test_receipt_must_qualify_exact_resource_envelope(self):
        for field, invalid in [('https_memory_bytes', 134217727), ('https_memory_bytes', 268435456),
                               ('https_memory_bytes', True), ('https_cpu_millicores', 299),
                               ('https_cpu_millicores', 600), ('https_cpu_millicores', '300')]:
            with self.subTest(field=field, invalid=invalid):
                self.write_receipt(lambda value: value['resources'].update({field: invalid}))
                with self.assertRaisesRegex(h.HttpsError, 'ENVELOPE_UNQUALIFIED'):
                    source_contract(self.root)

    def test_tls_verification_and_all_three_encodings_are_required(self):
        changes = [lambda v: v['tls'].update(verification_enabled=False),
                   lambda v: v['tls'].update(actual_handshake_verified=1),
                   lambda v: v.update(qualified_encodings=['identity', 'gzip']),
                   lambda v: v.update(qualified_encodings=['identity', 'gzip', 'gzip'])]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.write_receipt(change)
                with self.assertRaisesRegex(h.HttpsError, 'TLS_UNQUALIFIED'):
                    source_contract(self.root)

    def test_public_caddy_and_gateway_source_drift_invalidate_proof(self):
        for relative, original in ((h.CONFIG, CONFIG_TEXT), (h.GATEWAY, GATEWAY_TEXT)):
            path = self.root / relative
            with self.subTest(relative=relative):
                path.write_text(original + '# changed\n')
                with self.assertRaisesRegex(h.HttpsError, 'QUALIFICATION_CHANGED'):
                    source_contract(self.root)
                path.write_text(original)

    def test_missing_symlink_oversized_and_invalid_receipt_fail_closed(self):
        saved = self.receipt_path.read_bytes()
        self.receipt_path.unlink()
        with self.assertRaisesRegex(h.HttpsError, 'SOURCE_UNAVAILABLE'):
            source_contract(self.root)
        target = self.root / 'synthetic-receipt-target'
        target.write_bytes(saved)
        self.receipt_path.symlink_to(target)
        with self.assertRaisesRegex(h.HttpsError, 'SOURCE_UNAVAILABLE'):
            source_contract(self.root)
        self.receipt_path.unlink()
        self.receipt_path.write_bytes(b' ' * 1048577)
        with self.assertRaisesRegex(h.HttpsError, 'SOURCE_UNAVAILABLE'):
            source_contract(self.root)
        for raw in ('{', '[]', 'null'):
            with self.subTest(raw=raw):
                self.receipt_path.write_text(raw)
                with self.assertRaisesRegex(h.HttpsError, 'QUALIFICATION_INVALID'):
                    source_contract(self.root)

    def test_changed_manifest_or_receipt_is_rejected_before_runtime_reads(self):
        bad = dict(self.contract, image_id='sha256:' + 'd' * 64)
        with self.assertRaisesRegex(h.HttpsError, 'MANIFEST_CHANGED'):
            h.preflight(self.driver, bad, updater.resource_envelope)
        self.assertEqual(self.driver.calls, [])
        self.write_receipt(lambda value: value.update(synthetic_receipt_revision=2))
        with self.assertRaisesRegex(h.HttpsError, 'MANIFEST_CHANGED'):
            self.preflight()
        self.assertEqual(self.driver.calls, [])

    def test_valid_preflight_and_verify_only_read_public_configuration(self):
        original = copy.deepcopy((self.driver.config, self.driver.deployment, self.driver.pods))
        state = self.preflight()
        result = self.verify(state)
        self.assertEqual(result['deployment']['memory_bytes'], 134217728)
        self.assertEqual(result['deployment']['cpu_millicores'], 300)
        self.assertEqual(result['ready_pods'][0]['uid'], 'https-synthetic-pod-synthetic-uid')
        self.assertFalse(result['hosted_load_qualified'])
        self.assertEqual((self.driver.config, self.driver.deployment, self.driver.pods), original)
        self.assertTrue(any(call[0] == 'exec' for call in self.driver.calls))

    def test_ownership_is_required_for_both_public_objects(self):
        for target in ('config', 'deployment'):
            for key, value in [('uid', ''), ('resourceVersion', ''), ('namespace', 'foreign'), ('name', 'foreign')]:
                with self.subTest(target=target, key=key):
                    self.fault(lambda d: getattr(d, target)['metadata'].update({key: value}), 'OWNERSHIP_REQUIRED')
            self.fault(lambda d: getattr(d, target)['metadata'].update(labels={}), 'OWNERSHIP_REQUIRED')

    def test_public_config_requires_exact_data_without_binary_overrides(self):
        changes = [lambda d: d.config['data'].update(Caddyfile='different'),
                   lambda d: d.config['data'].update(extra='unqualified'),
                   lambda d: d.config.update(binaryData={'Caddyfile': 'YQ=='})]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.fault(change, 'CONFIG_CHANGED')

    def test_template_checksum_replica_count_and_selector_are_required(self):
        changes = [lambda d: d.deployment['spec']['template']['metadata'].update(annotations={}),
                   lambda d: d.deployment['spec'].update(replicas=0),
                   lambda d: d.deployment['spec'].update(replicas=True),
                   lambda d: d.deployment['spec']['selector'].update(matchLabels={})]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.fault(change)

    def test_deployment_and_pod_entrypoint_identity_and_sidecars_are_rejected(self):
        for target in ('deployment', 'pod'):
            changes = [lambda s: s['containers'][0].update(image=IMAGE[:-1] + 'f'),
                       lambda s: s['containers'][0].update(command=['caddy', 'run']),
                       lambda s: s['containers'][0].update(args=['--config', '/tmp/other']),
                       lambda s: s['containers'].append({'name': 'sidecar'}),
                       lambda s: s.update(initContainers=[{'name': 'init'}]),
                       lambda s: s.update(ephemeralContainers=[{'name': 'debug'}])]
            for index, change in enumerate(changes):
                with self.subTest(target=target, index=index):
                    self.fault(lambda d: change(d.deployment['spec']['template']['spec'] if target == 'deployment' else d.pods[0]['spec']))

    def test_deployment_and_pod_caddy_mount_overrides_are_rejected(self):
        changes = [lambda s: s['containers'][0].update(volumeMounts=[]),
                   lambda s: s['containers'][0]['volumeMounts'][0].update(subPath='other'),
                   lambda s: s['containers'][0]['volumeMounts'][0].update(subPathExpr='$(PRIVATE)'),
                   lambda s: s['containers'][0]['volumeMounts'][0].update(readOnly=False),
                   lambda s: s['containers'][0]['volumeMounts'].append({'name': 'override', 'mountPath': '/etc/caddy'}),
                   lambda s: s['containers'][0]['volumeMounts'].append({'name': 'override', 'mountPath': '/etc/caddy/Caddyfile/child'}),
                   lambda s: s['containers'][0]['volumeMounts'].append({'name': 'override', 'mountPath': '/usr/bin/caddy'}),
                   lambda s: s['volumes'][0]['configMap'].update(name='foreign'),
                   lambda s: s['volumes'][0]['configMap'].update(items=[{'key': 'other', 'path': 'Caddyfile'}]),
                   lambda s: s['volumes'][0].update(secret={'secretName': 'must-not-read'}),
                   lambda s: s['volumes'].append(copy.deepcopy(s['volumes'][0]))]
        for target in ('deployment', 'pod'):
            for index, change in enumerate(changes):
                with self.subTest(target=target, index=index):
                    self.fault(lambda d: change(d.deployment['spec']['template']['spec'] if target == 'deployment' else d.pods[0]['spec']), 'MOUNT_CHANGED')

    def test_runtime_environment_cannot_replace_binary_or_redirect_state(self):
        changes = [lambda c: c.update(envFrom=[{'configMapRef': {'name': 'unreviewed'}}]),
                   lambda c: c['env'].append({'name': 'PATH', 'value': '/tmp'}),
                   lambda c: c['env'].append({'name': 'PUBLIC_HOST', 'value': 'other.example.test'}),
                   lambda c: c['env'][0].update(value='https://synthetic.example.test'),
                   lambda c: c['env'][0].update(value='a..example.test'),
                   lambda c: c['env'][0].update(valueFrom={'secretKeyRef': {'name': 'must-not-read', 'key': 'host'}}),
                   lambda c: c['env'][1].update(value='/tmp'),
                   lambda c: c['env'][2].update(value='/tmp'),
                   lambda c: c.update(env=[])]
        for target in ('deployment', 'pod'):
            for index, change in enumerate(changes):
                with self.subTest(target=target, index=index):
                    self.fault(lambda d: change((d.deployment['spec']['template']['spec'] if target == 'deployment' else d.pods[0]['spec'])['containers'][0]))

    def test_each_actual_resource_floor_uses_real_quantity_parser(self):
        invalid = [{}, {'cpu': '299m', 'memory': '128Mi'}, {'cpu': '300m', 'memory': '127Mi'},
                   {'cpu': '300m', 'memory': '128M'}, {'cpu': 'NaN', 'memory': '128Mi'},
                   {'cpu': '300m', 'memory': True}, {'cpu': '300m', 'memory': '1e9'}]
        for target in ('deployment', 'pod'):
            for limits in invalid:
                with self.subTest(target=target, limits=limits):
                    self.fault(lambda d: (d.deployment['spec']['template']['spec'] if target == 'deployment' else d.pods[0]['spec'])['containers'][0]['resources'].update(limits=limits), 'RESOURCES')

    def test_stronger_actual_pod_limits_are_observed_separately(self):
        self.driver.pods[0]['spec']['containers'][0]['resources']['limits'] = {'cpu': '0.5', 'memory': '0.25Gi'}
        state = self.preflight()
        self.assertEqual(state['resources']['deployment']['memory_bytes'], 134217728)
        self.assertEqual(state['resources']['ready_pods'][0]['resources']['memory_bytes'], 268435456)
        self.assertEqual(state['resources']['ready_pods'][0]['resources']['cpu_millicores'], 500)
        self.verify(state)

    def test_missing_extra_deleting_and_unready_selected_pods_fail_closed(self):
        changes = [lambda d: d.pods.clear(), lambda d: d.pods.append(copy.deepcopy(d.pods[0])),
                   lambda d: d.pods[0]['metadata'].update(deletionTimestamp='2026-11-04T00:00:00Z'),
                   lambda d: d.pods[0]['metadata'].update(namespace='foreign'),
                   lambda d: d.pods[0]['metadata'].update(uid=''),
                   lambda d: d.pods[0]['metadata'].update(annotations={}),
                   lambda d: d.pods[0]['status'].update(phase='Pending'),
                   lambda d: d.pods[0]['status'].update(conditions=[]),
                   lambda d: d.pods[0]['status'].update(containerStatuses=[]),
                   lambda d: d.pods[0]['status']['containerStatuses'][0].update(ready=1),
                   lambda d: d.pods[0]['status']['containerStatuses'][0].update(containerID=''),
                   lambda d: d.pods[0]['status']['containerStatuses'][0].update(state={'terminated': {}})]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.fault(change, 'PODS_UNQUALIFIED')

    def test_unrelated_pods_are_not_exec_targets(self):
        unrelated = copy.deepcopy(self.driver.pods[0])
        unrelated['metadata'].update(name='private-unrelated', labels={'app': 'other'})
        unrelated['spec'] = {}
        self.driver.pods.append(unrelated)
        self.preflight()
        self.assertFalse(any('private-unrelated' in call for call in self.driver.calls))

    def test_old_running_image_cannot_borrow_updated_pod_spec(self):
        self.fault(lambda d: d.pods[0]['status']['containerStatuses'][0].update(imageID='docker-pullable://' + IMAGE[:-1] + 'f'), 'RUNNING_IMAGE_CHANGED')

    def test_only_proven_runtime_image_id_representations_are_accepted(self):
        for identity in (IMAGE, 'docker-pullable://' + IMAGE, IMAGE_ID, 'docker://' + IMAGE_ID, 'containerd://' + IMAGE_ID):
            with self.subTest(identity=identity):
                self.driver = ReadOnlyDriver(self.contract)
                self.driver.pods[0]['status']['containerStatuses'][0]['imageID'] = identity
                self.preflight()

    def test_missing_or_unqualified_running_image_identity_is_rejected(self):
        for identity in (None, '', 'sha256:' + 'd' * 64, 'docker://' + IMAGE,
                         IMAGE.replace('https@', 'runtime@')):
            with self.subTest(identity=identity):
                self.fault(lambda d: d.pods[0]['status']['containerStatuses'][0].update(imageID=identity), 'RUNNING_IMAGE_CHANGED')

    def test_unparseable_pod_census_is_not_an_empty_success(self):
        for response in ('not-json', '{}', 'null'):
            with self.subTest(response=response):
                self.fault(lambda d: setattr(d, 'pods_response', response), 'PODS_INVALID')

    def test_current_public_mount_bytes_must_match_the_frozen_config(self):
        self.fault(lambda d: d.mounted.update({'https-synthetic-pod': '# stale public config\n'}), 'RUNNING_CONFIG_CHANGED')

    def test_verify_rejects_replaced_objects_or_changed_template(self):
        for change in (lambda d: d.config['metadata'].update(uid='replacement'),
                       lambda d: d.deployment['metadata'].update(uid='replacement'),
                       lambda d: d.deployment['spec']['template']['spec']['containers'][0]['resources']['limits'].update(memory='256Mi')):
            self.driver = ReadOnlyDriver(self.contract)
            state = self.preflight()
            change(self.driver)
            with self.assertRaisesRegex(h.HttpsError, '(CONFIG|WORKLOAD)_CHANGED'):
                self.verify(state)

    def test_verify_rejects_pod_restart_replacement_or_resource_drift(self):
        for change in (lambda d: d.pods[0]['metadata'].update(uid='replacement'),
                       lambda d: d.pods[0]['status']['containerStatuses'][0].update(containerID='containerd://' + 'd' * 64),
                       lambda d: d.pods[0]['spec']['containers'][0]['resources']['limits'].update(memory='256Mi')):
            self.driver = ReadOnlyDriver(self.contract)
            state = self.preflight()
            change(self.driver)
            with self.assertRaisesRegex(h.HttpsError, 'POD_CHANGED'):
                self.verify(state)

    def test_actual_pod_public_host_must_match_deployment_literal(self):
        self.driver.pods[0]['spec']['containers'][0]['env'][0]['value']='other.valid.example.test'
        with self.assertRaisesRegex(h.HttpsError,'POD_ENVIRONMENT_CHANGED'):self.preflight()

    def test_payload_and_actual_temporary_filesystem_evidence_are_required(self):
        mutations=[lambda r:r['payload'].update(bytes=1),lambda r:r['payload'].update(bytes=True),
                   lambda r:r['resources'].update(tmp_budget_per_service_bytes=1),
                   lambda r:r['mount_filesystems']['https']['statfs_magic'].update({'/tmp':'1021994'}),
                   lambda r:r['mount_filesystems']['gateway']['statfs_magic'].clear()]
        for mutate in mutations:
            self.write_receipt(mutate)
            with self.subTest(mutate=mutate),self.assertRaises(h.HttpsError):source_contract(self.root)

    def test_verify_rechecks_qualification_before_reading_runtime(self):
        state = self.preflight()
        self.driver.calls.clear()
        self.write_receipt(lambda value: value.update(synthetic_receipt_revision=2))
        with self.assertRaisesRegex(h.HttpsError, 'MANIFEST_CHANGED'):
            self.verify(state)
        self.assertEqual(self.driver.calls, [])


if __name__ == '__main__':
    unittest.main()
