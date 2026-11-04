#!/usr/bin/env python3
"""Pinned API proxy transport proof; synthetic bytes, no Auth/SQL/hosted calls.

The private /tmp is disk-backed like the rendered emptyDir. Its 64MiB budget is
observed continuously, not a simulated filesystem ENOSPC. A baseline crossing
is cancelled and retained as a budget failure. No bytes are buffered by clients.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import stat
import threading
import time
import shutil
import tempfile

from legacy_batch_gateway import Probe, ROOT, GATEWAY, NGINX, NODE, DOCKER, canonical, executed_config, sha

TOTAL = 412_758_765
BUDGET = 64 * 1024 * 1024
PATTERN = bytes(range(256)) * 256

UPSTREAM = r"""const http=require('node:http');const records={};
const block=Buffer.alloc(65536);for(let i=0;i<block.length;i++)block[i]=i%256;
http.createServer((req,res)=>{const url=new URL(req.url,'http://synthetic');const id=url.searchParams.get('id');
 if(!id){res.end('synthetic');return;}const size=Number(url.searchParams.get('bytes'));
 const state=records[id]={sent:0,closed:false,completed:false,backpressure:0};
 res.setHeader('content-type','application/octet-stream');res.setHeader('content-length',size);
 res.on('close',()=>{state.closed=true;});
 function pump(){while(!state.closed&&state.sent<size){const chunk=block.subarray(0,Math.min(block.length,size-state.sent));state.sent+=chunk.length;
 if(!res.write(chunk)){state.backpressure++;res.once('drain',pump);return;}}
 if(!state.closed&&state.sent===size){state.completed=true;res.end();}}
 pump();}).listen(19080,'127.0.0.1');
