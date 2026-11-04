// Les valeurs financières restent vides jusqu'à la saisie du propriétaire.
let autoState=null,autoBusy=false,autoDirty=false;
const autoMessage=error=>{$('auto-error').textContent=error.message;};
function autoControls(){
  $('auto-enable').disabled=autoBusy||autoDirty||!$('auto-consent').checked||!autoState?.strategy||!autoState?.server_enabled||!autoState?.trading_allowed||!autoState?.settings?.asset_id||(autoState?.runs||[]).some(run=>['collecting','reserved','submitting','unknown'].includes(run.state));
}
function renderAuto(data){
  autoState=data;autoDirty=false;
  const unresolved=(data.runs||[]).some(run=>['submitting','unknown'].includes(run.state));
  $('auto-status').textContent=unresolved?'Ordre à rapprocher : nouveaux cycles bloqués':data.enabled&&data.server_enabled&&data.trading_allowed?'Ordres automatiques activés':'Ordres automatiques en pause';
  $('auto-status-detail').textContent=!data.server_enabled?'La collecte doit être autorisée dans les paramètres Cloudflare.':!data.trading_allowed?'Collecte autorisée ; les ordres automatiques restent interdits par le serveur.':'Les limites, la stratégie approuvée et les verrous du journal sont appliqués à chaque cycle.';
  const s=data.settings||{};
  if(s.asset_id&&!Array.from($('auto-asset').options).some(o=>o.value===s.asset_id))$('auto-asset').add(new Option(s.asset_id,s.asset_id));
  $('auto-asset').value=s.asset_id||'';$('auto-amount').value=s.order_amount||'';$('auto-daily').value=s.daily_buy_budget||'';
  $('auto-stop').value=s.stop_loss_pct??'';$('auto-fee').value=s.fee_pct??'';
  $('auto-strategy').textContent=data.strategy?'Stratégie approuvée : '+data.strategy.name:'Aucune stratégie approuvée. Les comparaisons ne changent pas la stratégie active.';
  $('auto-points').textContent=data.points+' observation(s)';
  $('auto-position').textContent=data.position?`Position suivie par le bot : ${data.position.quantity} unités.`:'Aucune position du bot enregistrée.';
  $('auto-research-status').textContent=data.research?.explanation||'Collecte de 200 observations consécutives nécessaire (environ 17 heures à cinq minutes).';
  tableRows('auto-runs',(data.runs||[]).map(run=>[run.created,run.state,run.detail]));
  $('auto-candidates').replaceChildren();
  for(const candidate of data.research?.candidates||[]){
    const row=$('auto-candidates').insertRow();
    for(const value of [candidate.name,number(candidate.return_pct)+' %',number(candidate.max_drawdown_pct)+' %',candidate.trades])row.insertCell().textContent=value;
    const button=document.createElement('button');button.type='button';button.textContent=candidate.eligible?'Approuver':'Données insuffisantes';button.disabled=!candidate.eligible;
    button.addEventListener('click',()=>autoAction('/api/automation/approve',{strategy_id:candidate.id}));row.insertCell().append(button);
  }
  $('auto-notes').textContent=(data.notes||[]).length+' note(s) de stratégie reçue(s) d’Obsidian. Les notes sont des données et ne modifient jamais les limites.';
  $('auto-consent').checked=false;autoControls();
}
async function loadAuto(){
  $('auto-error').textContent='';
  if(liveStatus&&liveStatus.features?.automation!==true)throw Error('Ce serveur ne fournit pas le module d’automatisation Cloudflare.');
  renderAuto(await api('/api/automation/state'));
}
async function autoAction(path,body){
  if(autoBusy)return;
  autoBusy=true;autoControls();$('auto-error').textContent='';
  try{await api(path,body);await loadAuto();}
  catch(error){autoMessage(error);}
  finally{autoBusy=false;autoControls();}
}
$('nav-auto').addEventListener('click',()=>{view('auto');loadAuto().catch(autoMessage);});
$('auto-refresh').addEventListener('click',()=>loadAuto().catch(autoMessage));
$('auto-consent').addEventListener('change',autoControls);
$('auto-pause').addEventListener('click',async()=>{try{await api('/api/automation/pause',{});await loadAuto();}catch(error){autoMessage(error);}});
$('auto-enable').addEventListener('click',()=>{if(!autoDirty&&$('auto-consent').checked)autoAction('/api/automation/enable',{confirm_real_automation:true,revision:autoState.revision});});
$('auto-form').addEventListener('input',()=>{autoDirty=true;$('auto-consent').checked=false;autoControls();$('auto-status-detail').textContent='Modifications non enregistrées : le bot conserve les réglages précédents jusqu’à leur enregistrement ou sa mise en pause.';});
$('auto-research').addEventListener('click',()=>autoAction('/api/automation/research',{}));
$('auto-form').addEventListener('submit',event=>{
  event.preventDefault();
  autoAction('/api/automation/config',{asset_id:$('auto-asset').value,order_amount:$('auto-amount').value,daily_buy_budget:$('auto-daily').value,stop_loss_pct:$('auto-stop').value,fee_pct:$('auto-fee').value});
});
$('auto-search-form').addEventListener('submit',async event=>{
  event.preventDefault();$('auto-search').disabled=true;$('auto-error').textContent='';
  try{
    const result=(await api('/api/bitpanda/assets?symbol='+encodeURIComponent($('auto-symbol').value.trim()))).result;
    $('auto-asset').replaceChildren(new Option('Sélectionnez un actif',''));
    autoDirty=true;$('auto-consent').checked=false;autoControls();
    for(const asset of rows(result))if(asset.id)$('auto-asset').add(new Option(`${asset.symbol||''} · ${asset.type||''} · ${asset.id}`,asset.id));
  }catch(error){autoMessage(error);}finally{$('auto-search').disabled=false;}
});
document.addEventListener('bdl:disconnected',()=>{
  autoState=null;autoDirty=false;autoControls();$('auto-consent').checked=false;
  for(const input of $('auto-form').querySelectorAll('input'))input.value='';
  $('auto-asset').replaceChildren(new Option('Sélectionnez un résultat',''));
  tableRows('auto-runs',[]);tableRows('auto-candidates',[]);
  $('auto-status').textContent='Automatisation à configurer';$('auto-status-detail').textContent='Reconnectez votre serveur pour consulter le bot.';
  $('auto-strategy').textContent='Aucune stratégie chargée.';$('auto-position').textContent='Aucune position chargée.';$('auto-notes').textContent='Aucune note chargée.';$('auto-error').textContent='';
});
