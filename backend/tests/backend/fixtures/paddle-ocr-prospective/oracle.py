"""Frozen strict whole-page comparison; no recognition or output correction."""
import re
import unicodedata

VERSION = 'a06-strict-nfc-whitespace-v1'


def normalize(text):
    value = unicodedata.normalize('NFC', text).replace('\r\n', '\n').replace('\r', '\n')
    return re.sub(r'\s+', ' ', value).strip()


def exact_page(actual, expected):
    return normalize(actual) == normalize(expected)
