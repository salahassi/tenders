import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest

SCRIPT = Path(__file__).with_name('capture-runtime-requalification-176bcf.py')
spec = importlib.util.spec_from_file_location('capture', SCRIPT)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
ROOT = SCRIPT.parents[3]


class CaptureTests(unittest.TestCase):
    def archive(self, entries):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.mode = 0o600
                archive.addfile(member)
        stream.seek(0)
        return stream

    def test_tar_preserves_actual_metadata(self):
        result = capture.inventory(self.archive([('./safe', tarfile.REGTYPE)]))
        self.assertEqual(result['safe']['mode'], '0600')
        self.assertEqual(result['safe']['uid'], 0)
        self.assertEqual(result['safe']['size'], 0)

    def test_tar_rejects_links_traversal_absolute_and_duplicates(self):
        for entries in [[('../bad', tarfile.REGTYPE)], [('/bad', tarfile.REGTYPE)],
                        [('safe', tarfile.SYMTYPE)], [('safe', tarfile.LNKTYPE)],
                        [('safe', tarfile.REGTYPE), ('./safe', tarfile.REGTYPE)]]:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                capture.inventory(self.archive(entries))

    def test_native_rejects_wrong_identity_resource_and_case_count(self):
        # Historical fixture is only test input; no evidence file is rewritten.
        original = json.loads((ROOT/'backend/docs/evidence/native-api-owned-snapshot-steady-20261104.json').read_text())
        candidate = copy.deepcopy(original)
        candidate['image_id'] = capture.IMAGE
        capture.validate_native(candidate, 'source_and_input', 2)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_IMAGE'):
            capture.validate_native(original, 'source_and_input', 2)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_CASES'):
            capture.validate_native(candidate, 'source_and_input', 1)
        candidate['container_limits']['memory_bytes'] *= 2
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_LIMITS'):
            capture.validate_native(candidate, 'source_and_input', 2)

    def test_native_rejects_swapped_artifact(self):
        candidate = json.loads((ROOT/'backend/docs/evidence/native-reviewed-docx-handler-20261104.json').read_text())
        candidate['image_id'] = capture.IMAGE
        capture.validate_native(candidate, 'source_and_input', 1)
        candidate['cases'][0]['artifact_hash'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_ARTIFACT'):
            capture.validate_native(candidate, 'source_and_input', 1)


if __name__ == '__main__':
    unittest.main()
