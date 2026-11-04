import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gateway_api_streaming import disk_census


class TemporaryFileCensusTests(unittest.TestCase):
    def test_retains_unlinked_open_temp_bytes_until_descriptor_closes(self):
        with tempfile.TemporaryDirectory(prefix='tdp-census-') as name:
            root = Path(name)
            with (root / 'synthetic').open('wb', buffering=0) as stream:
                stream.write(b'x' * 1024 * 1024)
                os.fsync(stream.fileno())
                before = disk_census(root, os.getpid())
                (root / 'synthetic').unlink()
                self.assertEqual(disk_census(root)['logical_bytes'], 0)
                after = disk_census(root, os.getpid())
                self.assertEqual(after['logical_bytes'], before['logical_bytes'])
                self.assertEqual(after['allocated_bytes'], before['allocated_bytes'])
                self.assertEqual(after['open_unlinked_files'], before['open_unlinked_files'] + 1)
            self.assertEqual(disk_census(root, os.getpid())['logical_bytes'], 0)

    def test_open_linked_file_is_counted_once(self):
        with tempfile.TemporaryDirectory(prefix='tdp-census-') as name:
            root = Path(name)
            with (root / 'synthetic').open('wb', buffering=0) as stream:
                stream.write(b'x' * 4096)
                observed = disk_census(root, os.getpid())
                self.assertEqual(observed['logical_bytes'], 4096)
                self.assertEqual(observed['files'], 1)
                self.assertGreater(observed['observed_processes'], 0)


if __name__ == '__main__':
    unittest.main()
