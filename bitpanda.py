"""Connecteur de production Bitpanda Public API (aucun ordre à l'import)."""
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

BASE_URL = 'https://api.public.bitpanda.com'
# Délai après l'expiration d'un devis avant de permettre son rapprochement :
# supérieur au timeout réseau, pour qu'aucune acceptation ne soit encore en vol.
RECONCILE_MARGIN_SECONDS = 30


class BrokerError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def identifier(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise BrokerError('Identifiant UUID invalide.') from None


def amount(value):
    if not isinstance(value, str) or len(value) > 50:
        raise BrokerError('Le montant doit être une chaîne décimale positive.')
    try:
        number = Decimal(value)
        if not number.is_finite() or number <= 0 or number > Decimal('1e15') or number.as_tuple().exponent < -18:
            raise InvalidOperation
        return number
    except InvalidOperation:
        raise BrokerError('Montant positif requis, avec 18 décimales maximum.') from None


def instant(value):
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.utcoffset() is None:
            raise ValueError
        return stamp.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise BrokerError('Date d’expiration du devis invalide.', 502) from None


def upstream_detail(raw):
    """Message d'erreur court renvoyé par Bitpanda, sans jamais le réinterpréter."""
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return ''
    candidates = []
    if isinstance(data, dict):
        for key in ('message', 'error', 'detail', 'title', 'errors'):
            candidates.append(data.get(key))
    for value in candidates:
        if isinstance(value, list) and value:
            value = value[0]
        if isinstance(value, dict):
            value = value.get('message') or value.get('detail') or value.get('code')
        if isinstance(value, str) and value.strip():
            text = ''.join(char if char.isprintable() else ' ' for char in value)
            return ' '.join(text.split())[:200]
    return ''


def is_expired(quote, margin=0):
    try:
        return instant(quote['expiresAt']) + margin <= datetime.now(timezone.utc).timestamp()
    except (BrokerError, KeyError, TypeError):
        return True


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the API key to another destination.
        return None


class BitpandaClient:
    def __init__(self, key=None):
        self.key = os.environ.get('BITPANDA_API_KEY', '') if key is None else key
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, body=None, query=None):
        if not self.key:
            raise BrokerError('Clé BITPANDA_API_KEY absente des paramètres sécurisés.', 503)
        url = BASE_URL + path + ('?' + urlencode(query) if query else '')
        headers = {'x-api-key': self.key, 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, allow_nan=False).encode()
        elif method == 'POST':
            data = b''
        try:
            # No automatic retries: a timed-out acceptance may already be executed.
            with self.opener.open(Request(url, data=data, headers=headers, method=method), timeout=20) as response:
                raw = response.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise BrokerError('Réponse Bitpanda trop volumineuse.', 502)
                return json.loads(raw) if raw else {}
        except HTTPError as error:
            code = error.code
            try:
                detail = upstream_detail(error.read(4096))
            except OSError:
                detail = ''
            finally:
                error.close()
            messages = {401: 'Clé Bitpanda refusée.', 403: 'Accès refusé par Bitpanda ou le proxy réseau.',
                        404: 'Ressource introuvable sur Bitpanda.',
                        429: 'Limite de requêtes Bitpanda atteinte. Attendez avant de réessayer.'}
            message = messages.get(code, f'Bitpanda a refusé la requête (HTTP {code}).')
            raise BrokerError(message + (f' Détail : {detail}' if detail else ''), 502) from None
        except (URLError, OSError, ValueError):
            raise BrokerError('Réponse Bitpanda indisponible ou illisible. Aucun renvoi automatique.', 502) from None

    def read(self, resource, query=None):
        paths = {'assets': '/assets', 'currencies': '/currencies',
                 'holdings': '/portfolio/holdings', 'operations': '/operations'}
        if resource not in paths:
            raise BrokerError('Ressource inconnue.', 404)
        return self.request('GET', paths[resource], query=query)

    def ticker(self, asset_id):
        return self.request('GET', f'/assets/{identifier(asset_id)}/ticker')


