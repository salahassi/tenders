"""Verify the pre-output fixture freeze without importing a native OCR package."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(expected):
    assert re.fullmatch('[a-f0-9]{64}', expected), 'Invalid expected freeze hash'
    freeze_path = HERE/'freeze.json'
    assert freeze_path.is_file() and not freeze_path.is_symlink()
    assert sha(freeze_path) == expected, 'Freeze changed'
    freeze = json.loads(freeze_path.read_text())
    for name, binding in freeze['files'].items():
        relative = PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        path = HERE/name
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == binding['bytes'] and sha(path) == binding['sha256'], name
    gold = json.loads((HERE/'gold-manifest.json').read_text())
    review = json.loads((HERE/'pre-output-review.json').read_text())
    rendered = json.loads((HERE/'render-manifest.json').read_text())
    assert len(gold['cases']) == 6 and len(gold['retained_controls']) == 7
    assert review['decision'] == 'approved_for_pre_output_fixture_freeze'
    assert review['gold_manifest_sha256'] == rendered['gold_manifest_sha256'] == sha(HERE/'gold-manifest.json')
    assert review['generator_sha256'] == rendered['generator_sha256'] == sha(HERE/'generate.py')
    assert review['render_manifest_sha256'] == sha(HERE/'render-manifest.json')
    for document in [freeze,gold,review,rendered]:
        assert document['ocr_executed'] is False and document['recognition_qualified'] is False
    for name, expected in gold['retained_control_source_hashes'].items():
        assert sha(ROOT/name) == expected, 'Historical control source changed'
    for row in rendered['files']:
        assert sha(HERE/row['pdf']) == row['pdf_sha256']
        assert sha(HERE/row['png']) == row['png_sha256']
    return {'new_pages':6,'historical_controls':7,'independent_agent_review_bound':True,
            'ocr_executed':False,'recognition_qualified':False,'native_package_imported':False}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-freeze-sha256',required=True)
    print(json.dumps(verify(parser.parse_args().expected_freeze_sha256)))
