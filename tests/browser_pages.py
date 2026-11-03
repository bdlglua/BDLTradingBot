"""Test du site sous /BDLTradingBot/, avec backend HTTPS entièrement fictif."""
import functools
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import expect, sync_playwright
from tools.build_pages import build


def main():
    with tempfile.TemporaryDirectory() as directory:
        build(Path(directory)/'BDLTradingBot', 'https://api.example.com')
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SimpleHTTPRequestHandler, directory=directory))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                token = 'fake-test-only-token-with-32-characters-minimum'
                origin = f'http://127.0.0.1:{server.server_port}'
                def backend(route):
                    requests.append(route.request)
                    assert route.request.headers.get('authorization') == 'Bearer '+token
                    path = route.request.url.removeprefix('https://api.example.com')
                    if path == '/api/session':
                        data = {'csrf_token': 'fake-session'}
                    elif path == '/api/bitpanda/status':
                        data = {'api_key_present': False, 'trading_enabled': False, 'reason': 'Clé API absente.', 'features': {'backtest': False}}
                    elif path == '/api/bitpanda/journal':
                        data = {'orders': []}
                    else:
                        raise AssertionError('Unexpected remote request: '+path)
                    route.fulfill(json=data, headers={'Access-Control-Allow-Origin': origin})
                page.route('https://api.example.com/**', backend)
                page.goto(origin+'/BDLTradingBot/')
                expect(page.locator('#connection-title')).to_have_text('Serveur sécurisé à connecter')
                assert not requests
                assert page.locator('#server-panel').is_visible()
                page.locator('#nav-lab').click(); page.locator('#example').click()
                expect(page.locator('#source')).to_contain_text('synthétique')
                page.locator('#run').click()
                expect(page.locator('#error')).to_contain_text('Connectez votre serveur sécurisé')
                page.locator('#nav-live').click()
                page.locator('#server-token').fill(token)
                page.locator('#server-connect').click()
                expect(page.locator('#server-message')).to_contain_text('Serveur connecté.')
                assert page.locator('#server-token').input_value() == ''
                assert len(requests) == 3
                assert page.evaluate('Object.values(localStorage).length') == 0
                assert page.evaluate('Object.values(sessionStorage).length') == 0
                page.locator('#nav-lab').click()
                assert page.locator('#lab-capability').is_visible()
                assert page.locator('#run').is_disabled()
                page.locator('#nav-live').click()
                page.locator('#server-disconnect').click()
                expect(page.locator('#connection-title')).to_have_text('Serveur déconnecté')
                assert page.locator('#run').is_enabled()
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path='/tmp/bdl-pages-mobile.png', full_page=True)
                assert not errors, errors
                browser.close()
                print('GitHub Pages : sous-chemin, fichiers relatifs, connexion HTTPS fictive, déconnexion et mobile validés.')
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    main()
