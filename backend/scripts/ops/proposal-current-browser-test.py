"""Local synthetic HTTPS/browser controls; no Auth, cloud or provider access.

Only this fixture engine trusts its throwaway self-signed HTTPS endpoint. The
production engine retains normal certificate verification without any bypass.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('browser_current_target', HERE / 'proposal-current-request.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class BrowserBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        def identity(n): return '00000000-0000-4000-8000-' + str(n).zfill(12)
        self.payload = {'workspace_id': identity(1), 'actor_id': identity(2), 'opportunity_id': identity(3),
            'plan_id': identity(4), 'proposal_id': identity(5), 'run_id': '123',
            'expected_plan_revision': 17, 'expected_opportunity_revision': 12, 'expected_proposal_revision': 8,
            'preserved_input_hash': 'a' * 64, 'access_token': 'synthetic-private-access-token-only',
            'session': {'access_token': 'synthetic-private-access-token-only', 'refresh_token': 'synthetic-refresh', 'user': {'id': identity(2)}}}
        p = self.payload
        self.details = {key: p[key] for key in ('plan_id', 'expected_plan_revision', 'preserved_input_hash',
            'opportunity_id', 'expected_opportunity_revision', 'proposal_id', 'expected_proposal_revision')}
        self.details.update(cancel_required=True, base_version_id=None, next_operation='proposal.generate')
        self.probe = {'commands': [{'operation': 'generation.retry', 'input': {'id': p['plan_id'],
            'expected_revision': p['expected_plan_revision'], 'reason': 'User requested continuation of the saved work.'}}]}
        self.batch = {'commands': [{'operation': 'generation.cancel', 'input': {'id': p['plan_id'],
            'expected_revision': p['expected_plan_revision'], 'reason': m.REASON}},
            {'operation': 'proposal.generate', 'input': {'id': p['opportunity_id'], 'expected_revision': p['expected_opportunity_revision']}}]}
        self.commands = []
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def respond(self, status, body, content_type='application/json'):
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def do_GET(self):
                if self.path == '/functions/v1/api/v1/bootstrap':
                    return self.respond(200, {'data': {'membership': {'user_id': p['actor_id'], 'workspace_id': p['workspace_id'], 'role': 'Owner'}, 'workspace': {'id': p['workspace_id']}}})
                page = '''<!doctype html><script>
                const command = body => fetch('/functions/v1/api/v1/commands', {method:'POST', headers:{'Content-Type':'application/json',Authorization:TOKEN,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});
                fetch('/functions/v1/api/v1/bootstrap').then(r=>r.json()).then(()=>{
                  const resume=document.createElement('button');resume.textContent='Resume saved work';document.body.append(resume);
                  resume.onclick=async()=>{resume.disabled=true;await command(PROBE);
                    const start=document.createElement('button');start.textContent='Start new request with current checks';document.body.append(start);
                    start.onclick=async()=>{start.disabled=true;await command(BATCH);};};
                });</script><body></body>'''.replace('TOKEN', json.dumps('Bearer ' + p['access_token'])).replace('PROBE', json.dumps(owner.probe)).replace('BATCH', json.dumps(owner.batch))
                self.respond(200, page.encode(), 'text/html')
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.commands.append(body)
                if body == owner.probe:
                    return self.respond(422, {'error': {'code': 'PROPOSAL_CURRENT_CONTRACT_REQUIRED', 'details': owner.details}})
                self.respond(200, {'data': [
                    {'id': p['plan_id'], 'workspace_id': p['workspace_id'], 'status': 'canceled'},
                    {'id': identity(20), 'workspace_id': p['workspace_id'], 'opportunity_id': p['opportunity_id'],
                     'proposal_id': p['proposal_id'], 'kind': 'proposal', 'issuance_request_id': identity(21),
                     'frozen_context': {'generated_delivery_version': 3, 'proposal_consistency_version': 1}}]})
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', str(self.directory / 'key.pem'), '-out', str(self.directory / 'cert.pem')],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.directory / 'cert.pem', self.directory / 'key.pem')
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.payload['origin'] = 'https://127.0.0.1:' + str(self.server.server_port)
        # Execute the actual browser helper and actual Python parent over pipes.
        # The fixture wrapper only supplies local TLS trust and test IPC wiring.
        script = '''import {createInterface} from 'node:readline';
        import {chromium} from PLAYWRIGHT;
        import {requestThroughBrowser} from HELPER;
        const reader=createInterface({input:process.stdin,crlfDelay:Infinity});const lines=reader[Symbol.asyncIterator]();
        const engine={launchServer:opts=>chromium.launchServer(opts),connect:async endpoint=>{
          const browser=await chromium.connect(endpoint);const create=browser.newContext.bind(browser);
          browser.newContext=options=>create({...options,ignoreHTTPSErrors:true});return browser;}};
        try{const input=JSON.parse((await lines.next()).value);
          const exchange=async event=>{process.stdout.write(JSON.stringify(event)+'\\n');return JSON.parse((await lines.next()).value);};
          const report=await requestThroughBrowser(input,request=>exchange({event:'prepared',request}),engine,pid=>exchange({event:'browser_started',pid}));
          process.stdout.write(JSON.stringify({event:'result',report})+'\\n');process.exitCode=report.outcome==='started'?0:1;
        }finally{reader.close();process.stdin.destroy();}
        '''.replace('PLAYWRIGHT', json.dumps((HERE.parent.parent / 'node_modules/playwright/index.mjs').as_uri())).replace('HELPER', json.dumps((HERE / 'proposal-current-request.mjs').as_uri()))
        self.script = self.directory / 'browser-fixture.mjs'
        self.script.write_text(script)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    def run_browser(self, persist, state):
        popen = subprocess.Popen
        def launch(arguments, **kwargs):
            arguments = ['node', '--experimental-transform-types', str(self.script)]
            return popen(arguments, **kwargs)
        with patch.object(m.subprocess, 'Popen', side_effect=launch):
            return m.run_child(self.payload, persist, state, timeout=25, private_directory=self.directory)

    def test_actual_browser_single_send_and_protocol_eof(self):
        state = {}
        started = time.monotonic()
        report = self.run_browser(lambda request: 'b' * 64, state)
        self.assertEqual(report['outcome'], 'started')
        self.assertEqual(self.commands, [self.probe, self.batch])
        self.assertTrue(state['browser_process_exit_confirmed'])
        self.assertTrue(state['child_termination_confirmed'])
        self.assertLess(time.monotonic() - started, 20)

    def test_actual_production_cli_closes_its_input_after_a_terminal_result(self):
        state = {}
        report = m.run_child({'invalid_synthetic_input': True}, lambda request: self.fail('must not prepare'),
                             state, timeout=5, private_directory=self.directory)
        self.assertEqual(report['outcome'], 'failed')
        self.assertEqual(self.commands, [])
        self.assertNotIn('browser_identity', state)
        self.assertTrue(state['child_termination_confirmed'])

    def test_withheld_persistence_ack_cannot_release_command_and_browser_exits(self):
        state = {}
        def withhold(request):
            self.assertEqual(self.commands, [self.probe])
            raise m.CurrentRequestError('CURRENT_REQUEST_PERSISTENCE_READBACK_FAILED')
        with self.assertRaisesRegex(m.CurrentRequestError, 'READBACK_FAILED'):
            self.run_browser(withhold, state)
        self.assertEqual(self.commands, [self.probe])
        self.assertNotIn('acknowledged', state)
        self.assertTrue(state['browser_process_exit_confirmed'])
        self.assertFalse(m.browser_group_alive(state['browser_identity']))

    def test_driver_death_while_persistence_pending_is_unknown_without_resend(self):
        state = {}
        def kill_driver(request):
            self.assertEqual(self.commands, [self.probe])
            os.kill(state['browser_identity']['parent'], signal.SIGKILL)
            # Force the pipe to observe the dead reader before parent ack.
            time.sleep(0.1)
            return 'b' * 64
        with self.assertRaises((BrokenPipeError, m.CurrentRequestError)):
            self.run_browser(kill_driver, state)
        self.assertEqual(self.commands, [self.probe])
        self.assertTrue(state['browser_process_exit_confirmed'])
        self.assertTrue(state['acknowledged'])  # Conservative possible-send state.
        self.assertTrue(state['child_termination_confirmed'])
        self.assertFalse(m.browser_group_alive(state['browser_identity']))


if __name__ == '__main__':
    unittest.main()