http.createServer((req,res)=>res.end(JSON.stringify(records))).listen(19090,'127.0.0.1');"""


def expected_hash():
    h = hashlib.sha256()
    remaining = TOTAL
    while remaining:
        count = min(remaining, len(PATTERN)); h.update(PATTERN[:count]); remaining -= count
    return h.hexdigest()


def disk_census(root, process_ids=None):
    files = {}; deleted = set(); observed = 0
    def add(value):
        if stat.S_ISREG(value.st_mode):files[(value.st_dev,value.st_ino)] = value
    for base, _, names in os.walk(root):
        for name in names:
            try:add((Path(base) / name).stat())
            except FileNotFoundError:pass
    # Nginx can unlink a temp name immediately while retaining its open file.
    # Observe only this owned master/descendants, and de-duplicate by inode.
    pending = ([process_ids] if isinstance(process_ids,int) else list(process_ids or [])); seen = set()
    while pending:
        pid = pending.pop()
        if pid in seen:continue
        seen.add(pid);proc=Path('/proc')/str(pid)
        try:
            for fd in (proc/'fd').iterdir():
                try:
                    target=os.readlink(fd)
                    if target.startswith('/tmp/'):
                        value=fd.stat();add(value)
                        if target.endswith(' (deleted)'):deleted.add((value.st_dev,value.st_ino))
                except (FileNotFoundError,ProcessLookupError):pass
            observed+=1
        except (FileNotFoundError,ProcessLookupError):pass
    return {'logical_bytes':sum(x.st_size for x in files.values()),
        'allocated_bytes':sum(x.st_blocks*512 for x in files.values()),'files':len(files),
        'open_unlinked_files':len(deleted),'observed_processes':observed}


class StreamingProbe(Probe):
    def __init__(self, output):
        super().__init__(output)
        # Host /tmp is tmpfs in this environment. The measured gateway spill mount
        # must live on the workspace disk, independently of helper/control files.
        self.spill = Path(tempfile.mkdtemp(prefix='tdp-proxy-disk-',dir=ROOT.parent)); self.spill.chmod(0o777)
        self.control = self.temp / 'control'; self.control.mkdir(mode=0o777); self.control.chmod(0o777)
        self.receipt = {'version': 1, 'synthetic_only': True, 'production_calls': 0, 'customer_calls': 0,
            'gateway_image': NGINX, 'helper_image': NODE,
            'harness_sha256': sha(Path(__file__).read_bytes()),
            'routing_harness_sha256': sha(Path(__file__).with_name('legacy_batch_gateway.py').read_bytes()),
            'gateway_config_source_sha256': sha(GATEWAY.read_bytes()),
            'payload_bytes': TOTAL, 'payload_sha256': expected_hash(),
            'envelope': {'gateway_memory_bytes': BUDGET, 'gateway_cpu_millicores': 200, 'gateway_worker_processes': 1,
                'tmp_budget_bytes': BUDGET, 'tmp_medium': 'disk', 'tmp_enforcement': 'observed-budget-cancel-on-crossing',
                'helper_memory_bytes': 128 * 1024 * 1024, 'helper_cpu_millicores': 1000,
                'client_pause_ms_per_chunk': 4, 'census_interval_ms': 5, 'census_includes_open_unlinked_files': True},
            'limitations': ['Deterministic synthetic octets of the admitted response byte length; no application JSON/SQL/Auth/model execution.',
                'Disk-backed temporary mount is continuously observed; crossing cancels the baseline, not a claimed filesystem ENOSPC or hosted eviction.',
                'A crashed/replaced baseline process can make its FD census incomplete; baseline spill then remains unknown. Target acceptance requires a complete stable-process census.',
                'Nginx transport only; outer Caddy, DigitalOcean LoadBalancer, browser and hosted rollout are outside this proof.',
                'Loopback upstream and synthetic namespace; final one-worker directive is unchanged. API request buffering/body limits and other routing are unchanged.',
                'Buffering-enabled control also uses one worker; it is not proof of the previous auto-worker production deployment.']}

    def docker(self, *args, data=None, check=True):
        if args[0] == 'run': args = ('run', '--pull', 'never', *args[1:])
        env = {k: v for k, v in os.environ.items() if k not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        result = subprocess.run(DOCKER + list(args), input=data, text=True, capture_output=True, timeout=120, env=env)
        if check and result.returncode:
            self.output.with_suffix('.local-diagnostic.txt').write_text(result.stderr[:4000])
            raise RuntimeError('LOCAL_DOCKER_COMMAND_FAILED:' + args[0] + ':' + str(result.returncode) + ':' + sha(result.stderr.encode())[:16])
        return result

    def start(self):
        for key, image in [('gateway', NGINX), ('helper', NODE)]:
            info = json.loads(self.docker('image', 'inspect', image).stdout)[0]
            assert image.split('@')[1] in ' '.join(info['RepoDigests'])
            self.receipt[key + '_image_id'] = info['Id']
        script = self.temp / 'upstream.js'; script.write_text(UPSTREAM); script.chmod(0o644)
        self.receipt['upstream_sha256'] = sha(script.read_bytes())
        self.docker('run', '-d', '--name', self.helper, '--network', 'none', '--user', '1000:1000', '--read-only',
            '--memory', '128m', '--cpus', '1', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-v', str(script) + ':/upstream.cjs:ro', '-v', str(self.control) + ':/control:ro', '--entrypoint', 'deno', NODE, 'run', '--no-config', '--no-npm', '--no-remote', '--allow-read', '--allow-net', '/upstream.cjs')
        self.owned.append(self.helper)
        for _ in range(60):
            try: self.stats(); return
            except (RuntimeError, ValueError): time.sleep(.1)
        raise RuntimeError('SYNTHETIC_UPSTREAM_NOT_READY')

    def start_gateway(self, source):
        config = self.temp / 'nginx.conf'; text = executed_config(source); config.write_text(text); config.chmod(0o644)
        self.docker('run', '-d', '--name', self.gateway, '--network', 'container:' + self.helper, '--user', '1000:1000', '--read-only',
            '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-v', str(self.spill) + ':/tmp', '-v', str(config) + ':/etc/nginx/nginx.conf:ro', '--entrypoint', 'nginx', NGINX, '-g', 'daemon off;')
        self.owned.append(self.gateway)
        self.gateway_pid = json.loads(self.docker('inspect', self.gateway).stdout)[0]['State']['Pid']
        assert (Path('/proc')/str(self.gateway_pid)/'fd').exists(), 'OWNED_PROC_OBSERVER_REQUIRED'
        for _ in range(60):
            try:
                if self.requests([{'port': 8080, 'method': 'GET', 'path': '/healthz'}])[0]['status'] == 200:
                    self.gateway_pids = self.process_ids()
                    assert self.worker_count() == 1, 'ONE_RUNNING_GATEWAY_WORKER_REQUIRED'
                    filesystem = self.docker('exec', self.gateway, 'stat', '-f', '-c', '%T %t', '/tmp').stdout.strip().split()
                    assert len(filesystem) == 2 and filesystem[1].lower() in ('794c7630','ef53','58465342','9123683e'), 'DISK_BACKED_TMP_REQUIRED'
                    self.receipt['actual_gateway_tmp_filesystem'] = filesystem[0]
                    self.receipt['actual_gateway_tmp_filesystem_magic'] = filesystem[1].lower()
                    return sha(text.encode())
            except (RuntimeError, ValueError): pass
            time.sleep(.1)
        raise RuntimeError('PINNED_GATEWAY_NOT_READY')

    def worker_count(self):
        lines = self.docker('exec', self.gateway, 'ps', '-o', 'args').stdout.splitlines()
        return sum(line.strip() == 'nginx: worker process' for line in lines)

    def process_ids(self):
        return sorted(int(x.strip()) for x in self.docker('top', self.gateway, '-eo', 'pid').stdout.splitlines()[1:])

    def memory(self):
        state = json.loads(self.docker('inspect', self.gateway).stdout)[0]['State']
        if not state['Running']:
            return {'peak_bytes': None, 'events': {}, 'oom_killed': state['OOMKilled'], 'exit_code': state['ExitCode']}
        values = self.docker('exec', self.gateway, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events').stdout.splitlines()
        return {'peak_bytes': int(values[0]), 'events': {row.split()[0]: int(row.split()[1]) for row in values[1:]}}

    def transfer(self, port, name, cancel_after=0, *, require_observer=True):
        stop = threading.Event(); peaks = {'logical_bytes': 0, 'allocated_bytes': 0, 'files': 0, 'open_unlinked_files': 0, 'observed_processes': 0}; exceeded = []; observer_errors = []
        abort = self.control / name
        def census():
            while not stop.is_set():
                try:now = disk_census(self.spill, self.gateway_pids)
                except Exception as error:
                    observer_errors.append(type(error).__name__);abort.touch(exist_ok=True);return
                for key in peaks: peaks[key] = max(peaks[key], now[key])
                if max(now['logical_bytes'], now['allocated_bytes']) > BUDGET:
                    exceeded.append(True); abort.touch(exist_ok=True)
                stop.wait(.005)
        thread = threading.Thread(target=census); thread.start(); started = time.monotonic()
        try:
            result = self.node(r"""const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto');
