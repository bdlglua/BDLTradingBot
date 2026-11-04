// Comparaison de règles explicites. Aucun code issu de notes n'est exécuté.
export const CATALOG = [
  {id:'sma-3-12', name:'Moyennes mobiles 3 / 12', fast:3, slow:12},
  {id:'sma-5-20', name:'Moyennes mobiles 5 / 20', fast:5, slow:20},
  {id:'sma-10-40', name:'Moyennes mobiles 10 / 40', fast:10, slow:40},
];
export function noteCandidate(id, content) {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return null;
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^(family|fast|slow):\s*([a-z\d]+)\s*$/);
    if (match) fields[match[1]]=match[2];
  }
  const fast=Number(fields.fast), slow=Number(fields.slow);
  if(fields.family!=='sma' || !Number.isInteger(fast) || !Number.isInteger(slow) || fast<1 || fast>=slow || slow>200) return null;
  return {id:'note-'+id, name:'Note '+id, fast, slow};
}
export function signal(prices, strategy) {
  const {fast,slow}=strategy;
  if(prices.length<slow+1)return 'HOLD';
  const mean=(end,size)=>prices.slice(end-size,end).reduce((sum,p)=>sum+p,0)/size;
  const current=mean(prices.length,fast)-mean(prices.length,slow);
  const prior=mean(prices.length-1,fast)-mean(prices.length-1,slow);
  return prior<=0 && current>0?'BUY':prior>=0 && current<0?'SELL':'HOLD';
}
export function compare(prices, candidates, fee) {
  // Paramètres fixes ; aucun réglage sur la période réservée à l'évaluation.
  const start=Math.floor(prices.length*.7);
  return candidates.map(strategy=>{
    let cash=100, qty=0, pending='HOLD', trades=0, peak=100, drawdown=0,fastSum=0,slowSum=0,prior=null;
    for(let i=0;i<prices.length;i++) {
      const price=prices[i];
      fastSum+=price;slowSum+=price;
      if(i>=strategy.fast)fastSum-=prices[i-strategy.fast];
      if(i>=strategy.slow)slowSum-=prices[i-strategy.slow];
      const spread=i>=strategy.slow-1?fastSum/strategy.fast-slowSum/strategy.slow:null;
      if(i<start){prior=spread;continue;}
      if(pending==='BUY' && qty===0){qty=cash/(price*(1+fee));cash=0;trades++;}
      else if(pending==='SELL' && qty>0){cash=qty*price*(1-fee);qty=0;trades++;}
      const equity=cash+qty*price;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,(peak-equity)/peak);
      pending=prior!==null&&prior<=0&&spread>0?'BUY':prior!==null&&prior>=0&&spread<0?'SELL':'HOLD';
      prior=spread;
    }
    return {...strategy, return_pct:cash+qty*prices.at(-1)-100, max_drawdown_pct:drawdown*100,
      trades, eligible:trades>=2, evaluation_points:prices.length-start};
  }).sort((a,b)=>Number(b.eligible)-Number(a.eligible) || b.return_pct-a.return_pct);
}
