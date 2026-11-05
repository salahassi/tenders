"""Prepare an exact reviewable binding; this neither authorizes nor runs OCR."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image-id', required=True)
    parser.add_argument('--experiment-directory', type=Path, required=True)
    parser.add_argument('--root-window-reference', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image_id):
        parser.error('Exact local immutable image ID required')
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    here = Path(__file__).resolve().parent
    binding = {'version': 1, 'scope': 'isolated_candidate_exact_inputs_reviewed_before_inference',
               'image_id': args.image_id, 'root_window_reference': args.root_window_reference,
               'host_files': {name: sha(here / name) for name in
                   ['run_campaign.py', 'entry_gate.py', 'campaign-sources.json', 'evaluate_campaign.py']},
               'experiment_files': {name: sha(args.experiment_directory / name) for name in
                   ['experiment-config.json', 'run_parent.mjs', 'run_engine.py']}}
    with args.output.open('x') as out:
        json.dump(binding, out, indent=2)
        out.write('\n')
    print(sha(args.output))


if __name__ == '__main__':
    main()
