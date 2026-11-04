import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location('https_streaming_proof',HERE/'https_api_streaming.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

class StreamProofTests(unittest.TestCase):
 def test_no_unbounded_or_oversized_compressed_read(self):
  reader=p.CountedReader(io.BytesIO(b'x'*(p.BLOCK*2)))
  with self.assertRaisesRegex(RuntimeError,'UNBOUNDED'):reader.read()
  self.assertEqual(len(reader.read(p.BLOCK*100)),p.BLOCK)
  self.assertEqual(reader.bytes,p.BLOCK)
 def test_open_unlinked_private_temp_is_counted(self):
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'spool';handle=path.open('wb+')
   try:
    handle.write(b'x'*32768);handle.flush()
    linked=p.census([Path(folder)],[os.getpid()])
    path.unlink();unlinked=p.census([Path(folder)],[os.getpid()])
    self.assertEqual(linked['logical_bytes'],unlinked['logical_bytes'])
    self.assertGreaterEqual(unlinked['logical_bytes'],32768)
    self.assertGreaterEqual(unlinked['open_unlinked_files'],1)
   finally:handle.close()
 def test_cleanup_failure_cannot_preserve_success(self):
  with tempfile.TemporaryDirectory() as folder:
   output=Path(folder)/'receipt.json'
   class FakeProof:
    def __init__(self,path,image):self.output=path;self.receipt={'passed':False}
    def qualify(self):self.receipt['passed']=True
    def cleanup(self):raise RuntimeError('owned deletion unconfirmed')
    def save(self):self.output.write_text(json.dumps(self.receipt))
   with patch.object(p,'Proof',FakeProof),patch.object(sys,'argv',['proof','--output',str(output)]):
    self.assertEqual(p.main(),1)
   value=json.loads(output.read_text());self.assertFalse(value['passed']);self.assertFalse(value['cleanup_confirmed'])
 def test_receipt_is_never_overwritten(self):
  with tempfile.TemporaryDirectory() as folder:
   output=Path(folder)/'receipt.json';output.write_text('original')
   with patch.object(sys,'argv',['proof','--output',str(output)]),self.assertRaisesRegex(ValueError,'FRESH_RECEIPT_REQUIRED'):p.main()
   self.assertEqual(output.read_text(),'original')

if __name__=='__main__':unittest.main()
