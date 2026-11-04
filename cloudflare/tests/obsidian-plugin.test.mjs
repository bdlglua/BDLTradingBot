import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../../obsidian-plugin/main.js',import.meta.url),'utf8');
test('extension Obsidian : journal, notes, mémoire seule et chemins contrôlés',async()=>{
  const files=new Map(),requests=[];
  const add=(path,content)=>{files.set(path,{path,content,extension:path.endsWith('.md')?'md':'',basename:path.split('/').at(-1).replace(/\.md$/,'')});};
  add('BDLTradingBot/Journal.md','Ancien journal');
  add('BDLTradingBot/Mes notes.md','À préserver');
  add('BDLTradingBot/Strategies/Exemple.md','---\nfamily: sma\nfast: 5\nslow: 20\n---\nMa note');
  const vault={getAbstractFileByPath:path=>files.get(path),createFolder:async path=>add(path,''),
    create:async(path,text)=>add(path,text),modify:async(file,text)=>{file.content=text;},
    getMarkdownFiles:()=>Array.from(files.values()).filter(f=>f.extension==='md'),read:async file=>file.content,on:()=>({})};
  class Plugin{constructor(app){this.app=app;}addCommand(){}registerInterval(){}registerEvent(){}saveData(){throw Error('Un secret ne doit pas être enregistré.');}}
  const sdk={Plugin,Modal:class{},Setting:class{},Notice:class{},requestUrl:async options=>{
    requests.push(options);
    if(options.url.endsWith('/api/session'))return {status:200,json:{csrf_token:'fake-session'}};
    if(options.url.endsWith('/api/obsidian/snapshot'))return {status:200,json:{files:{'Journal.md':'Journal actualisé','Recherche.md':'Comparaison','../intrusion.md':'Refuser'}}};
    if(options.url.endsWith('/api/obsidian/notes'))return {status:200,json:{saved:1}};
    throw Error('Route financière inattendue.');
  }};
  const context={module:{exports:{}},require:name=>{assert.equal(name,'obsidian');return sdk;},URL,window:{setInterval:()=>1}};
  vm.runInNewContext(source,context,{filename:'obsidian-plugin/main.js'});
  const plugin=new context.module.exports({vault});await plugin.onload();
  const token='fake-obsidian-code-over-32-characters';
  await plugin.connect('https://api.example.com',token);
  assert.equal(files.get('BDLTradingBot/Journal.md').content,'Journal actualisé');
  assert.equal(files.get('BDLTradingBot/Mes notes.md').content,'À préserver');assert.ok(!files.has('intrusion.md'));
  assert.ok(!Array.from(files.values()).some(file=>file.content.includes(token)));
  assert.equal(requests.length,3);assert.equal(requests[2].headers['X-CSRF-Token'],'fake-session');
  assert.equal(JSON.parse(requests[2].body).notes[0].id,'Exemple');
  plugin.disconnect();assert.equal(plugin.token,'');
  await assert.rejects(()=>plugin.sync(),/Connectez le bot/);
});
