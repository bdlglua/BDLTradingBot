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

/* ------------------------------------------------------------------ bot */
// Automatic trading: moving-average crossover on prices sampled by the cron
// trigger. Modes: off (default), paper (simulated fills, no Bitpanda order) and
// live (real orders through the same gate and journal as manual orders).
const BOT_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS bot_prices (asset_id TEXT NOT NULL, ts INTEGER NOT NULL, price TEXT NOT NULL, PRIMARY KEY (asset_id, ts))',
  'CREATE TABLE IF NOT EXISTS bot_state (mode TEXT PRIMARY KEY CHECK (mode IN (\'paper\',\'live\')), asset_id TEXT, position_quantity TEXT, entry_price TEXT, prior_spread REAL, last_run TEXT, last_status TEXT)',
  'CREATE TABLE IF NOT EXISTS bot_control (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL DEFAULT 0, reason TEXT)',
  'INSERT OR IGNORE INTO bot_control (id, paused) VALUES (1, 0)',
  'CREATE TABLE IF NOT EXISTS bot_trades (id TEXT PRIMARY KEY, mode TEXT NOT NULL, asset_id TEXT NOT NULL, side TEXT NOT NULL, price TEXT, quantity TEXT, notional TEXT, reason TEXT NOT NULL, quote_id TEXT, created TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS bot_trades_created ON bot_trades(mode, created DESC)',
];
const BOT_HISTORY = 500;
function integerSetting(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Failure(`${name} doit être un entier entre ${min} et ${max}.`, 503);
  return number;
}
export function botConfig(env) {
  const mode = String(env.BOT_MODE || 'off').trim().toLowerCase();
  if (!['off', 'paper', 'live'].includes(mode)) throw new Failure('BOT_MODE doit valoir off, paper ou live.', 503);
  const fast = integerSetting(env.BOT_FAST_PERIOD, 6, 1, 499, 'BOT_FAST_PERIOD');
  const slow = integerSetting(env.BOT_SLOW_PERIOD, 24, 2, 500, 'BOT_SLOW_PERIOD');
  if (fast >= slow) throw new Failure('BOT_FAST_PERIOD doit être inférieur à BOT_SLOW_PERIOD.', 503);
  const stopPercent = env.BOT_STOP_LOSS_PERCENT === undefined || env.BOT_STOP_LOSS_PERCENT === '' ? 5 : Number(env.BOT_STOP_LOSS_PERCENT);
  if (!Number.isFinite(stopPercent) || stopPercent <= 0 || stopPercent >= 100) throw new Failure('BOT_STOP_LOSS_PERCENT doit être compris entre 0 et 100.', 503);
  const maxBuysPerDay = integerSetting(env.BOT_MAX_BUYS_PER_DAY, 3, 1, 50, 'BOT_MAX_BUYS_PER_DAY');
  const amount = env.BOT_ORDER_AMOUNT || '10';
  try { decimal(amount); } catch { throw new Failure('BOT_ORDER_AMOUNT doit être un montant décimal positif.', 503); }
  let assetId = null;
  if (env.BOT_ASSET_ID) { try { assetId = uuid(env.BOT_ASSET_ID); } catch { throw new Failure('BOT_ASSET_ID doit être un UUID.', 503); } }
  const symbol = String(env.BOT_ASSET_SYMBOL || 'BTC').trim().toUpperCase();
  if (!/^[A-Z0-9.]{1,20}$/.test(symbol)) throw new Failure('BOT_ASSET_SYMBOL invalide.', 503);
  return {mode, fast, slow, stopLoss: stopPercent / 100, maxBuysPerDay, amount, assetId, symbol};
}
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
// Plain decimal text for a computed quantity (never exponential notation).
function quantityText(value) {
  const text = value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return text === '0' ? '0.00000001' : text;
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
    return requestQuote(env, payload);
  }
  // Shared by manual quotes and the bot. A request carries either a currency
  // `notional` (capped by the order limit) or, only for the bot's exit, the exact
  // asset `quantity` it bought: that sale reduces exposure and is not capped.
  async function requestQuote(env, payload) {
    const {currency, limit} = policy(env);
    const byQuantity = payload.quantity !== undefined;
    const requested = byQuantity ? decimal(payload.quantity) : decimal(payload.notional);
    if (byQuantity && payload.side !== 'SELL') throw new Failure('Seule la sortie du bot se fait par quantité.');
    if (payload.currencyId !== currency || (!byQuantity && requested > limit)) throw new Failure('Devise non autorisée ou plafond dépassé.');
    if (!env.BITPANDA_API_KEY) throw new Failure('Clé Bitpanda absente.', 503);
    const db = database(env), owner = crypto.randomUUID(), timestamp = now();
    const claim = await db.prepare("UPDATE gate SET owner=?,phase='requesting',release_at=? WHERE id=1 AND (phase='idle' OR (phase IN ('pending','requesting') AND release_at<=?))").bind(owner, timestamp + REQUEST_LEASE_MS, timestamp).run();
    if (claim.meta.changes !== 1) throw new Failure('Un devis est actif ou un ordre est à rapprocher avec Bitpanda. Nouvel ordre bloqué.', 409);
    try {
      const body = {asset_id: payload.assetId, currency_id: payload.currencyId, side: payload.side};
      if (byQuantity) body.quantity = payload.quantity; else body.notional = payload.notional;
      const response = await upstream(env, 'POST', '/v1/quotes', body);
      if (!response || typeof response !== 'object') throw new Failure('Devis Bitpanda invalide.', 502);
      const raw = normalizeQuote(response);
      let id, assetId, currencyId;
      try { id = uuid(raw.id); assetId = uuid(raw.assetId); currencyId = uuid(raw.currencyId); }
      catch { throw new Failure('Devis Bitpanda incomplet ou dans un format inconnu. Aucun ordre envoyé.', 502); }
      let notional, quantity;
      try { decimal(raw.price); quantity = decimal(raw.quantity); notional = decimal(raw.notional); }
      catch { throw new Failure('Prix, quantité ou montant du devis illisible. Aucun ordre envoyé.', 502); }
      const matches = byQuantity ? quantity === requested : notional === requested && notional <= limit;
      if (assetId !== payload.assetId || currencyId !== payload.currencyId || raw.side !== payload.side || !matches) throw new Failure('Le devis ne correspond pas à la demande.', 502);
      const expiry = expires(raw.expiresAt);
      if (expiry <= now()) throw new Failure('Devis déjà expiré.', 409);
      const result = {id, assetId, currencyId, side: raw.side, notional: raw.notional, price: raw.price, quantity: raw.quantity, expiresAt: raw.expiresAt};
      if (payload.origin) result.origin = payload.origin;
      if (byQuantity) result.exit = true;
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
    if (saved.currencyId !== currency || (!saved.exit && decimal(saved.notional) > limit)) throw new Failure('Le devis dépasse les limites actuelles.');
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
  async function ensureBotSchema(db) {
    await db.batch(BOT_SCHEMA.map(sql => db.prepare(sql)));
  }
  async function botAsset(env, config, state) {
    if (config.assetId) return config.assetId;
    if (state?.asset_id) return state.asset_id;
    const result = await upstream(env, 'GET', `/v1/assets?symbol=${encodeURIComponent(config.symbol)}&page_size=50`);
    const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    const matches = list.filter(asset => String(pick(asset, 'symbol') || '').toUpperCase() === config.symbol);
    if (matches.length !== 1) throw new Failure(`Actif ${config.symbol} ${matches.length ? 'ambigu' : 'introuvable'} : définissez BOT_ASSET_ID.`, 503);
    return uuid(pick(matches[0], 'id', 'asset_id', 'assetId'));
  }
  async function botPrice(env, assetId) {
    const result = await upstream(env, 'GET', `/v1/tickers/${assetId}`);
    const data = result && typeof result === 'object' && result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : result;
    let price = pick(data, 'price', 'last_price', 'lastPrice', 'value');
    if (price && typeof price === 'object') price = pick(price, 'value', 'amount');
    price = decimalText(price);
    try { decimal(price); } catch { throw new Failure('Prix Bitpanda illisible : aucun ordre.', 502); }
    return price;
  }
  async function botSnapshot(db, config, mode) {
    const state = await db.prepare('SELECT * FROM bot_state WHERE mode=?').bind(mode).first();
    const control = await db.prepare('SELECT paused, reason FROM bot_control WHERE id=1').first();
    return {state, control};
  }
  async function recordTrade(db, trade) {
    await db.prepare('INSERT INTO bot_trades (id,mode,asset_id,side,price,quantity,notional,reason,quote_id,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), trade.mode, trade.assetId, trade.side, trade.price, trade.quantity, trade.notional, trade.reason, trade.quoteId || null, new Date(now()).toISOString()).run();
  }
  async function saveState(db, mode, values) {
    await db.prepare(`INSERT INTO bot_state (mode, asset_id, position_quantity, entry_price, prior_spread, last_run, last_status) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(mode) DO UPDATE SET asset_id=excluded.asset_id, position_quantity=excluded.position_quantity, entry_price=excluded.entry_price,
      prior_spread=excluded.prior_spread, last_run=excluded.last_run, last_status=excluded.last_status`)
      .bind(mode, values.asset_id ?? null, values.position_quantity ?? null, values.entry_price ?? null, values.prior_spread ?? null, new Date(now()).toISOString(), values.last_status || '').run();
  }
  async function pauseBot(db, reason) {
    await db.prepare('UPDATE bot_control SET paused=1, reason=? WHERE id=1').bind(reason.slice(0, 300)).run();
  }
  // One cycle: sample the price, update the averages and act on a crossover.
  async function runBot(env) {
    const config = botConfig(env);
    if (config.mode === 'off') return {status: 'Bot arrêté (BOT_MODE=off).'};
    const db = database(env);
    await ensureBotSchema(db);
    const {state, control} = await botSnapshot(db, config, config.mode);
    const assetId = await botAsset(env, config, state);
    const price = await botPrice(env, assetId), priceNumber = Number(price);
    const minute = Math.floor(now() / 60000) * 60000;
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO bot_prices (asset_id, ts, price) VALUES (?,?,?)').bind(assetId, minute, price),
      db.prepare('DELETE FROM bot_prices WHERE asset_id=? AND ts NOT IN (SELECT ts FROM bot_prices WHERE asset_id=? ORDER BY ts DESC LIMIT ?)').bind(assetId, assetId, BOT_HISTORY),
    ]);
    const history = (await db.prepare('SELECT price FROM bot_prices WHERE asset_id=? ORDER BY ts DESC LIMIT ?').bind(assetId, config.slow).all()).results.map(row => Number(row.price)).reverse();
    const position = state?.position_quantity && state.asset_id === assetId ? state : null;
    const base = {asset_id: assetId, position_quantity: position?.position_quantity ?? null, entry_price: position?.entry_price ?? null, prior_spread: state?.asset_id === assetId ? state.prior_spread : null};
    if (history.length < config.slow) {
      await saveState(db, config.mode, {...base, last_status: `Collecte des prix : ${history.length}/${config.slow} relevés.`});
      return {status: 'warming-up', samples: history.length};
    }
    const spread = average(history.slice(-config.fast)) - average(history);
    const prior = base.prior_spread;
    let action = null;
    if (position) {
      if (priceNumber <= Number(position.entry_price) * (1 - config.stopLoss)) action = {side: 'SELL', reason: 'stop_loss'};
      else if (prior !== null && prior >= 0 && spread < 0) action = {side: 'SELL', reason: 'crossover'};
    } else if (prior !== null && prior <= 0 && spread > 0) action = {side: 'BUY', reason: 'crossover'};
    if (control?.paused) {
      await saveState(db, config.mode, {...base, prior_spread: spread, last_status: `En pause${control.reason ? ` : ${control.reason}` : ''}. Signal ignoré : ${action ? action.side : 'aucun'}.`});
      return {status: 'paused'};
    }
    if (!action) {
      await saveState(db, config.mode, {...base, prior_spread: spread, last_status: position ? 'Position ouverte, aucun signal de sortie.' : 'Aucun signal d’achat.'});
      return {status: 'idle'};
    }
    if (action.side === 'BUY') {
      const today = new Date(now()).toISOString().slice(0, 10);
      const buys = await db.prepare("SELECT COUNT(*) AS n FROM bot_trades WHERE mode=? AND side='BUY' AND created>=?").bind(config.mode, today).first();
      if ((buys?.n || 0) >= config.maxBuysPerDay) {
        await saveState(db, config.mode, {...base, prior_spread: spread, last_status: `Signal d’achat ignoré : ${config.maxBuysPerDay} achats déjà faits aujourd’hui.`});
        return {status: 'capped'};
      }
    }
    if (config.mode === 'paper') {
      const quantity = action.side === 'BUY' ? quantityText(Number(config.amount) / priceNumber) : position.position_quantity;
      const notional = action.side === 'BUY' ? config.amount : (Number(quantity) * priceNumber).toFixed(2);
      await recordTrade(db, {mode: 'paper', assetId, side: action.side, price, quantity, notional, reason: action.reason});
      await saveState(db, 'paper', {asset_id: assetId, position_quantity: action.side === 'BUY' ? quantity : null, entry_price: action.side === 'BUY' ? price : null,
        prior_spread: spread, last_status: `Simulation : ${action.side === 'BUY' ? 'achat' : 'vente'} au prix ${price}.`});
      return {status: 'paper-trade', side: action.side};
    }
    // Live: the same gate and journal as manual orders. Any failure pauses the bot
    // so that a person checks Bitpanda before anything else is sent.
    const {currency, limit} = policy(env);
    if (decimal(config.amount) > limit) throw new Failure('BOT_ORDER_AMOUNT dépasse BITPANDA_MAX_ORDER_AMOUNT.', 503);
    const request = action.side === 'BUY'
      ? {assetId, currencyId: currency, side: 'BUY', notional: config.amount, origin: 'bot'}
      : {assetId, currencyId: currency, side: 'SELL', quantity: position.position_quantity, origin: 'bot'};
    let quoted;
    try { quoted = await requestQuote(env, request); }
    catch (error) {
      // No order was sent: keep running, the next cycle will retry on a new signal.
      await saveState(db, 'live', {...base, prior_spread: prior, last_status: `Devis refusé, aucun ordre : ${error.message}`});
      return {status: 'quote-failed'};
    }
    try { await accept(env, {quote_id: quoted.quote.id, confirmation_token: quoted.confirmation_token, confirm_real_order: true}); }
    catch (error) {
      await pauseBot(db, `Ordre ${action.side} au résultat incertain : vérifiez Bitpanda et rapprochez-le.`);
      await saveState(db, 'live', {...base, prior_spread: prior, last_status: `Ordre non confirmé, bot en pause : ${error.message}`});
      return {status: 'paused-after-error'};
    }
    const executed = quoted.quote;
    await recordTrade(db, {mode: 'live', assetId, side: action.side, price: executed.price, quantity: executed.quantity, notional: executed.notional, reason: action.reason, quoteId: executed.id});
    await saveState(db, 'live', {asset_id: assetId, position_quantity: action.side === 'BUY' ? executed.quantity : null, entry_price: action.side === 'BUY' ? executed.price : null,
      prior_spread: spread, last_status: `Ordre réel ${action.side === 'BUY' ? 'd’achat' : 'de vente'} exécuté au prix ${executed.price}.`});
    return {status: 'live-trade', side: action.side};
  }
  async function botStatus(env) {
    let config, configError = '';
    try { config = botConfig(env); } catch (error) { configError = error.message; }
    const response = {config: config || null, config_error: configError, available: Boolean(env.DB)};
    if (!env.DB) return response;
    const db = database(env);
    await ensureBotSchema(db);
    const mode = config && config.mode !== 'off' ? config.mode : 'paper';
    const {state, control} = await botSnapshot(db, config, mode);
    response.mode_shown = mode;
    response.paused = Boolean(control?.paused);
    response.pause_reason = control?.reason || '';
    response.state = state || null;
    if (state?.asset_id && config) {
      const rows = (await db.prepare('SELECT price, ts FROM bot_prices WHERE asset_id=? ORDER BY ts DESC LIMIT ?').bind(state.asset_id, config.slow).all()).results.reverse();
      const values = rows.map(row => Number(row.price));
      response.samples = values.length;
      response.last_price = rows.at(-1)?.price ?? null;
      response.last_price_at = rows.length ? new Date(rows.at(-1).ts).toISOString() : null;
      if (values.length >= config.slow) { response.fast_average = average(values.slice(-config.fast)); response.slow_average = average(values); }
    }
    response.trades = (await db.prepare('SELECT mode,asset_id,side,price,quantity,notional,reason,quote_id,created FROM bot_trades ORDER BY created DESC LIMIT 50').all()).results;
    return response;
  }
  async function botControl(env, data) {
    exactFields(data, ['paused']);
    if (typeof data.paused !== 'boolean') throw new Failure('Valeur de pause invalide.');
    const db = database(env);
    await ensureBotSchema(db);
    await db.prepare('UPDATE bot_control SET paused=?, reason=? WHERE id=1').bind(data.paused ? 1 : 0, data.paused ? 'Mis en pause depuis le tableau de bord.' : null).run();
    return {paused: data.paused, message: data.paused ? 'Bot en pause : aucun ordre ne sera passé.' : 'Bot relancé.'};
  }
  return {
    async scheduled(controller, env, ctx) {
      const run = runBot(env).catch(async error => {
        // Record the failure where the dashboard can show it; never retry an order.
        try {
          const config = botConfig(env), db = database(env);
          if (config.mode !== 'off') await db.prepare('UPDATE bot_state SET last_run=?, last_status=? WHERE mode=?').bind(new Date(now()).toISOString(), `Erreur : ${error.message}`.slice(0, 300), config.mode).run();
        } catch { /* configuration or database unavailable */ }
        return {status: 'error', error: error.message};
      });
      if (ctx?.waitUntil) ctx.waitUntil(run);
      return run;
    },
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
          return reply(200, {broker: 'Bitpanda', api_key_present: Boolean(env.BITPANDA_API_KEY), trading_enabled: enabled, currency_id: enabled ? uuid(env.BITPANDA_TRADING_CURRENCY_ID) : null, max_order_amount: enabled ? env.BITPANDA_MAX_ORDER_AMOUNT : null, reason, connection_verified: false, journal_available: Boolean(env.DB), features: {backtest: false, reconcile: true, bot: true}});
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
        if (request.method === 'GET' && url.pathname === '/api/bot/status') return reply(200, await botStatus(env));
        if (request.method === 'POST' && url.pathname === '/api/backtest') throw new Failure('Ce serveur gratuit fournit l’espace Bitpanda. Le laboratoire Python nécessite un serveur Python.', 501);
        const actions = {'/api/bitpanda/quote': quote, '/api/bitpanda/accept': accept, '/api/bitpanda/reconcile': reconcile, '/api/bot/control': botControl};
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
