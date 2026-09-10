"""Verify the built website's links, anchors, metadata, and bundled release assets."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
import json
import hashlib
import zipfile

SITE = Path(__file__).resolve().parents[1]
BUILD = SITE / 'dist/client'

class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.ids, self.refs, self.duplicates = set(), [], []
        self.h1 = self.titles = 0
        self.canonical = self.description = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            if a['id'] in self.ids:
                self.duplicates.append(a['id'])
            self.ids.add(a['id'])
        if tag == 'h1': self.h1 += 1
        if tag == 'title': self.titles += 1
        if tag == 'link' and a.get('rel') == 'canonical': self.canonical = True
        if tag == 'meta' and a.get('name') == 'description': self.description = bool(a.get('content'))
        for key in ('src', 'href'):
            if a.get(key): self.refs.append(a[key])

pages = {'/' : BUILD / 'index.html', '/docs/': BUILD / 'docs/index.html'}
for doc in json.loads((SITE / 'app/content/docs.json').read_text()):
    pages[f'/docs/{doc["slug"]}/'] = BUILD / 'docs' / doc['slug'] / 'index.html'
parsed = {route: Page(file.read_text()) for route, file in pages.items()}
errors, total = [], 0
for route, page in parsed.items():
    if page.h1 != 1: errors.append(f'{route}: expected one h1, found {page.h1}')
    if page.titles != 1 or not page.canonical or not page.description:
        errors.append(f'{route}: missing or duplicated page metadata')
    if page.duplicates: errors.append(f'{route}: duplicate IDs {page.duplicates}')
    for ref in page.refs:
        url = urlsplit(ref)
        if url.scheme or url.netloc: continue
        total += 1
        target = unquote(url.path) or route
        if not target.startswith('/'):
            target = route + target
        file = BUILD / target.lstrip('/')
        if file.is_dir(): file = file / 'index.html'
        if not file.is_file(): errors.append(f'{route}: missing {ref}')
        if url.fragment:
            target_page = parsed.get(target)
            if target_page and unquote(url.fragment) not in target_page.ids:
                errors.append(f'{route}: missing anchor {ref}')

release = SITE / 'public/downloads/deskfish-0.1.0.vsix'
with zipfile.ZipFile(release) as archive:
    manifest = json.loads(archive.read('extension/package.json'))
    if manifest['version'] != '0.1.0': errors.append('Unexpected extension version')
    if manifest['license'] != 'Apache-2.0': errors.append('Unexpected extension license')
for original, copy in [
    ('deskfish-0.1.0.vsix', 'public/downloads/deskfish-0.1.0.vsix'),
    ('LICENSE', 'public/LICENSE.txt'), ('NOTICE', 'public/NOTICE.txt'),
    ('demo/deskfish-buys-its-domain.mp4', 'public/assets/deskfish-demo.mp4'),
]:
    if hashlib.sha256((SITE.parent / original).read_bytes()).digest() != hashlib.sha256((SITE / copy).read_bytes()).digest():
        errors.append(f'Bundled asset does not match current project: {original}')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'PASS: {len(pages)} pages, {total} local links/assets, headings, anchors, and SEO metadata.')
print('PASS: extension v0.1.0, Apache-2.0 license, NOTICE, and public recording match the project.')
