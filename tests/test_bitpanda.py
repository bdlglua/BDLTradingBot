"""Tests hors ligne : aucun appel réel à Bitpanda et aucun ordre financier."""
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from bitpanda import BitpandaClient, BrokerError, TradingService, upstream_detail

ASSET = '11111111-1111-4111-8111-111111111111'
CURRENCY = '22222222-2222-4222-8222-222222222222'
QUOTE = '33333333-3333-4333-8333-333333333333'


class FakeBitpanda:
    key = 'test-only-not-a-credential'

    def __init__(self):
        self.calls = []
        self.fail_accept = False
        self.overrides = {}

    def request(self, method, path, body=None, query=None):
        self.calls.append((method, path, body))
        if path.endswith('/accept'):
            if self.fail_accept:
                raise BrokerError('Timeout fictif.', 502)
            return {'id': 'fake-operation'}
        return {**body, 'id': QUOTE, 'price': '50000', 'quantity': '0.002',
                'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(), **self.overrides}


class TradingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = FakeBitpanda()
        self.environment = {'BITPANDA_ENABLE_TRADING': '1', 'BITPANDA_MAX_ORDER_AMOUNT': '100',
                            'BITPANDA_TRADING_CURRENCY_ID': CURRENCY}
        self.database = Path(self.temp.name) / 'state' / 'orders.sqlite3'
        self.service = TradingService(self.client, self.database, self.environment)
        self.request = dict(assetId=ASSET, currencyId=CURRENCY, side='BUY', notional='100')

    def confirmation(self, result):
        return dict(quote_id=result['quote']['id'], confirmation_token=result['confirmation_token'], confirm_real_order=True)

    def test_quote_does_not_execute_and_confirmation_is_single_use(self):
        quote = self.service.quote(self.request)
        self.assertEqual([path for _, path, _ in self.client.calls], ['/rfq/quotes'])
        self.assertEqual(self.service.accept(self.confirmation(quote))['state'], 'executed')
        restarted = TradingService(self.client, self.database, self.environment)
        with self.assertRaises(BrokerError):
            restarted.accept(self.confirmation(quote))
        self.assertEqual(sum(path.endswith('/accept') for _, path, _ in self.client.calls), 1)
        self.assertNotIn('confirmation_token', json.dumps(self.service.journal()))
        self.assertNotIn('test-only-not-a-credential', self.database.read_bytes().decode(errors='ignore'))

    def test_sell_quote_uses_fiat_notional(self):
        quote = self.service.quote(dict(self.request, side='SELL'))
        self.assertEqual(quote['quote']['side'], 'SELL')
        self.assertEqual(self.client.calls[0][2]['notional'], '100')

    def test_policy_rejects_before_remote_call(self):
        for change in ({'notional': '101'}, {'notional': '-1'}, {'notional': 'NaN'},
                       {'notional': 100}, {'currencyId': ASSET}, {'assetId': '../../accept'}, {'side': 'SHORT'}):
            with self.subTest(change=change), self.assertRaises(BrokerError):
                self.service.quote(dict(self.request, **change))
        self.environment['BITPANDA_ENABLE_TRADING'] = '0'
        with self.assertRaises(BrokerError):
            self.service.quote(self.request)
        self.assertEqual(self.client.calls, [])

    def test_pending_quote_blocks_second_request(self):
        self.service.quote(self.request)
        with self.assertRaises(BrokerError):
            self.service.quote(self.request)
        self.assertEqual(len(self.client.calls), 1)

    def test_quote_mismatch_rejected(self):
        with patch.object(self.client, 'request', return_value=dict(self.request, id=QUOTE, price='50000', quantity='.002',
                        notional='101', expiresAt=(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat())):
            with self.assertRaises(BrokerError):
                self.service.quote(self.request)
        self.assertEqual(self.service.journal(), [])

    def test_expired_or_unconfirmed_quote_never_accepted(self):
        quote = self.service.quote(self.request)
        confirmation = self.confirmation(quote)
        for changes in ({'confirm_real_order': False}, {'confirmation_token': 'wrong'}):
            with self.assertRaises(BrokerError):
                self.service.accept(dict(confirmation, **changes))
        with patch('bitpanda.instant', return_value=0), self.assertRaises(BrokerError):
            self.service.accept(confirmation)
        self.assertEqual(len(self.client.calls), 1)

    def test_reduced_limit_rechecked_at_acceptance(self):
        quote = self.service.quote(self.request)
        self.environment['BITPANDA_MAX_ORDER_AMOUNT'] = '50'
        with self.assertRaises(BrokerError):
            self.service.accept(self.confirmation(quote))
        self.assertEqual(len(self.client.calls), 1)

    def test_unknown_result_blocks_new_orders_after_restart(self):
        quote = self.service.quote(self.request)
        self.client.fail_accept = True
        with self.assertRaisesRegex(BrokerError, 'inconnu'):
            self.service.accept(self.confirmation(quote))
        restarted = TradingService(self.client, self.database, self.environment)
        for action in (lambda: restarted.accept(self.confirmation(quote)), lambda: restarted.quote(self.request)):
            with self.assertRaises(BrokerError):
                action()
        self.assertEqual(restarted.journal()[0]['state'], 'unknown')
        self.assertEqual(sum(path.endswith('/accept') for _, path, _ in self.client.calls), 1)

    def test_two_server_instances_cannot_double_submit(self):
        quote = self.service.quote(self.request)
        other = TradingService(self.client, self.database, self.environment)
        def accept(service):
            try:
                return service.accept(self.confirmation(quote))['state']
            except BrokerError:
                return 'blocked'
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(accept, (self.service, other)))
        self.assertCountEqual(results, ['executed', 'blocked'])
        self.assertEqual(sum(path.endswith('/accept') for _, path, _ in self.client.calls), 1)

    def test_missing_key_never_calls_network(self):
        client = BitpandaClient(key='')
        with patch.object(client.opener, 'open') as opened, self.assertRaises(BrokerError):
            client.read('holdings')
        opened.assert_not_called()

    def test_reconcile_after_unknown_result_unblocks_without_network(self):
        quote = self.service.quote(self.request)
        self.client.fail_accept = True
        with self.assertRaises(BrokerError):
            self.service.accept(self.confirmation(quote))
        body = dict(quote_id=QUOTE, outcome='executed', confirm_checked_bitpanda=True)
        for change in ({'confirm_checked_bitpanda': False}, {'outcome': 'maybe'}):
            with self.assertRaises(BrokerError):
                self.service.reconcile(dict(body, **change))
        with self.assertRaisesRegex(BrokerError, 'Attendez'):
            self.service.reconcile(body)
        calls = len(self.client.calls)
        later = datetime.now(timezone.utc) + timedelta(minutes=5)
        with patch('bitpanda.datetime') as clock:
            clock.now.return_value = later
            clock.fromisoformat = datetime.fromisoformat
            self.assertEqual(self.service.reconcile(body)['state'], 'executed')
        self.assertEqual(len(self.client.calls), calls)
        self.assertEqual(self.service.journal()[0]['quote']['reconciled'], 'executed')
        with self.assertRaises(BrokerError):
            self.service.reconcile(body)
        self.client.fail_accept = False
        self.client.overrides = {'id': '44444444-4444-4444-8444-444444444444'}
        self.assertEqual(self.service.quote(self.request)['quote']['id'], '44444444-4444-4444-8444-444444444444')

    def test_quote_accepts_uppercase_uuids_from_bitpanda(self):
        self.client.overrides = {'assetId': ASSET.upper(), 'currencyId': CURRENCY.upper()}
        result = self.service.quote(self.request)
        self.assertEqual(result['quote']['assetId'], ASSET)

    def test_journal_reports_expired_pending_quotes(self):
        self.service.quote(self.request)
        with patch('bitpanda.is_expired', return_value=True):
            self.assertEqual(self.service.journal()[0]['state'], 'expired')

    def test_upstream_error_detail_is_short_and_printable(self):
        self.assertEqual(upstream_detail(b'{"message": "Insufficient\\nfunds"}'), 'Insufficient funds')
        self.assertEqual(upstream_detail(b'{"errors": [{"detail": "Quote expired"}]}'), 'Quote expired')
        self.assertEqual(upstream_detail(b'<html>'), '')
        self.assertEqual(len(upstream_detail(('{"error": "%s"}' % ('x' * 500)).encode())), 200)
