"""Construit uniquement les fichiers publics pour GitHub Pages."""
import hashlib
import json
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = ('index.html', 'style.css', 'app.js', 'config.js', 'favicon.svg', 'examples/prices.csv', '.nojekyll')


def build(destination, api_url=''):
    if api_url:
        parsed = urlsplit(api_url)
        if parsed.scheme != 'https' or parsed.netloc != parsed.hostname or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('DASHBOARD_API_URL doit être une adresse HTTPS sans chemin ni identifiants.')
        api_url = parsed.scheme + '://' + parsed.netloc
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError('Le dossier de sortie ne peut pas être un lien symbolique.')
    if destination.exists():
        known = set(PUBLIC_FILES) | {'.bdl-pages-build'}
        files = {str(path.relative_to(destination)) for path in destination.rglob('*') if path.is_file() or path.is_symlink()}
        if not (destination / '.bdl-pages-build').is_file() or files - known:
            raise ValueError('Le dossier de sortie contient des fichiers étrangers : construction interrompue.')
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for name in ('style.css', 'app.js', 'favicon.svg'):
        shutil.copyfile(ROOT / 'static' / name, destination / name)
    config = {'apiBaseUrl': api_url, 'hosted': True}
    (destination / 'config.js').write_text('window.BDL_CONFIG = Object.freeze(' + json.dumps(config) + ');\n')
    # Cache busting: each publication references assets by content hash, so
    # browsers fetch the new CSS/JS instead of an outdated cached copy.
    page = (ROOT / 'static' / 'index.html').read_text()
    for name in ('style.css', 'config.js', 'app.js', 'favicon.svg'):
        reference = f'"./{name}"'
        if reference not in page:
            raise ValueError(f'Référence {reference} introuvable dans index.html.')
        version = hashlib.sha256((destination / name).read_bytes()).hexdigest()[:12]
        page = page.replace(reference, f'"./{name}?v={version}"')
    (destination / 'index.html').write_text(page)
    (destination / 'examples').mkdir()
    shutil.copyfile(ROOT / 'examples' / 'prices.csv', destination / 'examples' / 'prices.csv')
    (destination / '.nojekyll').touch()
    (destination / '.bdl-pages-build').write_text('public-assets-only\n')


if __name__ == '__main__':
    build(ROOT / '_site', os.environ.get('DASHBOARD_API_URL', ''))
    print('Site construit dans _site (fichiers publics uniquement).')
