"""Host-only frozen-gold evaluation after campaign capture; never repairs output."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

GOLD_SHA = 'c5ca3a7cc0ccb72eeb52e47dce2bac2429c92c47908c45aa63ea29da618fd735'
ORACLE_SHA = '13c70789d651bdceb1b56c57053280f4ef836e4dcd2165f501e58374b3d39c03'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_pair(upstream, projected, expected, normalize):
    target = normalize(expected)
    raw_pass = normalize(upstream) == target
    projection_pass = normalize(projected) == target
    return {'upstream_whole_page_exact': raw_pass,
            'projected_whole_page_exact': projection_pass,
            'whole_page_exact': raw_pass and projection_pass}


def evaluate(campaign_dir, gold_path, oracle_path):
    if sha(gold_path) != GOLD_SHA or sha(oracle_path) != ORACLE_SHA:
        raise ValueError('Pre-output gold/oracle hash changed')
    spec = importlib.util.spec_from_file_location('frozen_a06_oracle', oracle_path)
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    gold = json.loads(gold_path.read_text())
    campaign = json.loads((campaign_dir / 'campaign.json').read_text())
    if 'finished_utc_ns' not in campaign:
        raise ValueError('Campaign must finish or stop before any host gold evaluation')
    sources = json.loads((campaign_dir / 'campaign-sources.json').read_text())
    binding = json.loads((campaign_dir / 'run-binding.json').read_text())
    if sha(campaign_dir / 'run-binding.json') != campaign['binding_sha256']:
        raise ValueError('Captured root-reviewed binding changed')
    if sha(Path(__file__)) != binding['host_files']['evaluate_campaign.py']:
        raise ValueError('Post-capture evaluator differs from pre-output binding')
    if sha(campaign_dir / 'campaign-sources.json') != binding['host_files']['campaign-sources.json']:
        raise ValueError('Captured source mapping differs from binding')
    expected = {row['id']: row for row in [*gold['cases'], *gold['retained_controls']]}
    source_by_id = {row['id']: row for row in sources['cases']}
    rows = []
    for status in campaign['cases'][1:]:
        row = {'id': status['id'], 'attempt_status': status['status'],
               'whole_page_exact': False, 'critical_facts': [],
               'scored': False, 'qualification_pass': False}
        target = expected[row['id']]
        if status['status'] == 'completed':
            receipt_path = campaign_dir / status['receipt']
            if sha(receipt_path) != status['receipt_sha256']:
                raise ValueError('Attempt receipt changed before evaluation')
            receipt = json.loads(receipt_path.read_text())
            if receipt['source'] != source_by_id[row['id']] or receipt['status'] != 'completed':
                raise ValueError('Attempt source/status differs from campaign')
            projection_path = receipt_path.parent / 'outputs/node-projection.json'
            if sha(projection_path) != receipt['outputs']['outputs/node-projection.json']['sha256']:
                raise ValueError('Captured projection changed before evaluation')
            raw_path = receipt_path.parent / 'outputs/raw-engine.json'
            if sha(raw_path) != receipt['outputs']['outputs/raw-engine.json']['sha256']:
                raise ValueError('Captured upstream result changed before evaluation')
            text = json.loads(projection_path.read_text())['projection']['text']
            raw_texts = json.loads(raw_path.read_text())['result']['rec_texts']
            if not isinstance(raw_texts, list) or not all(isinstance(value, str) for value in raw_texts):
                raise ValueError('Malformed retained upstream rec_texts')
            upstream = '\n'.join(raw_texts)
            row['scored'] = True
            row['projected_text_sha256'] = hashlib.sha256(text.encode()).hexdigest()
            row['projected_text_codepoints'] = len(text)
            row['upstream_joined_text_sha256'] = hashlib.sha256(upstream.encode()).hexdigest()
            row['upstream_joined_text_codepoints'] = len(upstream)
            normalized, normalized_upstream = oracle.normalize(text), oracle.normalize(upstream)
            row.update(exact_pair(upstream, text, target['expected_text'], oracle.normalize))
            for fact in target.get('critical_facts', []):
                quote = oracle.normalize(fact['exact_quote'])
                row['critical_facts'].append({'id': fact['id'], 'kind': fact['kind'],
                    'projected_exact_quote_survived': quote in normalized,
                    'upstream_exact_quote_survived': quote in normalized_upstream,
                    'exact_quote_survived': quote in normalized and quote in normalized_upstream})
            row['qualification_pass'] = row['whole_page_exact'] and all(
                fact['exact_quote_survived'] for fact in row['critical_facts'])
        row['critical_fact_scope'] = ('Frozen source exact-quote checks, not a semantic correctness guarantee'
            if target.get('critical_facts') else 'No separately authored critical-fact annotations; whole-page oracle only')
        rows.append(row)
    if len(rows) != 13 or [r['id'] for r in rows] != [r['id'] for r in sources['cases']]:
        raise ValueError('All 13 fixed denominators must be retained in order')
    passed = sum(row['qualification_pass'] for row in rows)
    facts = [fact for row in rows for fact in row['critical_facts']]
    return {'version': 1, 'scope': 'agent_authored_synthetic_and_known_development_controls',
            'campaign_sha256': sha(campaign_dir / 'campaign.json'),
            'gold_sha256': GOLD_SHA, 'oracle_sha256': ORACLE_SHA,
            'gold_accessed_only_after_campaign_finished': True,
            'normalization': oracle.VERSION, 'expected_denominator': 13,
            'completed': sum(row['scored'] for row in rows), 'whole_page_passed': passed,
            'critical_facts_total_frozen': sum(len(row.get('critical_facts', [])) for row in gold['cases']),
            'critical_facts_scored': len(facts),
            'critical_facts_exact_quote_survived': sum(f['exact_quote_survived'] for f in facts),
            'cold_blank_status': campaign['cases'][0]['status'],
            'candidate_passed_this_finite_campaign': passed == 13 and campaign['cases'][0]['status'] == 'completed'
                and campaign['status'] == 'completed_pending_host_evaluation',
            'universal_correctness_or_production_adoption_established': False,
            'human_or_private_holdout_review': False, 'output_repair_performed': False,
            'rows': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign', type=Path, required=True)
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = evaluate(args.campaign, args.gold, args.oracle)
    with args.output.open('x') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write('\n')
    raise SystemExit(0 if result['candidate_passed_this_finite_campaign'] else 1)


if __name__ == '__main__':
    main()
