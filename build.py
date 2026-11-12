#!/usr/bin/env python3
"""Builds two outputs from src/:
  dist/OwnBooks.html      – ONE file. Double-click to open on any computer. Works offline.
  dist/web/               – same app + offline service worker, for hosting so phones can 'Add to Home Screen'."""
import os, shutil
R = os.path.dirname(os.path.abspath(__file__)); S = os.path.join(R, 'src'); D = os.path.join(R, 'dist')
t = open(f'{S}/index.html').read(); css = open(f'{S}/styles.css').read(); js = open(f'{S}/app.js').read().replace('</script', '<\\/script')
one = t.replace('/*CSS*/', css).replace('/*JS*/', js)
os.makedirs(f'{D}/web', exist_ok=True)
open(f'{D}/OwnBooks.html', 'w').write(one.replace('<!--MANIFEST-->', ''))
open(f'{D}/web/index.html', 'w').write(one.replace('<!--MANIFEST-->', '<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon.svg"><link rel="apple-touch-icon" href="icon.svg">'))
for f in ['sw.js', 'manifest.webmanifest', 'icon.svg']: shutil.copy(f'{S}/{f}', f'{D}/web/{f}')
os.makedirs(f'{D}/bank-bridge', exist_ok=True)
for f in os.listdir(f'{R}/bridge'):
    if f in ('node_modules', 'package-lock.json'): continue
    shutil.copy(f'{R}/bridge/{f}', f'{D}/bank-bridge/{f}')
    if not f.endswith('.bat'): os.chmod(f'{D}/bank-bridge/{f}', 0o755)
print('built', os.path.getsize(f'{D}/OwnBooks.html'), 'bytes')
