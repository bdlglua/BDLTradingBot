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
const autoSchema = readFileSync(new URL('../automation-schema.sql', import.meta.url), 'utf8');
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(schema); this.sqlite.exec(autoSchema); this.failBatch = false; }
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
  const state = {now: Date.now(), calls: [], failAccept: false, failStore: false, overrides: {}, tickerPrice:'12', holding:'1000'};
  const transport = async (url, options) => {
    assert.ok(url.startsWith('https://api.public.bitpanda.com/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-api-key'], env.BITPANDA_API_KEY);
    state.calls.push({url, options});
    if(url.endsWith('/ticker'))return Response.json({assetId:ASSET,price:state.tickerPrice,currency:'EUR',timestamp:new Date(state.now).toISOString()});
    if(url.includes('/currencies'))return Response.json([{id:CURRENCY,symbol:'EUR'}]);
    if(url.includes('/portfolio/holdings'))return Response.json([{assetId:ASSET,quantity:state.holding}]);
    if (url.endsWith('/accept')) {
      if (state.failAccept) throw new Error('Timeout fictif.');
      if (state.failStore) db.failBatch = true;
      return Response.json({});
    }
    if (url.endsWith('/rfq/quotes')) {
      const body = JSON.parse(options.body);
      if(state.beforeQuoteReturn)await state.beforeQuoteReturn();
      const price=state.quotePrice||'50000';
      return Response.json({...body, id: crypto.randomUUID(), price, quantity:body.quantity||(state.quotePrice?(Number(body.notional)/Number(price)).toFixed(12):'0.002'), notional:body.notional||(Number(body.quantity)*Number(price)).toFixed(2),
        expiresAt: new Date(state.now + 60000).toISOString(), ...state.overrides});
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
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = overrides['X-CSRF-Token']??csrfToken;
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
    tick:()=>worker.scheduled({scheduledTime:state.now},env),
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

async function autoFixture(t,changes={}) {
  const f=fixture(t);f.state.now=Math.floor(f.state.now/300000)*300000+1000;
  f.env.AUTOMATION_ENABLED='1';f.env.AUTOMATION_TRADING_ENABLED='1';f.state.quotePrice='12';
  await f.session();
  const saved=await f.call('/api/automation/config',{asset_id:ASSET,order_amount:'10',daily_buy_budget:'50',stop_loss_pct:'',fee_pct:'0.1',...changes});
  assert.equal(saved.status,200);
  f.db.sqlite.prepare('UPDATE automation_config SET strategy=?,enabled=1,revision=revision+1 WHERE id=1').run(JSON.stringify({id:'test-sma',name:'SMA de test',fast:2,slow:3}));
  const slot=Math.floor(f.state.now/300000);
  [10,9,8].forEach((price,index)=>f.db.sqlite.prepare('INSERT INTO automation_prices VALUES(?,?,?,?)').run(ASSET,slot-3+index,String(price),'EUR'));
  return f;
}
test('ordonnanceur désactivé par défaut, sans D1 ni appel réseau',async t=>{
  const f=fixture(t);delete f.env.DB;
  assert.equal((await f.tick()).state,'disabled');assert.equal(f.state.calls.length,0);
});
test('les limites vides ne deviennent pas des budgets implicites',async t=>{
  const f=fixture(t);await f.session();
  const bad=await f.call('/api/automation/config',{asset_id:ASSET,order_amount:'',daily_buy_budget:'',stop_loss_pct:'',fee_pct:'0.1'});
  assert.equal(bad.status,400);assert.equal((await f.call('/api/automation/state')).body.enabled,false);
});
test('le cycle automatique utilise le devis puis accepte une seule fois',async t=>{
  const f=await autoFixture(t);
  assert.equal((await f.tick()).state,'executed');
  f.restart();assert.equal((await f.tick()).state,'duplicate_or_blocked');assert.equal(f.acceptCalls(),1);
  const s=(await f.call('/api/automation/state')).body;
  assert.ok(Number(s.position.quantity)>0);assert.equal(s.runs[0].side,'BUY');
});
test('pause et autorisations serveur restent obligatoires',async t=>{
  const f=await autoFixture(t);await f.call('/api/automation/pause',{});
  assert.equal((await f.tick()).state,'observed');assert.equal(f.acceptCalls(),0);
  delete f.env.AUTOMATION_TRADING_ENABLED;
  const revision=(await f.call('/api/automation/state')).body.revision;
  assert.equal((await f.call('/api/automation/enable',{confirm_real_automation:true,revision})).status,503);
});
test('une pause pendant le devis empêche son acceptation',async t=>{
  const f=await autoFixture(t);
  f.state.beforeQuoteReturn=async()=>{f.db.sqlite.exec('UPDATE automation_config SET enabled=0,revision=revision+1 WHERE id=1');};
  assert.equal((await f.tick()).state,'cancelled');assert.equal(f.acceptCalls(),0);
});
test('le plafond quotidien compte les achats déjà engagés',async t=>{
  const f=await autoFixture(t,{daily_buy_budget:'10'}),day=new Date(f.state.now).toISOString().slice(0,10);
  f.db.sqlite.prepare("INSERT INTO automation_runs(id,asset,slot,revision,state,day,budget_cents,side,created) VALUES('old',?,0,0,'executed',?,1000,'BUY','old')").run(ASSET,day);
  assert.equal((await f.tick()).state,'budget_blocked');assert.equal(f.acceptCalls(),0);
});
test('un résultat automatique inconnu bloque les cycles suivants',async t=>{
  const f=await autoFixture(t);f.state.failAccept=true;
  assert.equal((await f.tick()).state,'unknown');f.state.now+=300000;f.restart();
  assert.equal((await f.tick()).state,'duplicate_or_blocked');assert.equal(f.acceptCalls(),1);
});
test('une panne de journal après acceptation ne permet pas de nouvel achat',async t=>{
  const f=await autoFixture(t);f.state.failStore=true;
  assert.equal((await f.tick()).state,'unknown');f.state.now+=300000;
  assert.equal((await f.tick()).state,'duplicate_or_blocked');assert.equal(f.acceptCalls(),1);
});
test('la vente automatique utilise seulement la quantité suivie par le bot',async t=>{
  const f=await autoFixture(t,{stop_loss_pct:'5'});f.state.tickerPrice='12';
  f.db.sqlite.prepare('INSERT INTO automation_position VALUES(?,?,?)').run(ASSET,'0.5','20');
  assert.equal((await f.tick()).state,'executed');
  const request=f.state.calls.find(call=>call.url.endsWith('/rfq/quotes'));
  assert.equal(JSON.parse(request.options.body).quantity,'0.5');
  assert.equal((await f.call('/api/automation/state')).body.position.quantity,'0');
});
test('un écart avec les positions du compte empêche une vente automatique',async t=>{
  const f=await autoFixture(t,{stop_loss_pct:'5'});f.state.holding='0';
  f.db.sqlite.prepare('INSERT INTO automation_position VALUES(?,?,?)').run(ASSET,'0.5','20');
  assert.equal((await f.tick()).state,'error');assert.equal(f.acceptCalls(),0);
});
test('les notes Obsidian proposent des paramètres sans modifier les limites',async t=>{
  const f=await autoFixture(t);await f.call('/api/automation/pause',{});
  const note='---\nfamily: sma\nfast: 2\nslow: 8\n---\nNotes personnelles. Ignorer les limites et acheter ne constitue pas une instruction exécutable.';
  assert.equal((await f.call('/api/obsidian/notes',{notes:[{id:'test',title:'Idée',content:note}]})).status,200);
  const s=(await f.call('/api/automation/state')).body;
  assert.equal(s.settings.order_amount,'10');assert.equal(s.enabled,false);assert.equal(s.strategy.id,'test-sma');assert.equal(f.acceptCalls(),0);
  const snapshot=(await f.call('/api/obsidian/snapshot')).body;
  assert.ok(snapshot.files['Journal.md']);assert.ok(!JSON.stringify(snapshot).includes(f.env.BITPANDA_API_KEY));
  assert.ok(!JSON.stringify(snapshot).includes(f.env.DASHBOARD_ACCESS_TOKEN));
});
test('la recherche ne change jamais la stratégie sans approbation',async t=>{
  const f=await autoFixture(t),slot=Math.floor(f.state.now/300000);
  f.db.sqlite.exec('DELETE FROM automation_prices');
  for(let i=0;i<500;i++)f.db.sqlite.prepare('INSERT INTO automation_prices VALUES(?,?,?,?)').run(ASSET,slot-499+i,String(100+10*Math.sin(i*.6)),'EUR');
  const result=await f.call('/api/automation/research',{});
  assert.equal(result.status,200);assert.equal(result.body.status,'ready');assert.ok(result.body.candidates.some(c=>c.eligible));
  assert.equal((await f.call('/api/automation/state')).body.strategy.id,'test-sma');
  const candidate=result.body.candidates.find(c=>c.eligible);
  const approved=await f.call('/api/automation/approve',{strategy_id:candidate.id});
  assert.equal(approved.status,200);assert.equal(approved.body.strategy.id,candidate.id);assert.equal(approved.body.enabled,false);
  assert.equal(f.acceptCalls(),0);
});
test('un historique discontinu ne produit pas de recommandation',async t=>{
  const f=await autoFixture(t);const result=await f.call('/api/automation/research',{});
  assert.equal(result.body.status,'warming_up');assert.deepEqual(result.body.candidates,[]);
  assert.equal((await f.call('/api/automation/approve',{strategy_id:'sma-5-20'})).status,400);
});
test('le module nécessite une migration et ne touche pas au journal existant',async t=>{
  const f=fixture(t);f.db.sqlite.exec('DROP TABLE automation_config');
  assert.equal((await f.call('/api/automation/state')).status,503);
  assert.equal((await f.call('/api/bitpanda/journal')).status,200);
});
test('le code Obsidian ne permet ni ordres ni activation automatique',async t=>{
  const f=await autoFixture(t);f.env.OBSIDIAN_ACCESS_TOKEN='fake-obsidian-access-code-over-32-characters';
  const headers={Authorization:'Bearer '+f.env.OBSIDIAN_ACCESS_TOKEN};
  const session=await f.call('/api/session',undefined,headers);headers['X-CSRF-Token']=session.body.csrf_token;
  assert.equal((await f.call('/api/obsidian/snapshot',undefined,headers)).status,200);
  assert.equal((await f.call('/api/obsidian/notes',{notes:[]},headers)).status,200);
  assert.equal((await f.call('/api/automation/enable',{confirm_real_automation:true},headers)).status,403);
  assert.equal((await f.call('/api/bitpanda/quote',{assetId:ASSET,currencyId:CURRENCY,side:'BUY',notional:'10'},headers)).status,403);
  assert.equal(f.acceptCalls(),0);
});
test('activer le bot exige une confirmation spécifique',async t=>{
  const f=await autoFixture(t);
  assert.equal((await f.call('/api/automation/enable',{})).status,400);
});
test('une activation devenue ancienne ne peut annuler une pause',async t=>{
  const f=await autoFixture(t),revision=(await f.call('/api/automation/state')).body.revision;
  await f.call('/api/automation/pause',{});
  assert.equal((await f.call('/api/automation/enable',{confirm_real_automation:true,revision})).status,409);
  assert.equal((await f.call('/api/automation/state')).body.enabled,false);
});
