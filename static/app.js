const $ = id => document.getElementById(id);
let csv = '', report = null;
const number = value => new Intl.NumberFormat('fr-FR', {maximumFractionDigits: 2}).format(value);
function reset() {
  report = null; $('download').disabled = true;
  for (const id of ['equity', 'return', 'drawdown']) { $(id).textContent = '—'; $(id).className = ''; }
  $('chart').setAttribute('hidden', ''); $('chart-empty').hidden = false;
  $('trades').replaceChildren(); const row = $('trades').insertRow();
  const cell = row.insertCell(); cell.colSpan = 6; cell.className = 'empty-row'; cell.textContent = 'Lancez un backtest avec ces données.';
  $('count').textContent = '0'; $('position').textContent = ''; $('period').textContent = 'Paramètres modifiés : relancez le test.';
}
$('form').addEventListener('input', reset);
$('file').addEventListener('change', async event => {
  csv = ''; reset(); $('error').textContent = '';
  const file = event.target.files[0];
  if (!file) { $('source').textContent = 'Aucun fichier sélectionné'; return; }
  if (file.size > 2000000) { $('error').textContent = 'Le fichier dépasse 2 Mo.'; return; }
  csv = await file.text(); $('source').textContent = file.name;
});
$('example').addEventListener('click', async () => {
  try {
    const response = await fetch('./examples/prices.csv'); if (!response.ok) throw Error('Exemple indisponible.');
    csv = await response.text(); $('file').value = '';
    $('form').elements.fast.value = 2; $('form').elements.slow.value = 3;
    reset(); $('source').textContent = 'Exemple synthétique · 8 observations'; $('error').textContent = '';
  } catch (error) { $('error').textContent = error.message; }
});
function chart(points) {
  const svg = $('chart'); svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, text) => { const el = document.createElementNS(ns, tag); for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,value); if (text !== undefined) el.textContent = text; svg.append(el); return el; };
  const values = points.map(p => p.equity); const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max-min)*.15, max*.005, .01); const low = min-padding, high = max+padding;
  const x = i => 75 + i/(points.length-1)*705, y = value => 220-(value-low)/(high-low)*200;
  for(let i=0;i<5;i++) { const value=low+(high-low)*i/4; add('line',{x1:75,x2:780,y1:y(value),y2:y(value),stroke:'#29323d'}); add('text',{x:65,y:y(value)+4,'text-anchor':'end',fill:'#8f9dab','font-size':11},number(value)); }
  add('polyline',{points:points.map((p,i)=>`${x(i)},${y(p.equity)}`).join(' '),fill:'none',stroke:'#b8ed96','stroke-width':2.5});
  add('text',{x:75,y:250,fill:'#8f9dab','font-size':11},points[0].timestamp.slice(0,10));
  add('text',{x:780,y:250,'text-anchor':'end',fill:'#8f9dab','font-size':11},points.at(-1).timestamp.slice(0,10));
  svg.removeAttribute('hidden'); $('chart-empty').hidden=true;
}
$('form').addEventListener('submit', async event => {
  event.preventDefault(); $('error').textContent = ''; reset();
  if(liveStatus?.features?.backtest===false) { $('error').textContent='Le laboratoire n’est pas disponible avec ce serveur.'; return; }
  if (!csv) { $('error').textContent = 'Importez un CSV ou chargez l’exemple.'; return; }
  const config = Object.fromEntries([...new FormData(event.target)].map(([k,v])=>[k,Number(v)]));
  for(const key of ['allocation','stop_loss','fee']) config[key] /= 100;
  $('run').disabled = true; $('run').textContent = 'Calcul en cours…';
  // Freeze the form while awaiting the result so inputs and displayed results match.
  const inputs = [...$('form').querySelectorAll('input, #example')]; inputs.forEach(el=>el.disabled=true);
  try {
    const data = await api('/api/backtest', {csv,config});
    report=data; $('equity').textContent=number(data.final_equity);
    $('return').textContent=`${data.return_pct>=0?'+':''}${number(data.return_pct)} %`; $('return').className=data.return_pct>=0?'positive':'negative';
    $('drawdown').textContent=`${number(data.max_drawdown_pct)} %`; chart(data.equity_curve);
    $('period').textContent=`${data.equity_curve.length} observations · Valorisation aux prix de clôture`;
    $('position').textContent=data.open_quantity>0?`Position ouverte : ${number(data.open_quantity)} unités · Valeur incluse dans le capital final.`:'Aucune position ouverte à la fin du test.';
    $('count').textContent=data.trades.length;
    if(data.trades.length) $('trades').replaceChildren();
    else $('trades').rows[0].cells[0].textContent='Aucun signal exécuté sur cette période.';
    for(const trade of data.trades) {
      const row=$('trades').insertRow();
      const values=[trade.timestamp,trade.side==='buy'?'Achat':'Vente',number(trade.price),new Intl.NumberFormat('fr-FR',{maximumFractionDigits:8}).format(trade.quantity),number(trade.fee),trade.reason==='stop_loss'?'Stop de sortie':'Croisement'];
      values.forEach((value,i)=>{ const cell=row.insertCell();cell.textContent=value;if(i===1)cell.className=trade.side; });
    }
    $('download').disabled=false;
  } catch(error) { $('error').textContent=error.message; }
  finally { $('run').disabled=liveStatus?.features?.backtest===false; $('run').textContent='Lancer le backtest ↗'; inputs.forEach(el=>el.disabled=false); }
});
$('download').addEventListener('click',()=>{
  if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='bdl-backtest.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

// Live Bitpanda workspace. API credentials are never received by the browser.
let sessionToken = '', liveStatus = null, activeQuote = null, expiryTimer = null, orderBusy = false;
const hosted = Boolean(window.BDL_CONFIG?.hosted) || !['127.0.0.1','localhost'].includes(location.hostname);
let apiBase = hosted ? (window.BDL_CONFIG?.apiBaseUrl || '') : location.origin;
let accessToken = '';
let connectionRequests = new AbortController();
async function api(path, body) {
  if(!apiBase || (hosted && !accessToken)) throw Error('Connectez votre serveur sécurisé dans le panneau en haut de page.');
  const headers = accessToken ? {'Authorization':'Bearer '+accessToken} : {};
  const controller = connectionRequests;
  const options = {headers, signal:controller.signal, credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer'};
  if(body !== undefined) {
    options.method='POST'; options.body=JSON.stringify(body);
    Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':sessionToken});
  }
  let response;
  try {response = await fetch(apiBase + path, options);}
  catch {throw Error('Serveur inaccessible. Vérifiez son adresse HTTPS et l’autorisation de ce site sur le serveur.');}
  if(!response.headers.get('Content-Type')?.includes('application/json')) throw Error('Le serveur n’a pas renvoyé une réponse API valide.');
  const data = await response.json();
  if(controller.signal.aborted) throw Error('Connexion interrompue.');
  if(!response.ok) throw Error(data.error || 'Requête indisponible.');
  return data;
}
function view(live) {
  const selected=live===true?'live':live===false?'lab':live;
  for(const name of ['live','lab','auto']) {
    $(name+'-view').hidden=selected!==name;
    $('nav-'+name).classList.toggle('active',selected===name);
    $('nav-'+name).setAttribute('aria-pressed',String(selected===name));
  }
  $('breadcrumb').textContent='ESPACE DE TRAVAIL / '+({live:'BITPANDA',lab:'LABORATOIRE',auto:'AUTOMATISATION'}[selected]);
  $('mode-badge').textContent=selected==='lab'?'● Simulation':selected==='auto'?'● Automatisation · À vérifier':'● Compte Bitpanda · Réel';
}
$('nav-live').addEventListener('click',()=>view(true)); $('nav-lab').addEventListener('click',()=>view(false));
function clearQuote() {
  clearInterval(expiryTimer); activeQuote=null;
  $('quote-details').hidden=true; $('quote-empty').hidden=false;
  $('quote-expiry').textContent='Aucun devis'; $('confirm-real').checked=false; $('accept-quote').disabled=true;
}
function rows(result) {
  if(Array.isArray(result)) return result;
  if(result && Array.isArray(result.data)) return result.data;
  throw Error('Format de réponse Bitpanda non reconnu.');
}
function tableRows(id, data) {
  $(id).replaceChildren();
  for(const values of data) {const row=$(id).insertRow(); for(const value of values) row.insertCell().textContent=value ?? '—';}
}
async function loadStatus() {
  liveStatus=await api('/api/bitpanda/status');
  $('lab-capability').hidden=liveStatus.features?.backtest!==false;
  $('run').disabled=liveStatus.features?.backtest===false;
  $('connection-title').textContent=liveStatus.api_key_present?'Clé configurée · Connexion à vérifier':'Compte Bitpanda non connecté';
  $('connection-detail').textContent=liveStatus.reason || 'Actualisez le compte pour vérifier l’accès à Bitpanda.';
  $('limits').textContent=liveStatus.max_order_amount?`Plafond par ordre : ${liveStatus.max_order_amount} · Devise autorisée : ${liveStatus.currency_id}`:'';
  $('request-quote').disabled=!liveStatus.trading_enabled;
}
async function journal() {
  const {orders}=await api('/api/bitpanda/journal');
  const labels={pending:'Devis à confirmer / à laisser expirer',expired:'Expiré',submitted:'Envoyé · À rapprocher',executed:'Exécution confirmée',unknown:'Résultat inconnu · À rapprocher'};
  tableRows('live-orders',orders.map(order=>[order.id,order.quote.side==='BUY'?'Achat':'Vente',order.quote.notional,labels[order.state] || order.state]));
}
$('refresh-orders').addEventListener('click',()=>journal().catch(error=>$('live-error').textContent=error.message));
$('refresh-account').addEventListener('click',async()=>{
  $('live-error').textContent=''; $('refresh-account').disabled=true;
  try {
    await loadStatus();
    const holdings=await api('/api/bitpanda/holdings');
    const positions=rows(holdings.result);
    tableRows('holdings',positions.map(p=>[p.assetId,p.quantity,p.value,p.equivalentCurrencyId]));
    $('connection-title').textContent='Compte Bitpanda connecté';
    $('connection-detail').textContent=liveStatus.trading_enabled?'Trading réel configuré · Confirmation requise pour chaque ordre.':'Lecture du compte active. '+liveStatus.reason;
    $('holdings-status').textContent=`${positions.length} position(s) · Actualisé à ${new Date().toLocaleTimeString('fr-FR')} · Valorisation EUR par défaut`;
    const currencies=rows((await api('/api/bitpanda/currencies')).result);
    $('currency-id').replaceChildren(new Option('Sélectionnez une devise',''));
    for(const currency of currencies) {
      if(!currency.id || (liveStatus.currency_id && currency.id!==liveStatus.currency_id)) continue;
      $('currency-id').add(new Option(`${currency.symbol || currency.code || currency.name || 'Devise'} · ${currency.id}`,currency.id));
    }
    if($('currency-id').options.length===2) $('currency-id').selectedIndex=1;
    $('currency-info').textContent=liveStatus.currency_id?'Seule la devise autorisée dans vos paramètres est proposée.':'Choisissez une devise et configurez son UUID dans les paramètres pour activer les ordres.';
    await journal();
  } catch(error) {$('live-error').textContent=error.message;}
  finally {$('refresh-account').disabled=false;}
});
$('asset-search').addEventListener('submit',async event=>{
  event.preventDefault(); $('live-error').textContent=''; $('search-assets').disabled=true;
  try {
    const result=(await api('/api/bitpanda/assets?symbol='+encodeURIComponent($('asset-symbol').value.trim()))).result;
    $('asset-id').replaceChildren(new Option('Sélectionnez un actif',''));
    for(const asset of rows(result)) if(asset.id) $('asset-id').add(new Option(`${asset.symbol || ''} · ${asset.type || ''} · ${asset.id}`,asset.id));
    $('asset-info').textContent=`${$('asset-id').options.length-1} actif(s) sur cette page.`+(result.cursor?' Précisez le symbole pour affiner la recherche.':'');
  } catch(error) {$('live-error').textContent=error.message;}
  finally {$('search-assets').disabled=false;}
});
function tickQuote() {
  if(!activeQuote)return;
  const remaining=Math.max(0,Math.ceil((Date.parse(activeQuote.quote.expiresAt)-Date.now())/1000));
  $('quote-expiry').textContent=remaining?`Expire dans ${remaining} s`:'Devis expiré';
  $('accept-quote').disabled=!remaining || !$('confirm-real').checked || orderBusy;
  if(!remaining)clearInterval(expiryTimer);
}
$('confirm-real').addEventListener('change',tickQuote);
$('order-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('live-error').textContent=''; $('order-result').textContent='';
  if(orderBusy)return;
  orderBusy=true; $('request-quote').disabled=true;
  try {
    const data=await api('/api/bitpanda/quote',{assetId:$('asset-id').value,currencyId:$('currency-id').value,side:$('order-side').value,notional:$('order-amount').value});
    clearQuote(); activeQuote=data; const q=data.quote; $('quote-summary').replaceChildren();
    for(const [label,value] of [['Ordre',q.side==='BUY'?'Achat':'Vente'],['Actif (UUID)',q.assetId],['Devise (UUID)',q.currencyId],['Montant en devise',q.notional],['Quantité',q.quantity],['Prix',q.price],['Expiration',q.expiresAt]]) {
      const term=document.createElement('dt'),desc=document.createElement('dd');term.textContent=label;desc.textContent=value;$('quote-summary').append(term,desc);
    }
    $('quote-details').hidden=false;$('quote-empty').hidden=true;
    expiryTimer=setInterval(tickQuote,500); tickQuote();
    await journal();
  } catch(error) {$('live-error').textContent=error.message;}
  finally {orderBusy=false;$('request-quote').disabled=!liveStatus?.trading_enabled;tickQuote();}
});
$('accept-quote').addEventListener('click',async()=>{
  if(!activeQuote || !$('confirm-real').checked || orderBusy)return;
  tickQuote(); if($('accept-quote').disabled)return;
  orderBusy=true;$('accept-quote').disabled=true;$('request-quote').disabled=true;$('live-error').textContent='';
  const quote=activeQuote; clearQuote();
  $('order-result').textContent='Ordre envoyé. Attendez la réponse avant toute autre action.';
  try {
    const result=await api('/api/bitpanda/accept',{quote_id:quote.quote.id,confirmation_token:quote.confirmation_token,confirm_real_order:true});
    $('order-result').textContent=result.message+' Consultez votre compte pour le détail.';
  } catch(error) {
    $('order-result').textContent='Exécution non confirmée. Vérifiez le journal et les opérations Bitpanda avant de réessayer.';
    $('live-error').textContent=error.message;
  } finally {
    orderBusy=false;$('request-quote').disabled=!liveStatus?.trading_enabled;
    journal().catch(error=>$('live-error').textContent=error.message);
  }
});
$('read-operations').addEventListener('click',async()=>{
  $('read-operations').disabled=true;
  try {const result=(await api('/api/bitpanda/operations')).result;$('operations').textContent=JSON.stringify(result,null,2);$('operations').hidden=false;}
  catch(error){$('live-error').textContent=error.message;}
  finally{$('read-operations').disabled=false;}
});
async function initializeServer() {
  sessionToken=(await api('/api/session')).csrf_token;await loadStatus();await journal();
  document.dispatchEvent(new Event('bdl:connected'));
}
function clearRemoteSession() {
  connectionRequests.abort();connectionRequests=new AbortController();
  accessToken='';sessionToken='';liveStatus=null;clearQuote();$('request-quote').disabled=true;
  $('lab-capability').hidden=true;$('run').disabled=false;
  $('server-token').value='';$('connection-title').textContent='Serveur déconnecté';$('connection-detail').textContent='Reconnectez-vous pour consulter votre compte.';
  $('limits').textContent='';$('order-result').textContent='';$('live-error').textContent='';$('operations').textContent='';$('operations').hidden=true;
  tableRows('holdings',[]);tableRows('live-orders',[]);$('holdings-status').textContent='Compte à actualiser après connexion.';
  $('asset-id').replaceChildren(new Option('Recherchez et sélectionnez un actif',''));
  $('currency-id').replaceChildren(new Option('Actualisez le compte',''));
  document.dispatchEvent(new Event('bdl:disconnected'));
}
$('server-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(orderBusy)return;
  $('server-connect').disabled=true; $('server-message').textContent='';
  try {
    const url=new URL($('server-url').value.trim());
    if(url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname!=='/') throw Error('Utilisez l’adresse HTTPS du serveur, sans chemin, paramètres ni identifiants.');
    const token=$('server-token').value;
    if(token.length<32 || token.length>256 || !/^[\x21-\x7e]+$/.test(token)) throw Error('Code d’accès invalide : 32 à 256 caractères sans espaces.');
    clearRemoteSession();
    apiBase=url.origin; accessToken=token; $('server-token').value='';
    clearQuote(); await initializeServer();
    $('server-message').textContent='Serveur connecté. Actualisez le compte pour vérifier l’accès à Bitpanda.';
    $('live-error').textContent='';
  } catch(error) {
    clearRemoteSession();
    $('server-message').textContent=error.message;
  } finally {$('server-connect').disabled=false;}
});
$('server-disconnect').addEventListener('click',()=>{
  if(orderBusy){$('server-message').textContent='Attendez le résultat de l’ordre en cours avant de vous déconnecter.';return;}
  clearRemoteSession();
  $('server-message').textContent='Code d’accès effacé de cette session.';
});
(async()=>{
  if(hosted) {
    $('server-panel').hidden=false;$('server-url').value=apiBase;
    $('connection-title').textContent='Serveur sécurisé à connecter';
    $('connection-detail').textContent='Connectez le serveur avec votre code d’accès personnel. Votre clé Bitpanda reste sur le serveur.';
    return;
  }
  try {await initializeServer();}
  catch(error){$('connection-title').textContent='Connexion indisponible';$('live-error').textContent=error.message;}
})();