class TradingService:
    def __init__(self, client=None, database=None, environment=None):
        self.client = client or BitpandaClient()
        self.environment = os.environ if environment is None else environment
        state_directory = Path(os.environ.get('BITPANDA_STATE_DIR', Path(__file__).parent / '.state'))
        self.database = Path(database or state_directory / 'bitpanda.sqlite3')
        self.lock = threading.Lock()

    def policy(self):
        if self.environment.get('BITPANDA_ENABLE_TRADING') != '1':
            raise BrokerError('Le trading réel doit être activé dans les paramètres de l’environnement.', 503)
        try:
            return identifier(self.environment.get('BITPANDA_TRADING_CURRENCY_ID')), amount(self.environment.get('BITPANDA_MAX_ORDER_AMOUNT'))
        except BrokerError:
            raise BrokerError('Configurez la devise UUID et le plafond par ordre dans les paramètres de l’environnement.', 503) from None

    def status(self):
        try:
            currency, limit = self.policy()
            enabled, reason = True, ''
        except BrokerError as error:
            currency, limit, enabled, reason = None, None, False, str(error)
        return dict(broker='Bitpanda', api_key_present=bool(self.client.key),
                    trading_enabled=enabled and bool(self.client.key),
                    currency_id=currency, max_order_amount=str(limit) if limit else None,
                    reason=reason or ('' if self.client.key else 'Clé API absente.'),
                    connection_verified=False, features=dict(backtest=True, reconcile=True))

    def connect_db(self):
        self.database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Exclusive creation gives the ledger private permissions from its first write.
        try:
            descriptor = os.open(self.database, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
        except FileExistsError:
            pass
        connection = sqlite3.connect(self.database, timeout=25, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, quote TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL)')
        return connection

    def journal(self):
        connection = self.connect_db()
        try:
            rows = connection.execute('SELECT id, quote, state, created FROM orders ORDER BY rowid DESC LIMIT 100').fetchall()
            orders = []
            for row in rows:
                quote = json.loads(row['quote'])
                # A pending quote past its expiry can no longer be accepted.
                state = 'expired' if row['state'] == 'pending' and is_expired(quote) else row['state']
                orders.append(dict(id=row['id'], quote=quote, state=state, created=row['created']))
            return orders
        finally:
            connection.close()

    def quote(self, data):
        currency, limit = self.policy()
        if not isinstance(data, dict) or set(data) != {'assetId', 'currencyId', 'side', 'notional'}:
            raise BrokerError('Actif, devise, sens et montant en devise requis.')
        request = dict(assetId=identifier(data['assetId']), currencyId=identifier(data['currencyId']), side=data['side'], notional=data['notional'])
        requested = amount(request['notional'])
        if request['side'] not in ('BUY', 'SELL') or request['currencyId'] != currency or requested > limit:
            raise BrokerError('Sens invalide, devise non autorisée ou plafond par ordre dépassé.')
        with self.lock:
            connection = self.connect_db()
            try:
                connection.execute('BEGIN IMMEDIATE')
                for row in connection.execute("SELECT quote,state FROM orders WHERE state IN ('pending','submitted','unknown')"):
                    if row['state'] != 'pending':
                        raise BrokerError('Un ordre reste à rapprocher avec l’historique Bitpanda. Nouvel ordre bloqué.', 409)
                    if instant(json.loads(row['quote'])['expiresAt']) > datetime.now(timezone.utc).timestamp():
                        raise BrokerError('Un devis est déjà actif. Confirmez-le ou attendez son expiration.', 409)
                connection.execute("UPDATE orders SET state='expired' WHERE state='pending'")
                quote = self.client.request('POST', '/rfq/quotes', body=request)
                if not isinstance(quote, dict):
                    raise BrokerError('Devis Bitpanda invalide.', 502)
                try:
                    quote_id = identifier(quote['id'])
                    # UUIDs are compared in canonical form: Bitpanda may change their case.
                    quote['assetId'], quote['currencyId'] = identifier(quote['assetId']), identifier(quote['currencyId'])
                    if any(quote.get(k) != request[k] for k in ('assetId', 'currencyId', 'side')):
                        raise BrokerError('Le devis ne correspond pas à la demande.', 502)
                    if amount(quote.get('notional')) != requested or amount(quote.get('notional')) > limit:
                        raise BrokerError('Montant du devis différent du montant demandé.', 502)
                    amount(quote.get('price')); amount(quote.get('quantity'))
                    if instant(quote.get('expiresAt')) <= datetime.now(timezone.utc).timestamp():
                        raise BrokerError('Le devis est déjà expiré. Demandez-en un nouveau.', 409)
                except KeyError:
                    raise BrokerError('Devis Bitpanda incomplet.', 502) from None
                except BrokerError as error:
                    raise BrokerError(str(error), 502 if error.status == 400 else error.status) from None
                token = secrets.token_urlsafe(32)
                # Retain only the documented quote fields, never arbitrary upstream text.
                quote = {key: quote[key] for key in ('id', 'assetId', 'currencyId', 'side', 'price', 'quantity', 'notional', 'expiresAt')}
                try:
                    connection.execute('INSERT INTO orders VALUES (?, ?, ?, ?, ?)',
                                       (quote_id, json.dumps(quote), token, 'pending', datetime.now(timezone.utc).isoformat()))
                except sqlite3.IntegrityError:
                    raise BrokerError('Bitpanda a renvoyé un devis déjà présent dans le journal. Aucun ordre envoyé.', 502) from None
                connection.commit()
                return dict(quote=quote, confirmation_token=token)
            finally:
                connection.close()

    def accept(self, data):
        currency, limit = self.policy()
        if not isinstance(data, dict) or set(data) != {'quote_id', 'confirmation_token', 'confirm_real_order'} or data['confirm_real_order'] is not True:
            raise BrokerError('Confirmation explicite de l’ordre réel requise.')
        quote_id = identifier(data['quote_id'])
        token = data['confirmation_token']
        if not isinstance(token, str) or len(token) > 200:
            raise BrokerError('Confirmation invalide.', 403)
        with self.lock:
            connection = self.connect_db()
            try:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT * FROM orders WHERE id=?', (quote_id,)).fetchone()
                if row is None or not secrets.compare_digest(token, row['token']):
                    raise BrokerError('Confirmation invalide.', 403)
                if row['state'] != 'pending':
                    raise BrokerError('Ce devis a déjà été traité. Vérifiez le journal.', 409)
                quote = json.loads(row['quote'])
                if instant(quote['expiresAt']) <= datetime.now(timezone.utc).timestamp():
                    raise BrokerError('Devis expiré. Demandez-en un nouveau.', 409)
                if quote['currencyId'] != currency or amount(quote['notional']) > limit:
                    raise BrokerError('Le devis dépasse les limites actuelles.')
                # Commit BEFORE the remote call: restart/double click cannot resend it.
                connection.execute("UPDATE orders SET state='submitted' WHERE id=?", (quote_id,))
                connection.commit()
                try:
                    self.client.request('POST', f'/rfq/quotes/{quote_id}/accept')
                except Exception as failure:
                    connection.execute("UPDATE orders SET state='unknown' WHERE id=?", (quote_id,))
                    cause = f' ({failure})' if isinstance(failure, BrokerError) else ''
                    raise BrokerError(f'Résultat de l’ordre inconnu{cause}. Ne le renvoyez pas : vérifiez les opérations sur Bitpanda '
                                      'puis rapprochez l’ordre dans le journal. Les nouveaux ordres sont bloqués d’ici là.', 502) from None
                connection.execute("UPDATE orders SET state='executed' WHERE id=?", (quote_id,))
                return dict(quote_id=quote_id, state='executed', message='Bitpanda a confirmé l’exécution de l’ordre réel.')
            finally:
                connection.close()

    def reconcile(self, data):
        """Clôt un ordre `submitted`/`unknown` après vérification manuelle sur Bitpanda.

        Aucun appel financier : on enregistre seulement ce que l'utilisateur a constaté
        dans son historique, une fois le devis expiré depuis assez longtemps pour ne
        plus pouvoir être exécuté.
        """
        if (not isinstance(data, dict) or set(data) != {'quote_id', 'outcome', 'confirm_checked_bitpanda'}
                or data['confirm_checked_bitpanda'] is not True):
            raise BrokerError('Confirmez avoir vérifié l’historique de vos opérations Bitpanda.')
        if data['outcome'] not in ('executed', 'not_executed'):
            raise BrokerError('Résultat constaté invalide.')
        quote_id = identifier(data['quote_id'])
        with self.lock:
            connection = self.connect_db()
            try:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT quote, state FROM orders WHERE id=?', (quote_id,)).fetchone()
                if row is None:
                    raise BrokerError('Devis introuvable dans le journal.', 404)
                if row['state'] not in ('submitted', 'unknown'):
                    raise BrokerError('Ce devis n’est pas en attente de rapprochement.', 409)
                quote = json.loads(row['quote'])
                if not is_expired(quote, RECONCILE_MARGIN_SECONDS):
                    raise BrokerError(f'Attendez {RECONCILE_MARGIN_SECONDS} s après l’expiration du devis avant de le rapprocher.', 409)
                quote['reconciled'] = data['outcome']
                quote['reconciledAt'] = datetime.now(timezone.utc).isoformat()
                state = 'executed' if data['outcome'] == 'executed' else 'expired'
                connection.execute('UPDATE orders SET state=?, quote=? WHERE id=?', (state, json.dumps(quote), quote_id))
                connection.commit()
                return dict(quote_id=quote_id, state=state, message='Ordre rapproché. Les nouveaux devis sont de nouveau possibles.')
            finally:
                connection.close()
