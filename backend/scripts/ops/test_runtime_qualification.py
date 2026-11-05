import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('tested_runtime_qualification', Path(__file__).with_name('runtime-qualification.py'))
q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(q)
ROOT = Path(__file__).resolve().parents[3]
REVISION = 'a' * 40
REFERENCE = q.REGISTRY + '@sha256:' + 'b' * 64


class RuntimeQualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receipt = q.load(ROOT)
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        for name in q.COPY_ROOTS:
            source, target = ROOT / name, cls.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        for name in [*cls.receipt['supplementary_inputs'], *[e['path'] for e in cls.receipt['native_evidence']], q.RECEIPT, q.PUBLICATION]:
            target = cls.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        (cls.root / q.PUBLICATION).write_text(json.dumps({'version':1,'qualified_image_id':q.QUALIFIED_ID,'reference':None}))
        subprocess.run(['git', 'init', '-q', str(cls.root)], check=True)
        subprocess.run(['git', '-C', str(cls.root), 'add', '.'], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def image(self):
        r = self.receipt['qualified_image']
        return {'Id': q.QUALIFIED_ID, 'Os': r['os'], 'Architecture': r['architecture'],
                'RootFS': copy.deepcopy(r['rootfs']),
                'Config': {**copy.deepcopy(r['config_without_labels']), 'Labels': dict(r['labels'])},
                'RepoDigests': [REFERENCE]}

    def test_actual_frozen_copied_inputs_native_receipts_and_git_modes(self):
        q.verify_checkout(ROOT, self.receipt)
        self.assertEqual(sum(e['type'] == 'file' for e in self.receipt['source_entries'].values()), 130)
        self.assertEqual(len(self.receipt['image_app_tar_inventory']), 146)
        self.assertEqual(len(self.receipt['qualified_image']['rootfs']['Layers']), 17)
        self.assertEqual(len(self.receipt['native_evidence']), 4)
        self.assertEqual(self.receipt['source_entries']['backend/supabase/functions/_shared/model.ts']['sha256'],
                         'e98fdffb10e6a07aea33c34d214b6432081955a37aa9aa8d66e1ee4d97ea2ae8')
        self.assertEqual(self.receipt['observed_checkout_revision'], '19498666b511a29c251923baa75bf42c88a0c6f0')
        q.verify_published(self.image(), REFERENCE, self.receipt)

    def test_source_bytes_and_executable_mode_are_both_required(self):
        p = self.root / 'backend/scripts/runtime/main.ts'
        original, mode = p.read_bytes(), p.stat().st_mode
        try:
            p.write_bytes(original + b'\n// changed runtime\n')
            with self.assertRaisesRegex(q.QualificationError, 'SOURCE_BYTES'):
                q.verify_checkout(self.root, self.receipt)
            p.write_bytes(original)
            p.chmod(0o700)
            with self.assertRaisesRegex(q.QualificationError, 'SOURCE_MODE'):
                q.verify_checkout(self.root, self.receipt)
            # Normal Git checkout permissions are compatible; they never change image permissions.
            p.chmod(0o644)
            q.verify_checkout(self.root, self.receipt)
        finally:
            p.write_bytes(original)
            p.chmod(mode)

    def test_missing_extra_ignored_and_untracked_copy_paths_are_rejected_before_hashing(self):
        for name in ['surprise.ts', '.env', '__pycache__']:
            with self.subTest(name=name):
                p = self.root / 'backend/scripts/runtime' / name
                try:
                    if name == '__pycache__': p.mkdir()
                    else: p.write_text('MUST_NOT_READ_EXTRA_INPUT')
                    with patch.object(q, 'sha256', side_effect=AssertionError('unexpected file read')):
                        with self.assertRaisesRegex(q.QualificationError, 'SOURCE_PATH_SET'):
                            q.verify_checkout(self.root, self.receipt)
                finally:
                    if p.is_dir(): p.rmdir()
                    else: p.unlink()
        p = self.root / 'backend/scripts/runtime/main.ts'
        parked = self.root / 'main.saved'
        p.rename(parked)
        try:
            with self.assertRaisesRegex(q.QualificationError, 'SOURCE_PATH_SET'):
                q.verify_checkout(self.root, self.receipt)
        finally: parked.rename(p)
        subprocess.run(['git', '-C', str(self.root), 'rm', '--cached', '-q', 'backend/scripts/runtime/main.ts'], check=True)
        try:
            with self.assertRaisesRegex(q.QualificationError, 'GIT_PATH_SET'):
                q.verify_checkout(self.root, self.receipt)
        finally: subprocess.run(['git', '-C', str(self.root), 'add', 'backend/scripts/runtime/main.ts'], check=True)

    def test_links_and_specials_are_never_followed_or_opened(self):
        p = self.root / 'backend/scripts/runtime/foreign'
        p.symlink_to('/proc/self/environ')
        try:
            with self.assertRaisesRegex(q.QualificationError, 'SOURCE_LINK'):
                q.verify_checkout(self.root, self.receipt)
        finally: p.unlink()
        import os
        os.mkfifo(p)
        try:
            with self.assertRaisesRegex(q.QualificationError, 'SOURCE_SPECIAL'):
                q.verify_checkout(self.root, self.receipt)
        finally: p.unlink()

    def test_recipe_ignore_and_harness_lock_changes_require_new_review(self):
        for name in self.receipt['supplementary_inputs']:
            with self.subTest(name=name):
                p = self.root / name; original = p.read_bytes()
                try:
                    p.write_bytes(original + b'\n')
                    with self.assertRaisesRegex(q.QualificationError, 'INPUT_BYTES'):
                        q.verify_checkout(self.root, self.receipt)
                finally: p.write_bytes(original)

    def test_dockerfile_specific_ignore_cannot_change_the_closed_context(self):
        p=self.root/'backend/deploy/Dockerfile.dockerignore';p.write_text('!**/.env\n')
        try:
            with self.assertRaisesRegex(q.QualificationError,'IGNORE_OVERRIDE'):q.verify_checkout(self.root,self.receipt)
        finally:p.unlink()

    def test_deno_lock_and_all_fonts_are_copied_inputs(self):
        for name in ['backend/supabase/functions/deno.lock', 'backend/supabase/functions/deno.json',
                     'frontend/public/fonts/Amiri-Regular.ttf', 'frontend/public/fonts/Carlito-Bold.ttf']:
            self.assertIn(name, self.receipt['source_entries'])
        image_files = {p: v for p, v in self.receipt['image_app_tar_inventory'].items() if v['type'] == 'file'}
        self.assertEqual(set(image_files), {p for p, v in self.receipt['source_entries'].items() if v['type'] == 'file'})
        for name, image_file in image_files.items():
            self.assertEqual(image_file['sha256'], self.receipt['source_entries'][name]['sha256'])
            self.assertEqual((image_file['mode'], image_file['uid'], image_file['gid']), ('0600', 1000, 1000))

    def test_qualification_or_native_receipt_tampering_is_not_reinterpreted(self):
        for name in [q.RECEIPT, *[e['path'] for e in self.receipt['native_evidence']]]:
            with self.subTest(name=name):
                p = self.root / name; original = p.read_bytes()
                try:
                    p.write_bytes(original + b'\n')
                    with self.assertRaises(q.QualificationError):
                        if name == q.RECEIPT: q.load(self.root)
                        else: q.verify_native_receipts(self.root, self.receipt)
                finally: p.write_bytes(original)

    def test_every_runtime_config_field_and_unknown_field_is_bound(self):
        for key in [*self.receipt['qualified_image']['config_without_labels'], 'UnexpectedRuntimeSetting']:
            with self.subTest(key=key):
                value = self.image(); value['Config'][key] = 'MUTATED'
                with self.assertRaisesRegex(q.QualificationError, 'CONFIG'):
                    q.verify_image(value, self.receipt)
        for key in self.receipt['qualified_image']['config_without_labels']:
            with self.subTest(missing=key):
                value = self.image(); del value['Config'][key]
                with self.assertRaisesRegex(q.QualificationError, 'CONFIG'):
                    q.verify_image(value, self.receipt)

    def test_layer_order_count_platform_and_original_id_are_bound(self):
        original = self.image()
        mutations = []
        for layers in [original['RootFS']['Layers'][::-1], original['RootFS']['Layers'][:-1],
                       original['RootFS']['Layers'] + ['sha256:' + 'd'*64]]:
            value = self.image(); value['RootFS']['Layers'] = layers; mutations.append(value)
        for key, wrong in [('Os','other'), ('Architecture','arm64'), ('Variant','v8'), ('Id','sha256:'+'e'*64)]:
            value=self.image();value[key]=wrong;mutations.append(value)
        for value in mutations:
            with self.subTest(value=value.get('Architecture')):
                with self.assertRaises(q.QualificationError): q.verify_image(value,self.receipt)

    def test_only_revision_label_may_change_for_promoted_image(self):
        value=self.image();value['Id']='sha256:'+'c'*64
        value['Config']['Labels'][q.REVISION_LABEL]=REVISION
        q.verify_image(value,self.receipt,REVISION)
        for kind in ['add','remove','change','wrong_revision']:
            bad=copy.deepcopy(value)
            if kind=='add': bad['Config']['Labels']['new']='value'
            if kind=='remove': del bad['Config']['Labels']['org.opencontainers.image.licenses']
            if kind=='change': bad['Config']['Labels']['org.opencontainers.image.licenses']='other'
            if kind=='wrong_revision': bad['Config']['Labels'][q.REVISION_LABEL]='f'*40
            with self.subTest(kind=kind),self.assertRaisesRegex(q.QualificationError,'LABELS'):
                q.verify_image(bad,self.receipt,REVISION)

    def test_publication_never_infers_registry_digest_from_local_id(self):
        with self.assertRaisesRegex(q.QualificationError,'PUBLICATION_PENDING'):q.publication(self.root)
        # An actual historical publication cannot qualify the corrected image.
        path = self.root / q.PUBLICATION
        pending = path.read_bytes()
        try:
            path.write_bytes((ROOT/'backend/docs/evidence/runtime-qualified-publication-20261104.json').read_bytes())
            with self.assertRaisesRegex(q.QualificationError,'PUBLICATION_IDENTITY'):q.publication(self.root)
        finally:
            path.write_bytes(pending)
        for reference in ['runtime:latest','other/runtime@sha256:'+'b'*64,REFERENCE+'\nRUN something']:
            with self.assertRaises(q.QualificationError): q.promotion_dockerfile(reference,REVISION)
        value=self.image();value['RepoDigests']=[]
        with self.assertRaisesRegex(q.QualificationError,'PUBLISHED_DIGEST'):
            q.verify_published(value,REFERENCE,self.receipt)

    def test_promotion_recipe_has_exactly_two_instructions_and_no_source_files(self):
        self.assertEqual(q.promotion_dockerfile(REFERENCE,REVISION),
                         f'FROM {REFERENCE}\nLABEL {q.REVISION_LABEL}={REVISION}\n')
        for revision in ['', 'a'*39, REVISION+'\nCOPY . /app']:
            with self.assertRaises(q.QualificationError): q.promotion_dockerfile(REFERENCE,revision)


if __name__=='__main__': unittest.main()
