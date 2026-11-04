'use strict';
// BDL Trading — interface. Les identifiants Bitpanda ne sont jamais reçus par le navigateur.
const $ = id => document.getElementById(id);
const config = window.BDL_CONFIG || {};
const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname);
const hosted = Boolean(config.hosted) || !isLocal;
const DECIMAL = /^\d{1,16}(?:\.\d{1,18})?$/;
const VIEWS = {
  overview: ['Bitpanda', 'Portefeuille'],
  trade: ['Bitpanda · Fonds réels', 'Trader'],
  history: ['Bitpanda', 'Historique'],
  lab: ['Simulation', 'Laboratoire'],
  settings: ['Configuration', 'Connexion'],
};

const state = {
  apiBase: hosted ? (config.apiBaseUrl || (config.hosted ? '' : location.origin)) : location.origin,
  accessToken: '', sessionToken: '', status: null, connected: false, accountRead: false,
  side: 'BUY', asset: null, quote: null, quoteTotal: 0, quoteBlockedUntil: 0, expiryTimer: null, busy: false,
  assets: new Map(), currencies: new Map(), holdings: [], orders: [], operations: [], opsCursor: null,
  requests: new AbortController(), report: null, csv: '', reconcileTarget: null,
};

/* ------------------------------------------------------------------ helpers */
const nf = (max = 2, min = 0) => new Intl.NumberFormat('fr-FR', {maximumFractionDigits: max, minimumFractionDigits: min});
const formatNumber = (value, max = 2) => Number.isFinite(Number(value)) ? nf(max).format(Number(value)) : String(value ?? '—');
const formatAmount = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '—');
  return nf(Math.abs(number) >= 1 ? 2 : 8).format(number);
};
const money = (value, code) => `${Number.isFinite(Number(value)) ? nf(2, 2).format(Number(value)) : String(value ?? '—')}${code ? ' ' + code : ''}`;
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '—') : date.toLocaleString('fr-FR', {dateStyle: 'short', timeStyle: 'short'});
}
function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  for (const [key, value] of Object.entries(options.attrs || {})) node.setAttribute(key, value);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}
function emptyRow(tbody, columns, message) {
  const row = tbody.insertRow(); row.className = 'empty';
  const cell = row.insertCell(); cell.colSpan = columns; cell.textContent = message;
}
function rows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.data)) return result.data;
  throw Error('Format de réponse Bitpanda non reconnu.');
}
const normalizeId = value => typeof value === 'string' ? value.toLowerCase() : '';
const assetLabel = id => state.assets.get(normalizeId(id))?.symbol || '';
const currencyCode = id => state.currencies.get(normalizeId(id)) || '';

function showError(message) { $('alert-text').textContent = message; $('alert').hidden = false; }
function clearError() { $('alert').hidden = true; $('alert-text').textContent = ''; }
$('alert-close').addEventListener('click', clearError);
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function setResult(id, message, kind = '') { $(id).textContent = message; $(id).className = 'result' + (kind ? ' ' + kind : ''); }

