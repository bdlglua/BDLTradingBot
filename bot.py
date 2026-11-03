"""Bot de simulation et backtest, sans dépendance externe."""
import argparse
import csv
import json
import math
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    capital: float = 10000
    fast: int = 5
    slow: int = 20
    allocation: float = 0.20
    stop_loss: float = 0.05
    fee: float = 0.001

    def validate(self):
        if not 1 <= self.fast < self.slow:
            raise ValueError('Les périodes doivent respecter 1 <= fast < slow.')
        if not math.isfinite(self.capital) or self.capital <= 0:
            raise ValueError('Le capital doit être positif et fini.')
        for name in ('allocation', 'stop_loss', 'fee'):
            value = getattr(self, name)
            if not math.isfinite(value) or not 0 < value < 1:
                raise ValueError(f'{name} doit être compris entre 0 et 1 exclus.')


def read_prices(path):
    """CSV chronologique : timestamp ISO 8601 UTC, close positif."""
    from datetime import datetime
    prices = []
    previous = None
    with open(path, newline='', encoding='utf-8') as stream:
        reader = csv.DictReader(stream)
        if not {'timestamp', 'close'} <= set(reader.fieldnames or []):
            raise ValueError('Colonnes CSV requises : timestamp,close.')
        for line, row in enumerate(reader, 2):
            try:
                stamp = datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
                price = float(row['close'])
                if stamp.utcoffset() is None:
                    raise ValueError('fuseau horaire requis')
                if not math.isfinite(price) or price <= 0:
                    raise ValueError('prix positif et fini requis')
                if previous is not None and stamp <= previous:
                    raise ValueError('dates strictement croissantes requises')
            except (ValueError, TypeError) as error:
                raise ValueError(f'Ligne {line} : {error}') from error
            prices.append((row['timestamp'], price))
            previous = stamp
    return prices


def backtest(prices, config):
    """Signal à la clôture ; exécution à la clôture suivante (sans anticipation)."""
    config.validate()
    if len(prices) < config.slow + 2:
        raise ValueError(f'Au moins {config.slow + 2} observations sont requises.')
    cash, quantity, entry = config.capital, 0.0, 0.0
    history = deque(maxlen=config.slow)
    prior_spread = None
    pending = None
    trades, equity_curve = [], []
    peak, max_drawdown = config.capital, 0.0
    for timestamp, price in prices:
        if not math.isfinite(price) or price <= 0:
            raise ValueError('Prix positif et fini requis.')
        if pending == 'buy' and quantity == 0:
            budget = cash * config.allocation
            quantity = budget / (price * (1 + config.fee))
            fee = quantity * price * config.fee
            cash -= budget
            entry = price
            trades.append(dict(timestamp=timestamp, side='buy', price=price,
                               quantity=quantity, fee=fee, reason='crossover'))
        elif pending in ('sell', 'stop_loss') and quantity > 0:
            fee = quantity * price * config.fee
            cash += quantity * price - fee
            trades.append(dict(timestamp=timestamp, side='sell', price=price,
                               quantity=quantity, fee=fee, reason=pending))
            quantity = 0.0
        pending = None
        equity = cash + quantity * price
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak)
        equity_curve.append(dict(timestamp=timestamp, equity=equity))
        history.append(price)
        if len(history) == config.slow:
            values = list(history)
            spread = sum(values[-config.fast:]) / config.fast - sum(values) / config.slow
            if quantity > 0 and price <= entry * (1 - config.stop_loss):
                pending = 'stop_loss'
            elif prior_spread is not None:
                if quantity == 0 and prior_spread <= 0 < spread:
                    pending = 'buy'
                elif quantity > 0 and prior_spread >= 0 > spread:
                    pending = 'sell'
            prior_spread = spread
    return dict(config=asdict(config), initial_capital=config.capital,
                final_equity=equity_curve[-1]['equity'], cash=cash,
                open_quantity=quantity, return_pct=(equity_curve[-1]['equity'] / config.capital - 1) * 100,
                max_drawdown_pct=max_drawdown * 100, trades=trades,
                equity_curve=equity_curve)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--output', type=Path, help='Nouveau fichier JSON (sans écrasement)')
    parser.add_argument('--capital', type=float, default=10000)
    parser.add_argument('--fast', type=int, default=5)
    parser.add_argument('--slow', type=int, default=20)
    parser.add_argument('--allocation', type=float, default=.2)
    parser.add_argument('--stop-loss', type=float, default=.05)
    parser.add_argument('--fee', type=float, default=.001)
    args = parser.parse_args()
    try:
        config = Config(args.capital, args.fast, args.slow, args.allocation, args.stop_loss, args.fee)
        report = backtest(read_prices(args.csv), config)
        if args.output:
            with args.output.open('x', encoding='utf-8') as stream:
                json.dump(report, stream, indent=2, allow_nan=False)
        print(json.dumps({k: v for k, v in report.items() if k not in ('config', 'trades', 'equity_curve')}, indent=2))
        print(f"Transactions : {len(report['trades'])}")
    except (ValueError, OSError) as error:
        parser.exit(2, f'Erreur : {error}\n')


if __name__ == '__main__':
    main()