const cfg=""" + canonical({'port': port, 'id': name, 'total': TOTAL, 'cancel': cancel_after}) + r""";
const h=crypto.createHash('sha256');let bytes=0, settled=false, status=null;
const r=http.get({host:'127.0.0.1',port:cfg.port,path:'/functions/v1/api/v1/synthetic-stream?id='+cfg.id+'&bytes='+cfg.total,headers:{connection:'close'}},res=>{
 status=res.statusCode;res.on('data',d=>{bytes+=d.length;h.update(d);res.pause();
 if((cfg.cancel&&bytes>=cfg.cancel)||fs.existsSync('/control/'+cfg.id)){res.destroy();r.destroy();finish('cancelled');return;}
 setTimeout(()=>res.resume(),4);});res.on('end',()=>finish('complete'));res.on('error',()=>finish('aborted'));});
function finish(outcome){if(settled)return;settled=true;clearTimeout(timer);console.log(JSON.stringify({status,outcome,bytes,sha256:h.digest('hex')}));}
r.on('error',()=>finish('request_error'));const timer=setTimeout(()=>{r.destroy();finish('timeout');},90000);""")
        finally:
            stop.set(); thread.join()
        state = json.loads(self.docker('inspect', self.gateway).stdout)[0]['State']
        stable = state['Running'] and self.process_ids() == self.gateway_pids
        complete = not observer_errors and peaks['observed_processes'] > 0 and stable
        if require_observer:assert complete, 'TEMP_OBSERVER_INCOMPLETE:' + canonical({'errors':observer_errors,'peak':peaks,'stable':stable})
        result.update(port=port, id=name, elapsed_seconds=round(time.monotonic()-started, 3), temporary_peak=peaks,
            temporary_budget_crossed=bool(exceeded), temporary_observer_complete=complete, observer_error_classes=observer_errors, gateway_memory=self.memory())
        return result

    def qualify(self):
        self.start(); source = GATEWAY.read_text()
        assert source.count('proxy_buffering off;') == 2 and source.count('worker_processes 1;') == 1 and 'worker_processes auto;' not in source
        baseline = source.replace(' proxy_buffering off;', '')
        self.receipt['baseline_config_source_sha256'] = sha(baseline.encode())
        self.receipt['baseline_executed_config_sha256'] = self.start_gateway(baseline)
        try:self.receipt['baseline'] = self.transfer(8080, 'baseline-buffered', require_observer=False)
        except Exception as error:
            state = json.loads(self.docker('inspect', self.gateway).stdout)[0]['State']
            self.receipt['baseline'] = {'outcome':'observation_incomplete','temporary_observer_complete':False,
                'temporary_budget_crossed':False,'failure_class':type(error).__name__,
                'gateway_memory':{'peak_bytes':None,'events':{},'oom_killed':state['OOMKilled'],'exit_code':state['ExitCode'],'running':state['Running']}}
        self.stop_gateway()
        # A new Nginx process resets cgroup accounting, not the private disk census.
        assert disk_census(self.spill)['logical_bytes'] < 4096
        self.receipt['executed_config_sha256'] = self.start_gateway(source)
        self.receipt['running_gateway_worker_count'] = self.worker_count()
        self.receipt['completed_transfers'] = []
        self.receipt['cancelled_transfers'] = []
        for port in (8080, 8081):
            row = self.transfer(port, 'full-' + str(port)); self.receipt['completed_transfers'].append(row)
            assert row['status'] == 200 and row['outcome'] == 'complete' and row['bytes'] == TOTAL and row['sha256'] == self.receipt['payload_sha256'], row
            assert not row['temporary_budget_crossed'] and row['gateway_memory']['peak_bytes'] <= BUDGET and row['gateway_memory']['events'].get('oom_kill', 0) == 0
            name = 'cancel-' + str(port); row = self.transfer(port, name, 2 * 1024 * 1024)
            assert row['outcome'] == 'cancelled' and not row['temporary_budget_crossed']
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                state = self.stats()[name]
                if state['closed']: break
                time.sleep(.05)
            assert state['closed'] and not state['completed'] and state['sent'] < TOTAL, state
            time.sleep(.2); later = self.stats()[name]; assert later['sent'] == state['sent']
            row['upstream_after_cancel'] = later; self.receipt['cancelled_transfers'].append(row)
        self.receipt.update(actual_binary_exercised=True, exact_delivery_qualified=True, cancellation_qualified=True,
            temporary_budget_qualified=True, gateway_memory_qualified=True,
            baseline_budget_failure_reproduced=self.receipt['baseline']['temporary_budget_crossed'],
            baseline_oom_reproduced=self.receipt['baseline']['gateway_memory'].get('oom_killed') is True or self.receipt['baseline']['gateway_memory'].get('events',{}).get('oom_kill',0)>0)

    def cleanup(self):
        super().cleanup()
        shutil.rmtree(self.spill)
        assert not self.spill.exists()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--output', type=Path, required=True); args = parser.parse_args()
    probe = StreamingProbe(args.output)
    try: probe.qualify(); probe.receipt['passed'] = True
    except Exception as error:
        probe.receipt['passed'] = False; probe.receipt['failure_class'] = type(error).__name__; probe.receipt['failure_detail'] = str(error)[:500]
    finally:
        probe.cleanup(); args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(probe.receipt, indent=2, sort_keys=True) + '\n')
    print(canonical({'passed': probe.receipt['passed'], 'cleanup_confirmed': probe.receipt['cleanup_confirmed'], 'receipt_sha256': sha(args.output.read_bytes())}))
    return 0 if probe.receipt['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
