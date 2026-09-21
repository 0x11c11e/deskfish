"""Verify the built website's links, anchors, metadata, and release links and bundled media."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
import json
import hashlib

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
        for key in ('src', 'href', 'poster'):
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

# Downloads use stable GitHub URLs and work on any static host. Vercel keeps old links alive.
release_root = 'https://github.com/0x11c11e/deskfish/releases/latest/download/'
assets = {
    'Deskfish-linux-x86_64.AppImage', 'Deskfish-linux-amd64.deb',
    'Deskfish-mac-universal.dmg', 'Deskfish-windows-x64-setup.exe',
    'deskfish.vsix', 'deskfish.tgz',
}
home = parsed['/']
for name in assets:
    if release_root + name not in home.refs:
        errors.append(f'Missing release download: {name}')
redirects = json.loads((SITE / 'vercel.json').read_text())['redirects']
for name in assets:
    if not any(r['source'] == '/downloads/' + name and r['destination'] == release_root + name
               for r in redirects):
        errors.append(f'Missing download redirect: {name}')
for original, copy in [
    ('LICENSE', 'public/LICENSE.txt'), ('NOTICE', 'public/NOTICE.txt'),
    ('demo/deskfish-buys-its-domain.mp4', 'public/assets/films/domain.mp4'),
    ('demo/deskfish-writes-a-post.mp4', 'public/assets/films/post.mp4'),
    ('demo/deskfish-prices-a-trip.mp4', 'public/assets/films/trip.mp4'),
    ('docker/desktop/wallpaper.svg', 'public/assets/tank-wallpaper.svg'),
]:
    source, bundled = SITE.parent / original, SITE / copy
    if not source.is_file() or not bundled.is_file():
        errors.append(f'Missing source or bundled asset: {original}')
    elif hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(bundled.read_bytes()).digest():
        errors.append(f'Bundled asset does not match current project: {original}')
source_slugs = {p.stem for p in (SITE.parent / 'docs').glob('*.md')}
published_slugs = {p['slug'] for p in json.loads((SITE / 'app/content/docs.json').read_text())}
if source_slugs != published_slugs:
    errors.append('Published documentation does not include every project guide')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'PASS: {len(pages)} pages, {total} local links/assets, headings, anchors, and SEO metadata.')
print('PASS: six release downloads and redirects, complete guide set, license, NOTICE, wallpaper, and three recordings.')
