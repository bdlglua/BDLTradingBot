"""Interface locale BDLTradingBot : python3 web.py."""
import argparse
import json
import os
import secrets
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from bot import Config, backtest, read_prices
from bitpanda import BrokerError, TradingService, identifier
from access import AccessPolicy

ROOT = Path(__file__).resolve().parent
MAX_BODY = 2_000_000
STATIC = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'),
          '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css'),
          '/config.js': ('config.js', 'text/javascript'), '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
READS = {'assets': {'symbol', 'cursor', 'id'}, 'currencies': set(), 'holdings': set(), 'operations': {'cursor'}}
LIVE_ACTIONS = {'/api/bitpanda/quote': 'quote', '/api/bitpanda/accept': 'accept', '/api/bitpanda/reconcile': 'reconcile'}


class Handler(BaseHTTPRequestHandler):
    broker = TradingService()
    csrf_token = secrets.token_urlsafe(32)
    access = AccessPolicy.from_environment()

    def local_request(self):
        if not self.access.permits_request(self.headers, self.server.server_port):
            self.reply(403, {'error': 'Hôte ou origine refusé.'})
            return False
        if self.path != '/health' and not self.access.authenticated(self.headers):
            self.reply(401, {'error': 'Code d’accès au serveur requis ou incorrect.'})
            return False
        return True

    def reply(self, status, body, content_type='application/json; charset=utf-8'):
        if isinstance(body, dict):
            body = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        if self.access.public and self.headers.get('Origin') == self.access.origin:
            self.send_header('Access-Control-Allow-Origin', self.access.origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.local_request():
            return
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == '/health':
            return self.reply(200, {'status': 'ok'})
        if path == '/api/session':
            return self.reply(200, {'csrf_token': self.csrf_token})
        if path == '/api/bitpanda/status':
            return self.reply(200, self.broker.status())
        if path.startswith('/api/bitpanda/'):
            resource = path.removeprefix('/api/bitpanda/')
            try:
                query = parse_qs(parsed.query, keep_blank_values=True)
                if any(len(v) != 1 or len(v[0]) > 200 for v in query.values()):
                    raise BrokerError('Requête Bitpanda invalide.', 400)
                params = {key: values[0] for key, values in query.items()}
                if resource == 'journal' and not params:
                    return self.reply(200, {'orders': self.broker.journal()})
                if resource == 'ticker' and set(params) == {'assetId'}:
                    return self.reply(200, {'result': self.broker.client.ticker(params['assetId'])})
                if resource not in READS or set(params) - READS[resource]:
                    raise BrokerError('Requête Bitpanda invalide.', 400)
                if 'id' in params:
                    params['id'] = identifier(params['id'])
                if resource in ('assets', 'operations'):
                    params['pageSize'] = 50
                return self.reply(200, {'result': self.broker.client.read(resource, params)})
            except BrokerError as error:
                return self.reply(error.status, {'error': str(error)})
        if path in ('/api/example', '/examples/prices.csv'):
            text = (ROOT / 'examples/prices.csv').read_text()
            if path == '/api/example':
                return self.reply(200, {'csv': text})
            return self.reply(200, text.encode(), 'text/csv; charset=utf-8')
        if path not in STATIC:
            return self.reply(404, {'error': 'Page introuvable.'})
        name, mime = STATIC[path]
        self.reply(200, (ROOT / 'static' / name).read_bytes(), mime + '; charset=utf-8')

    def do_OPTIONS(self):
        if (not self.access.public or not self.access.permits_request(self.headers, self.server.server_port)
                or self.headers.get('Origin') != self.access.origin):
            return self.reply(403, {'error': 'Origine refusée.'})
        requested = {name.strip().lower() for name in self.headers.get('Access-Control-Request-Headers', '').split(',') if name.strip()}
        if (self.headers.get('Access-Control-Request-Method') not in ('GET', 'POST')
                or requested - {'authorization', 'content-type', 'x-csrf-token'}):
            return self.reply(403, {'error': 'Prérequête refusée.'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.access.origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if not self.local_request():
            return
        path = urlsplit(self.path).path
        live = path in LIVE_ACTIONS
        if path != '/api/backtest' and not live:
            return self.reply(404, {'error': 'Route introuvable.'})
        if live and not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), self.csrf_token):
            return self.reply(403, {'error': 'Session invalide. Rechargez la page.'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(415, {'error': 'JSON requis.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'Requête vide ou supérieure à 2 Mo.'})
            data = json.loads(self.rfile.read(length))
            if live:
                return self.reply(200, getattr(self.broker, LIVE_ACTIONS[path])(data))
            if not isinstance(data, dict) or not isinstance(data.get('csv'), str):
                raise ValueError('Données CSV requises.')
            settings = data.get('config', {})
            if not isinstance(settings, dict) or set(settings) - set(Config.__dataclass_fields__):
                raise ValueError('Paramètres inconnus.')
            for key, value in settings.items():
                if isinstance(value, bool) or not isinstance(value, (float, int)):
                    raise ValueError('Paramètres numériques requis.')
                if key in ('fast', 'slow') and (not isinstance(value, int) or value > 10000):
                    raise ValueError('Périodes entières limitées à 10 000.')
            config = Config(**settings)
            config.validate()
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'prices.csv'
                path.write_text(data['csv'], encoding='utf-8')
                prices = read_prices(path)
            if len(prices) > 20000:
                raise ValueError('Maximum : 20 000 observations par backtest.')
            self.reply(200, backtest(prices, config))
        except UnicodeEncodeError:
            self.reply(400, {'error': 'Fichier CSV illisible : enregistrez-le en UTF-8.'})
        except BrokerError as error:
            self.reply(error.status, {'error': str(error)})
        except (ValueError, TypeError, OverflowError, AttributeError) as error:
            self.reply(400, {'error': str(error)})


class Server(ThreadingHTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(30)
        return connection, address


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['127.0.0.1', 'localhost', '0.0.0.0'], default='127.0.0.1')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8000')))
    args = parser.parse_args()
    if args.host == '0.0.0.0' and not Handler.access.public:
        parser.error('Configurer origine HTTPS, hôte API et code d’accès avant une écoute publique.')
    server = Server((args.host, args.port), Handler)
    print(f'BDLTradingBot écoute sur {args.host}:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
