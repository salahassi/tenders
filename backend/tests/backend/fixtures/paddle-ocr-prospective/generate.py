"""Render pre-authored page gold to image-only PDFs without invoking OCR.

Derived from uploaded-ocr-holdout/generate.py; uses its existing PyMuPDF 1.26.6
and bundled font mechanism. Creates a new output directory; never overwrites
historical fixtures or changes source text in response to recognizer output.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import fitz

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
LATIN = re.compile(r'(\([A-Za-z][A-Za-z0-9/-]*\)|[A-Za-z][A-Za-z0-9/-]*|[0-9]{4}/[0-9]{2}/[0-9]{2}(?: [0-9]{2}:[0-9]{2})?|[0-9]+(?:\.[0-9]+)?)')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def escaped_text(text, direction):
    if direction == 'ltr':
        return html.escape(text)
    # Rendering-only directional markers isolate complete mixed identifiers and
    # dates. They do not enter the frozen logical gold or any OCR result.
    return ''.join('<span dir="ltr" style="font-family:Latin">&#x200E;' + html.escape(part) + '&#x200E;</span>'
                   if index % 2 else html.escape(part)
                   for index, part in enumerate(LATIN.split(text)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--gold-sha256', required=True)
    args = parser.parse_args()
    gold_path = HERE/'gold-manifest.json'
    raw = gold_path.read_bytes()
    assert digest(raw) == args.gold_sha256, 'Authored gold changed before rendering'
    gold = json.loads(raw)
    assert gold['ocr_executed'] is False and gold['recognition_qualified'] is False
    assert fitz.VersionBind == '1.26.6', 'Use the existing exact fixture renderer version'
    for relative, expected in gold['retained_control_source_hashes'].items():
        assert digest((ROOT/relative).read_bytes()) == expected, 'Historical fixture changed'
    for font in gold['fonts'].values():
        assert digest((ROOT/font['path']).read_bytes()) == font['sha256'], 'Pinned font changed'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    outputs = []
    for case in gold['cases']:
        native = fitz.open()
        page = native.new_page(width=case['page_size_pt'][0], height=case['page_size_pt'][1])
        for graphic in case['graphics']:
            assert graphic['kind'] == 'line'
            page.draw_line(graphic['from_pt'], graphic['to_pt'], color=(graphic['gray'],)*3, width=graphic['width_pt'])
        fits = []
        for block in case['blocks']:
            font = 'Arabic' if block['direction'] == 'rtl' else 'Latin'
            style = '''@font-face {font-family:Arabic;src:url(Amiri-Regular.ttf)}
            @font-face {font-family:Latin;src:url(Carlito-Regular.ttf)}
            body {font-family:%s;font-size:%spt;line-height:%s;direction:%s;text-align:%s;margin:0;padding:0}
            p {margin:0;padding:0;direction:%s;text-align:%s}''' % (
                font, block['font_size_pt'], block['line_height'], block['direction'],
                'right' if block['direction']=='rtl' else 'left', block['direction'],
                'right' if block['direction']=='rtl' else 'left')
            content = '<p dir="' + block['direction'] + '">' + escaped_text(block['text'], block['direction']) + '</p>'
            spare, scale = page.insert_htmlbox(fitz.Rect(block['rect_pt']), content, css=style,
                archive=fitz.Archive(str(ROOT/'frontend/public/fonts')), scale_low=1)
            assert spare >= 0 and scale == 1, 'Frozen block does not fit: ' + case['id'] + '/' + block['id']
            fits.append({'block_id':block['id'],'available_height_pt':spare,'scale':scale})
        pixels = page.get_pixmap(matrix=fitz.Matrix(case['scan_dpi']/72, case['scan_dpi']/72), colorspace=fitz.csGRAY, alpha=False)
        assert [pixels.width,pixels.height] == case['raster_size_px']
        assert max(pixels.width,pixels.height) <= 2000
        png = pixels.tobytes('png')
        (output/case['png_filename']).write_bytes(png)
        scan = fitz.open()
        scanned = scan.new_page(width=case['page_size_pt'][0],height=case['page_size_pt'][1])
        scanned.insert_image(scanned.rect,stream=png)
        scan.set_metadata({'title':'Synthetic prospective OCR page','producer':'PyMuPDF 1.26.6'})
        target=output/case['filename']
        scan.save(target,garbage=4,deflate=True,no_new_id=True)
        scan.close(); native.close()
        with fitz.open(target) as check:
            assert check.page_count == 1 and not check[0].get_text() and not check[0].get_texttrace()
            assert not check[0].get_fonts(full=True) and len(check[0].get_images(full=True)) == 1
            assert check.embfile_count() == 0 and not list(check[0].annots() or []) and not check[0].get_links()
        if not case['blocks']:
            assert set(pixels.samples) == {255}, 'Blank control is not uniformly white'
        outputs.append({'id':case['id'],'pdf':case['filename'],'pdf_bytes':target.stat().st_size,
            'pdf_sha256':digest(target.read_bytes()),'png':case['png_filename'],'png_sha256':digest(png),
            'raster_size_px':[pixels.width,pixels.height],'scan_dpi':case['scan_dpi'],
            'image_objects':1,'hidden_text_characters':0,'texttrace_entries':0,'font_resources':0,
            'embedded_files':0,'annotations':0,'links':0,'blocks_fit_without_shrinking':fits})
    assert gold_path.read_bytes() == raw, 'Authored gold changed during rendering'
    assert all(digest((ROOT/name).read_bytes()) == value for name,value in gold['retained_control_source_hashes'].items())
    receipt={'version':1,'scope':'fixture_preparation_only_before_ocr','gold_manifest_sha256':digest(raw),
        'generator_sha256':digest(Path(__file__).read_bytes()),'pymupdf_version':fitz.VersionBind,
        'fonts':gold['fonts'],'gold_source_unchanged':True,'all_historical_control_sources_unchanged':True,
        'files':outputs,'ocr_executed':False,'recognition_qualified':False,'provider_calls':0,
        'production_changes':0,'native_capacity_measurement':False}
    (output/'render-manifest.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'output':str(output),'gold_sha256':digest(raw),'pages':len(outputs),'ocr_executed':False}))


if __name__ == '__main__':
    main()
