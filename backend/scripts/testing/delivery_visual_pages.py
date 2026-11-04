#!/usr/bin/env python3
"""Render synthetic DOCX fixtures and bind every PDF/page to its input hash.

This does not certify visual quality automatically. Inspect all contact sheets
and relevant full pages, then record the review separately from these metrics.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile
import fitz
from PIL import Image, ImageDraw

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def run(repository,output):
 if (output/'page-receipt.json').exists():raise RuntimeError('Choose a fresh output directory; existing qualification evidence is immutable')
 receipt=json.loads((output/'render-receipt.json').read_text());pdfdir=output/'pdf';pages=output/'pages';sheets=output/'contact-sheets'
 for directory in (pdfdir,pages,sheets,output/'font-cache'):directory.mkdir(exist_ok=True,mode=0o700)
 fontconfig=output/'fonts.conf'
 fontconfig.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>'+str(repository/'frontend/public/fonts')+'</dir><cachedir>'+str(output/'font-cache')+'</cachedir></fontconfig>')
 env={**os.environ,'FONTCONFIG_FILE':str(fontconfig)}
 subprocess.run(['fc-cache','-f',str(repository/'frontend/public/fonts')],env=env,capture_output=True,check=True,timeout=60)
 fonts={name:subprocess.check_output(['fc-match',name],env=env,text=True).strip() for name in ('Amiri','Carlito')}
 if any(name not in fonts[name] for name in fonts):raise RuntimeError('Bundled font family unavailable')
 conversion=subprocess.run(['soffice','-env:UserInstallation='+str((output/'lo-profile').as_uri()),'--headless','--convert-to','pdf','--outdir',str(pdfdir),*[str(output/(row['file']+'.docx')) for row in receipt['documents']]],env=env,capture_output=True,text=True,timeout=300)
 (output/'libreoffice-conversion.log').write_text(conversion.stdout+conversion.stderr)
 if conversion.returncode:raise RuntimeError('LibreOffice conversion failed')
 version=subprocess.check_output(['soffice','--version'],text=True).strip()
 rows=[];W={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 for item in receipt['documents']:
  name=item['file'];docx=output/(name+'.docx');pdf=pdfdir/(name+'.pdf')
  if digest(docx)!=item['docx_sha256'] or not pdf.is_file():raise RuntimeError('Input changed or PDF missing')
  with zipfile.ZipFile(docx) as archive:
   xml=ET.fromstring(archive.read('word/document.xml'));settings=ET.fromstring(archive.read('word/settings.xml'))
   fields=[node.text or '' for node in xml.findall('.//w:instrText',W)]
   footer_fields=[node.text or '' for key in archive.namelist() if key.startswith('word/footer') and key.endswith('.xml') for node in ET.fromstring(archive.read(key)).findall('.//w:instrText',W)]
   headings=len(xml.findall('.//w:pStyle[@w:val="Heading1"]',W));yellow=len(xml.findall('.//w:highlight[@w:val="yellow"]',W))
   if not any('TOC' in field for field in fields) or not any('PAGE' in field for field in footer_fields) or not headings or not yellow or settings.find('.//w:updateFields',W) is None:raise RuntimeError('Required document fields/heading/highlight missing')
  document=fitz.open(pdf);page_rows=[];all_text=[]
  for index,page in enumerate(document):
   filename=f'{name}-{index+1:03}.png';path=pages/filename
   pix=page.get_pixmap(matrix=fitz.Matrix(1.4,1.4),alpha=False);pix.save(path)
   text=page.get_text();all_text.append(text)
   spans=[span for block in page.get_text('dict')['blocks'] if block.get('type')==0 for line in block.get('lines',[]) for span in line['spans']]
   outside=[span['bbox'] for span in spans if span['text'].strip() and (span['bbox'][0]<-1 or span['bbox'][1]<-1 or span['bbox'][2]>page.rect.width+1 or span['bbox'][3]>page.rect.height+1)]
   page_rows.append({'page':index+1,'png':str(path.relative_to(output)),'sha256':digest(path),'width_pt':page.rect.width,'height_pt':page.rect.height,'text_characters':len(text),'text_sha256':hashlib.sha256(text.encode()).hexdigest(),'text_outside_page':outside})
  (pdfdir/(name+'.txt')).write_text('\n\f\n'.join(all_text))
  font_report=subprocess.check_output(['pdffonts',str(pdf)],text=True)
  (pdfdir/(name+'.fonts.txt')).write_text(font_report)
  contacts=[]
  for offset in range(0,len(page_rows),6):
   group=page_rows[offset:offset+6];tile_w,tile_h=575,845
   sheet=Image.new('RGB',(tile_w*3,tile_h*2),'#ddd');draw=ImageDraw.Draw(sheet)
   for pos,row in enumerate(group):
    picture=Image.open(output/row['png']);picture.thumbnail((tile_w-16,tile_h-45))
    x=(pos%3)*tile_w;y=(pos//3)*tile_h
    sheet.paste(picture,(x+(tile_w-picture.width)//2,y+30));draw.text((x+10,y+8),f"{name} / {row['page']}",fill='black')
   path=sheets/f'{name}-{offset//6+1:02}.png';sheet.save(path)
   contacts.append({'file':str(path.relative_to(output)),'sha256':digest(path),'pages':[row['page'] for row in group]})
  rows.append({**item,'pdf':str(pdf.relative_to(output)),'pdf_sha256':digest(pdf),'page_count':len(page_rows),'ooxml_heading_count':headings,'ooxml_yellow_run_count':yellow,'toc_field_present':True,'page_field_present':True,'update_fields_enabled':True,'pdf_font_report_sha256':digest(pdfdir/(name+'.fonts.txt')),'pages':page_rows,'contact_sheets':contacts})
 report={'version':1,'source_hash':receipt['source_hash'],'render_receipt_sha256':digest(output/'render-receipt.json'),'libreoffice_version':version,'font_matches':fonts,'synthetic_layout_only':True,'visual_review_performed':False,'microsoft_word_tested':False,'documents':rows}
 (output/'page-receipt.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'documents':len(rows),'pages':sum(r['page_count'] for r in rows),'outside_page_spans':sum(len(p['text_outside_page']) for r in rows for p in r['pages']),'page_counts':{r['file']:r['page_count'] for r in rows},'libreoffice_version':version}))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('repository',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args();run(args.repository.resolve(),args.output.resolve())
