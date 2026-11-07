import importlib.util,io,tarfile,tempfile,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('frontend_image_assets_test',Path(__file__).with_name('frontend-image-assets.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ImageAssets(unittest.TestCase):
 def archive(self,entries):
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w') as tar:
   for name,value,kind in entries:
    member=tarfile.TarInfo(name);member.type=kind
    if kind==tarfile.REGTYPE:member.size=len(value);tar.addfile(member,io.BytesIO(value))
    else:member.linkname='/private';tar.addfile(member)
  out.seek(0);return out
 def test_exact_static_bytes_and_nested_paths(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d);m.extract(self.archive([('./index.html',b'<html>',tarfile.REGTYPE),('./assets/app.js',b'exact',tarfile.REGTYPE)]),path)
   self.assertEqual((path/'index.html').read_bytes(),b'<html>');self.assertEqual((path/'assets/app.js').read_bytes(),b'exact')
 def test_paths_links_and_duplicate_files_fail_closed(self):
  for name,kind in [('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('a/../escape',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE)]:
   with tempfile.TemporaryDirectory() as d,self.subTest(name=name),self.assertRaises(m.AssetError):m.extract(self.archive([(name,b'x',kind)]),Path(d))
  with tempfile.TemporaryDirectory() as d,self.assertRaises(m.AssetError):m.extract(self.archive([('index.html',b'a',tarfile.REGTYPE),('index.html',b'b',tarfile.REGTYPE)]),Path(d))
 def test_missing_index_is_not_an_accepted_artifact(self):
  with tempfile.TemporaryDirectory() as d,self.assertRaisesRegex(m.AssetError,'INDEX_REQUIRED'):m.extract(self.archive([('asset.js',b'x',tarfile.REGTYPE)]),Path(d))
if __name__=='__main__':unittest.main()
