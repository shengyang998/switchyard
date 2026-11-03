#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { command } from './process.js';
const args = process.argv.slice(2), flags: Record<string,string> = {}, positional: string[] = [];
const help = `Switchyard — durable local Router/Worker orchestration
Usage: node dist/cli.js [--state DIR] COMMAND [options]
  init --repo PATH [--concurrency 2] [--model MODEL] [--min-free-mb 10240]
       [--router-command '["executable","arg"]']
       [--worker-kind codex] [--worker-args '["arg"]'] [--herdr PATH]
  submit "message" [--task TASK] [--id INPUT_ID]   (persist only; run routes)
  run [--passes 1]                         bounded supervisor passes
  serve [--interval 2000] [--passes N]      foreground, Ctrl-C to stop
  status                                  JSON state, no live control
  report --task ID --token TOKEN --event ID --id ID --outcome OUTCOME --summary TEXT --evidence TEXT
  recover                                 inspect saved workers, freeze ambiguity
  recover --task ID                       re-verify a frozen task against its saved pane + session
  recover --task ID --respawn             resume the saved agent session (saved pane or a new one)
  recover --task ID --ref JSON --session JSON explicit verified adoption
  resolve --event ID --action retry|delivered (after operator inspection)
  retry-route --event ID                   explicitly retry failed classification
  history                                 durable audit log
  du [--task ID]                          disk usage per task, free space, gc --merged estimate
  close --task ID [--abandon] [--discard-changes]
                                          close worker pane + remove worktree; keep branch
  drop --task ID [--into REF] [--abandon] [--discard-changes] [--discard-unmerged]
                                          close, then delete the branch if merged into REF (HEAD)
  gc --merged [--into REF] [--dry-run]    drop every finished, clean task merged into REF (HEAD)
Default state: .switchyard in current directory. No automatic merge/push/publication.`;
const booleans = new Set(['abandon','discard-changes','discard-unmerged','merged','dry-run','respawn']);
const required = (name:string) => { if (!flags[name]) throw new Error(`Missing --${name}`); return flags[name]; };
function integer(value: string | undefined, fallback:number) { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n)||n<1||n>86400000) throw new Error('Expected positive bounded integer'); return n; }
function nonNegative(value: string | undefined, fallback:number) { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n)||n<0||n>1e9) throw new Error('Expected non-negative bounded integer'); return n; }
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
function argv(value:string) { const a = JSON.parse(value); if (!Array.isArray(a)||!a.every(x=>typeof x==='string')||!a.length) throw new Error('Expected nonempty JSON argv array'); return a; }
let store: Store | undefined;
try {
  const commands:Record<string,string[]>={init:['repo','concurrency','model','router-command','worker-kind','worker-args','herdr','codex','timeout','min-free-mb'],du:['task'],close:['task','abandon','discard-changes'],drop:['task','into','abandon','discard-changes','discard-unmerged'],gc:['merged','into','dry-run'],submit:['task','id'],run:['passes','interval'],serve:['passes','interval'],status:[],history:[],report:['task','token','event','id','outcome','summary','evidence'],recover:['task','ref','session','respawn'],resolve:['event','action'],'retry-route':['event'],help:[]};
  if(args.includes('--help')||args.includes('-h')) positional.push('help');
  else for(let i=0;i<args.length;i++) {
    if(args[i]==='--'){positional.push(...args.slice(i+1));break;}
    if(args[i].startsWith('--')) {
      const key=args[i].slice(2);
      if(key in flags) throw new Error(`Duplicate option --${key}`);
      if(booleans.has(key)) { flags[key]='true'; continue; }
      if(!args[i+1]||args[i+1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      flags[key]=args[++i];
    } else positional.push(args[i]);
  }
  const cmd=positional.shift();
  if(cmd && !(cmd in commands)) throw new Error(`Unknown command ${cmd}`);
  if(cmd) for(const key of Object.keys(flags)) if(key!=='state'&&!commands[cmd].includes(key)) throw new Error(`Unknown option --${key} for ${cmd}`);
  if(cmd && cmd!=='submit' && positional.length) throw new Error('Unexpected positional arguments');
  if(cmd==='init') {
    required('repo'); integer(flags.concurrency,2); integer(flags.timeout,120000); nonNegative(flags['min-free-mb'],10240);
    if(flags['router-command']) argv(flags['router-command']);
    if(flags['worker-args']) {const a=JSON.parse(flags['worker-args']);if(!Array.isArray(a)||!a.every(x=>typeof x==='string'))throw new Error('worker-args must be JSON string array');}
    if(flags['worker-kind']&&!/^[a-z][a-z0-9_-]*$/.test(flags['worker-kind'])) throw new Error('Invalid worker kind');
  }
  if(cmd==='run'||cmd==='serve'){integer(flags.passes,1);integer(flags.interval,2000);}
  if(cmd==='recover'){
    if((flags.ref||flags.session||flags.respawn)&&!flags.task) throw new Error('recover options require --task');
    if(flags.ref||flags.session){required('ref');required('session');if(flags.respawn)throw new Error('--respawn cannot be combined with --ref/--session');}
  }
  if(cmd==='report') for(const key of commands.report) required(key);
  if(cmd==='resolve'){required('event');if(!['retry','delivered'].includes(required('action')))throw new Error('Invalid resolution action');}
  if(cmd==='retry-route')required('event');
  if(cmd==='close'||cmd==='drop')required('task');
  if(cmd==='gc'&&!flags.merged) throw new Error('gc requires --merged (the only collection mode in this release)');
  if(flags.into?.startsWith('-')) throw new Error('Invalid --into reference');
  if (!cmd || cmd === 'help') { console.log(help); } else {
    let state = resolve(flags.state ?? process.env.SWITCHYARD_STATE ?? '.switchyard');
    if (cmd !== 'init' && !existsSync(join(state,'state.db'))) throw new Error('State not initialized; run init');
    store = new Store(state); state=realpathSync(state); store.dir=state;
    if (cmd === 'init') {
      const repo = realpathSync(resolve(required('repo')));
      await command('git',['-C',repo,'rev-parse','--verify','HEAD']);
      const top = (await command('git',['-C',repo,'rev-parse','--show-toplevel'])).trim();
      if (resolve(top) !== repo) throw new Error('--repo must be repository root');
      if (store.config().repo) throw new Error('State already initialized');
      if (state === repo || state.startsWith(repo + '/')) {
        const check = await command('git',['-C',repo,'check-ignore','--no-index',state]).catch(()=> '');
        if (!check.trim()) throw new Error('State inside repo must already be ignored; add .switchyard/ or choose external --state');
      }
      const kind=flags['worker-kind']??'codex';
      const config = {repo,base:(await command('git',['-C',repo,'rev-parse','HEAD'])).trim(),concurrency:integer(flags.concurrency,2),timeout:integer(flags.timeout,120000),minFreeMb:nonNegative(flags['min-free-mb'],10240),transport:{type:'herdr',executable:flags.herdr??'herdr'},cli:fileURLToPath(import.meta.url),router:flags['router-command']?{type:'command',argv:argv(flags['router-command'])}:{type:'codex',executable:flags.codex??'codex',model:flags.model??'gpt-6.1-sol'},worker:{kind,args:flags['worker-args']?JSON.parse(flags['worker-args']):kind==='codex'?['--sandbox','workspace-write','--ask-for-approval','on-request','--add-dir',state,'--no-alt-screen']:[]}};
      if (!Array.isArray(config.worker.args)||!config.worker.args.every((x:unknown)=>typeof x==='string')) throw new Error('worker-args must be JSON string array');
      store.tx(()=>{for(const [key,value] of Object.entries(config)) store!.run('INSERT INTO config VALUES(?,?)',key,JSON.stringify(value));});
      mkdirSync(state,{recursive:true}); writeFileSync(join(state,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
      console.log(JSON.stringify({initialized:state,config},null,2));
    } else {
      const engine=new Engine(store);
      let output: unknown;
      if(cmd==='submit') output=await engine.submit(positional.join(' '),flags.task,flags.id);
      else if(cmd==='status') output=engine.status();
      else if(cmd==='history') output=store.all('SELECT * FROM audit ORDER BY seq');
      else if(cmd==='report') output=engine.report(Object.fromEntries(['task','token','event','id','outcome','summary','evidence'].map(k=>[k,required(k)])));
      else if(cmd==='du') output=await engine.du(flags.task);
      else if(cmd==='gc'&&flags['dry-run']) output={dryRun:true,...await engine.gcPlan(await engine.resolveInto(flags.into))};
      else if(cmd==='close'||cmd==='drop'||cmd==='gc') {
        let ids:string[], plan:any;
        if(cmd==='gc') {
          plan=await engine.gcPlan(await engine.resolveInto(flags.into));
          ids=plan.eligible.map((x:any)=>engine.request(x.task,'drop',{into:plan.into,abandon:false,discardChanges:false,discardUnmerged:false}).id);
        } else {
          const options={into:cmd==='drop'?await engine.resolveInto(flags.into):null,abandon:!!flags.abandon,discardChanges:!!flags['discard-changes'],discardUnmerged:!!flags['discard-unmerged']};
          ids=[engine.request(required('task'),cmd,options).id];
        }
        // Execute under the supervisor lock, or let the running supervisor apply the durable request.
        const deadline=Date.now()+2*engine.config.timeout+10000;
        while(engine.pending(ids)) {
          let unlock:(()=>void)|undefined;
          try { unlock=store.lock(); } catch(e:any) { if(!/Supervisor already active/.test(e.message)) throw e; }
          if(unlock) { try { await engine.applyRequests(ids); } finally { unlock(); } continue; }
          if(Date.now()>deadline) break;
          await sleep(200);
        }
        const requests=ids.map(key=>engine.requestView(store!.get('SELECT * FROM requests WHERE id=?',key)!));
        if(cmd==='gc') output={into:plan.into,dropped:requests.filter(r=>r.state==='done').map(r=>r.result),failed:requests.filter(r=>!['done','pending'].includes(r.state)).map(r=>({task:r.task,state:r.state,error:r.error})),pending:requests.filter(r=>r.state==='pending').map(r=>r.id),skipped:plan.skipped};
        else if(['rejected','failed'].includes(requests[0].state)) throw new Error(requests[0].error);
        else output=requests[0].state==='done'?requests[0].result:{pending:true,request:requests[0]};
      }
      else if(['run','serve','recover','resolve','retry-route'].includes(cmd)) {
        const unlock=store.lock();
        try {
          if(cmd==='retry-route') { engine.retryRoute(required('event')); output=engine.status(); }
          else if(cmd==='recover') {
            await engine.reconcile();
            if(flags.task&&engine.offline) throw new Error(`${engine.offline}; start Herdr, then retry`);
            let recovered:unknown;
            if(flags.task&&flags.respawn) recovered=await engine.respawn(flags.task);
            else if(flags.task&&flags.ref) await engine.recover(flags.task,required('ref'),required('session'));
            else if(flags.task) recovered=await engine.reverify(flags.task);
            output={...(recovered?{recovered}:{}),...engine.status(),...(engine.offline?{transport:{ok:false,error:engine.offline}}:{})};
          }
          else if(cmd==='resolve') { await engine.reconcile(); engine.resolveDelivery(required('event'),required('action')); output=engine.status(); }
          else {
            const passes=integer(flags.passes,cmd==='serve'?100000:1),interval=integer(flags.interval,2000);
            let stopped=false; const stop=()=>{stopped=true;}; process.on('SIGINT',stop); process.on('SIGTERM',stop);
            try { for(let i=0;i<passes&&!stopped;i++){output=await engine.pass(); if(cmd==='serve') console.log(JSON.stringify(output)); if(i+1<passes&&!stopped) await new Promise(r=>setTimeout(r,interval));} } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
          }
        } finally {unlock();}
      } else throw new Error(`Unknown command ${cmd}\n${help}`);
      if(output && cmd!=='serve') console.log(JSON.stringify(output,null,2));
    }
  }
} catch(e:any) {console.error(e.message);process.exitCode=1;} finally {store?.close();}
