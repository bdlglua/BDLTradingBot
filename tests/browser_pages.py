"""Test du site sous /BDLTradingBot/, avec backend HTTPS entièrement fictif.

Nécessite Playwright (Python) et Chromium ; CHROMIUM_PATH peut désigner le binaire.
"""
import functools
import os
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import expect, sync_playwright
from tools.build_pages import build

SHOTS = Path(os.environ.get('SCREENSHOT_DIR', '/tmp'))


def main():
    with tempfile.TemporaryDirectory() as directory:
        build(Path(directory)/'BDLTradingBot', 'https://api.example.com')
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SimpleHTTPRequestHandler, directory=directory))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                path = os.environ.get('CHROMIUM_PATH')
                browser = playwright.chromium.launch(**({'executable_path': path} if path else {}), headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                token = 'fake-test-only-token-with-32-characters-minimum'
                origin = f'http://127.0.0.1:{server.server_port}'
                journal_available = {'value': False}

                def backend(route):
                    requests.append(route.request)
                    assert route.request.headers.get('authorization') == 'Bearer '+token
                    path = route.request.url.removeprefix('https://api.example.com')
                    status = 200
                    if path == '/api/session':
                        data = {'csrf_token': 'fake-session'}
                    elif path == '/api/bitpanda/status':
                        data = {'api_key_present': True, 'trading_enabled': False, 'reason': 'Base D1 persistante non connectée.',
                                'journal_available': False, 'features': {'backtest': False, 'reconcile': True}}
                    elif path == '/api/bitpanda/journal':
                        status, data = 503, {'error': 'Base D1 persistante non connectée.'}
                    elif path in ('/api/bitpanda/currencies', '/api/bitpanda/holdings'):
                        data = {'result': []}
                    else:
                        raise AssertionError('Unexpected remote request: '+path)
                    route.fulfill(status=status, json=data, headers={'Access-Control-Allow-Origin': origin})
                page.route('https://api.example.com/**', backend)
                page.goto(origin+'/BDLTradingBot/')
                expect(page.locator('#connection-label')).to_have_text('Non connecté')
                assert page.locator('#onboarding').is_visible()
                assert not requests
                page.locator('.nav[data-view="lab"]').click()
                page.locator('#example').click()
                expect(page.locator('#source')).to_contain_text('synthétique')
                page.locator('#run').click()
                expect(page.locator('#error')).to_contain_text('Connectez votre serveur sécurisé')

                # Premier déploiement sans base D1 : la connexion et la lecture du compte doivent réussir.
                page.locator('.nav[data-view="settings"]').click()
                expect(page.locator('#server-url')).to_have_value('https://api.example.com')
                page.locator('#server-token').fill(token)
                page.locator('#server-connect').click()
                expect(page.locator('#server-message')).to_contain_text('compte Bitpanda lu')
                assert page.locator('#server-token').input_value() == ''
                expect(page.locator('[data-check="journal"]')).to_have_attribute('data-state', 'error')
                expect(page.locator('[data-check="account"]')).to_have_attribute('data-state', 'ok')
                expect(page.locator('#connection-label')).to_have_text('Lecture seule')
                assert page.evaluate('Object.values(localStorage).length') == 0
                assert page.evaluate('Object.values(sessionStorage).length') == 0
                page.screenshot(path=str(SHOTS / 'bdl-pages-settings.png'), full_page=True)
                page.locator('.nav[data-view="history"]').click()
                expect(page.locator('#journal-status')).to_contain_text('D1')
                page.locator('.nav[data-view="lab"]').click()
                assert page.locator('#lab-capability').is_visible()
                assert page.locator('#run').is_disabled()
                page.locator('.nav[data-view="settings"]').click()
                page.locator('#server-disconnect').click()
                expect(page.locator('#connection-label')).to_have_text('Déconnecté')
                assert page.locator('#run').is_enabled()
                page.set_viewport_size({'width': 390, 'height': 844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path=str(SHOTS / 'bdl-pages-mobile.png'), full_page=True)
                assert not errors, errors
                browser.close()
                print('GitHub Pages : sous-chemin, connexion HTTPS fictive sans D1, déconnexion et mobile validés.')
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    main()
