import json
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from web import Handler, ROOT


class WebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post(self, data):
        return urlopen(Request(self.base + '/api/backtest',
                              data=json.dumps(data).encode(),
                              headers={'Content-Type': 'application/json'}), timeout=5)

    def test_assets_and_example(self):
        for path in ('/', '/app.js', '/style.css', '/api/example'):
            with urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertIn('nosniff', response.headers['X-Content-Type-Options'])
                self.assertTrue(response.read())

    def test_backtest(self):
        with self.post({'csv': (ROOT / 'examples/prices.csv').read_text(),
                        'config': {'fast': 2, 'slow': 3}}) as response:
            report = json.load(response)
        self.assertEqual(len(report['trades']), 2)
        self.assertEqual(len(report['equity_curve']), 8)
        self.assertAlmostEqual(report['final_equity'], 8921.232613540305)

    def test_reject_invalid_inputs(self):
        for data in ({'csv': 'invalid'}, {'csv': '', 'config': {'fast': 2.5}},
                     {'csv': '', 'config': {'capital': True}}, []):
            with self.assertRaises(HTTPError) as error:
                self.post(data)
            self.assertEqual(error.exception.code, 400)
            self.assertIn('error', json.load(error.exception))

    def test_static_paths_ignore_query_string(self):
        for path in ('/?v=2', '/app.js?v=2', '/favicon.svg', '/examples/prices.csv'):
            with urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)

    def test_ticker_and_asset_lookup_validate_uuid(self):
        from unittest.mock import Mock, patch
        client = Mock(key='test-only')
        client.ticker.return_value = {'price': '1'}
        client.read.return_value = {'data': []}
        service = Mock(client=client)
        asset = '11111111-1111-4111-8111-111111111111'
        with patch.object(Handler, 'broker', service):
            with urlopen(self.base + '/api/bitpanda/ticker?assetId=' + asset, timeout=5) as response:
                self.assertEqual(json.load(response)['result'], {'price': '1'})
            with urlopen(self.base + '/api/bitpanda/assets?id=' + asset.upper(), timeout=5) as response:
                client.read.assert_called_with('assets', {'id': asset, 'page_size': 50})
            for path in ('/api/bitpanda/assets?id=nope', '/api/bitpanda/ticker?foo=1', '/api/bitpanda/journal?x=1'):
                with self.assertRaises(HTTPError) as error:
                    urlopen(self.base + path, timeout=5)
                self.assertEqual(error.exception.code, 400)

    def test_no_file_traversal(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + '/bot.py', timeout=5)
        self.assertEqual(error.exception.code, 404)

    def test_reject_foreign_host_and_origin(self):
        for headers in ({'Host': 'untrusted.example'}, {'Origin': 'https://untrusted.example'}):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(self.base + '/api/session', headers=headers), timeout=5)
            self.assertEqual(error.exception.code, 403)

    def test_live_endpoint_requires_session(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + '/api/bitpanda/accept', data=b'{}',
                            headers={'Content-Type': 'application/json'}), timeout=5)
        self.assertEqual(error.exception.code, 403)

    def test_no_key_is_not_claimed_connected(self):
        from bitpanda import BitpandaClient, TradingService
        from unittest.mock import patch
        service = TradingService(client=BitpandaClient(key=''), environment={})
        with patch.object(Handler, 'broker', service), urlopen(self.base + '/api/bitpanda/status', timeout=5) as response:
            status = json.load(response)
        self.assertFalse(status['api_key_present'])
        self.assertFalse(status['trading_enabled'])
        self.assertFalse(status['connection_verified'])

    def test_live_http_flow_with_fake_bitpanda(self):
        import tempfile
        from datetime import datetime, timedelta, timezone
        from unittest.mock import Mock, patch
        from bitpanda import TradingService
        asset = '11111111-1111-4111-8111-111111111111'
        currency = '22222222-2222-4222-8222-222222222222'
        quote_id = '33333333-3333-4333-8333-333333333333'
        payload = dict(assetId=asset, currencyId=currency, side='BUY', notional='10')
        client = Mock(key='test-only-not-a-credential')
        client.request.side_effect = [dict(payload, id=quote_id, price='50000', quantity='.0002',
            expiresAt=(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()), {}]
        with tempfile.TemporaryDirectory() as directory:
            service = TradingService(client=client, database=Path(directory)/'orders.db', environment={
                'BITPANDA_ENABLE_TRADING': '1', 'BITPANDA_TRADING_CURRENCY_ID': currency,
                'BITPANDA_MAX_ORDER_AMOUNT': '10'})
            with patch.object(Handler, 'broker', service):
                with urlopen(self.base+'/api/session', timeout=5) as response:
                    token = json.load(response)['csrf_token']
                def live_post(path, data):
                    with urlopen(Request(self.base+path, data=json.dumps(data).encode(), headers={
                        'Content-Type': 'application/json', 'X-CSRF-Token': token}), timeout=5) as response:
                        return json.load(response)
                quote = live_post('/api/bitpanda/quote', payload)
                self.assertEqual(client.request.call_count, 1)
                result = live_post('/api/bitpanda/accept', dict(quote_id=quote_id,
                    confirmation_token=quote['confirmation_token'], confirm_real_order=True))
                self.assertEqual(result['state'], 'executed')
                client.request.assert_called_with('POST', f'/v1/quotes/{quote_id}/accept')
