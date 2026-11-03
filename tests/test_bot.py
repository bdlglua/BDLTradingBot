import tempfile
import unittest
from pathlib import Path

from bot import Config, backtest, read_prices


class BotTests(unittest.TestCase):
    def test_next_bar_execution_and_fees(self):
        prices = list(enumerate([10, 9, 8, 12, 13, 14, 7, 6]))
        report = backtest(prices, Config(fast=2, slow=3))
        buy, sell = report['trades']
        self.assertEqual((buy['timestamp'], buy['price']), (4, 13))
        self.assertEqual((sell['timestamp'], sell['reason']), (7, 'stop_loss'))
        expected_quantity = 2000 / (13 * 1.001)
        self.assertAlmostEqual(report['final_equity'], 8000 + expected_quantity * 6 * .999)
        self.assertEqual(report['open_quantity'], 0)

    def test_flat_market(self):
        report = backtest(list(enumerate([10] * 25)), Config())
        self.assertEqual(report['trades'], [])
        self.assertEqual(report['final_equity'], 10000)

    def test_open_position_marked_to_market(self):
        report = backtest(list(enumerate([10, 9, 8, 12, 13, 14])), Config(fast=2, slow=3))
        self.assertGreater(report['open_quantity'], 0)
        self.assertAlmostEqual(report['final_equity'], report['cash'] + report['open_quantity'] * 14)

    def test_invalid_configuration(self):
        for config in (Config(fast=20), Config(capital=float('nan')), Config(allocation=2)):
            with self.assertRaises(ValueError):
                config.validate()

    def test_csv_rejects_duplicate_dates_and_nan(self):
        for body in ('2026-01-01T00:00:00Z,10\n2026-01-01T00:00:00Z,11',
                     '2026-01-01T00:00:00Z,nan'):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'prices.csv'
                path.write_text('timestamp,close\n' + body)
                with self.assertRaises(ValueError):
                    read_prices(path)


if __name__ == '__main__':
    unittest.main()
