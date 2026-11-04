"""Vérification navigateur facultative : python3 tests/browser_smoke.py.

Nécessite Playwright (Python) et Chromium ; CHROMIUM_PATH peut désigner le binaire.
Toutes les routes Bitpanda sont interceptées : aucune clé, aucune requête réelle, aucun ordre.
"""
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import expect, sync_playwright
from web import Handler

ASSET = '11111111-1111-4111-8111-111111111111'
CURRENCY = '22222222-2222-4222-8222-222222222222'
QUOTE = '33333333-3333-4333-8333-333333333333'
STUCK = '44444444-4444-4444-8444-444444444444'
SHOTS = Path(os.environ.get('SCREENSHOT_DIR', '/tmp'))


def launch(playwright):
    path = os.environ.get('CHROMIUM_PATH')
    return playwright.chromium.launch(**({'executable_path': path} if path else {}), headless=True)


def no_horizontal_scroll(page):
    return page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = launch(playwright)
            errors = []

            # 1. Serveur local sans clé : lecture seule, laboratoire fonctionnel.
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/api/bitpanda/status', lambda route: route.fulfill(json={
                'api_key_present': False, 'trading_enabled': False, 'reason': 'Clé API absente.'}))
            page.route('**/api/bitpanda/journal', lambda route: route.fulfill(json={'orders': []}))
            page.goto(url)
            expect(page.locator('#connection-label')).to_have_text('Lecture seule')
            expect(page.locator('#kpi-trading')).to_have_text('Désactivé')
            assert page.locator('#onboarding').is_hidden()
            page.locator('.nav[data-view="trade"]').click()
            expect(page.locator('#view-title')).to_have_text('Trader')
            assert page.locator('#request-quote').is_disabled()
            expect(page.locator('#trading-disabled')).to_contain_text('Clé API absente')
            page.locator('.nav[data-view="lab"]').click()
            page.locator('#example').click()
            expect(page.locator('#source')).to_contain_text('synthétique')
            page.locator('#run').click()
            expect(page.locator('#count')).to_have_text('2')
            assert page.locator('#chart').is_visible()
            assert page.locator('#chart .marker-buy').count() == 1
            page.locator('#chart').hover()
            assert page.locator('#download').is_enabled()
            page.screenshot(path=str(SHOTS / 'bdl-lab-desktop.png'), full_page=True)
            page.emulate_media(color_scheme='dark')
            page.screenshot(path=str(SHOTS / 'bdl-lab-desktop-dark.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            for view in ('overview', 'trade', 'history', 'lab', 'settings'):
                page.goto(f'{url}/#{view}')
                page.locator(f'#view-{view}').wait_for(state='visible')
                assert no_horizontal_scroll(page), view
            page.close()

            # 2. Compte simulé complet : portefeuille, devis, ordre, rapprochement.
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            accept_calls, reconcile_calls = [], []
            journal = [dict(id=STUCK, state='unknown', created='2026-11-01T10:00:00+00:00',
                            quote=dict(id=STUCK, assetId=ASSET, currencyId=CURRENCY, side='BUY', notional='50',
                                       price='50000', quantity='0.001', expiresAt='2026-11-01T10:00:30+00:00'))]

            def mock_bitpanda(route):
                parts = urlsplit(route.request.url)
                path, query = parts.path.split('/api/bitpanda/')[1], parse_qs(parts.query)
                if path == 'status':
                    response = dict(api_key_present=True, trading_enabled=True, reason='', currency_id=CURRENCY,
                                    max_order_amount='100', features={'backtest': True, 'reconcile': True})
                elif path == 'holdings':
                    response = {'result': [dict(assetId=ASSET, quantity='0.1', value='5000', equivalentCurrencyId=CURRENCY),
                                           dict(assetId='55555555-5555-4555-8555-555555555555', quantity='2', value='1250.5',
                                                equivalentCurrencyId=CURRENCY)]}
                elif path == 'currencies':
                    response = {'result': [dict(id=CURRENCY, symbol='EUR'), dict(id='66666666-6666-4666-8666-666666666666', symbol='USD')]}
                elif path == 'assets' and 'id' in query:
                    symbol = 'BTC' if query['id'][0] == ASSET else 'ETH'
                    response = {'result': {'data': [dict(id=query['id'][0], symbol=symbol, type='CRYPTO')]}}
                elif path == 'assets':
                    assert query['symbol'] == ['BTC']
                    response = {'result': {'data': [dict(id=ASSET, symbol='BTC', type='CRYPTO')]}}
                elif path == 'ticker':
                    response = {'result': dict(assetId=ASSET, price='50123.45', currency='EUR')}
                elif path == 'journal':
                    response = {'orders': journal}
                elif path == 'operations':
                    response = {'result': {'data': [dict(id=QUOTE, type='BUY', assetId=ASSET, amount='0.002',
                                                         timestamp='2026-11-02T09:00:00Z')]}}
                elif path == 'quote':
                    request = route.request.post_data_json
                    assert request == dict(assetId=ASSET, currencyId=CURRENCY, side='BUY', notional='99.5'), request
                    response = dict(quote=dict(request, id=QUOTE, price='50000', quantity='0.00201',
                                    expiresAt=(datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()),
                                    confirmation_token='fake-confirmation')
                elif path == 'accept':
                    accept_calls.append(route.request.post_data_json)
                    response = {'state': 'executed', 'message': 'Exécution fictive confirmée pour le test.'}
                elif path == 'reconcile':
                    reconcile_calls.append(route.request.post_data_json)
                    journal[0] = dict(journal[0], state='expired', quote=dict(journal[0]['quote'], reconciled='not_executed'))
                    response = {'state': 'expired', 'message': 'Ordre rapproché.'}
                else:
                    raise AssertionError('Unexpected Bitpanda route: ' + path)
                route.fulfill(json=response)
            page.route('**/api/bitpanda/**', mock_bitpanda)
            page.goto(url)
            expect(page.locator('#connection-label')).to_have_text('Trading activé')
            expect(page.locator('#holdings tr')).to_have_count(2)
            expect(page.locator('#holdings')).to_contain_text('BTC')
            expect(page.locator('#kpi-value')).to_contain_text('6')
            expect(page.locator('#kpi-limit')).to_contain_text('100')
            page.screenshot(path=str(SHOTS / 'bdl-portfolio-desktop.png'), full_page=True)

            page.locator('.nav[data-view="trade"]').click()
            expect(page.locator('#currency-id option')).to_have_count(2)
            page.locator('#asset-symbol').fill('BTC')
            page.locator('#search-assets').click()
            expect(page.locator('#asset-price')).to_contain_text('50')
            page.locator('#order-amount').fill('500')
            expect(page.locator('#amount-hint')).to_contain_text('plafond')
            assert page.locator('#request-quote').is_disabled()
            page.locator('#order-amount').fill('99,5')
            page.locator('#request-quote').click()
            page.locator('#quote-details').wait_for(state='visible')
            expect(page.locator('#quote-headline')).to_contain_text('Acheter')
            assert page.locator('#accept-quote').is_disabled()
            assert page.locator('#request-quote').is_disabled()
            page.screenshot(path=str(SHOTS / 'bdl-trade-desktop.png'), full_page=True)
            assert not accept_calls
            page.locator('#confirm-real').check()
            page.locator('#accept-quote').click()
            expect(page.locator('#order-result')).to_contain_text('Exécution fictive')
            assert accept_calls == [dict(quote_id=QUOTE, confirmation_token='fake-confirmation', confirm_real_order=True)]

            page.locator('.nav[data-view="history"]').click()
            expect(page.locator('#live-orders')).to_contain_text('Inconnu')
            page.locator('#live-orders button', has_text='Rapprocher').click()
            page.locator('#reconcile-dialog').wait_for(state='visible')
            page.locator('#reconcile-submit').click()
            expect(page.locator('#reconcile-error')).to_contain_text('Indiquez')
            assert not reconcile_calls
            page.locator('input[name="outcome"][value="not_executed"]').check()
            page.locator('#reconcile-checked').check()
            page.locator('#reconcile-submit').click()
            expect(page.locator('#live-orders')).to_contain_text('Non exécuté')
            assert reconcile_calls == [dict(quote_id=STUCK, outcome='not_executed', confirm_checked_bitpanda=True)]
            page.locator('#read-operations').click()
            expect(page.locator('#operations')).to_contain_text('BTC')
            page.screenshot(path=str(SHOTS / 'bdl-history-desktop.png'), full_page=True)

            page.set_viewport_size({'width': 390, 'height': 844})
            page.emulate_media(color_scheme='dark', reduced_motion='reduce')
            page.locator('.nav[data-view="overview"]').click()
            assert no_horizontal_scroll(page)
            page.screenshot(path=str(SHOTS / 'bdl-portfolio-mobile-dark.png'), full_page=True)
            page.locator('.nav[data-view="trade"]').click()
            assert no_horizontal_scroll(page)
            page.screenshot(path=str(SHOTS / 'bdl-trade-mobile-dark.png'), full_page=True)
            assert not errors, errors
            browser.close()
            print('Navigateur : lecture seule, laboratoire, portefeuille, ordre, rapprochement et mobile validés (API fictive).')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
