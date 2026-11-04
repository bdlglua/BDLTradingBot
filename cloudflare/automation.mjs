import {CATALOG,noteCandidate,signal,compare} from './strategies.mjs';
import {AUTOMATION_SCHEMA} from './automation-schema.mjs';
const PERIOD=300000, SCALE=10n**18n;
const units=value=>{const whole=value/SCALE, fraction=(value%SCALE).toString().padStart(18,'0').replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');};
const escape=value=>String(value??'').replace(/[\r\n|]/g,' ');

export function createAutomation({Failure,database,uuid,decimal,policy,quote,accept,upstream,now}) {
  function cents(value) {
    if(typeof value!=='string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value))throw new Failure('Montant positif avec au plus deux décimales requis.');
    const [whole,fraction='']=value.split('.'), result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    if(!Number.isSafeInteger(result)||result<=0)throw new Failure('Montant positif requis.');
    return result;
  }
  async function config(env) {
    try {
      const row=await database(env).prepare('SELECT * FROM automation_config WHERE id=1').first();
      if(!row)throw Error();
      return {...row,enabled:row.enabled===1,settings:JSON.parse(row.settings),strategy:row.strategy?JSON.parse(row.strategy):null};
    } catch {throw new Failure('Initialisez automation-schema.sql dans la même base D1.',503);}
  }
  async function setup(env){
    const db=database(env);
    const commands=AUTOMATION_SCHEMA.split(';').map(sql=>sql.trim()).filter(Boolean);
    await db.batch(commands.map(sql=>db.prepare(sql)));
    return state(env);
  }
  async function prices(env,asset) {
    const result=await database(env).prepare('SELECT slot,price,currency FROM automation_prices WHERE asset=? ORDER BY slot DESC LIMIT 500').bind(asset).all();
    return result.results.reverse();
  }
  function continuous(rows) {return rows.every((row,index)=>index===0 || (row.slot===rows[index-1].slot+1&&row.currency===rows[0].currency));}
  async function research(env) {
    const c=await config(env), rows=await prices(env,c.settings.asset_id||'');
    const notes=await database(env).prepare('SELECT candidate FROM automation_notes WHERE candidate IS NOT NULL LIMIT 4').all();
    const candidates=[...CATALOG,...notes.results.map(row=>JSON.parse(row.candidate))];
    const ready=rows.length>=200 && continuous(rows);
    const result={asset_id:c.settings.asset_id,created:new Date(now()).toISOString(),points:rows.length,
      status:ready?'ready':'warming_up',fee_pct:c.settings.fee_pct??null,
      candidates:ready?compare(rows.map(row=>Number(row.price)),candidates,Number(c.settings.fee_pct)/100):[],
      explanation:ready?'Comparaison exploratoire sur les 30 % de points les plus récents ; frais estimés, exécution au point suivant. Deux transactions minimum pour proposer une variante.':'Collecte de 200 observations consécutives de cinq minutes nécessaire.'};
    await database(env).prepare('INSERT INTO automation_research(id,result) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result').bind(JSON.stringify(result)).run();
    return result;
  }
  async function state(env) {
    const c=await config(env), db=database(env);
    const comparison=await db.prepare('SELECT result FROM automation_research WHERE id=1').first();
    const position=await db.prepare('SELECT * FROM automation_position WHERE asset=?').bind(c.settings.asset_id||'').first();
    const count=await db.prepare('SELECT COUNT(*) AS n FROM automation_prices WHERE asset=?').bind(c.settings.asset_id||'').first();
    const runs=await db.prepare('SELECT id,state,side,detail,created FROM automation_runs ORDER BY created DESC LIMIT 30').all();
    const notes=await db.prepare('SELECT id,title,content FROM automation_notes ORDER BY id').all();
    let currencyId=null;try{currencyId=uuid(env.BITPANDA_TRADING_CURRENCY_ID);}catch{}
    return {settings:c.settings,currency_id:currencyId,enabled:c.enabled,strategy:c.strategy,revision:c.revision,position:position||null,
      points:count.n,research:comparison?JSON.parse(comparison.result):null,runs:runs.results,notes:notes.results,
      server_enabled:env.AUTOMATION_ENABLED==='1',trading_allowed:env.AUTOMATION_TRADING_ENABLED==='1'&&env.BITPANDA_ENABLE_TRADING==='1'};
  }
  async function save(env,data) {
    const fields=['asset_id','currency_id','order_amount','daily_buy_budget','stop_loss_pct','fee_pct'];
    if(!data||Object.keys(data).sort().join()!==fields.sort().join())throw new Failure('Paramètres d’automatisation incomplets.');
    const asset=uuid(data.asset_id), amount=cents(data.order_amount), budget=cents(data.daily_buy_budget);
    const currency=uuid(data.currency_id);
    if(currency!==uuid(env.BITPANDA_TRADING_CURRENCY_ID))throw new Failure('La devise serveur a changé. Actualisez avant enregistrement.');
    if(amount>budget)throw new Failure('Le montant par achat dépasse le budget quotidien.');
    const stop=data.stop_loss_pct===''?null:Number(data.stop_loss_pct), fee=Number(data.fee_pct);
    if((stop!==null&&(!Number.isFinite(stop)||stop<=0||stop>=100))||typeof data.fee_pct!=='string'||!/^\d{1,2}(?:\.\d{1,4})?$/.test(data.fee_pct)||!Number.isFinite(fee)||fee<0||fee>=10)throw new Failure('Pourcentages invalides.');
    const old=await config(env), db=database(env);
    const position=await db.prepare("SELECT asset FROM automation_position WHERE quantity!='0' LIMIT 1").first();
    if(position&&position.asset!==asset)throw new Failure('Une position du bot est encore ouverte : rapprochez-la avant de changer d’actif.',409);
    if(old.settings.currency_id&&old.settings.currency_id!==currency){
      const committed=await db.prepare('SELECT id FROM automation_runs WHERE day=? AND budget_cents>0 LIMIT 1').bind(new Date(now()).toISOString().slice(0,10)).first();
      if(position||committed)throw new Failure('Conservez la devise tant qu’une position est ouverte ou qu’un budget est engagé aujourd’hui.',409);
    }
    const settings={asset_id:asset,currency_id:currency,order_amount:data.order_amount,daily_buy_budget:data.daily_buy_budget,stop_loss_pct:stop,fee_pct:fee};
    await db.prepare('UPDATE automation_config SET settings=?,revision=revision+1,enabled=0,strategy=? WHERE id=1').bind(JSON.stringify(settings),asset===old.settings.asset_id&&old.strategy?JSON.stringify(old.strategy):null).run();
    return state(env);
  }
  async function approve(env,data) {
    if(!data||typeof data.strategy_id!=='string'||Object.keys(data).length!==1)throw new Failure('Variante à approuver requise.');
    const c=await config(env), row=await database(env).prepare('SELECT result FROM automation_research WHERE id=1').first();
    const report=row?JSON.parse(row.result):null;
    const candidate=report?.candidates.find(item=>item.id===data.strategy_id&&item.eligible);
    if(!candidate||report.asset_id!==c.settings.asset_id||now()-Date.parse(report.created)>86400000)throw new Failure('Une comparaison récente et exploitable de cet actif est requise.');
    const strategy={id:candidate.id,name:candidate.name,fast:candidate.fast,slow:candidate.slow,approved_at:new Date(now()).toISOString()};
    await database(env).prepare('UPDATE automation_config SET strategy=?,enabled=0,revision=revision+1 WHERE id=1').bind(JSON.stringify(strategy)).run();
    return state(env);
  }
  async function pause(env) {
    await config(env);
    await database(env).prepare('UPDATE automation_config SET enabled=0,revision=revision+1 WHERE id=1').run();
    return state(env);
  }
  async function enable(env,data) {
    if(!data||data.confirm_real_automation!==true||Object.keys(data).length!==2||!Number.isInteger(data.revision))throw new Failure('Confirmation explicite et révision courante des ordres automatiques requises.');
    const c=await config(env), p=policy(env);
    if(c.revision!==data.revision)throw new Failure('Les réglages ont changé. Actualisez avant activation.',409);
    if(env.AUTOMATION_ENABLED!=='1'||env.AUTOMATION_TRADING_ENABLED!=='1')throw new Failure('Les autorisations serveur de collecte et d’ordres automatiques doivent être activées par vous.',503);
    if(!env.BITPANDA_API_KEY)throw new Failure('Clé Bitpanda à configurer.',503);
    if(!c.settings.asset_id||!c.strategy)throw new Failure('Enregistrez les limites et approuvez une stratégie.');
    if(c.settings.currency_id!==p.currency)throw new Failure('Enregistrez de nouveau les limites dans la devise actuelle.');
    if(decimal(c.settings.order_amount)>p.limit)throw new Failure('Le montant dépasse le plafond Bitpanda du serveur.');
    const unresolved=await database(env).prepare("SELECT id FROM automation_runs WHERE state IN ('collecting','reserved','submitting','unknown') LIMIT 1").first();
    if(unresolved)throw new Failure('Un cycle reste à rapprocher avant la reprise.',409);
    const updated=await database(env).prepare('UPDATE automation_config SET enabled=1,revision=revision+1 WHERE id=1 AND revision=?').bind(data.revision).run();
    if(updated.meta.changes!==1)throw new Failure('Pause ou modification concurrente : activation annulée.',409);
    return state(env);
  }
  async function notes(env,data) {
    if(!data||!Array.isArray(data.notes)||data.notes.length>4)throw new Failure('Quatre notes maximum.');
    const db=database(env);await config(env);
    for(const note of data.notes) {
      if(!/^[a-zA-Z0-9_-]{1,60}$/.test(note.id||'')||typeof note.title!=='string'||note.title.length>80||typeof note.content!=='string'||note.content.length>2000)throw new Failure('Note invalide (2 000 caractères maximum).');
    }
    // Full snapshot from the vault: removed notes cease to propose candidates.
    await db.batch([db.prepare('DELETE FROM automation_notes'),...data.notes.map(note=>{
      const candidate=noteCandidate(note.id,note.content);
      return db.prepare('INSERT INTO automation_notes(id,title,content,candidate,updated) VALUES(?,?,?,?,?)').bind(note.id,note.title,note.content,candidate?JSON.stringify(candidate):null,new Date(now()).toISOString());
    })]);
    return {saved:data.notes.length};
  }
  async function snapshot(env) {
    const s=await state(env), rows=await database(env).prepare('SELECT quote,state,created FROM orders ORDER BY created DESC LIMIT 100').all();
    const tradeTable=rows.results.map(row=>{const q=JSON.parse(row.quote);return `| ${escape(row.created)} | ${escape(q.assetId)} | ${escape(q.side)} | ${escape(q.notional)} | ${escape(row.state)} |`;}).join('\n');
    const comparisons=s.research?.candidates.map(c=>`| ${escape(c.name)} | ${c.return_pct.toFixed(2)} % | ${c.max_drawdown_pct.toFixed(2)} % | ${c.trades} |`).join('\n')||'Pas encore de comparaison exploitable.';
    return {files:{
      'Tableau de bord.md':`# BDLTradingBot\n\nActualisé : ${new Date(now()).toISOString()}\n\nAutomatisation : ${s.enabled?'active':'en pause'}\n\nActif : ${s.settings.asset_id||'à choisir'}\n\nStratégie approuvée : ${s.strategy?.name||'aucune'}\n\n[[Journal]] · [[Recherche]] · [[Fonctionnement]]\n`,
      'Journal.md':`# Journal Bitpanda\n\nLes devis ne sont pas tous exécutés : consultez leur état.\n\n| Date | Actif | Sens | Montant en devise | État |\n|---|---|---|---|---|\n${tradeTable}\n`,
      'Recherche.md':`# Comparaison des stratégies\n\n${s.research?.explanation||'Collecte à configurer.'}\n\nPoints : ${s.points}\n\nFrais estimés : ${s.settings.fee_pct??'à renseigner'} %\n\n| Variante | Rendement période test | Drawdown | Transactions |\n|---|---|---|---|\n${comparisons}\n\nToute modification de stratégie doit être approuvée dans le site. Les notes ne sont jamais exécutées comme du code.\n`,
    }};
  }
  async function tick(env,scheduledTime) {
    if(env.AUTOMATION_ENABLED!=='1')return {state:'disabled'};
    const c=await config(env);
    if(!c.settings.asset_id)return {state:'unconfigured'};
    const time=now();if(Math.abs(time-scheduledTime)>PERIOD)return {state:'stale_event'};
    const slot=Math.floor(scheduledTime/PERIOD), id=`${slot}-${c.revision}-${c.settings.asset_id}`, db=database(env), day=new Date(time).toISOString().slice(0,10);
    const claim=await db.prepare("INSERT OR IGNORE INTO automation_runs(id,asset,slot,revision,state,day,created) SELECT ?,?,?,?,'collecting',?,? WHERE NOT EXISTS(SELECT 1 FROM automation_runs WHERE state IN ('collecting','reserved','submitting','unknown'))").bind(id,c.settings.asset_id,slot,c.revision,day,new Date(time).toISOString()).run();
    if(claim.meta.changes!==1)return {state:'duplicate_or_blocked'};
    let submitted=false;
    const finish=async(state,detail='')=>{await db.prepare("UPDATE automation_runs SET state=?,detail=? WHERE id=? AND state!='executed'").bind(state,detail,id).run();return {state,detail};};
    try {
      const ticker=await upstream(env,'GET',`/assets/${c.settings.asset_id}/ticker`);
      if(uuid(ticker.assetId)!==c.settings.asset_id||typeof ticker.currency!=='string'||!Number.isFinite(Date.parse(ticker.timestamp))||time-Date.parse(ticker.timestamp)>PERIOD*2||Date.parse(ticker.timestamp)-time>60000)throw new Failure('Cours absent, périmé ou incohérent.');
      const price=decimal(ticker.price);
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO automation_prices(asset,slot,price,currency) VALUES(?,?,?,?)').bind(c.settings.asset_id,slot,ticker.price,ticker.currency),
        db.prepare('DELETE FROM automation_prices WHERE asset=? AND slot<?').bind(c.settings.asset_id,slot-599),
      ]);
      const history=await prices(env,c.settings.asset_id);
      if(slot%12===0&&history.length>=200&&continuous(history))await research(env);
      if(!c.enabled||env.AUTOMATION_TRADING_ENABLED!=='1')return finish('observed','Collecte uniquement.');
      const p=policy(env);
      if(c.settings.currency_id!==p.currency)throw new Failure('Devise serveur modifiée : réenregistrez les limites avant reprise.');
      if(!c.strategy||!continuous(history)||history.length<c.strategy.slow+1)return finish('warming_up','Historique consécutif insuffisant.');
      const currencies=await upstream(env,'GET','/currencies?id='+p.currency);
      const list=Array.isArray(currencies)?currencies:currencies?.data;
      const currency=list?.find(item=>item.id===p.currency);
      if((currency?.symbol||currency?.code)!==ticker.currency)throw new Failure('La devise du cours ne correspond pas à la devise autorisée.');
      const position=await db.prepare('SELECT * FROM automation_position WHERE asset=?').bind(c.settings.asset_id).first();
      const quantity=position&&position.quantity!=='0'?decimal(position.quantity):0n;
      let action=signal(history.map(row=>Number(row.price)),c.strategy);
      if(quantity>0n&&c.settings.stop_loss_pct!==null&&Number(ticker.price)<=Number(position.entry)*(1-c.settings.stop_loss_pct/100))action='SELL';
      if((action==='BUY'&&quantity>0n)||(action==='SELL'&&quantity===0n)||action==='HOLD')return finish('held','Aucun nouvel ordre.');
      let payload={assetId:c.settings.asset_id,currencyId:p.currency,side:action};
      if(action==='BUY') {
        if(decimal(c.settings.order_amount)>p.limit)throw new Failure('Le montant dépasse le plafond serveur.');
        const budget=cents(c.settings.daily_buy_budget), cost=cents(c.settings.order_amount);
        const reserved=await db.prepare("UPDATE automation_runs SET state='reserved',side='BUY',budget_cents=? WHERE id=? AND COALESCE((SELECT SUM(budget_cents) FROM automation_runs WHERE day=? AND side='BUY' AND state IN ('reserved','submitting','executed','unknown')),0)+?<=?").bind(cost,id,day,cost,budget).run();
        if(reserved.meta.changes!==1)return finish('budget_blocked','Plafond des achats du jour atteint.');
        payload.notional=c.settings.order_amount;
      } else {
        const holdings=await upstream(env,'GET','/portfolio/holdings?assetId='+c.settings.asset_id);
        if(!Array.isArray(holdings))throw new Failure('Positions Bitpanda non reconnues.');
        const held=holdings.filter(item=>item.assetId===c.settings.asset_id).reduce((total,item)=>total+(item.quantity==='0'?0n:decimal(item.quantity)),0n);
        if(held<quantity)throw new Failure('La position réelle diffère du journal du bot. Rapprochement nécessaire.');
        const sold=quantity<p.limit*SCALE/price?quantity:p.limit*SCALE/price;
        if(sold===0n)throw new Failure('Quantité de vente trop faible.');
        payload.quantity=units(sold);
        await db.prepare("UPDATE automation_runs SET state='reserved',side='SELL' WHERE id=?").bind(id).run();
      }
      const q=await quote(env,payload), latest=await config(env);
      if(!latest.enabled||latest.revision!==c.revision)return finish('cancelled','Configuration modifiée ou pause demandée avant acceptation.');
      if(new Date(now()).toISOString().slice(0,10)!==day)return finish('cancelled','Changement de jour UTC avant acceptation ; budget à revérifier.');
      const authorized=await db.prepare("UPDATE automation_runs SET state='submitting',quote_id=? WHERE id=? AND EXISTS(SELECT 1 FROM automation_config WHERE id=1 AND enabled=1 AND revision=?)").bind(q.quote.id,id,c.revision).run();
      if(authorized.meta.changes!==1)return finish('cancelled','Pause ou changement de configuration avant envoi.');
      submitted=true;
      await accept(env,{quote_id:q.quote.id,confirmation_token:q.confirmation_token,confirm_real_order:true});
      const next=action==='BUY'?decimal(q.quote.quantity):quantity-decimal(q.quote.quantity);
      if(next<0n)throw new Failure('Quantité exécutée incohérente.');
      await db.batch([
        db.prepare('INSERT INTO automation_position(asset,quantity,entry) VALUES(?,?,?) ON CONFLICT(asset) DO UPDATE SET quantity=excluded.quantity,entry=excluded.entry').bind(c.settings.asset_id,units(next),action==='BUY'?q.quote.price:position.entry),
        db.prepare("UPDATE automation_runs SET state='executed',detail='Exécution confirmée par Bitpanda.' WHERE id=?").bind(id),
      ]);
      return {state:'executed'};
    } catch(error) {
      // A submitted cycle stays blocked if recording the outcome also fails.
      return finish(submitted?'unknown':'error',error instanceof Failure?error.message:'Erreur du cycle ; vérifiez le journal et Bitpanda.');
    }
  }
  return {state,setup,save,approve,pause,enable,research,notes,snapshot,tick};
}
