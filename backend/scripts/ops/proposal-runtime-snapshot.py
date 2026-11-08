#!/usr/bin/env python3
"""Optional, bounded resource metadata through the existing Kubernetes client.

No logs or provider requests are read. Transient pod specifications are reduced
to metadata; configuration, environment and customer data are not retained.
"""
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import re
import time

COMPONENTS = ('worker', 'rest', 'gateway')
MAX_BYTES = 128 * 1024
MAX_INTEGER = 9007199254740991
CPU_FIELDS = {'usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'}
MEMORY_FIELDS = {'low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill'}
CGROUP_SCRIPT = """const files=['cpu.stat','memory.current','memory.events'];
const values={};for(const f of files)values[f]=await Deno.readTextFile('/sys/fs/cgroup/'+f);
console.log(JSON.stringify(values));"""


def integer(value):
    if type(value) is not int or not 0 <= value <= MAX_INTEGER:
        raise ValueError('INVALID_METADATA')
    return value


def document(raw):
    if not isinstance(raw, str) or len(raw.encode()) > MAX_BYTES:
        raise ValueError('METADATA_LIMIT')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('INVALID_METADATA')
    return value


def quantity(value, cpu=False):
    units = {'n': 1, 'u': 1000, 'm': 1000000, '': 1000000000} if cpu else {
        '': 1, 'Ki': 1024, 'Mi': 1024**2, 'Gi': 1024**3, 'Ti': 1024**4,
        'K': 1000, 'M': 1000**2, 'G': 1000**3}
    match = re.fullmatch(r'([0-9]{1,16}(?:\.[0-9]{1,9})?)([A-Za-z]*)', value) if isinstance(value, str) else None
    if not match or match[2] not in units:
        raise ValueError('INVALID_QUANTITY')
    amount = Decimal(match[1]) * units[match[2]]
    if amount != int(amount):
        raise ValueError('INVALID_QUANTITY')
    return integer(int(amount))


def cgroup(raw):
    value = document(raw)
    if set(value) != {'cpu.stat', 'memory.current', 'memory.events'}:
        raise ValueError('INVALID_CGROUP')
    def counters(text, allowed):
        if not isinstance(text, str) or len(text) > 4096:
            raise ValueError('INVALID_CGROUP')
        result = {}
        for line in text.splitlines():
            parts = line.split()
            if len(parts) != 2 or not re.fullmatch('[0-9]{1,16}', parts[1]):
                raise ValueError('INVALID_CGROUP')
            if parts[0] in allowed:
                if parts[0] in result:
                    raise ValueError('INVALID_CGROUP')
                result[parts[0]] = integer(int(parts[1]))
        return result
    memory = value['memory.current']
    if not isinstance(memory, str) or not re.fullmatch(r'[0-9]{1,16}\s*', memory):
        raise ValueError('INVALID_CGROUP')
    cpu = counters(value['cpu.stat'], CPU_FIELDS)
    if not {'usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'} <= set(cpu):
        raise ValueError('INVALID_CGROUP')
    return {'cpu': cpu, 'memory_current_bytes': integer(int(memory)),
        'memory_events': counters(value['memory.events'], MEMORY_FIELDS)}


def capture(deploy, remaining_seconds):
    """At most 7.5 extra seconds, retaining the runner's 70-second reserve."""
    started = time.monotonic()
    deadline = started + min(7.5, max(0, remaining_seconds() - 70))
    result = {'version': 1, 'kind': 'proposal_runtime_snapshot', 'status': 'unavailable',
        'metrics_status': 'unavailable', 'cgroup_status': 'unavailable', 'pods': [], 'elapsed_ms': 0}
    def command(arguments):
        budget = deadline - time.monotonic()
        if budget < 0.1:
            raise TimeoutError('SNAPSHOT_BUDGET')
        return deploy.command(arguments, timeout=min(2, budget))
    try:
        if deadline - started < 1:
            result['status'] = 'skipped_budget'
            return result
        pods = document(command(['get', 'pods', '-n', deploy.NAMESPACE, '-l',
            'app.kubernetes.io/name in (worker,rest,gateway)', '-o', 'json'])).get('items')
        if not isinstance(pods, list) or len(pods) > 24:
            raise ValueError('POD_LIMIT')
        selected = {}
        for pod in pods:
            meta = pod.get('metadata', {})
            component = meta.get('labels', {}).get('app.kubernetes.io/name')
            name, uid = meta.get('name'), meta.get('uid')
            if component not in COMPONENTS or meta.get('namespace') != deploy.NAMESPACE:
                raise ValueError('POD_SCOPE')
            if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,252}', name):
                raise ValueError('POD_IDENTITY')
            if not isinstance(uid, str) or not re.fullmatch('[a-f0-9-]{36}', uid):
                raise ValueError('POD_IDENTITY')
            statuses = [s for s in pod.get('status', {}).get('containerStatuses', []) if s.get('name') == component]
            if len(statuses) != 1 or type(statuses[0].get('ready')) is not bool:
                raise ValueError('POD_STATUS')
            row = {'component': component, 'identity': hashlib.sha256(uid.encode()).hexdigest()[:16],
                'ready': statuses[0]['ready'], 'restarts': integer(statuses[0].get('restartCount')),
                'usage': None, 'cgroup': None}
            selected[name] = row
        result['pods'] = list(selected.values())
        result['status'] = 'captured'
        try:
            metrics = document(command(['get', '--raw', '/apis/metrics.k8s.io/v1beta1/namespaces/' + deploy.NAMESPACE + '/pods']))
            items = metrics.get('items')
            if not isinstance(items, list) or len(items) > 128:
                raise ValueError('METRIC_LIMIT')
            for item in items:
                meta = item.get('metadata', {})
                if meta.get('name') not in selected or meta.get('namespace') != deploy.NAMESPACE:
                    continue
                row = selected[meta['name']]
                values = [c for c in item.get('containers', []) if c.get('name') == row['component']]
                if len(values) != 1:
                    raise ValueError('METRIC_SCOPE')
                usage = values[0].get('usage', {})
                stamp, window = item.get('timestamp'), item.get('window')
                if not isinstance(stamp, str) or len(stamp) > 40 or datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo is None:
                    raise ValueError('METRIC_TIME')
                if not isinstance(window, str) or not re.fullmatch(r'[0-9]{1,5}(?:\.[0-9]{1,9})?s', window):
                    raise ValueError('METRIC_TIME')
                row['usage'] = {'cpu_nanocores': quantity(usage.get('cpu'), True),
                    'memory_bytes': quantity(usage.get('memory')), 'timestamp': stamp,
                    'window_ms': integer(int(Decimal(window[:-1]) * 1000))}
            result['metrics_status'] = 'captured'
        except Exception:
            for row in selected.values():
                row['usage'] = None
        worker = next((name for name, row in selected.items() if row['component'] == 'worker' and row['ready']), None)
        if worker:
            try:
                selected[worker]['cgroup'] = cgroup(command(['exec', worker, '-n', deploy.NAMESPACE,
                    '-c', 'worker', '--', 'deno', 'eval', '--cached-only', CGROUP_SCRIPT]))
                result['cgroup_status'] = 'captured'
            except Exception:
                pass
    except Exception:
        result['pods'] = []
    finally:
        result['elapsed_ms'] = max(0, int((time.monotonic() - started) * 1000))
    return result
