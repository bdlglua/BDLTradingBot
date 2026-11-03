"""Vérification navigateur facultative : python3 tests/browser_smoke.py.

Nécessite Playwright et Chromium. Les appels de trading sont interceptés :
aucune clé API, aucune requête Bitpanda et aucun ordre réel.
"""
import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import expect, sync_playwright
from web import Handler

ASSET = '11111111-1111-4111-8111-111111111111'
CURRENCY = '22222222-2222-4222-8222-222222222222'
QUOTE = '33333333-3333-4333-8333-333333333333'


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Force credentials absent, independently of any machine configuration.
            page.route('**/api/bitpanda/status', lambda route: route.fulfill(json={
                'api_key_present': False, 'trading_enabled': False, 'reason': 'Clé API absente.'}))
            page.goto(url)
            expect(page.locator('#connection-title')).to_have_text('Compte Bitpanda non connecté')
            assert page.locator('#request-quote').is_disabled()
            assert page.locator('#live-view').is_visible()
            page.locator('#nav-lab').click()
            page.locator('#example').click()
            expect(page.locator('#source')).to_contain_text('synthétique')
            page.locator('#run').click()
            expect(page.locator('#count')).to_have_text('2')
            assert page.locator('#chart').is_visible()
            assert page.locator('#download').is_enabled()
            page.locator('#nav-live').click()
            page.screenshot(path='/tmp/bdl-bitpanda-desktop.png', full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path='/tmp/bdl-bitpanda-mobile.png', full_page=True)
            page.close()

            # New page, all Bitpanda routes mocked before navigation.
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            accept_calls = []
            def mock_bitpanda(route):
                path = route.request.url.split('/api/bitpanda/')[1].split('?')[0]
                if path == 'status':
                    response = dict(api_key_present=True, trading_enabled=True, reason='',
                                    currency_id=CURRENCY, max_order_amount='100')
                elif path == 'holdings':
                    response = {'result': [dict(assetId=ASSET, quantity='.1', value='5000', equivalentCurrencyId=CURRENCY)]}
                elif path == 'currencies':
                    response = {'result': [dict(id=CURRENCY, symbol='EUR')]}
                elif path == 'assets':
                    response = {'result': {'data': [dict(id=ASSET, symbol='BTC', type='CRYPTO')]}}
                elif path == 'journal':
                    response = {'orders': []}
                elif path == 'quote':
                    request = route.request.post_data_json
                    assert request == dict(assetId=ASSET, currencyId=CURRENCY, side='BUY', notional='100')
                    response = dict(quote=dict(request, id=QUOTE, price='50000', quantity='.002',
                                    expiresAt=(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()),
                                    confirmation_token='fake-confirmation')
                elif path == 'accept':
                    accept_calls.append(route.request.post_data_json)
                    response = {'state': 'executed', 'message': 'Exécution fictive confirmée pour le test.'}
                else:
                    raise AssertionError('Unexpected Bitpanda route: ' + path)
                route.fulfill(json=response)
            page.route('**/api/bitpanda/**', mock_bitpanda)
            page.goto(url)
            page.locator('#refresh-account').click()
            expect(page.locator('#currency-id option')).to_have_count(2)
            page.locator('#asset-symbol').fill('BTC')
            page.locator('#search-assets').click()
            page.locator('#asset-id').select_option(ASSET)
            page.locator('#order-amount').fill('100')
            page.locator('#request-quote').click()
            page.locator('#quote-details').wait_for(state='visible')
            assert page.locator('#accept-quote').is_disabled()
            assert not accept_calls
            page.locator('#confirm-real').check()
            page.locator('#accept-quote').click()
            expect(page.locator('#order-result')).to_contain_text('Exécution fictive')
            assert len(accept_calls) == 1
            assert accept_calls[0] == dict(quote_id=QUOTE, confirmation_token='fake-confirmation', confirm_real_order=True)
            assert not errors, errors
            browser.close()
            print('Navigateur : écran déconnecté, mobile, backtest et confirmation réelle (API fictive) validés.')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
