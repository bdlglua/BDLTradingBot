const {Plugin,Modal,Setting,Notice,requestUrl}=require('obsidian');
const ROOT='BDLTradingBot';
const MANAGED=new Set(['Tableau de bord.md','Journal.md','Recherche.md']);
class ConnectModal extends Modal {
  constructor(app,connect){super(app);this.connect=connect;this.url='https://bdltradingbot.bdlminer-bot.workers.dev';this.token='';}
  onOpen(){
    this.contentEl.createEl('h2',{text:'Connecter BDLTradingBot'});
    this.contentEl.createEl('p',{text:'Utilisez de préférence le code dédié OBSIDIAN_ACCESS_TOKEN. Il reste en mémoire jusqu’à la fermeture. Ne saisissez pas votre clé Bitpanda.'});
    new Setting(this.contentEl).setName('Adresse HTTPS du serveur').addText(input=>input.setValue(this.url).onChange(value=>this.url=value));
    new Setting(this.contentEl).setName('Code d’accès Obsidian').addText(input=>{input.inputEl.type='password';input.inputEl.autocomplete='off';input.onChange(value=>this.token=value);});
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Connecter').setCta().onClick(async()=>{
      button.setDisabled(true);
      try{await this.connect(this.url,this.token);this.close();}catch(error){new Notice(error.message);button.setDisabled(false);}
    }));
  }
  onClose(){this.token='';this.contentEl.empty();}
}
module.exports=class BDLTradingPlugin extends Plugin {
  async onload(){
    this.token='';this.base='';this.busy=false;
    this.addCommand({id:'connect',name:'Connecter le bot',callback:()=>new ConnectModal(this.app,(url,token)=>this.connect(url,token)).open()});
    this.addCommand({id:'sync',name:'Synchroniser le journal et les notes',callback:()=>this.sync().catch(error=>new Notice(error.message))});
    this.addCommand({id:'disconnect',name:'Déconnecter le bot',callback:()=>{this.disconnect();new Notice('Code d’accès effacé de la mémoire.');}});
    this.registerInterval(window.setInterval(()=>{if(this.token)this.sync().catch(error=>new Notice('BDLTradingBot : '+error.message));},300000));
    this.registerEvent(this.app.vault.on('modify',file=>{if(file.path.startsWith(ROOT+'/Strategies/')&&file.extension==='md')this.dirty=true;}));
  }
  disconnect(){this.token='';this.base='';this.csrf='';this.generation=(this.generation||0)+1;}
  onunload(){this.disconnect();}
  async api(path,body){
    if(!this.token)throw Error('Connectez le bot avec la commande Obsidian « Connecter le bot ».');
    const generation=this.generation;
    const headers={Authorization:'Bearer '+this.token};
    const options={url:this.base+path,method:body===undefined?'GET':'POST',headers,throw:false};
    if(body!==undefined){headers['Content-Type']='application/json';headers['X-CSRF-Token']=this.csrf;options.body=JSON.stringify(body);}
    const response=await requestUrl(options);
    if(generation!==this.generation)throw Error('Session déconnectée.');
    if(response.status>=300)throw Error(response.json?.error||'Serveur indisponible.');
    return response.json;
  }
  async connect(url,token){
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash||parsed.pathname!=='/')throw Error('Adresse HTTPS sans chemin ni identifiants requise.');
    if(!/^[\x21-\x7e]{32,256}$/.test(token))throw Error('Code de 32 à 256 caractères sans espaces requis.');
    this.disconnect();this.base=parsed.origin;this.token=token;
    try{this.csrf=(await this.api('/api/session')).csrf_token;await this.sync();new Notice('Journal BDLTradingBot synchronisé.');}
    catch(error){this.disconnect();throw error;}
  }
  async folder(path){if(!this.app.vault.getAbstractFileByPath(path))await this.app.vault.createFolder(path);}
  async sync(){
    if(this.busy)return;
    this.busy=true;
    try{
      const generation=this.generation;
      const snapshot=await this.api('/api/obsidian/snapshot');
      if(generation!==this.generation)return;
      await this.folder(ROOT);await this.folder(ROOT+'/Strategies');
      for(const [name,content]of Object.entries(snapshot.files||{})){
        if(!MANAGED.has(name)||typeof content!=='string'||content.length>100000)continue;
        const path=ROOT+'/'+name,file=this.app.vault.getAbstractFileByPath(path);
        if(file)await this.app.vault.modify(file,content);else await this.app.vault.create(path,content);
      }
      const files=this.app.vault.getMarkdownFiles().filter(file=>file.path.startsWith(ROOT+'/Strategies/')).sort((a,b)=>a.path.localeCompare(b.path));
      if(files.length>4)throw Error('Quatre notes de stratégie au maximum peuvent être synchronisées.');
      const notes=[];
      for(const file of files){
        const content=await this.app.vault.read(file);
        if(content.length>2000)throw Error('La note '+file.basename+' dépasse 2 000 caractères.');
        const id=file.basename.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,60);
        if(!id||notes.some(note=>note.id===id))throw Error('Noms de notes ambigus : renommez-les avec des lettres et tirets.');
        notes.push({id,title:file.basename.slice(0,80),content});
      }
      if(generation===this.generation)await this.api('/api/obsidian/notes',{notes});
    }finally{this.busy=false;}
  }
};
