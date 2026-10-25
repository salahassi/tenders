#!/usr/bin/env python3
"""Keep the old bookmark as a redirect to the verified Kubernetes frontend."""
import html
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

origin = (Path(__file__).with_name("public-origin.txt")).read_text().strip()
url = urlsplit(origin)
if (url.scheme != "https" or not url.hostname or url.username or url.password
    or url.port not in (None, 443) or url.path not in ("", "/") or url.query or url.fragment
    or not re.fullmatch(r"[a-z0-9.-]+", url.hostname) or ".." in url.hostname):
    raise SystemExit("A verified HTTPS application origin is required.")
target = "https://" + url.hostname + "/"
markup = """<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=%s">
<link rel="canonical" href="%s"><title>TenderDesk</title></head>
<body><p>انتقل التطبيق إلى عنوانه الجديد.</p><a href="%s">فتح التطبيق</a>
<script>location.replace(%s);</script></body></html>
""" % (html.escape(target, quote=True), html.escape(target, quote=True),
       html.escape(target, quote=True), json.dumps(target))
directory = Path(__file__).resolve().parents[1] / "dist"
if directory.exists():
    shutil.rmtree(directory)
directory.mkdir()
for name in ("index.html", "404.html"):
    (directory / name).write_text(markup)
print("The previous application URL now redirects to its verified HTTPS origin.")
