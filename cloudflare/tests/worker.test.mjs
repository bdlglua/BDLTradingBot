// API financière entièrement fictive ; véritable moteur SQLite pour les requêtes D1.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createWorker} from '../worker.mjs';

const ASSET = '11111111-1111-4111-8111-111111111111';
const CURRENCY = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://bdlglua.github.io';
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(schema); this.failBatch = false; }
  withSession(mode) { assert.equal(mode, 'first-primary'); return this; }
  prepare(sql) {
    const db = this;
    const make = params => ({
      bind: (...values) => make(values),
      run: async () => ({meta: {changes: Number(db.sqlite.prepare(sql).run(...params).changes)}}),
      first: async () => db.sqlite.prepare(sql).get(...params) || null,
      all: async () => ({results: db.sqlite.prepare(sql).all(...params)}),
    });
    return make([]);
  }
  async batch(statements) {
    if (this.failBatch) { this.failBatch = false; throw new Error('Quota D1 fictif.'); }
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT'); return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
function fixture(t) {
  const db = new D1(); t.after(() => db.sqlite.close());
  const env = {DB: db, DASHBOARD_PUBLIC_ORIGIN: ORIGIN,
    DASHBOARD_ACCESS_TOKEN: 'fake-access-code-longer-than-32-characters',
    BITPANDA_API_KEY: 'fake-not-a-real-bitpanda-key', BITPANDA_ENABLE_TRADING: '1',
    BITPANDA_TRADING_CURRENCY_ID: CURRENCY, BITPANDA_MAX_ORDER_AMOUNT: '100'};
  const state = {now: Date.now(), calls: [], failAccept: false, failStore: false, overrides: {}};
  const transport = async (url, options) => {
    assert.ok(url.startsWith('https://api.public.bitpanda.com/v1/'));
    assert.equal(options.redirect, 'manual');
    if (state.respond) return state.respond(url, options);
    assert.equal(options.headers['x-api-key'], env.BITPANDA_API_KEY);
    state.calls.push({url, options});
    if (url.endsWith('/accept')) {
      if (state.failAccept) throw new Error('Timeout fictif.');
      if (state.failStore) db.failBatch = true;
      return Response.json({});
    }
    if (url.endsWith('/v1/quotes')) {
      // Format documented for production: snake_case, wrapped in data, prices in a nested quote.
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['asset_id', 'currency_id', 'notional', 'side']);
      const {notional, ...overrides} = state.overrides;
      return Response.json({data: {quote_id: crypto.randomUUID(), status: 'OPEN', side: body.side, asset_id: body.asset_id,
        currency_id: body.currency_id, quote: {price: '49900', price_with_premium: '50000', premium: '100', quantity: '0.002',
          notional: notional ?? body.notional, expires_at: new Date(state.now + 60000).toISOString()}, ...overrides}});
    }
    return Response.json([]);
  };
  let worker = createWorker(transport, () => state.now);
  let csrfToken = '';
  async function call(path, data, overrides = {}) {
    const headers = {Origin: ORIGIN, Authorization: 'Bearer '+env.DASHBOARD_ACCESS_TOKEN, ...overrides};
    const options = {headers};
    if (data !== undefined) {
      options.method = 'POST'; options.body = JSON.stringify(data);
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrfToken;
    }
    const response = await worker.fetch(new Request('https://test.workers.dev'+path, options), env);
    return {status: response.status, headers: response.headers, body: await response.json()};
  }
  async function session() { csrfToken = (await call('/api/session')).body.csrf_token; }
  async function quote(changes = {}) {
    await session();
    return call('/api/bitpanda/quote', {assetId: ASSET, currencyId: CURRENCY, side: 'BUY', notional: '100', ...changes});
  }
  function confirmation(result, changes = {}) {
    return {quote_id: result.body.quote.id, confirmation_token: result.body.confirmation_token, confirm_real_order: true, ...changes};
  }
  return {db, env, state, call, session, quote, confirmation,
    restart: () => { worker = createWorker(transport, () => state.now); },
    acceptCalls: () => state.calls.filter(call => call.url.endsWith('/accept')).length};
}

