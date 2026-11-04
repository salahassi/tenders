"""Prepare frozen synthetic Arabic image-only OCR holdouts; never run OCR.

The input gold-manifest.json must already exist. Its bytes are read once before
any rendering, and its digest is checked again before the receipt is written.
Only output-local files are created. No production or recognition code is used.
"""
from pathlib import Path
import hashlib
import html
import json
import re
import shutil
import fitz

HERE = Path(__file__).resolve().parent
REFERENCE = Path('/workspace/work/reliability-arabic-ocr/backend/tests/backend/fixtures/uploaded-ocr/generate.py')
FONT_SOURCES = {
    'Amiri-Regular.ttf': Path('/workspace/work/reliability-arabic-ocr/frontend/public/fonts/Amiri-Regular.ttf'),
    'Carlito-Regular.ttf': Path('/workspace/work/reliability-arabic-ocr/frontend/public/fonts/Carlito-Regular.ttf'),
    'NotoNaskhArabic-Regular.ttf': Path('/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf'),
    'NotoSansArabic-Regular.ttf': Path('/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf'),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def logical_html(text):
    # Isolate Latin identifiers and numeric dates without changing gold content.
    pieces = re.split(r'([A-Z]+(?:-[A-Z0-9]+)+|[0-9]{4}[-/][0-9]{2}[-/][0-9]{2})', text)
    return ''.join(
        '<span dir="ltr" style="font-family:Latin">&#x200E;' + html.escape(piece) + '&#x200E;</span>'
        if index % 2 else html.escape(piece)
        for index, piece in enumerate(pieces)
    )


def main():
    gold_path = HERE / 'gold-manifest.json'
    gold_bytes = gold_path.read_bytes()
    gold_sha = digest(gold_bytes)
    gold = json.loads(gold_bytes)
    assert gold['recognition_run'] is False
    assert gold['recognition_qualification'] is False
    fonts = HERE / 'fonts'
    fonts.mkdir(exist_ok=True)
    for name, source in FONT_SOURCES.items():
        shutil.copyfile(source, fonts / name)
    outputs = []
    for case in gold['cases']:
        target = HERE / case['filename']
        if target.exists():
            raise RuntimeError('Refusing to overwrite a frozen holdout PDF: ' + target.name)
        native = fitz.open()
        page = native.new_page(width=595, height=842)
        rules = 'border-bottom:0.5pt solid #b0b0b0;padding-bottom:8pt;' if case['id'] == 'records-retention' else ''
        border = 'border:1pt solid #777;padding:14pt;' if case['id'] == 'sensor-acceptance' else ''
        style = '''@font-face {font-family:Arabic;src:url(%s)}
        @font-face {font-family:Latin;src:url(Carlito-Regular.ttf)}
        body {font-family:Arabic;direction:rtl;text-align:right;font-size:%spt;line-height:%s}
        h1 {font-size:25pt;font-weight:normal;margin:0 0 20pt 0;text-align:right;direction:rtl}
        p {margin:0 0 15pt 0;text-align:right;direction:rtl;%s}
        .notice {text-align:right;direction:rtl;%s}''' % (case['font'], case['font_size_pt'], case['line_height'], rules, border)
        content = '<div dir="rtl" class="notice"><h1>' + logical_html(case['heading']) + '</h1>'
        content += ''.join('<p>' + logical_html(line) + '</p>' for line in case['lines']) + '</div>'
        spare, scale = page.insert_htmlbox(fitz.Rect(42, 44, 553, 798), content, css=style, archive=fitz.Archive(str(fonts)), scale_low=1)
        assert spare >= 0 and scale == 1, 'Holdout text must fit without automatic shrinking'
        assert page.get_text().strip(), 'Native rendering source must contain text'
        pixels = page.get_pixmap(matrix=fitz.Matrix(case['scan_dpi'] / 72, case['scan_dpi'] / 72), colorspace=fitz.csGRAY, alpha=False)
        png = pixels.tobytes('png')
        (HERE / (case['id'] + '-preview.png')).write_bytes(png)
        scan = fitz.open()
        scan_page = scan.new_page(width=595, height=842)
        scan_page.insert_image(scan_page.rect, stream=png)
        scan.set_metadata({'title': 'Synthetic Arabic OCR holdout', 'producer': 'PyMuPDF ' + fitz.VersionBind})
        scan.save(target, garbage=4, deflate=True, no_new_id=True)
        scan.close()
        native.close()
        with fitz.open(target) as check:
            assert check.page_count == 1
            scanned = check[0]
            assert scanned.get_text() == '', 'Scan contains extractable hidden text'
            assert scanned.get_texttrace() == [], 'Scan contains hidden text drawing operators'
            assert scanned.get_fonts(full=True) == [], 'Scan retains font resources'
            assert len(scanned.get_images(full=True)) == 1
            assert check.embfile_count() == 0, 'Scan contains embedded source data'
            assert not list(scanned.annots() or []), 'Scan contains annotations'
        raw = target.read_bytes()
        outputs.append({
            'id': case['id'], 'path': str(target), 'filename': target.name,
            'sha256': digest(raw), 'bytes': len(raw), 'pages': 1,
            'raster_size_pixels': [pixels.width, pixels.height], 'scan_dpi': case['scan_dpi'],
            'raster_sha256': digest(png), 'hidden_text_characters': 0,
            'texttrace_entries': 0, 'font_resources': 0, 'image_objects': 1,
            'embedded_files': 0, 'annotations': 0,
        })
    assert gold_path.read_bytes() == gold_bytes, 'Frozen gold changed during preparation'
    receipt = {
        'version': 1, 'scope': gold['scope'], 'synthetic': True,
        'gold_manifest': str(gold_path), 'gold_manifest_sha256': gold_sha,
        'gold_frozen_before_rendering': True, 'generator_sha256': digest(Path(__file__).read_bytes()),
        'pymupdf_version': fitz.VersionBind, 'reference_generator_path': str(REFERENCE),
        'reference_generator_sha256': digest(REFERENCE.read_bytes()),
        'fonts': {name: {'source': str(source), 'sha256': digest((fonts / name).read_bytes())} for name, source in FONT_SOURCES.items()},
        'files': outputs, 'recognition_run': False, 'recognition_qualification': False,
        'external_calls': 0, 'tracked_source_edits': 0,
        'limits': 'Preparation and image-only structure checks only; no OCR, recognition accuracy, native extraction or hosted acceptance evidence.',
    }
    (HERE / 'manifest.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'gold_sha256': gold_sha, 'files': outputs, 'recognition_run': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
