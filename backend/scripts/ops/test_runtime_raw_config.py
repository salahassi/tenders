"""Image-ID binding of raw config, independent of Docker inspect API defaults."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import test_proposal_delivery_images as fixture

p=fixture.p

class RawConfig(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  env=patch.dict(os.environ,{'DOKS_WORKDIR':self.temp.name});env.start();self.addCleanup(env.stop)
  p._RAW_CONFIG_CACHE.clear();self.addCleanup(p._RAW_CONFIG_CACHE.clear)
  self.document={'os':'linux','architecture':'amd64','rootfs':{'type':'layers','diff_ids':['sha256:'+'a'*64]},
   'config':{'User':'deno','Env':['PRIVATE_VALUE=hidden'],'Cmd':['run','main.ts'],'Labels':{p.qualification.REVISION_LABEL:fixture.REVISION}}}
 def value(self,document=None):
  document=document or self.document;raw=json.dumps(document,separators=(',',':')).encode()
  identifier='sha256:'+hashlib.sha256(raw).hexdigest()
  return raw,{'Id':identifier,'Os':document['os'],'Architecture':document['architecture'],
   'RootFS':{'Type':document['rootfs']['type'],'Layers':document['rootfs']['diff_ids']},
   'Config':{'Hostname':'API_DEFAULT','Env':['API_PRESENTATION']}}
 def export(self,raw,value,*,layout='docker',corrupt=False,missing=False,duplicate=False,symlink=False):
  def run(args,**kwargs):
   if args[1:3]==['image','inspect']:return fixture.result(stdout=json.dumps(value))
   self.assertEqual(args[:4],['docker','image','save','--output']);self.assertEqual(args[-1],value['Id'])
   name=value['Id'][7:]+'.json' if layout=='docker' else 'blobs/sha256/'+value['Id'][7:]
   with tarfile.open(args[4],'w') as archive:
    for _ in range(2 if duplicate else 1):
     member=tarfile.TarInfo('unrelated.json' if missing else name)
     payload=raw+b' ' if corrupt else raw
     if symlink:member.type=tarfile.SYMTYPE;member.linkname='/private';archive.addfile(member)
     else:member.size=len(payload);archive.addfile(member,io.BytesIO(payload))
   return fixture.result()
  return run
 def test_both_archive_layouts_bind_raw_bytes_to_image_id_without_extraction(self):
  for layout in ('docker','oci'):
   p._RAW_CONFIG_CACHE.clear();raw,value=self.value()
   with patch.object(p.subprocess,'run',side_effect=self.export(raw,value,layout=layout)):
    self.assertEqual(p.raw_image_config(value),self.document['config'])
   self.assertEqual(list(Path(self.temp.name).iterdir()),[])
 def test_containerd_manifest_id_resolves_exact_config_digest(self):
  for media in ('application/vnd.oci.image.config.v1+json','application/vnd.docker.container.image.v1+json'):
   p._RAW_CONFIG_CACHE.clear();raw,value=self.value();config_id=value['Id']
   manifest={'schemaVersion':2,'config':{'digest':config_id,'size':len(raw),'mediaType':media},'layers':[]}
   encoded=json.dumps(manifest).encode();value['Id']='sha256:'+hashlib.sha256(encoded).hexdigest()
   def run(args,**kwargs):
    with tarfile.open(args[4],'w') as archive:
     for digest,payload in [(value['Id'],encoded),(config_id,raw)]:
      member=tarfile.TarInfo('blobs/sha256/'+digest[7:]);member.size=len(payload);archive.addfile(member,io.BytesIO(payload))
    return fixture.result()
   with patch.object(p.subprocess,'run',side_effect=run) as export:
    self.assertEqual(p.raw_image_config(value),self.document['config']);self.assertEqual(value['Id'],config_id)
    self.assertEqual(p.raw_image_config(value),self.document['config']);self.assertEqual(export.call_count,1)
 def test_manifest_descriptor_and_config_bytes_are_both_verified(self):
  for change in ('digest','size','type','bytes'):
   p._RAW_CONFIG_CACHE.clear();raw,value=self.value();config_id=value['Id']
   descriptor={'digest':config_id,'size':len(raw),'mediaType':'application/vnd.oci.image.config.v1+json'}
   if change=='digest':descriptor['digest']='sha256:'+'0'*64
   if change=='size':descriptor['size']+=1
   if change=='type':descriptor['mediaType']='untrusted'
   encoded=json.dumps({'schemaVersion':2,'config':descriptor}).encode();value['Id']='sha256:'+hashlib.sha256(encoded).hexdigest()
   def run(args,**kwargs):
    with tarfile.open(args[4],'w') as archive:
     for digest,payload in [(value['Id'],encoded),(config_id,raw+b' ' if change=='bytes' else raw)]:
      member=tarfile.TarInfo('blobs/sha256/'+digest[7:]);member.size=len(payload);archive.addfile(member,io.BytesIO(payload))
    return fixture.result()
   with patch.object(p.subprocess,'run',side_effect=run),self.assertRaisesRegex(p.ImageError,'RAW_CONFIG_UNVERIFIED'):p.raw_image_config(value)
 def test_missing_duplicate_symlink_and_changed_config_bytes_fail_closed(self):
  for kwargs in ({'missing':True},{'duplicate':True},{'symlink':True},{'corrupt':True}):
   p._RAW_CONFIG_CACHE.clear();raw,value=self.value()
   with patch.object(p.subprocess,'run',side_effect=self.export(raw,value,**kwargs)),self.assertRaisesRegex(p.ImageError,'RAW_CONFIG_UNVERIFIED'):p.raw_image_config(value)
   self.assertEqual(list(Path(self.temp.name).iterdir()),[])
 def test_content_addressed_cache_is_immutable_and_does_not_repeat_large_exports(self):
  raw,value=self.value()
  with patch.object(p.subprocess,'run',side_effect=self.export(raw,value)) as run:
   first=p.raw_image_config(value);first['Env'].append('changed')
   self.assertEqual(p.raw_image_config(value),self.document['config']);self.assertEqual(run.call_count,1)
 def test_raw_platform_and_filesystem_must_match_observed_image(self):
  raw,value=self.value()
  with patch.object(p.subprocess,'run',side_effect=self.export(raw,value)):p.raw_image_config(value)
  for field,changed in (('Os','windows'),('Architecture','arm64'),('RootFS',{'Type':'layers','Layers':[]})):
   with self.assertRaisesRegex(p.ImageError,'RAW_IDENTITY_MISMATCH'):p.raw_image_config({**value,field:changed})
 def test_inspect_defaults_are_replaced_only_by_hash_verified_raw_configuration(self):
  raw,value=self.value()
  with patch.object(p.subprocess,'run',side_effect=self.export(raw,value)):
   actual=p.image_metadata('immutable-reference',canonical_runtime=True)
  self.assertEqual(actual['Config'],self.document['config'])
  self.assertNotIn('Hostname',actual['Config'])
 def test_canonical_runtime_config_changes_still_fail_qualification(self):
  baseline=copy.deepcopy(self.document['config']);baseline.pop('Labels')
  changed=copy.deepcopy(self.document);changed['config']['UnexpectedRuntimeSetting']='MUTATED'
  raw,value=self.value(changed)
  receipt={'qualified_image':{'os':'linux','architecture':'amd64','variant':'','rootfs':value['RootFS'],
   'config_without_labels':baseline,'labels':self.document['config']['Labels']}}
  with patch.object(p.subprocess,'run',side_effect=self.export(raw,value)):
   actual=p.image_metadata('immutable-reference',canonical_runtime=True)
  with self.assertRaisesRegex(p.qualification.QualificationError,'CONFIG'):p.qualification.verify_image(actual,receipt,fixture.REVISION)

if __name__=='__main__':unittest.main()