test('les lectures privées exigent le code et l’origine exacte', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/api/bitpanda/holdings', undefined, {Authorization: ''})).status, 401);
  const rejected = await f.call('/api/bitpanda/holdings', undefined, {Origin: 'https://attacker.example'});
  assert.equal(rejected.status, 403); assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(f.state.calls.length, 0);
});
test('prérequête CORS, sans exposition de secret', async t => {
  const f = fixture(t), worker = createWorker();
  const response = await worker.fetch(new Request('https://test.workers.dev/api/bitpanda/accept', {method:'OPTIONS', headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type, X-CSRF-Token'}}), f.env);
  assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const session = await f.call('/api/session');
  assert.equal(session.status, 200); assert.ok(session.body.csrf_token);
  assert.ok(!JSON.stringify(session.body).includes(f.env.BITPANDA_API_KEY));
});
test('un devis ne passe aucun ordre et exige la confirmation explicite', async t => {
  const f = fixture(t), quote = await f.quote();
  assert.equal(quote.status, 200); assert.equal(f.acceptCalls(), 0);
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote, {confirm_real_order: false}))).status, 400);
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote, {confirmation_token:'wrong'}))).status, 403);
  assert.equal(f.acceptCalls(), 0);
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).body.state, 'executed');
  f.restart();
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 409);
  assert.equal(f.acceptCalls(), 1);
});
test('la session CSRF est indispensable pour les ordres', async t => {
  const f = fixture(t);
  const result = await f.call('/api/bitpanda/quote', {assetId:ASSET, currencyId:CURRENCY, side:'BUY', notional:'100'});
  assert.equal(result.status, 403); assert.equal(f.state.calls.length, 0);
});
test('plafond exact, devise, montant et activation sont contrôlés avant l’API', async t => {
  const f = fixture(t);
  for (const changes of [{notional:'101'},{notional:'NaN'},{notional:'0'},{notional:'-1'},{notional:100},{currencyId:ASSET},{side:'SHORT'}]) assert.equal((await f.quote(changes)).status, 400);
  f.env.BITPANDA_MAX_ORDER_AMOUNT = '1.000000000000000001';
  assert.equal((await f.quote({notional:'1.000000000000000002'})).status, 400);
  f.env.BITPANDA_ENABLE_TRADING = '0';
  assert.equal((await f.quote()).status, 503); assert.equal(f.state.calls.length, 0);
});
test('la vente utilise aussi un montant en devise', async t => {
  const f = fixture(t), result = await f.quote({side:'SELL'});
  assert.equal(result.status, 200); assert.equal(result.body.quote.side, 'SELL');
  assert.equal(JSON.parse(f.state.calls[0].options.body).notional, '100');
});
test('un seul devis peut être actif, même entre deux instances Worker', async t => {
  const f = fixture(t);
  assert.equal((await f.quote()).status, 200); f.restart();
  assert.equal((await f.quote()).status, 409); assert.equal(f.state.calls.length, 1);
});
test('deux confirmations concurrentes ne passent qu’un ordre', async t => {
  const f = fixture(t), quote = await f.quote();
  const results = await Promise.all([f.call('/api/bitpanda/accept', f.confirmation(quote)), f.call('/api/bitpanda/accept', f.confirmation(quote))]);
  assert.deepEqual(results.map(result=>result.status).sort(), [200,409]); assert.equal(f.acceptCalls(), 1);
});
test('expiration et réduction du plafond sont revérifiées à la confirmation', async t => {
  const f = fixture(t), quote = await f.quote();
  f.env.BITPANDA_MAX_ORDER_AMOUNT = '50';
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 400);
  f.env.BITPANDA_MAX_ORDER_AMOUNT = '100'; f.state.now += 60001;
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 409);
  assert.equal(f.acceptCalls(), 0); assert.equal((await f.quote()).status, 200);
});
test('devis différent de la demande refusé sans acceptation', async t => {
  const f = fixture(t); f.state.overrides.notional = '101';
  assert.equal((await f.quote()).status, 502); assert.equal(f.acceptCalls(), 0);
  assert.equal((await f.call('/api/bitpanda/journal')).body.orders.length, 0);
});
test('résultat inconnu bloque les nouveaux ordres après redémarrage', async t => {
  const f = fixture(t), quote = await f.quote(); f.state.failAccept = true;
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 502);
  f.restart(); f.db.sqlite.exec(schema);
  assert.equal((await f.quote()).status, 409);
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 409);
  const orders = (await f.call('/api/bitpanda/journal')).body.orders;
  assert.equal(orders[0].state, 'unknown'); assert.ok(!JSON.stringify(orders).includes(quote.body.confirmation_token));
  assert.equal(f.acceptCalls(), 1);
});
test('quota D1 avant l’envoi interdit l’appel financier', async t => {
  const f = fixture(t), quote = await f.quote(); f.db.failBatch = true;
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 503);
  assert.equal(f.acceptCalls(), 0);
});
test('quota D1 après l’envoi conserve submitted et empêche le renvoi', async t => {
  const f = fixture(t), quote = await f.quote(); f.state.failStore = true;
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 503); f.restart();
  assert.equal((await f.quote()).status, 409);
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 409);
  assert.equal((await f.call('/api/bitpanda/journal')).body.orders[0].state, 'submitted');
  assert.equal(f.acceptCalls(), 1);
});
test('base absente bloque le trading ; le laboratoire n’est pas inventé', async t => {
  const f = fixture(t); delete f.env.DB;
  const status = await f.call('/api/bitpanda/status');
  assert.equal(status.body.trading_enabled, false); assert.equal(status.body.features.backtest, false);
  assert.equal((await f.quote()).status, 503); assert.equal(f.state.calls.length, 0);
  assert.equal((await f.call('/api/backtest', {})).status, 501);
});
test('rapprochement manuel après vérification : aucun appel financier, verrou levé', async t => {
  const f = fixture(t), quote = await f.quote(); f.state.failAccept = true;
  assert.equal((await f.call('/api/bitpanda/accept', f.confirmation(quote))).status, 502);
  const id = quote.body.quote.id, calls = f.state.calls.length;
  const body = {quote_id: id, outcome: 'not_executed', confirm_checked_bitpanda: true};
  assert.equal((await f.call('/api/bitpanda/reconcile', {...body, confirm_checked_bitpanda: false})).status, 400);
  assert.equal((await f.call('/api/bitpanda/reconcile', body)).status, 409, 'devis pas encore expiré');
  f.state.now += 60000 + 30001;
  const done = await f.call('/api/bitpanda/reconcile', body);
  assert.equal(done.status, 200); assert.equal(done.body.state, 'expired');
  assert.equal((await f.call('/api/bitpanda/reconcile', body)).status, 409);
  assert.equal(f.state.calls.length, calls);
  const order = (await f.call('/api/bitpanda/journal')).body.orders[0];
  assert.equal(order.quote.reconciled, 'not_executed');
  assert.equal((await f.quote()).status, 200);
  assert.equal(f.acceptCalls(), 1);
});
test('un devis interrompu en « requesting » libère le verrou après le délai', async t => {
  const f = fixture(t);
  f.db.sqlite.exec(`UPDATE gate SET owner='crashed', phase='requesting', release_at=${f.state.now + 120000}`);
  assert.equal((await f.quote()).status, 409);
  f.state.now += 120001;
  assert.equal((await f.quote()).status, 200);
});
test('code d’accès manquant : erreur lisible par le site, aucune donnée', async t => {
  const f = fixture(t); delete f.env.DASHBOARD_ACCESS_TOKEN;
  const result = await f.call('/api/bitpanda/status', undefined, {Authorization: ''});
  assert.equal(result.status, 503); assert.equal(result.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(result.body.error, /DASHBOARD_ACCESS_TOKEN/);
});
test('prix indicatif, recherche par UUID et détail d’erreur Bitpanda', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/api/bitpanda/ticker?assetId=' + ASSET.toUpperCase())).status, 200);
  assert.ok(f.state.calls.at(-1).url.endsWith(`/v1/tickers/${ASSET}`));
  assert.equal((await f.call('/api/bitpanda/ticker?assetId=../x')).status, 400);
  assert.equal((await f.call('/api/bitpanda/assets?id=' + ASSET)).status, 200);
  assert.equal((await f.call('/api/bitpanda/assets?id=nope')).status, 400);
  f.env.BITPANDA_TRADING_CURRENCY_ID = CURRENCY.toUpperCase();
  assert.equal((await f.call('/api/bitpanda/status')).body.currency_id, CURRENCY);
});
test('échec réseau, délai et redirection Bitpanda : cause et route indiquées, clé jamais renvoyée', async t => {
  const f = fixture(t);
  f.state.respond = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}); };
  let result = await f.call('/api/bitpanda/currencies');
  assert.equal(result.status, 502); assert.match(result.body.error, /GET \/v1\/currencies, délai de 15 s dépassé/);
  f.state.respond = async () => { throw new TypeError('fetch failed'); };
  assert.match((await f.call('/api/bitpanda/holdings')).body.error, /GET \/v1\/portfolio, erreur réseau : fetch failed/);
  const redirected = [];
  f.state.respond = async url => { redirected.push(url); return new Response(null, {status: 301, headers: {Location: 'https://elsewhere.example/currencies?key=x'}}); };
  result = await f.call('/api/bitpanda/currencies');
  assert.match(result.body.error, /redirigé GET \/v1\/currencies vers https:\/\/elsewhere\.example\/currencies \(HTTP 301\)/);
  assert.ok(!result.body.error.includes('key=x')); assert.equal(redirected.length, 1);
  f.state.respond = async () => Response.json({message: 'Invalid API key'}, {status: 401});
  assert.equal((await f.call('/api/bitpanda/holdings')).body.error, 'Clé Bitpanda refusée. [GET /v1/portfolio] Détail : Invalid API key');
});
test('formats de devis documentés : snake_case, camelCase et plat, avec prix prime incluse', async () => {
  const {normalizeQuote} = await import('../worker.mjs');
  const expected = {id: 'q', assetId: 'a', currencyId: 'c', side: 'BUY', price: '101', quantity: '0.5', notional: '50.5', expiresAt: 'e'};
  assert.deepEqual(normalizeQuote({data: {quote_id: 'q', side: 'buy', asset_id: 'a', currency_id: 'c', quote: {price: '100', price_with_premium: '101', quantity: '0.5', notional: 50.5, expires_at: 'e'}}}), expected);
  assert.deepEqual(normalizeQuote({data: {quoteId: 'q', side: 'BUY', assetId: 'a', currencyId: 'c', quote: {priceWithPremium: '101', quantity: '0.5', notional: '50.5', expiresAt: 'e'}}}), expected);
  assert.deepEqual(normalizeQuote({id: 'q', side: 'BUY', assetId: 'a', currencyId: 'c', price: '101', quantity: '0.5', notional: '50.5', expiresAt: 'e'}), expected);
  assert.equal(normalizeQuote({data: {quote: {notional: 1e-7}}}).notional, 1e-7, 'notation exponentielle jamais convertie');
});
test('devis dans un format inconnu : refusé sans ordre, verrou libéré', async t => {
  const f = fixture(t); f.state.overrides = {quote_id: undefined, id: undefined};
  const result = await f.quote();
  assert.equal(result.status, 502); assert.match(result.body.error, /format inconnu/);
  assert.equal(f.acceptCalls(), 0);
  f.state.overrides = {}; assert.equal((await f.quote()).status, 200);
});
