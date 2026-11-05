#!/usr/bin/env python3
"""Convert a future target-native pip dry-run report into a wheel hash lock.

This reads JSON only. It does not resolve, download, install, import Paddle, or
claim that the dependency graph is closed. Offline pip installation/check and
native compatibility remain required. Existing output is never overwritten.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


def check(condition, code):
    if not condition:
        raise ValueError('PADDLE_LOCK_' + code)


def canonical_name(value):
    check(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value), 'NAME')
    return re.sub(r'[-_.]+', '-', value).lower()


def lock_rows(seed, report):
    check(report.get('version') == '1', 'REPORT_VERSION')
    environment = report.get('environment', {})
    for key in ('implementation_name', 'python_version', 'platform_machine', 'sys_platform'):
        check(environment.get(key) == seed['target'][key], 'TARGET_ENVIRONMENT')
    rows = {}
    for selected in report.get('install', []):
        metadata, download = selected.get('metadata', {}), selected.get('download_info', {})
        name = canonical_name(metadata.get('name'))
        version = metadata.get('version')
        check(isinstance(version, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.!+_-]*', version), 'VERSION')
        check(name not in rows and selected.get('is_yanked') is False, 'DUPLICATE_OR_YANKED')
        url = download.get('url', '')
        parsed = urlsplit(url)
        filename = unquote(parsed.path.rsplit('/', 1)[-1])
        check(parsed.scheme == 'https' and parsed.hostname == 'files.pythonhosted.org' and
              not parsed.query and not parsed.fragment and not parsed.username and not parsed.password and
              re.fullmatch(r'[A-Za-z0-9_.+!-]+\.whl', filename), 'WHEEL_URL')
        digest = download.get('archive_info', {}).get('hashes', {}).get('sha256')
        check(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest), 'WHEEL_SHA256')
        rows[name] = {'name': name, 'version': version, 'filename': filename, 'url': url,
                      'sha256': digest, 'requires_dist': metadata.get('requires_dist', [])}
    check(len(rows) > len(seed['root_wheel_pins']), 'TRANSITIVES_MISSING')
    for expected in seed['root_wheel_pins']:
        actual = rows.get(expected['name'])
        check(actual is not None and all(actual[key] == expected[key]
              for key in ('version', 'filename', 'url', 'sha256')), 'ROOT_PIN_CHANGED')
    return [rows[name] for name in sorted(rows)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=Path, default=Path(__file__).with_name('seed-manifest.json'))
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    check(not args.output.exists(), 'OUTPUT_EXISTS')
    seed, report = json.loads(args.seed.read_text()), json.loads(args.report.read_text())
    rows = lock_rows(seed, report)
    lines = ['# From a target-native resolver report; offline dependency closure is not yet verified.']
    for row in rows:
        extras = seed['requested_extras'].get(row['name'], [])
        suffix = '[' + ','.join(extras) + ']' if extras else ''
        lines.append(f"{row['name']}{suffix}=={row['version']} --hash=sha256:{row['sha256']}")
    args.output.mkdir(parents=True, exist_ok=False)
    lock = args.output/'requirements.lock'
    lock.write_text('\n'.join(lines) + '\n')
    manifest = {'version': 1, 'status': 'resolver_report_frozen_offline_closure_unverified',
                'seed_sha256': hashlib.sha256(args.seed.read_bytes()).hexdigest(),
                'resolver_report_sha256': hashlib.sha256(args.report.read_bytes()).hexdigest(),
                'requirements_lock_sha256': hashlib.sha256(lock.read_bytes()).hexdigest(),
                'resolver_environment': report['environment'], 'resolver_pip_version': report.get('pip_version'),
                'wheels': rows, 'actual_wheels_verified': False, 'offline_dependency_closure_verified': False,
                'models_verified': False, 'base_verified': False, 'native_imported': False,
                'ready_to_build': False, 'recognition_executed': False}
    (args.output/'resolved-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'frozen_wheels': len(rows), 'output': str(args.output), 'ready_to_build': False}))


if __name__ == '__main__':
    main()
