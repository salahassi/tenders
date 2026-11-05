"""Stdlib-only pre-Node gate. No gold, OCR import or model execution here."""
import hashlib
import json
import os
from pathlib import Path
import time


def read_cgroup(root=Path('/sys/fs/cgroup')):
    return {name: (root / name).read_text().strip() for name in
            ('memory.max', 'memory.swap.max', 'cpu.max', 'memory.current',
             'memory.peak', 'memory.events', 'cgroup.procs')}


def main():
    paths = ('experiment-config.json', 'run_parent.mjs', 'run_engine.py')
    receipt = {'phase': 'before_node', 'pid': os.getpid(),
               'utc_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns(),
               'cgroup': Path('/proc/self/cgroup').read_text(),
               'controls': read_cgroup(),
               'experiment_files': {name: hashlib.sha256(
                   (Path('/experiment') / name).read_bytes()).hexdigest() for name in paths}}
    temporary = Path('/outputs/gate-ready.tmp')
    temporary.write_text(json.dumps(receipt, indent=2) + '\n')
    temporary.rename('/outputs/gate-ready.json')
    # The external coordinator enforces the shorter absolute attempt deadline.
    deadline = time.monotonic() + 90
    while not Path('/gate/start').exists():
        if time.monotonic() >= deadline:
            raise SystemExit('Pre-Node gate expired')
        time.sleep(0.025)
    Path('/outputs/node-start.json').write_text(json.dumps(
        {'utc_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns()}) + '\n')
    os.execv('/usr/local/bin/node', ['/usr/local/bin/node', '--experimental-transform-types',
                                  '/experiment/run_parent.mjs'])


if __name__ == '__main__':
    main()