/* ---------------------------------------------------------------------- API */
async function api(path, body) {
  if (!state.apiBase || (hosted && !state.accessToken)) throw Error('Connectez votre serveur sécurisé dans l’onglet Connexion.');
  const headers = state.accessToken ? {Authorization: 'Bearer ' + state.accessToken} : {};
  const controller = state.requests;
  const options = {headers, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'};
  if (body !== undefined) {
    options.method = 'POST'; options.body = JSON.stringify(body);
    Object.assign(headers, {'Content-Type': 'application/json', 'X-CSRF-Token': state.sessionToken});
  }
  let response;
  try { response = await fetch(state.apiBase + path, options); }
  catch {
    if (controller.signal.aborted) throw Error('Connexion interrompue.');
    throw Error('Serveur injoignable. Vérifiez son adresse HTTPS et que DASHBOARD_PUBLIC_ORIGIN autorise ce site.');
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw Error(`Le serveur n’a pas renvoyé une réponse API valide (HTTP ${response.status}).`);
  const data = await response.json();
  if (controller.signal.aborted) throw Error('Connexion interrompue.');
  if (!response.ok) throw Error(data.error || `Requête refusée (HTTP ${response.status}).`);
  return data;
}

/* -------------------------------------------------------------- navigation */
function show(view) {
  if (!VIEWS[view]) view = 'overview';
  for (const name of Object.keys(VIEWS)) $('view-' + name).hidden = name !== view;
  for (const button of document.querySelectorAll('.nav')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  [$('view-eyebrow').textContent, $('view-title').textContent] = VIEWS[view];
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
}
for (const button of document.querySelectorAll('[data-view], [data-goto]')) {
  button.addEventListener('click', () => show(button.dataset.view || button.dataset.goto));
}
addEventListener('hashchange', () => show(location.hash.slice(1)));

/* ------------------------------------------------------- connection status */
function setPill(kind, label) { $('connection-pill').className = 'pill pill-' + kind; $('connection-label').textContent = label; }
function setCheck(name, value, note) {
  const item = document.querySelector(`[data-check="${name}"]`);
  if (value) item.dataset.state = value; else delete item.dataset.state;
  if (note !== undefined && name === 'trading') $('trading-reason').textContent = note;
}
function renderStatus() {
  const status = state.status;
  $('onboarding').hidden = state.connected || !hosted;
  $('refresh').disabled = !state.connected;
  if (!state.connected || !status) {
    setPill('muted', hosted ? 'Non connecté' : 'Serveur local indisponible');
    for (const id of ['kpi-trading', 'kpi-limit']) $(id).textContent = '—';
    $('kpi-trading').className = ''; $('kpi-trading-note').textContent = 'Configuration serveur';
    ['server', 'key', 'account', 'journal', 'trading'].forEach(name => setCheck(name, null));
    $('trading-reason').textContent = 'Devise, plafond et activation';
    $('trading-disabled').hidden = true; updateQuoteButton();
    $('lab-capability').hidden = true; $('run').disabled = false;
    return;
  }
  const trading = Boolean(status.trading_enabled);
  setPill(trading ? 'ok' : 'warn', trading ? 'Trading activé' : 'Lecture seule');
  $('kpi-trading').textContent = trading ? 'Activé' : 'Désactivé';
  $('kpi-trading').className = trading ? 'positive' : '';
  $('kpi-trading-note').textContent = trading ? 'Confirmation requise par ordre' : (status.reason || 'Lecture du compte uniquement');
  $('kpi-limit').textContent = status.max_order_amount ? money(status.max_order_amount, currencyCode(status.currency_id)) : '—';
  $('kpi-limit-note').textContent = status.currency_id ? 'Devise unique autorisée' : 'Défini sur le serveur';
  setCheck('server', 'ok');
  setCheck('key', status.api_key_present ? 'ok' : 'error');
  setCheck('account', state.accountRead ? 'ok' : null);
  if (status.journal_available === false) setCheck('journal', 'error');
  setCheck('trading', trading ? 'ok' : 'warn', trading ? 'Activé : chaque ordre exige votre confirmation.' : (status.reason || 'Désactivé'));
  $('trading-disabled').hidden = trading;
  $('trading-disabled').textContent = trading ? '' : `Trading réel indisponible : ${status.reason || 'désactivé sur le serveur'} La recherche et le prix indicatif restent accessibles.`;
  const lab = status.features?.backtest !== false;
  $('lab-capability').hidden = lab; $('run').disabled = !lab;
  updateQuoteButton();
}
async function loadStatus() { state.status = await api('/api/bitpanda/status'); renderStatus(); }

/* --------------------------------------------------------------- portfolio */
function renderHoldings() {
  const tbody = $('holdings'); tbody.replaceChildren();
  const positions = state.holdings.filter(item => Number(item.quantity) !== 0 || Number(item.value) !== 0)
    .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  const total = positions.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const code = currencyCode(positions[0]?.equivalentCurrencyId) || (positions.length ? 'EUR' : '');
  $('kpi-value').textContent = state.accountRead ? money(total, code) : '—';
  $('kpi-positions').textContent = state.accountRead ? String(positions.length) : '—';
  if (!positions.length) { emptyRow(tbody, 4, state.accountRead ? 'Aucune position sur ce compte.' : 'Aucune donnée pour le moment.'); return; }
  for (const item of positions) {
    const symbol = assetLabel(item.assetId), share = total > 0 ? (Number(item.value) || 0) / total : 0;
    const row = tbody.insertRow();
    row.insertCell().append(element('div', {className: 'asset-cell'}, [
      element('span', {className: 'avatar', text: (symbol || '?').slice(0, 4)}),
      element('div', {}, [element('strong', {text: symbol || 'Actif'}), element('small', {text: item.assetId, title: item.assetId})]),
    ]));
    row.insertCell().textContent = formatAmount(item.quantity); row.cells[1].className = 'num';
    const value = row.insertCell(); value.className = 'num'; value.textContent = money(item.value, currencyCode(item.equivalentCurrencyId) || code);
    const bar = element('span', {className: 'bar'}, element('span')); bar.firstChild.style.width = `${Math.round(share * 1000) / 10}%`;
    const shareCell = row.insertCell(); shareCell.className = 'share-cell';
    shareCell.append(element('div', {className: 'share'}, [bar, element('b', {text: `${formatNumber(share * 100, 1)} %`})]));
  }
}
async function resolveAssets(ids) {
  const missing = [...new Set(ids.map(normalizeId))].filter(id => id && !state.assets.has(id)).slice(0, 25);
  for (const id of missing) {
    try {
      const asset = rows((await api('/api/bitpanda/assets?id=' + encodeURIComponent(id))).result).find(item => normalizeId(item.id) === id);
      state.assets.set(id, asset || {id, symbol: ''});
    } catch { state.assets.set(id, {id, symbol: ''}); }
  }
  if (missing.length) { renderHoldings(); renderJournal(); renderOperations(); }
}
async function refreshAccount() {
  clearError(); $('refresh').disabled = true;
  try {
    await loadStatus();
    const currencies = rows((await api('/api/bitpanda/currencies')).result);
    state.currencies.clear();
    for (const currency of currencies) if (currency?.id) state.currencies.set(normalizeId(currency.id), currency.symbol || currency.code || currency.name || 'Devise');
    renderCurrencies();
    state.holdings = rows((await api('/api/bitpanda/holdings')).result);
    state.accountRead = true;
    $('holdings-status').textContent = `Actualisé à ${new Date().toLocaleTimeString('fr-FR')} · valeurs fournies par Bitpanda`;
    renderStatus(); renderHoldings();
    await loadJournal();
    resolveAssets([...state.holdings.map(item => item.assetId), ...state.orders.map(order => order.quote?.assetId)]);
  } catch (error) {
    showError(error.message);
    setCheck('account', 'error');
  } finally { $('refresh').disabled = !state.connected; }
}
$('refresh').addEventListener('click', () => { refreshAccount(); if (state.operations.length) loadOperations(false); });

/* ------------------------------------------------------------------- trade */
function renderCurrencies() {
  const select = $('currency-id'), allowed = normalizeId(state.status?.currency_id), previous = select.value;
  select.replaceChildren(new Option('Sélectionnez une devise', ''));
  for (const [id, code] of state.currencies) {
    if (allowed && id !== allowed) continue;
    select.add(new Option(code, id));
  }
  if (select.options.length === 2) select.selectedIndex = 1; else select.value = previous;
  updateAmountSuffix();
}
function updateAmountSuffix() {
  $('amount-currency').textContent = currencyCode($('currency-id').value) || '—';
  $('amount-side-hint').textContent = state.side === 'BUY' ? 'à investir' : 'à vendre, en devise';
}
function normalizedAmount() { return $('order-amount').value.replace(/[\s  ]/g, '').replace(',', '.'); }
function amountProblem() {
  const value = normalizedAmount();
  if (!value) return '';
  if (!DECIMAL.test(value) || Number(value) <= 0) return 'Montant invalide : utilisez un nombre positif, ex. 25 ou 25,50.';
  const limit = state.status?.max_order_amount;
  if (limit && Number(value) > Number(limit)) return `Au-dessus du plafond par ordre (${money(limit, currencyCode(state.status.currency_id))}).`;
  return '';
}
function updateQuoteButton() {
  const problem = amountProblem();
  $('amount-hint').textContent = problem || 'Montant exprimé dans la devise, à l’achat comme à la vente.';
  $('amount-hint').className = problem ? 'form-error' : 'muted small';
  const blocked = state.quote || Date.now() < state.quoteBlockedUntil;
  $('request-quote').disabled = !state.status?.trading_enabled || !state.asset || !$('currency-id').value
    || !normalizedAmount() || Boolean(problem) || state.busy || Boolean(blocked);
  $('request-quote').textContent = blocked && !state.quote ? 'Devis précédent en cours d’expiration…' : 'Obtenir un devis';
}
for (const button of document.querySelectorAll('.seg')) {
  button.addEventListener('click', () => {
    state.side = button.dataset.side;
    for (const other of document.querySelectorAll('.seg')) other.setAttribute('aria-checked', String(other === button));
    updateAmountSuffix(); updateQuoteButton();
  });
}
$('currency-id').addEventListener('change', () => { updateAmountSuffix(); updateQuoteButton(); });
$('order-amount').addEventListener('input', updateQuoteButton);

$('asset-search').addEventListener('submit', async event => {
  event.preventDefault(); clearError();
  const symbol = $('asset-symbol').value.trim(); if (!symbol) return;
  $('search-assets').disabled = true;
  const list = $('asset-results');
  try {
    const result = (await api('/api/bitpanda/assets?symbol=' + encodeURIComponent(symbol))).result;
    const assets = rows(result).filter(asset => asset?.id);
    list.replaceChildren();
    for (const asset of assets) {
      state.assets.set(normalizeId(asset.id), asset);
      const option = element('button', {className: 'asset-option', attrs: {type: 'button', role: 'option'}}, [
        element('span', {}, [element('strong', {text: asset.symbol || 'Actif'}), document.createTextNode(' '), element('span', {className: 'tag', text: asset.type || asset.group || '—'})]),
        element('small', {text: asset.isin || asset.id}),
      ]);
      option.addEventListener('click', () => selectAsset(asset));
      list.append(option);
    }
    if (!assets.length) list.append(element('p', {className: 'muted', text: 'Aucun actif trouvé pour ce symbole sur votre compte.'}));
    if (result?.cursor) list.append(element('p', {className: 'muted', text: 'D’autres résultats existent : précisez le symbole.'}));
    list.hidden = false;
    if (assets.length === 1) selectAsset(assets[0]);
  } catch (error) { showError(error.message); }
  finally { $('search-assets').disabled = false; }
});
async function selectAsset(asset) {
  state.asset = asset;
  $('asset-results').hidden = true; $('asset-search').hidden = true; $('asset-selected').hidden = false;
  $('asset-selected-symbol').textContent = asset.symbol || 'Actif';
  $('asset-selected-type').textContent = asset.type || asset.group || '';
  $('asset-price').textContent = 'Prix indicatif…';
  updateQuoteButton();
  try {
    const ticker = (await api('/api/bitpanda/ticker?assetId=' + encodeURIComponent(asset.id))).result;
    if (state.asset !== asset) return;
    $('asset-price').textContent = ticker?.price ? `Prix indicatif : ${formatAmount(ticker.price)} ${ticker.currency || ''}` : 'Prix indicatif indisponible';
  } catch { if (state.asset === asset) $('asset-price').textContent = 'Prix indicatif indisponible'; }
}
$('asset-clear').addEventListener('click', () => {
  state.asset = null; $('asset-selected').hidden = true; $('asset-search').hidden = false;
  $('asset-symbol').focus(); updateQuoteButton();
});

function clearQuote() {
  clearInterval(state.expiryTimer); state.quote = null;
  $('quote-details').hidden = true; $('quote-empty').hidden = false;
  $('quote-expiry').textContent = 'Aucun devis'; $('quote-expiry').className = 'tag';
  $('confirm-real').checked = false; $('accept-quote').disabled = true;
  updateQuoteButton();
}
function tickQuote() {
  if (!state.quote) { updateQuoteButton(); return; }
  const remainingMs = Math.max(0, Date.parse(state.quote.quote.expiresAt) - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  $('quote-expiry').textContent = remaining ? `Expire dans ${remaining} s` : 'Devis expiré';
  $('quote-expiry').className = 'tag ' + (remaining > 10 ? 'tag-info' : remaining ? 'tag-warn' : 'tag-danger');
  const fraction = state.quoteTotal > 0 ? remainingMs / state.quoteTotal : 0;
  $('quote-progress').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  $('quote-progress').classList.toggle('low', remaining <= 10);
  $('accept-quote').disabled = !remaining || !$('confirm-real').checked || state.busy;
  if (!remaining) {
    clearQuote(); state.quoteBlockedUntil = 0;
    setResult('order-result', 'Ce devis a expiré sans être exécuté. Demandez-en un nouveau.');
  }
}
$('confirm-real').addEventListener('change', tickQuote);
$('order-form').addEventListener('submit', async event => {
  event.preventDefault(); clearError(); setResult('order-result', '');
  if (state.busy || $('request-quote').disabled) return;
  state.busy = true; updateQuoteButton(); $('request-quote').textContent = 'Demande en cours…';
  try {
    const data = await api('/api/bitpanda/quote', {assetId: state.asset.id, currencyId: $('currency-id').value, side: state.side, notional: normalizedAmount()});
    clearQuote(); state.quote = data; state.quoteBlockedUntil = Date.parse(data.quote.expiresAt) || 0;
    state.quoteTotal = Math.max(1000, Date.parse(data.quote.expiresAt) - Date.now());
    renderQuote(data.quote);
    state.expiryTimer = setInterval(tickQuote, 250); tickQuote();
    loadJournal().catch(() => {});
  } catch (error) { showError(error.message); }
  finally { state.busy = false; updateQuoteButton(); tickQuote(); }
});
function renderQuote(quote) {
  const symbol = assetLabel(quote.assetId) || state.asset?.symbol || 'l’actif', code = currencyCode(quote.currencyId);
  $('quote-headline').textContent = `${quote.side === 'BUY' ? 'Acheter' : 'Vendre'} ${formatAmount(quote.quantity)} ${symbol} pour ${money(quote.notional, code)}`;
  $('quote-headline').className = 'quote-headline ' + (quote.side === 'BUY' ? 'side-buy' : 'side-sell');
  const summary = $('quote-summary'); summary.replaceChildren();
  for (const [label, value, mono] of [
    ['Sens', quote.side === 'BUY' ? 'Achat' : 'Vente'], ['Actif', symbol], ['Montant', money(quote.notional, code)],
    ['Quantité', `${formatAmount(quote.quantity)} ${symbol}`], ['Prix unitaire', money(quote.price, code)],
    ['Expiration', new Date(quote.expiresAt).toLocaleTimeString('fr-FR')], ['Identifiant du devis', quote.id, true],
  ]) summary.append(element('dt', {text: label}), element('dd', {text: value, className: mono ? 'mono' : ''}));
  $('quote-details').hidden = false; $('quote-empty').hidden = true;
}
$('cancel-quote').addEventListener('click', () => {
  const until = state.quoteBlockedUntil; clearQuote();
  const seconds = Math.ceil((until - Date.now()) / 1000);
  if (seconds > 0) {
    toast(`Devis ignoré. Bitpanda le laissera expirer dans ${seconds} s avant d’en accepter un nouveau.`);
    setTimeout(updateQuoteButton, seconds * 1000 + 200);
  }
});
$('accept-quote').addEventListener('click', async () => {
  if (!state.quote || !$('confirm-real').checked || state.busy) return;
  tickQuote(); if ($('accept-quote').disabled) return;
  state.busy = true; $('accept-quote').disabled = true; clearError();
  const quote = state.quote; clearQuote(); state.quoteBlockedUntil = 0;
  setResult('order-result', 'Ordre envoyé. Attendez la réponse avant toute autre action.');
  try {
    const result = await api('/api/bitpanda/accept', {quote_id: quote.quote.id, confirmation_token: quote.confirmation_token, confirm_real_order: true});
    setResult('order-result', `${result.message} Consultez votre portefeuille pour le détail.`, 'ok');
    toast('Ordre exécuté par Bitpanda.');
  } catch (error) {
    setResult('order-result', 'Exécution non confirmée. Vérifiez vos opérations Bitpanda, puis rapprochez l’ordre dans l’Historique.', 'error');
    showError(error.message);
  } finally {
    state.busy = false; updateQuoteButton();
    loadJournal().catch(error => showError(error.message));
  }
});

/* ----------------------------------------------------------------- history */
const ORDER_STATES = {
  pending: ['Devis actif', 'tag-info'], expired: ['Expiré', ''], submitted: ['Envoyé · à rapprocher', 'tag-warn'],
  executed: ['Exécuté', 'tag-ok'], unknown: ['Inconnu · à rapprocher', 'tag-danger'],
};
async function loadJournal() {
  try {
    state.orders = (await api('/api/bitpanda/journal')).orders || [];
    $('journal-status').hidden = true;
    if (state.connected) setCheck('journal', 'ok');
  } catch (error) {
    state.orders = [];
    $('journal-status').textContent = `Journal indisponible : ${error.message}`; $('journal-status').hidden = false;
    if (state.connected) setCheck('journal', 'error');
  }
  renderJournal();
}
function renderJournal() {
  const tbody = $('live-orders'); tbody.replaceChildren();
  if (!state.orders.length) { emptyRow(tbody, 6, 'Aucun ordre enregistré.'); return; }
  const canReconcile = state.status?.features?.reconcile !== false;
  for (const order of state.orders) {
    const quote = order.quote || {}, row = tbody.insertRow();
    let [label, tone] = ORDER_STATES[order.state] || [order.state, ''];
    if (quote.reconciled === 'not_executed') [label, tone] = ['Non exécuté · rapproché', ''];
    if (quote.reconciled === 'executed') label = 'Exécuté · rapproché';
    row.insertCell().textContent = formatDate(order.created);
    row.insertCell().textContent = assetLabel(quote.assetId) || (quote.assetId ? quote.assetId.slice(0, 8) + '…' : '—');
    const side = row.insertCell(); side.textContent = quote.side === 'BUY' ? 'Achat' : 'Vente'; side.className = quote.side === 'BUY' ? 'side-buy' : 'side-sell';
    const amount = row.insertCell(); amount.className = 'num'; amount.textContent = money(quote.notional, currencyCode(quote.currencyId));
    row.insertCell().append(element('span', {className: 'tag ' + tone, text: label}));
    const action = row.insertCell(); action.className = 'num';
    if (canReconcile && ['submitted', 'unknown'].includes(order.state)) {
      const button = element('button', {className: 'btn btn-secondary btn-sm', text: 'Rapprocher', attrs: {type: 'button'}});
      button.addEventListener('click', () => openReconcile(order));
      action.append(button);
    }
  }
}
$('refresh-orders').addEventListener('click', () => loadJournal());

function openReconcile(order) {
  state.reconcileTarget = order;
  const quote = order.quote || {}, summary = $('reconcile-summary'); summary.replaceChildren();
  for (const [label, value] of [['Date', formatDate(order.created)], ['Ordre', `${quote.side === 'BUY' ? 'Achat' : 'Vente'} ${assetLabel(quote.assetId)}`],
    ['Montant', money(quote.notional, currencyCode(quote.currencyId))], ['Quantité devisée', formatAmount(quote.quantity)], ['Devis', order.id]]) {
    summary.append(element('dt', {text: label}), element('dd', {text: value, className: label === 'Devis' ? 'mono' : ''}));
  }
  $('reconcile-form').reset(); $('reconcile-error').textContent = '';
  $('reconcile-dialog').showModal();
}
$('reconcile-cancel').addEventListener('click', () => $('reconcile-dialog').close());
$('reconcile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const outcome = new FormData(event.target).get('outcome');
  if (!outcome || !$('reconcile-checked').checked) { $('reconcile-error').textContent = 'Indiquez le résultat constaté et cochez la vérification.'; return; }
  $('reconcile-submit').disabled = true;
  try {
    const result = await api('/api/bitpanda/reconcile', {quote_id: state.reconcileTarget.id, outcome, confirm_checked_bitpanda: true});
    $('reconcile-dialog').close(); toast(result.message);
    await loadJournal();
  } catch (error) { $('reconcile-error').textContent = error.message; }
  finally { $('reconcile-submit').disabled = false; }
});

async function loadOperations(more) {
  clearError(); const button = more ? $('more-operations') : $('read-operations'); button.disabled = true;
  try {
    const query = more && state.opsCursor ? '?cursor=' + encodeURIComponent(state.opsCursor) : '';
    const result = (await api('/api/bitpanda/operations' + query)).result;
    const page = rows(result);
    state.operations = more ? state.operations.concat(page) : page;
    state.opsCursor = typeof result?.cursor === 'string' && result.cursor ? result.cursor : null;
    $('more-operations').hidden = !state.opsCursor;
    renderOperations(true);
    resolveAssets(page.map(item => item.assetId));
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
}
function renderOperations(loaded) {
  const tbody = $('operations');
  if (!loaded && !state.operations.length) return;
  tbody.replaceChildren();
  if (!state.operations.length) { emptyRow(tbody, 4, 'Aucune opération sur ce compte.'); return; }
  for (const operation of state.operations) {
    const row = tbody.insertRow();
    row.insertCell().textContent = formatDate(operation.timestamp || operation.time || operation.createdAt);
    row.insertCell().append(element('span', {className: 'tag', text: String(operation.type || '—').replaceAll('_', ' ').toLowerCase()}));
    row.insertCell().textContent = assetLabel(operation.assetId) || (operation.assetId ? operation.assetId.slice(0, 8) + '…' : '—');
    const amount = row.insertCell(); amount.className = 'num'; amount.textContent = operation.amount !== undefined ? formatAmount(operation.amount) : '—';
  }
}
$('read-operations').addEventListener('click', () => loadOperations(false));
$('more-operations').addEventListener('click', () => loadOperations(true));

/* -------------------------------------------------------------- connection */
async function connect() {
  state.sessionToken = (await api('/api/session')).csrf_token;
  await loadStatus();
  state.connected = true; renderStatus();
  await loadJournal();
}
function resetData() {
  state.requests.abort(); state.requests = new AbortController();
  Object.assign(state, {accessToken: '', sessionToken: '', status: null, connected: false, accountRead: false, asset: null,
    holdings: [], orders: [], operations: [], opsCursor: null, quoteBlockedUntil: 0});
  state.currencies.clear();
  clearQuote(); renderStatus(); renderHoldings(); renderJournal();
  $('operations').replaceChildren(); emptyRow($('operations'), 4, 'Cliquez sur « Charger » pour consulter vos opérations.');
  $('more-operations').hidden = true; $('journal-status').hidden = true;
  $('holdings-status').textContent = 'Actualisez le compte pour afficher vos positions réelles.';
  $('kpi-value-note').textContent = 'Valeur fournie par Bitpanda';
  $('currency-id').replaceChildren(new Option('Actualisez le compte', ''));
  $('asset-selected').hidden = true; $('asset-search').hidden = false; $('asset-results').hidden = true;
  setResult('order-result', ''); clearError(); updateAmountSuffix();
}
$('server-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy) return;
  $('server-connect').disabled = true; setResult('server-message', '');
  try {
    const url = new URL($('server-url').value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw Error('Utilisez l’adresse HTTPS du serveur, sans chemin, paramètres ni identifiants.');
    const token = $('server-token').value;
    if (token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) throw Error('Code d’accès invalide : 32 à 256 caractères, sans espaces.');
    resetData();
    state.apiBase = url.origin; state.accessToken = token; $('server-token').value = '';
    setPill('muted', 'Connexion…');
    await connect();
    setResult('server-message', 'Serveur connecté. Lecture du compte Bitpanda…', 'ok');
    await refreshAccount();
    if (state.accountRead) { setResult('server-message', 'Serveur connecté et compte Bitpanda lu.', 'ok'); toast('Compte Bitpanda connecté.'); }
  } catch (error) {
    resetData(); setPill('error', 'Échec de connexion');
    setResult('server-message', error.message, 'error');
  } finally { $('server-connect').disabled = false; }
});
$('server-disconnect').addEventListener('click', () => {
  if (state.busy) { setResult('server-message', 'Attendez le résultat de l’ordre en cours avant de vous déconnecter.', 'error'); return; }
  resetData(); $('server-token').value = '';
  setPill('muted', 'Déconnecté'); setResult('server-message', 'Code d’accès effacé de cette session.');
});

/* --------------------------------------------------------------------- lab */
function resetLab(message = 'Paramètres modifiés : relancez le test.') {
  state.report = null; $('download').disabled = true;
  for (const id of ['equity', 'return', 'drawdown']) { $(id).textContent = '—'; $(id).className = ''; }
  $('chart').setAttribute('hidden', ''); $('chart-empty').hidden = false;
  $('trades').replaceChildren(); emptyRow($('trades'), 6, 'Lancez un backtest avec ces données.');
  $('count').textContent = '0'; $('position').textContent = ''; $('period').textContent = message;
}
$('form').addEventListener('input', event => { if (event.target.id !== 'file') resetLab(); });
async function useFile(file) {
  state.csv = ''; resetLab('Fichier chargé : lancez le test.'); $('error').textContent = '';
  if (!file) { $('source').textContent = 'Déposez un CSV ou cliquez pour choisir'; return; }
  if (file.size > 2000000) { $('error').textContent = 'Le fichier dépasse 2 Mo.'; return; }
  state.csv = await file.text(); $('source').textContent = file.name;
}
$('file').addEventListener('change', event => useFile(event.target.files[0]));
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('drag'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, () => $('dropzone').classList.remove('drag'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); useFile(event.dataTransfer.files[0]); });
$('example').addEventListener('click', async () => {
  try {
    const response = await fetch('./examples/prices.csv'); if (!response.ok) throw Error('Exemple indisponible.');
    state.csv = await response.text(); $('file').value = '';
    $('fast').value = 2; $('slow').value = 3;
    resetLab('Exemple chargé : lancez le test.'); $('source').textContent = 'Exemple synthétique · 8 observations'; $('error').textContent = '';
  } catch (error) { $('error').textContent = error.message; }
});

function drawChart(points, trades) {
  const svg = $('chart'), ns = 'http://www.w3.org/2000/svg'; svg.replaceChildren();
  const add = (tag, attrs, text, parent = svg) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  };
  const W = 800, H = 280, L = 70, R = 16, T = 16, B = 34;
  const values = points.map(point => point.equity), min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * .12, Math.abs(max) * .005, .01), low = min - pad, high = max + pad;
  const x = index => L + (points.length > 1 ? index / (points.length - 1) : .5) * (W - L - R);
  const y = value => T + (1 - (value - low) / (high - low)) * (H - T - B);
  const gradient = add('linearGradient', {id: 'area-fill', x1: 0, x2: 0, y1: 0, y2: 1}, undefined, add('defs', {}));
  add('stop', {offset: '0', class: 'area-top'}, undefined, gradient); add('stop', {offset: '1', class: 'area-bottom'}, undefined, gradient);
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4;
    add('line', {x1: L, x2: W - R, y1: y(value), y2: y(value), class: 'grid'});
    add('text', {x: L - 10, y: y(value) + 4, 'text-anchor': 'end', class: 'axis'}, formatNumber(value, value >= 100 ? 0 : 2));
  }
  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.equity).toFixed(1)}`).join(' ');
  add('polygon', {points: `${x(0)},${H - B} ${line} ${x(points.length - 1)},${H - B}`, fill: 'url(#area-fill)'});
  add('polyline', {points: line, class: 'line'});
  const labelCount = Math.min(points.length, 5);
  for (let i = 0; i < labelCount; i++) {
    const index = labelCount === 1 ? 0 : Math.round(i * (points.length - 1) / (labelCount - 1));
    add('text', {x: x(index), y: H - 10, 'text-anchor': i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle', class: 'axis'}, String(points[index].timestamp).slice(0, 10));
  }
  const indexOf = new Map(points.map((point, index) => [String(point.timestamp), index]));
  for (const trade of trades) {
    const index = indexOf.get(String(trade.timestamp)); if (index === undefined) continue;
    add('circle', {cx: x(index), cy: y(points[index].equity), r: 6, class: trade.side === 'buy' ? 'marker-buy' : 'marker-sell'},
      undefined).append(Object.assign(document.createElementNS(ns, 'title'), {textContent: `${trade.side === 'buy' ? 'Achat' : 'Vente'} à ${formatNumber(trade.price)}`}));
  }
  const cursor = add('g', {visibility: 'hidden'});
  const cursorLine = add('line', {y1: T, y2: H - B, class: 'cursor'}, undefined, cursor);
  const cursorDot = add('circle', {r: 5, class: 'cursor-dot'}, undefined, cursor);
  const tip = add('g', {}, undefined, cursor);
  const tipBg = add('rect', {width: 150, height: 42, rx: 7, class: 'tip-bg'}, undefined, tip);
  const tipValue = add('text', {class: 'tip-text'}, '', tip), tipDate = add('text', {class: 'tip-sub'}, '', tip);
  svg.onpointermove = event => {
    const box = svg.getBoundingClientRect(); if (!box.width) return;
    const svgX = (event.clientX - box.left) / box.width * W;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((svgX - L) / (W - L - R) * (points.length - 1))));
    const px = x(index), py = y(points[index].equity), left = px + 160 > W ? px - 160 : px + 10;
    cursorLine.setAttribute('x1', px); cursorLine.setAttribute('x2', px);
    cursorDot.setAttribute('cx', px); cursorDot.setAttribute('cy', py);
    tipBg.setAttribute('x', left); tipBg.setAttribute('y', T);
    tipValue.setAttribute('x', left + 10); tipValue.setAttribute('y', T + 18); tipValue.textContent = formatNumber(points[index].equity);
    tipDate.setAttribute('x', left + 10); tipDate.setAttribute('y', T + 33); tipDate.textContent = String(points[index].timestamp).slice(0, 19).replace('T', ' ');
    cursor.setAttribute('visibility', 'visible');
  };
  svg.onpointerleave = () => cursor.setAttribute('visibility', 'hidden');
  svg.removeAttribute('hidden'); $('chart-empty').hidden = true;
}
$('form').addEventListener('submit', async event => {
  event.preventDefault(); $('error').textContent = ''; resetLab('Calcul en cours…');
  if (state.status?.features?.backtest === false) { $('error').textContent = 'Le laboratoire n’est pas disponible avec ce serveur.'; return; }
  if (!state.csv) { $('error').textContent = 'Importez un CSV ou chargez l’exemple.'; resetLab('Aucune donnée.'); return; }
  const settings = {};
  for (const name of ['capital', 'allocation', 'fast', 'slow', 'stop_loss', 'fee']) {
    const value = Number($(name).value);
    if ($(name).value === '' || !Number.isFinite(value)) { $('error').textContent = 'Tous les paramètres doivent être des nombres.'; return; }
    settings[name] = value;
  }
  for (const key of ['allocation', 'stop_loss', 'fee']) settings[key] /= 100;
  if (!Number.isInteger(settings.fast) || !Number.isInteger(settings.slow)) { $('error').textContent = 'Les périodes doivent être des nombres entiers.'; return; }
  $('run').disabled = true; $('run').textContent = 'Calcul en cours…';
  const inputs = [...$('form').querySelectorAll('input, #example')]; inputs.forEach(input => { input.disabled = true; });
  try {
    const data = await api('/api/backtest', {csv: state.csv, config: settings});
    state.report = data;
    $('equity').textContent = formatNumber(data.final_equity);
    $('return').textContent = `${data.return_pct >= 0 ? '+' : ''}${formatNumber(data.return_pct)} %`; $('return').className = data.return_pct >= 0 ? 'positive' : 'negative';
    $('drawdown').textContent = `${formatNumber(data.max_drawdown_pct)} %`; $('drawdown').className = data.max_drawdown_pct > 0 ? 'negative' : '';
    drawChart(data.equity_curve, data.trades);
    $('period').textContent = `${data.equity_curve.length} observations · ${String(data.equity_curve[0].timestamp).slice(0, 10)} → ${String(data.equity_curve.at(-1).timestamp).slice(0, 10)}`;
    $('position').textContent = data.open_quantity > 0 ? `Position ouverte : ${formatAmount(data.open_quantity)} unités, valorisée au dernier prix dans le capital final.` : 'Aucune position ouverte à la fin du test.';
    $('count').textContent = data.trades.length;
    $('trades').replaceChildren();
    if (!data.trades.length) emptyRow($('trades'), 6, 'Aucun signal exécuté sur cette période.');
    for (const trade of data.trades) {
      const row = $('trades').insertRow();
      const values = [String(trade.timestamp), trade.side === 'buy' ? 'Achat' : 'Vente', formatNumber(trade.price), formatNumber(trade.quantity, 8), formatNumber(trade.fee), trade.reason === 'stop_loss' ? 'Stop de sortie' : 'Croisement'];
      values.forEach((value, index) => {
        const cell = row.insertCell(); cell.textContent = value;
        if (index === 1) cell.className = trade.side === 'buy' ? 'side-buy' : 'side-sell';
        if (index >= 2 && index <= 4) cell.className = 'num';
      });
    }
    $('download').disabled = false;
  } catch (error) { $('error').textContent = error.message; resetLab('Le test n’a pas abouti.'); }
  finally {
    $('run').disabled = state.status?.features?.backtest === false; $('run').textContent = 'Lancer le backtest';
    inputs.forEach(input => { input.disabled = false; });
  }
});
$('download').addEventListener('click', () => {
  if (!state.report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.report, null, 2)], {type: 'application/json'}));
  const link = element('a', {attrs: {href: url, download: 'bdl-backtest.json'}}); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* -------------------------------------------------------------------- init */
(async () => {
  show(location.hash.slice(1) || 'overview');
  resetData();
  if (hosted) {
    $('server-url').value = state.apiBase;
    $('server-mode').textContent = 'Hébergé'; $('server-mode').className = 'tag tag-info';
    setPill('muted', 'Non connecté');
    return;
  }
  $('server-form').hidden = true; $('local-server').hidden = false;
  $('server-mode').textContent = 'Local'; $('server-mode').className = 'tag tag-ok';
  try {
    await connect();
    setResult('server-message', 'Serveur local connecté.', 'ok');
    if (state.status?.api_key_present) await refreshAccount();
  } catch (error) {
    setPill('error', 'Serveur indisponible'); showError(error.message);
  }
})();
