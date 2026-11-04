"""Rebuild public, synthetic OCR fixtures with PyMuPDF 1.26.6 and bundled fonts.

Gold obligations are authored before OCR and never derived from engine output.
The committed PDFs are the acceptance inputs; regeneration changes their hash.
"""
from pathlib import Path
import hashlib
import json
import fitz

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
FONTS = ROOT / 'frontend/public/fonts'
GOLD = {
    'en': [
        'The supplier must deliver 12 reports within 30 days.',
        'Payment is SAR 12500 after acceptance.',
        'The submission deadline is 2026-12-15.',
        'Subcontracting is prohibited without written approval.',
    ],
    'ar': [
        'يجب على المورد تسليم 12 تقريرا خلال 30 يوما.',
        'الدفع بقيمة 12500 ريال بعد القبول.',
        'الموعد النهائي للتقديم هو 15 ديسمبر 2026.',
        'يمنع التعاقد من الباطن دون موافقة خطية.',
    ],
}


def native(language):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    style = '''@font-face {font-family: Arabic;src:url(Amiri-Regular.ttf)}
    @font-face {font-family: Latin;src:url(Carlito-Regular.ttf)}
    body {font-family: Latin,Arabic; font-size:22pt; line-height:1.8}
    .ar {font-family:Arabic; direction:rtl; text-align:right}
    p {margin:18pt 0}'''
    html = '<div class="' + language + '">' + ''.join('<p>' + line + '</p>' for line in GOLD[language]) + '</div>'
    spare, _ = page.insert_htmlbox(fitz.Rect(40, 45, 555, 780), html,
                                 css=style, archive=fitz.Archive(str(FONTS)))
    assert spare >= 0, 'Fixture text does not fit'
    return doc


def scan(language):
    doc = native(language)
    pixels = doc[0].get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
    result = fitz.open()
    page = result.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=pixels.tobytes('png'))
    assert not page.get_text().strip(), 'A scan must not contain a hidden text layer'
    return result


def save(doc, name):
    doc.set_metadata({'title': 'Synthetic OCR acceptance fixture', 'producer': 'PyMuPDF 1.26.6'})
    doc.save(HERE / name, garbage=4, deflate=True, no_new_id=True)


for language in GOLD:
    save(scan(language), 'scanned-' + language + '.pdf')
mixed = fitz.open()
for index in range(1, 6):
    if index == 3:
        mixed.insert_pdf(scan('en'))
    else:
        page = mixed.new_page(width=595, height=842)
        if index != 5:
            page.insert_text((45, 75), f'Native page {index}. Preserve this original text and page identity.', fontsize=16)
save(mixed, 'mixed-five-pages.pdf')
manifest = {
    'version': 1,
    'synthetic': True,
    'generator': 'PyMuPDF 1.26.6; bundled Amiri and Carlito fonts',
    'recognition_oracle': GOLD,
    'mixed': {'native_pages': [1, 2, 4], 'scan_page': 3, 'blank_page': 5},
    'files': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(HERE.glob('*.pdf'))},
}
(HERE / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
