// Backend Cloudflare Workers Free + D1. Aucun secret dans ce fichier.
// API officielle : https://github.com/bitpanda-labs/bitpanda-public-api
const BASE = 'https://api.public.bitpanda.com';
const SCALE = 10n ** 18n;
// Un appel « requesting » interrompu (arrêt du Worker) libère le verrou après ce délai,
// bien supérieur au timeout réseau : aucun devis n'est alors en cours d'enregistrement.
const REQUEST_LEASE_MS = 120000;
// Délai après expiration avant rapprochement : aucune acceptation ne peut encore être en vol.
const RECONCILE_MARGIN_MS = 30000;
const encoder = new TextEncoder();
class Failure extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) throw new Failure('Identifiant UUID invalide.');
  return value.toLowerCase();
}
function decimal(value) {
  if (typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,18})?$/.test(value)) throw new Failure('Montant décimal positif requis, sans notation exponentielle.');
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (scaled <= 0n || scaled > 10n ** 15n * SCALE) throw new Failure('Montant hors limites.');
  return scaled;
}
function expires(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Failure('Expiration du devis invalide.', 502);
  return Date.parse(value);
}
function pick(object, ...names) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  for (const name of names) if (object[name] !== undefined && object[name] !== null) return object[name];
  return undefined;
}
function decimalText(value) {
  // Numbers are accepted only when their text form is a plain decimal.
  return typeof value === 'number' && Number.isFinite(value) && !/e/i.test(String(value)) ? String(value) : value;
}
// Production answers {data: {quote_id, side, asset_id, currency_id, quote: {...}}};
// the docs also show camelCase and flat variants. All are mapped to one shape.
export function normalizeQuote(raw) {
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const inner = pick(data, 'quote') && typeof data.quote === 'object' ? data.quote : data;
  const field = (...names) => pick(inner, ...names) ?? pick(data, ...names);
  const side = field('side');
  return {
    id: pick(data, 'quote_id', 'quoteId', 'id') ?? pick(inner, 'quote_id', 'quoteId', 'id'),
    assetId: field('asset_id', 'assetId'), currencyId: field('currency_id', 'currencyId'),
    side: typeof side === 'string' ? side.toUpperCase() : side,
    price: decimalText(field('price_with_premium', 'priceWithPremium', 'price')),
    quantity: decimalText(field('quantity')), notional: decimalText(field('notional')),
    expiresAt: field('expires_at', 'expiresAt'),
  };
}
function exactFields(data, fields) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).sort().join(',') !== fields.sort().join(',')) throw new Failure('Paramètres manquants ou inconnus.');
}
async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 512 || b.length > 512) return false;
  const hashes = await Promise.all([a, b].map(text => crypto.subtle.digest('SHA-256', encoder.encode(text))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function csrf(secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('BDLTradingBot/CSRF/v1'));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}
function configuredOrigin(env) {
  let origin;
  try { origin = new URL(env.DASHBOARD_PUBLIC_ORIGIN); } catch { throw new Failure('Origine HTTPS du site à configurer.', 503); }
  if (origin.protocol !== 'https:' || origin.origin !== env.DASHBOARD_PUBLIC_ORIGIN || origin.username || origin.password || origin.port) throw new Failure('Origine HTTPS exacte requise, sans chemin.', 503);
  return origin.origin;
}
function requireAccessToken(env) {
  // Checked after the origin so that the site can read this configuration error.
  if (!/^[\x21-\x7e]{32,256}$/.test(env.DASHBOARD_ACCESS_TOKEN || '')) throw new Failure('Code d’accès DASHBOARD_ACCESS_TOKEN à configurer dans les secrets du Worker.', 503);
}
function upstreamDetail(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return ''; }
  if (!data || typeof data !== 'object') return '';
  for (const key of ['message', 'error', 'detail', 'title', 'errors']) {
    let value = data[key];
    if (Array.isArray(value)) value = value[0];
    if (value && typeof value === 'object') value = value.message || value.detail || value.title || value.code;
    if (typeof value === 'string' && value.trim()) return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return '';
}
function policy(env) {
  if (env.BITPANDA_ENABLE_TRADING !== '1') throw new Failure('Trading réel désactivé dans les paramètres du serveur.', 503);
  try { return {currency: uuid(env.BITPANDA_TRADING_CURRENCY_ID), limit: decimal(env.BITPANDA_MAX_ORDER_AMOUNT)}; }
  catch { throw new Failure('Configurez la devise UUID et le plafond par ordre.', 503); }
}
function database(env) {
  if (!env.DB) throw new Failure('Base D1 persistante non connectée.', 503);
  // Primary-first reads keep an operation's state consistent with its writes.
  return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
}
async function readLimited(stream, maximum) {
  if (!stream) return '';
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new Failure('Données trop volumineuses.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}
async function jsonBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new Failure('JSON requis.', 415);
  try { return JSON.parse(await readLimited(request.body, 16384)); }
  catch (error) { if (error instanceof Failure) throw error; throw new Failure('JSON invalide.'); }
}

export function createWorker(transport = fetch, now = Date.now) {
  async function upstream(env, method, path, body) {
    if (!env.BITPANDA_API_KEY) throw new Failure('Clé Bitpanda absente des secrets du serveur.', 503);
    const headers = {'x-api-key': env.BITPANDA_API_KEY, Accept: 'application/json'};
    // Redirections are never followed (the key must not leave Bitpanda) but are reported.
    const options = {method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000)};
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const route = `${method} ${path.split('?')[0]}`;
    let response;
    try { response = await transport(BASE + path, options); }
    catch (error) {
      const cause = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'délai de 15 s dépassé'
        : `erreur réseau${typeof error?.message === 'string' && error.message ? ` : ${error.message.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
      throw new Failure(`Bitpanda injoignable (${route}, ${cause}). Aucun renvoi automatique.`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      let target = 'destination inconnue';
      try { const location = new URL(response.headers.get('Location'), BASE); target = (location.origin + location.pathname).slice(0, 120); } catch { /* en-tête absent ou invalide */ }
      throw new Failure(`Bitpanda a redirigé ${route} vers ${target} (HTTP ${response.status}). Redirection non suivie pour protéger la clé.`, 502);
    }
    if (!response.ok) {
      let detail = '';
      try { detail = upstreamDetail(await readLimited(response.body, 4096)); } catch { /* corps illisible ou trop long */ }
      const known = {401: 'Clé Bitpanda refusée.', 403: 'Accès refusé par Bitpanda.', 404: 'Ressource introuvable sur Bitpanda.', 429: 'Limite de requêtes Bitpanda atteinte. Attendez avant de réessayer.'};
      throw new Failure((known[response.status] || `Bitpanda a refusé la requête (HTTP ${response.status}).`) + ` [${route}]` + (detail ? ` Détail : ${detail}` : ''), 502);
    }
    try {
      const raw = await readLimited(response.body, 4000000);
      return raw ? JSON.parse(raw) : {};
    } catch { throw new Failure('Réponse Bitpanda illisible.', 502); }
  }
  async function quote(env, data) {
    const {currency, limit} = policy(env);
    exactFields(data, ['assetId', 'currencyId', 'side', 'notional']);
    const payload = {assetId: uuid(data.assetId), currencyId: uuid(data.currencyId), side: data.side, notional: data.notional};
    const requested = decimal(payload.notional);
    if (!['BUY', 'SELL'].includes(payload.side) || payload.currencyId !== currency || requested > limit) throw new Failure('Sens invalide, devise non autorisée ou plafond dépassé.');
    if (!env.BITPANDA_API_KEY) throw new Failure('Clé Bitpanda absente.', 503);
    const db = database(env), owner = crypto.randomUUID(), timestamp = now();
    const claim = await db.prepare("UPDATE gate SET owner=?,phase='requesting',release_at=? WHERE id=1 AND (phase='idle' OR (phase IN ('pending','requesting') AND release_at<=?))").bind(owner, timestamp + REQUEST_LEASE_MS, timestamp).run();
    if (claim.meta.changes !== 1) throw new Failure('Un devis est actif ou un ordre est à rapprocher avec Bitpanda. Nouvel ordre bloqué.', 409);
    try {
      const response = await upstream(env, 'POST', '/v1/quotes', {asset_id: payload.assetId, currency_id: payload.currencyId, side: payload.side, notional: payload.notional});
      if (!response || typeof response !== 'object') throw new Failure('Devis Bitpanda invalide.', 502);
      const raw = normalizeQuote(response);
      let id, assetId, currencyId;
      try { id = uuid(raw.id); assetId = uuid(raw.assetId); currencyId = uuid(raw.currencyId); }
      catch { throw new Failure('Devis Bitpanda incomplet ou dans un format inconnu. Aucun ordre envoyé.', 502); }
      if (assetId !== payload.assetId || currencyId !== payload.currencyId || raw.side !== payload.side || decimal(raw.notional) !== requested || decimal(raw.notional) > limit) throw new Failure('Le devis ne correspond pas à la demande.', 502);
      try { decimal(raw.price); decimal(raw.quantity); }
      catch { throw new Failure('Prix ou quantité du devis illisible. Aucun ordre envoyé.', 502); }
      const expiry = expires(raw.expiresAt);
      if (expiry <= now()) throw new Failure('Devis déjà expiré.', 409);
      const result = {id, assetId, currencyId, side: raw.side, notional: raw.notional, price: raw.price, quantity: raw.quantity, expiresAt: raw.expiresAt};
      const token = randomToken();
      const stored = await db.batch([
        db.prepare("UPDATE orders SET state='expired' WHERE state='pending' AND expires<=?").bind(now()),
        db.prepare('INSERT INTO orders (id,quote,token,state,expires,created) VALUES (?,?,?,\'pending\',?,?)').bind(id, JSON.stringify(result), token, expiry, new Date(now()).toISOString()),
        db.prepare("UPDATE gate SET owner=?,phase='pending',release_at=? WHERE id=1 AND owner=? AND phase='requesting'").bind(id, expiry, owner),
      ]);
      if (stored[1].meta.changes !== 1 || stored[2].meta.changes !== 1) throw new Failure('Journal du devis non confirmé. Aucun ordre envoyé.', 503);
      return {quote: result, confirmation_token: token};
    } catch (error) {
      // Only a quote was requested; no acceptance is sent on this path.
      await db.prepare("UPDATE gate SET owner=NULL,phase='idle',release_at=0 WHERE id=1 AND owner=? AND phase='requesting'").bind(owner).run();
      throw error;
    }
  }
  async function accept(env, data) {
    const {currency, limit} = policy(env);
    exactFields(data, ['quote_id', 'confirmation_token', 'confirm_real_order']);
    if (data.confirm_real_order !== true) throw new Failure('Confirmation explicite de l’ordre réel requise.');
    const id = uuid(data.quote_id), db = database(env);
    const row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!row || !await equal(row.token, data.confirmation_token)) throw new Failure('Confirmation invalide.', 403);
    if (row.state !== 'pending') throw new Failure('Ce devis a déjà été traité. Vérifiez le journal.', 409);
    const saved = JSON.parse(row.quote);
    if (row.expires <= now()) throw new Failure('Devis expiré.', 409);
    if (saved.currencyId !== currency || decimal(saved.notional) > limit) throw new Failure('Le devis dépasse les limites actuelles.');
    const claimed = await db.batch([
      db.prepare("UPDATE orders SET state='submitted' WHERE id=? AND state='pending' AND EXISTS (SELECT 1 FROM gate WHERE id=1 AND owner=orders.id AND phase='pending')").bind(id),
      db.prepare("UPDATE gate SET phase='submitted',release_at=0 WHERE id=1 AND owner=? AND phase='pending' AND EXISTS (SELECT 1 FROM orders WHERE id=? AND state='submitted')").bind(id, id),
    ]);
    if (claimed[0].meta.changes !== 1 || claimed[1].meta.changes !== 1) throw new Failure('Ordre déjà envoyé ou journal bloqué. Aucun renvoi.', 409);
    // Durable claim precedes the financial call: crashes and double clicks cannot resend it.
    try { await upstream(env, 'POST', `/v1/quotes/${id}/accept`); }
    catch (failure) {
      await db.batch([
        db.prepare("UPDATE orders SET state='unknown' WHERE id=? AND state='submitted'").bind(id),
        db.prepare("UPDATE gate SET phase='unknown' WHERE id=1 AND owner=? AND phase='submitted'").bind(id),
      ]);
      const cause = failure instanceof Failure ? ` (${failure.message})` : '';
      throw new Failure(`Résultat de l’ordre inconnu${cause}. Vérifiez les opérations sur Bitpanda puis rapprochez l’ordre dans le journal : les nouveaux ordres sont bloqués d’ici là.`, 502);
    }
    await db.batch([
      db.prepare("UPDATE orders SET state='executed' WHERE id=? AND state='submitted'").bind(id),
      db.prepare("UPDATE gate SET owner=NULL,phase='idle',release_at=0 WHERE id=1 AND owner=? AND phase='submitted'").bind(id),
    ]);
    return {quote_id: id, state: 'executed', message: 'Bitpanda a confirmé l’exécution de l’ordre réel.'};
  }
  async function reconcile(env, data) {
    exactFields(data, ['quote_id', 'outcome', 'confirm_checked_bitpanda']);
    if (data.confirm_checked_bitpanda !== true) throw new Failure('Confirmez avoir vérifié l’historique de vos opérations Bitpanda.');
    if (!['executed', 'not_executed'].includes(data.outcome)) throw new Failure('Résultat constaté invalide.');
    const id = uuid(data.quote_id), db = database(env);
    const row = await db.prepare('SELECT quote,state,expires FROM orders WHERE id=?').bind(id).first();
    if (!row) throw new Failure('Devis introuvable dans le journal.', 404);
    if (!['submitted', 'unknown'].includes(row.state)) throw new Failure('Ce devis n’est pas en attente de rapprochement.', 409);
    if (row.expires + RECONCILE_MARGIN_MS > now()) throw new Failure(`Attendez ${RECONCILE_MARGIN_MS / 1000} s après l’expiration du devis avant de le rapprocher.`, 409);
    const saved = {...JSON.parse(row.quote), reconciled: data.outcome, reconciledAt: new Date(now()).toISOString()};
    const state = data.outcome === 'executed' ? 'executed' : 'expired';
    // Aucun appel Bitpanda : seule la constatation de l'utilisateur est enregistrée.
    const result = await db.batch([
      db.prepare("UPDATE orders SET state=?,quote=? WHERE id=? AND state IN ('submitted','unknown')").bind(state, JSON.stringify(saved), id),
      db.prepare("UPDATE gate SET owner=NULL,phase='idle',release_at=0 WHERE id=1 AND owner=? AND phase IN ('submitted','unknown')").bind(id),
    ]);
    if (result[0].meta.changes !== 1) throw new Failure('Ce devis a changé d’état. Actualisez le journal.', 409);
    return {quote_id: id, state, message: 'Ordre rapproché. Les nouveaux devis sont de nouveau possibles.'};
  }
  return {
    async fetch(request, env) {
      const url = new URL(request.url), incomingOrigin = request.headers.get('Origin');
      let allowedOrigin = '';
      function reply(status, data) {
        const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin'};
        if (incomingOrigin && incomingOrigin === allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
        return new Response(JSON.stringify(data), {status, headers});
      }
      try {
        if (url.pathname === '/health' && request.method === 'GET') return reply(200, {status: 'ok'});
        const origin = configuredOrigin(env);
        if (incomingOrigin && incomingOrigin !== origin) throw new Failure('Origine refusée.', 403);
        allowedOrigin = origin;
        if (request.method === 'OPTIONS') {
          const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
          if (incomingOrigin !== allowedOrigin || !['GET', 'POST'].includes(request.headers.get('Access-Control-Request-Method')) || requestedHeaders.some(name => !['authorization', 'content-type', 'x-csrf-token'].includes(name))) throw new Failure('Prérequête refusée.', 403);
          return new Response(null, {status: 204, headers: {'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-CSRF-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin'}});
        }
        requireAccessToken(env);
        if (!await equal(request.headers.get('Authorization'), 'Bearer ' + env.DASHBOARD_ACCESS_TOKEN)) throw new Failure('Code d’accès au serveur requis ou incorrect.', 401);
        if (request.method === 'GET' && url.pathname === '/api/session') return reply(200, {csrf_token: await csrf(env.DASHBOARD_ACCESS_TOKEN)});
        if (request.method === 'GET' && url.pathname === '/api/bitpanda/status') {
          let enabled = false, reason = '';
          try { policy(env); enabled = Boolean(env.BITPANDA_API_KEY && env.DB); } catch (error) { reason = error.message; }
          if (!env.DB) reason = 'Base D1 persistante non connectée.';
          else if (!env.BITPANDA_API_KEY) reason = 'Clé Bitpanda absente.';
          return reply(200, {broker: 'Bitpanda', api_key_present: Boolean(env.BITPANDA_API_KEY), trading_enabled: enabled, currency_id: enabled ? uuid(env.BITPANDA_TRADING_CURRENCY_ID) : null, max_order_amount: enabled ? env.BITPANDA_MAX_ORDER_AMOUNT : null, reason, connection_verified: false, journal_available: Boolean(env.DB), features: {backtest: false, reconcile: true}});
        }
        if (request.method === 'GET' && url.pathname === '/api/bitpanda/journal') {
          const result = await database(env).prepare('SELECT id,quote,state,expires,created FROM orders ORDER BY created DESC LIMIT 100').all();
          return reply(200, {orders: result.results.map(row => ({id: row.id, quote: JSON.parse(row.quote), state: row.state === 'pending' && row.expires <= now() ? 'expired' : row.state, created: row.created}))});
        }
        if (request.method === 'GET' && url.pathname === '/api/bitpanda/ticker') {
          const keys = [...url.searchParams.keys()];
          if (keys.length !== 1 || keys[0] !== 'assetId') throw new Failure('Paramètres de recherche invalides.');
          return reply(200, {result: await upstream(env, 'GET', `/v1/tickers/${uuid(url.searchParams.get('assetId'))}`)});
        }
        const reads = {'/api/bitpanda/assets': ['/v1/assets', ['symbol', 'cursor', 'id']], '/api/bitpanda/currencies': ['/v1/currencies', []], '/api/bitpanda/holdings': ['/v1/portfolio', []], '/api/bitpanda/operations': ['/v1/operations', ['cursor']]};
        if (request.method === 'GET' && reads[url.pathname]) {
          const [path, permitted] = reads[url.pathname], query = new URLSearchParams();
          for (const [name, value] of url.searchParams) {
            if (!permitted.includes(name) || value.length > 200 || query.has(name)) throw new Failure('Paramètres de recherche invalides.');
            query.set(name, name === 'id' ? uuid(value) : value);
          }
          if (permitted.length) query.set('page_size', '50');
          return reply(200, {result: await upstream(env, 'GET', path + (query.size ? '?' + query : ''))});
        }
        if (request.method === 'POST' && url.pathname === '/api/backtest') throw new Failure('Ce serveur gratuit fournit l’espace Bitpanda. Le laboratoire Python nécessite un serveur Python.', 501);
        const actions = {'/api/bitpanda/quote': quote, '/api/bitpanda/accept': accept, '/api/bitpanda/reconcile': reconcile};
        if (request.method === 'POST' && Object.hasOwn(actions, url.pathname)) {
          if (!await equal(request.headers.get('X-CSRF-Token'), await csrf(env.DASHBOARD_ACCESS_TOKEN))) throw new Failure('Session invalide. Reconnectez le serveur.', 403);
          const data = await jsonBody(request);
          return reply(200, await actions[url.pathname](env, data));
        }
        throw new Failure('Route introuvable.', 404);
      } catch (error) {
        return reply(error instanceof Failure ? error.status : 503, {error: error instanceof Failure ? error.message : 'Journal persistant indisponible. Aucun renvoi automatique : vérifiez Bitpanda avant toute nouvelle opération.'});
      }
    },
  };
}
export default createWorker();
