"""Rollback-only ops admission/readback proof on the native recovery fixture."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

from postgres_races import OWNER, literal as q


def run(f, x, cases):
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location('native_review_trial_request', root / 'backend/scripts/ops/proposal-trial-request.py')
    request = importlib.util.module_from_spec(spec); sys.modules[spec.name] = request; spec.loader.exec_module(request)
    tables = ('public.generation_plans', 'public.jobs', 'public.generation_steps', 'public.proposals',
        'public.proposal_versions', 'public.proposal_sections', 'public.provider_usage', 'public.model_attempts',
        'public.proposal_issuance_requests', 'public.audit_events', 'app_private.idempotency_records',
        'app_private.model_graph_threads', 'app_private.model_graph_results', 'app_private.model_graph_checkpoints',
        'app_private.model_graph_budgets', 'app_private.legacy_zero_inventory_review_lineage')

    def snapshot():
        return {table: f.scalar("select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')::text,'UTF8')),'hex') from " + table + " t") for table in tables}

    def local(sql):
        # The isolated native database uses postgres for the ops client role.
        # Authenticated command authority and every business guard stay actual.
        return sql.replace("current_database()='tenderdesk_app'", 'current_database()=' + q(f.database)).replace(
            'SET LOCAL ROLE tdp_app_owner', 'SET LOCAL ROLE postgres')

    before = snapshot()
    selection = {'version': 1, 'workspace_id': f.workspace, 'opportunity_id': x['plan']['opportunity_id']}
    with patch.object(request.auth.access, 'WORKSPACE', f.workspace), \
         patch.object(request, 'read', side_effect=lambda database, sql: json.loads(f.sql(local(sql)).stdout.strip())):
        proof = request.inspect(None, selection)
        assert proof['whole_review_recovery']['status'] == 'ready'
        prepared = request.prepare(proof)
        assert prepared['body'] == {'commands': [{'operation': 'generation.retry', 'input': {
            'id': x['plan']['id'], 'expected_revision': x['plan']['revision'], 'reason': request.REASON}}]}
        assert prepared['command_key'] == hashlib.sha256(('batch:' + prepared['idempotency_key'] + ':1').encode()).hexdigest()
        assert snapshot() == before, 'Read-only trial preparation mutated retained state'
        transaction = f.command_sql('generation.retry', prepared['body']['commands'][0]['input'], prepared['command_key'])
        assert transaction.endswith('commit;')
        # Read the exact accepted lineage in the same test transaction, then
        # roll it back. Production uses the identical read-only SQL afterward.
        result = f.sql(transaction[:-len('commit;')] + '\nreset role;\n' + local(request.acceptance_sql(prepared)))
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        accepted = rows[-1]
        assert accepted['count'] == 1 and accepted['bound'] is True
        with patch.object(request, 'read', return_value=accepted):
            target = request.verify_result(None, prepared)
        assert target['operation'] == 'generation.retry' and target['plan_id'] == x['plan']['id']
        assert target['actor_id'] == OWNER and target['issuance_request_id'] != proof['latest_issuance']['id']
    assert snapshot() == before, 'Rollback-only trial proof changed saved model/version/usage history'
    cases.append({'case': 'ops-canonical-prepare-and-immutable-lineage-readback-without-history-change', 'passed': True})
