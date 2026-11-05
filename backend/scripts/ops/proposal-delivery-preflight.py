#!/usr/bin/env python3
"""Read the production release prerequisites without schema or workload writes."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import re
import sys

SPEC = importlib.util.spec_from_file_location('delivery_preflight_update', Path(__file__).with_name('proposal-delivery-update.py'))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


def main():
    stage = 'source'
    completed = []
    try:
        # Shared guards may capture command output. Emit only fixed stages/codes.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            manifest = json.loads(p.release.MANIFEST.read_text())
            p.release.verify_source(manifest)
            completed.append(stage)
            stage = 'cluster'
            p.d.probe.validate_cluster()
            completed.append(stage)
            stage = 'worker_resources'
            p.worker_resource_envelope(p.u.deployment('worker', ready=False))
            completed.append(stage)
            stage = 'api_resources'
            p.api_resource_envelope(p.u.deployment('api', ready=False))
            completed.append(stage)
            stage = 'storage_gateway'
            p.gateway.preflight(p.d, manifest['gateway_configuration'])
            completed.append(stage)
            stage = 'https'
            p.https.preflight(p.d, manifest['https_configuration'], p.resource_envelope)
            completed.append(stage)
    except Exception as error:
        known = isinstance(error, (p.UpdateError, p.release.ReleaseError, p.gateway.GatewayError, p.https.HttpsError))
        code = str(error) if known and re.fullmatch(r'[A-Z_]{1,100}', str(error)) else 'DELIVERY_PREFLIGHT_FAILED'
        print(json.dumps({'release_preflight': 'blocked', 'stage': stage, 'completed': completed, 'code': code,
                          'schema_or_workload_writes': False, 'model_calls': 0}), flush=True)
        return 1
    print(json.dumps({'release_preflight': 'passed', 'completed': completed,
                      'scope': 'resource_and_proxy_prerequisites_only',
                      'schema_or_workload_writes': False, 'model_calls': 0}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
