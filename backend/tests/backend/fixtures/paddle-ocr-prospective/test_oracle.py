"""Pre-output oracle controls; no engine import, image processing, or OCR."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
spec = importlib.util.spec_from_file_location('prospective_oracle', HERE/'oracle.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
GOLD = json.loads((HERE/'gold-manifest.json').read_text())


class ProspectiveGoldTests(unittest.TestCase):
    def test_declared_page_and_critical_spans_are_complete_and_ordered(self):
        self.assertEqual(len(GOLD['cases']), 6)
        self.assertEqual(len(GOLD['retained_controls']), 7)
        for case in GOLD['cases']:
            blocks = {b['id']:b for b in case['blocks']}
            self.assertEqual(len(blocks), len(case['blocks']))
            self.assertEqual(set(blocks), set(case['reading_order']))
            self.assertEqual(case['expected_text'], '\n'.join(blocks[b]['text'] for b in case['reading_order']))
            for block in blocks.values():
                x0,y0,x1,y1 = block['rect_pt']
                self.assertTrue(0 <= x0 < x1 <= 595 and 0 <= y0 < y1 <= 842)
            for fact in case['critical_facts']:
                source = '\n'.join(blocks[b]['text'] for b in fact['block_ids'])
                span = fact['source_quote_codepoint_span']
                self.assertEqual(source[span['start']:span['end']], fact['exact_quote'])
                self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), fact['source_block_text_sha256'])

    def test_all_seven_historical_controls_and_source_hashes_are_unchanged(self):
        for row in GOLD['retained_controls']:
            self.assertEqual(hashlib.sha256((ROOT/row['path']).read_bytes()).hexdigest(), row['sha256'])
        for name, expected in GOLD['retained_control_source_hashes'].items():
            self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(), expected)

    def test_only_declared_whitespace_and_nfc_equivalence_are_accepted(self):
        self.assertTrue(oracle.exact_page(' a\r\n b\t ', 'a b'))
        self.assertTrue(oracle.exact_page('e\u0301', 'é'))
        for actual, expected in [('850','0.850'),('34,000','34.000'),('40','٤٠'),
                                 ('INCB4/27','INC-B4/27'),('2028/17/09','2028/09/17'),
                                 ('06:45','06.45'),('ﻻ','لا'),('\u200fلا','لا'),('نعم','لا')]:
            with self.subTest(actual=actual, expected=expected):
                self.assertFalse(oracle.exact_page(actual, expected))

    def test_missing_negation_and_changed_decimals_are_rejected(self):
        for case in GOLD['cases']:
            text = case['expected_text']
            for original, changed in [('لا يجوز','يجوز'),('لا تستحق','تستحق'),('لا يؤجل','يؤجل'),
                                      ('لا يبدأ','يبدأ'),('Do not replace','Do replace'),
                                      ('0.850','850'),('34.000','34000')]:
                if original in text:
                    with self.subTest(page=case['id'], mutation=changed):
                        self.assertFalse(oracle.exact_page(text.replace(original,changed,1),text))

    def test_column_interleaving_and_table_identifier_swaps_are_rejected(self):
        page = next(p for p in GOLD['cases'] if p['id']=='a06-04-right-column-first')
        blocks = {b['id']:b['text'] for b in page['blocks']}
        wrong = '\n'.join(blocks[b] for b in ['heading','right-1','left-3','right-2','left-4','footer'])
        self.assertFalse(oracle.exact_page(wrong,page['expected_text']))
        page = next(p for p in GOLD['cases'] if p['id']=='a06-05-mixed-table')
        wrong = page['expected_text'].replace('API-READ-5','TEMP-ID').replace('LOG-AUD-8','API-READ-5').replace('TEMP-ID','LOG-AUD-8')
        self.assertFalse(oracle.exact_page(wrong,page['expected_text']))

    def test_blank_requires_no_visible_characters(self):
        page = GOLD['cases'][-1]
        self.assertEqual(page['expected_text'],'')
        self.assertEqual(page['blocks'],[])
        self.assertEqual(page['graphics'],[])
        self.assertTrue(oracle.exact_page('\t\r\n ',''))
        self.assertFalse(oracle.exact_page('.', ''))
        self.assertFalse(oracle.exact_page('blank', ''))


if __name__ == '__main__':
    unittest.main()
