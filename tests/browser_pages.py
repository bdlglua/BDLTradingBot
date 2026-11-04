"""Test du site sous /BDLTradingBot/, avec backend HTTPS entièrement fictif."""
import functools
import sys
import tempfile
import threading
import zipfile
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
                page = browser.new_page(viewport={'width': 1440, 'height': 1000},accept_downloads=True)
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                token = 'fake-test-only-token-with-32-characters-minimum'
                origin = f'http://127.0.0.1:{server.server_port}'
                auto_state={'settings':{},'strategy':None,'enabled':False,'server_enabled':False,'trading_allowed':False,'points':0,'runs':[],'notes':[],'research':None,'revision':1}
                asset='11111111-1111-4111-8111-111111111111'
                def backend(route):
                    requests.append(route.request)
                    assert route.request.headers.get('authorization') == 'Bearer '+token
                    path = route.request.url.removeprefix('https://api.example.com')
                    if path == '/api/session':
                        data = {'csrf_token': 'fake-session'}
                    elif path == '/api/bitpanda/status':
                        data = {'api_key_present': False, 'trading_enabled': False, 'reason': 'Clé API absente.', 'features': {'backtest': False,'automation':True}}
                    elif path == '/api/bitpanda/journal':
                        data = {'orders': []}
                    elif path == '/api/automation/state':
                        data=auto_state
                    elif path.startswith('/api/bitpanda/assets?'):
                        data={'result':{'data':[{'id':asset,'symbol':'BTC','type':'CRYPTO'}]}}
                    elif path == '/api/automation/config':
                        auto_state['settings']=route.request.post_data_json
                        auto_state['revision']+=1
                        data=auto_state
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
                page.locator('#nav-auto').click()
                expect(page.locator('#auto-status')).to_have_text('Ordres automatiques en pause')
                assert page.locator('#auto-amount').input_value()==''
                assert page.locator('#auto-daily').input_value()==''
                assert page.locator('#auto-enable').is_disabled()
                page.locator('#auto-symbol').fill('BTC');page.locator('#auto-search').click()
                page.locator('#auto-asset').select_option(asset)
                page.locator('#auto-amount').fill('10');page.locator('#auto-daily').fill('50');page.locator('#auto-fee').fill('0.1')
                page.locator('#auto-save').click()
                expect(page.locator('#auto-status-detail')).to_contain_text('collecte doit être autorisée')
                assert auto_state['settings']['order_amount']=='10'
                assert auto_state['enabled'] is False
                page.locator('#auto-consent').check();assert page.locator('#auto-enable').is_disabled()
                assert not any('/api/automation/enable' in request.url for request in requests)
                with page.expect_download() as download_info:
                    page.get_by_text('Télécharger le coffre Obsidian').click()
                download=download_info.value;destination=Path(directory)/'vault.zip';download.save_as(destination)
                with zipfile.ZipFile(destination) as archive:
                    assert 'Coffre-BDLTradingBot/.obsidian/plugins/bdltradingbot/main.js' in archive.namelist()
                page.screenshot(path='/tmp/bdl-automation-desktop.png',full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path='/tmp/bdl-automation-mobile.png',full_page=True)
                page.set_viewport_size({'width':1440,'height':1000})
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
