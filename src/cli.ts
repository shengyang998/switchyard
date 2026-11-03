#!/usr/bin/env node
import './quiet.js';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { Store, type Row } from './store.js';
import { Engine } from './engine.js';
import { command } from './process.js';
import { defaultState, locate, mainRoot } from './locate.js';
import { changes, detail, inbox, inputView, renderDetail, renderDu, renderGc, renderInbox, renderInput, renderLifecycle, snapshot } from './view.js';
const args = process.argv.slice(2), flags: Record<string,string> = {}, positional: string[] = [];
const help = `Switchyard: long-running coding agents, one Git worktree and one worker per task.
Usage: sy [--state DIR] [COMMAND | "message"] [options]   (also installed as \`switchyard\`; or node dist/cli.js)

Everyday use, from anywhere inside your project (state is found automatically):
  sy init                         set this repository up (once)
  sy up                           run the supervisor; keep it open in a Herdr pane (Ctrl-C stops it)
  sy "add a JSON export"          send work: the Router starts a new task or continues an existing one
  sy "#2 also add timestamps"     send a follow-up straight to task #2 (no Router call)
  sy                              inbox: what needs you, what is running, what is ready for review
  sy show 2    sy diff 2          a task's timeline and next steps; its changes
  sy du    sy close 2    sy drop 2    sy gc --merged    see and reclaim disk space

A task is #2, 2, its ID or a unique ID prefix. Output is text on a terminal and JSON otherwise;
force it with --json or --format text|json. Quote the input, or put it after --, if it starts with --.

Commands (all accept --state DIR):
  init [--repo PATH] [--concurrency 2] [--model MODEL] [--min-free-mb 10240]
       [--router-command '["executable","arg"]']
       [--worker-kind codex] [--worker-args '["arg"]'] [--herdr PATH]
  inbox                                   the default view (same as bare \`sy\`)
  "message" [--task TASK] [--id INPUT_ID] submit and route now; prints where it went
  submit "message" [--task TASK] [--id INPUT_ID]   persist only; the supervisor routes it
  show TASK                               state, timeline of inputs/reports/audit, next steps
  diff TASK [--stat]                      changes against the initialized base commit
  up [--interval 2000] [--no-notify]      supervisor with a readable log and Herdr notifications
  serve [--interval 2000] [--passes N] [--notify]   foreground supervisor
  run [--passes 1]                        bounded supervisor passes
  status                                  JSON state, no live control
  history                                 durable audit log (JSON)
  report --task ID --token TOKEN --event ID --id ID --outcome OUTCOME --summary TEXT --evidence TEXT
  recover                                 inspect saved workers, freeze ambiguity
  recover TASK                            re-verify a frozen task against its saved pane + session
  recover TASK --respawn                  resume the saved agent session (saved pane or a new one)
  recover TASK --ref JSON --session JSON  explicit verified adoption (stop the supervisor first)
  resolve --event ID --action retry|delivered (after operator inspection)
  retry-route --event ID                  explicitly retry failed classification
  du [TASK]                               disk usage per task, free space, gc --merged estimate
  close TASK [--abandon] [--discard-changes]
                                          close worker pane + remove worktree; keep branch
  drop TASK [--into REF] [--abandon] [--discard-changes] [--discard-unmerged]
                                          close, then delete the branch if merged into REF (HEAD)
  gc --merged [--into REF] [--dry-run]    drop every finished, clean task merged into REF (HEAD)
TASK may also be given as --task TASK. Default state: \`.switchyard\` or a task worktree's state above the
current directory, else $XDG_STATE_HOME/switchyard/<repo>-<hash> for the current repository
(~/.local/state when XDG_STATE_HOME is unset). SWITCHYARD_STATE overrides the search.
No automatic merge/push/publication.`;
const booleans = new Set(['abandon','discard-changes','discard-unmerged','merged','dry-run','respawn','json','stat','notify','no-notify']);
const required = (name:string) => { if (!flags[name]) throw new Error(`Missing --${name}`); return flags[name]; };
function integer(value: string | undefined, fallback:number) { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n)||n<1||n>86400000) throw new Error('Expected positive bounded integer'); return n; }
function nonNegative(value: string | undefined, fallback:number) { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n)||n<0||n>1e9) throw new Error('Expected non-negative bounded integer'); return n; }
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
function argv(value:string) { const a = JSON.parse(value); if (!Array.isArray(a)||!a.every(x=>typeof x==='string')||!a.length) throw new Error('Expected nonempty JSON argv array'); return a; }
const clock = () => new Date().toTimeString().slice(0, 8);
let store: Store | undefined;
try {
  const commands:Record<string,string[]>={init:['repo','concurrency','model','router-command','worker-kind','worker-args','herdr','codex','timeout','min-free-mb'],inbox:[],say:['task','id'],show:['task'],diff:['task','stat'],du:['task'],close:['task','abandon','discard-changes'],drop:['task','into','abandon','discard-changes','discard-unmerged'],gc:['merged','into','dry-run'],submit:['task','id'],run:['passes','interval'],serve:['passes','interval','notify'],up:['interval','no-notify'],status:[],history:[],report:['task','token','event','id','outcome','summary','evidence'],recover:['task','ref','session','respawn'],resolve:['event','action'],'retry-route':['event'],help:[]};
  const global=['state','json','format'], withRef=new Set(['show','diff','du','close','drop','recover']), machine=new Set(['status','history','report']);
  let literal=-1;
  if(args.includes('--help')||args.includes('-h')) positional.push('help');
  else for(let i=0;i<args.length;i++) {
    if(args[i]==='--'){literal=positional.length;positional.push(...args.slice(i+1));break;}
    if(args[i].startsWith('--')) {
      const key=args[i].slice(2);
      if(key in flags) throw new Error(`Duplicate option --${key}`);
      if(booleans.has(key)) { flags[key]='true'; continue; }
      if(!args[i+1]||args[i+1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      flags[key]=args[++i];
    } else positional.push(args[i]);
  }
  // A known command word, else natural-language input: several words, a `#N` prefix, or anything after `--`.
  let cmd=positional[0];
  if(cmd!==undefined&&literal!==0&&cmd in commands&&cmd!=='say') positional.shift();
  else if(cmd!==undefined) {
    if(literal!==0&&positional.length===1&&!/\s/.test(cmd)&&!cmd.startsWith('#')) throw new Error(`Unknown command ${cmd}. To send it as input instead: sy -- ${cmd}`);
    cmd='say';
  }
  if(cmd) for(const key of Object.keys(flags)) if(!global.includes(key)&&!commands[cmd].includes(key)) throw new Error(`Unknown option --${key} for ${cmd}`);
  if(cmd&&!['submit','say'].includes(cmd)&&positional.length>(withRef.has(cmd)?1:0)) throw new Error('Unexpected positional arguments');
  if(cmd&&withRef.has(cmd)&&positional.length&&flags.task) throw new Error('Give the task either as an argument or with --task, not both');
  const ref=flags.task??(cmd&&withRef.has(cmd)?positional[0]:undefined);
  if(flags.format&&!['text','json'].includes(flags.format)) throw new Error('--format must be text or json');
  if(flags.format&&flags.json) throw new Error('Use either --json or --format');
  const json=flags.json?true:flags.format?flags.format==='json':cmd==='up'?false:!process.stdout.isTTY;
  if(cmd==='init') {
    integer(flags.concurrency,2); integer(flags.timeout,120000); nonNegative(flags['min-free-mb'],10240);
    if(flags['router-command']) argv(flags['router-command']);
    if(flags['worker-args']) {const a=JSON.parse(flags['worker-args']);if(!Array.isArray(a)||!a.every(x=>typeof x==='string'))throw new Error('worker-args must be JSON string array');}
    if(flags['worker-kind']&&!/^[a-z][a-z0-9_-]*$/.test(flags['worker-kind'])) throw new Error('Invalid worker kind');
  }
  if(cmd==='run'||cmd==='serve'||cmd==='up'){integer(flags.passes,1);integer(flags.interval,2000);}
  if(cmd==='recover'){
    if((flags.ref||flags.session||flags.respawn)&&!ref) throw new Error('recover options require --task');
    if(flags.ref||flags.session){required('ref');required('session');if(flags.respawn)throw new Error('--respawn cannot be combined with --ref/--session');}
  }
  if(cmd==='report') for(const key of commands.report) required(key);
  if(cmd==='resolve'){required('event');if(!['retry','delivered'].includes(required('action')))throw new Error('Invalid resolution action');}
  if(cmd==='retry-route')required('event');
  if((cmd==='close'||cmd==='drop')&&!ref) throw new Error(`Missing task: sy ${cmd} TASK`);
  if((cmd==='show'||cmd==='diff')&&!ref&&!process.env.SWITCHYARD_TASK) throw new Error(`Missing task: sy ${cmd} TASK`);
  if(cmd==='gc'&&!flags.merged) throw new Error('gc requires --merged (the only collection mode in this release)');
  if(flags.into?.startsWith('-')) throw new Error('Invalid --into reference');
  const emit=(value:unknown,text?:()=>string)=>console.log(json||!text||machine.has(cmd!)?JSON.stringify(value,null,2):text());
  const located=cmd==='init'||cmd==='help'?null:await locate(flags.state);
  if (cmd === 'help' || (!cmd && !located)) {
    console.log(help);
    if (!cmd) console.log('\nNo Switchyard state found for this directory: run `sy init` inside your project.');
  } else if (cmd === 'init') {
    const repo = flags.repo ? realpathSync(resolve(flags.repo)) : await mainRoot(process.cwd());
    if (!repo) throw new Error('Not inside a Git repository; run init from your project or pass --repo PATH');
    await command('git',['-C',repo,'rev-parse','--verify','HEAD']);
    const top = (await command('git',['-C',repo,'rev-parse','--show-toplevel'])).trim();
    if (resolve(top) !== repo) throw new Error('--repo must be repository root');
    let state = resolve(flags.state ?? process.env.SWITCHYARD_STATE ?? defaultState(repo));
    store = new Store(state); state=realpathSync(state); store.dir=state;
    if (store.config().repo) throw new Error(`State already initialized at ${state}`);
    if (state === repo || state.startsWith(repo + '/')) {
      const check = await command('git',['-C',repo,'check-ignore','--no-index',state]).catch(()=> '');
      if (!check.trim()) throw new Error('State inside repo must already be ignored; add .switchyard/ or choose external --state');
    }
    const kind=flags['worker-kind']??'codex';
    const config = {repo,base:(await command('git',['-C',repo,'rev-parse','HEAD'])).trim(),concurrency:integer(flags.concurrency,2),timeout:integer(flags.timeout,120000),minFreeMb:nonNegative(flags['min-free-mb'],10240),transport:{type:'herdr',executable:flags.herdr??'herdr'},cli:fileURLToPath(import.meta.url),router:flags['router-command']?{type:'command',argv:argv(flags['router-command'])}:{type:'codex',executable:flags.codex??'codex',model:flags.model??'gpt-6.1-sol'},worker:{kind,args:flags['worker-args']?JSON.parse(flags['worker-args']):kind==='codex'?['--sandbox','workspace-write','--ask-for-approval','on-request','--add-dir',state,'--no-alt-screen']:[]}};
    if (!Array.isArray(config.worker.args)||!config.worker.args.every((x:unknown)=>typeof x==='string')) throw new Error('worker-args must be JSON string array');
    store.tx(()=>{for(const [key,value] of Object.entries(config)) store!.run('INSERT INTO config VALUES(?,?)',key,JSON.stringify(value));});
    mkdirSync(state,{recursive:true}); writeFileSync(join(state,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
    emit({initialized:state,config},()=>`Initialized Switchyard for ${repo}\n  state   ${state}\n  router  ${config.router.type==='codex'?`codex (${config.router.model})`:config.router.argv!.join(' ')}\n  worker  ${kind}, at most ${config.concurrency} active at once; ${config.minFreeMb?`new work held below ${config.minFreeMb} MB free`:'disk guard off'}\nNext: run \`sy up\` in a Herdr pane, then send work with: sy "describe the change"`);
  } else {
    if (!located) throw new Error('No Switchyard state found for this directory; run `sy init` inside your project, or pass --state DIR');
    const state = located.state;
    if (!existsSync(join(state,'state.db'))) throw new Error(`State not initialized at ${state}; run init`);
    store = new Store(state); store.dir=realpathSync(state);
    const engine=new Engine(store), s=store;
    const repoName=String(engine.config.repo).replace(homedir(),'~');
    // The supervisor lock, if free right now. A running supervisor (or another command) keeps it.
    const tryLock=(role:'serve'|'run'|'cli'='cli')=>{ try { return s.lock(role); } catch(e:any) { if(/Supervisor already active/.test(e.message)) return undefined; throw e; } };
    // Execute durable requests under the lock, or let the running supervisor apply them; never a second writer.
    // One note on a terminal's stderr when a wait on another process gets noticeable; stdout stays clean.
    const patience=(text:string)=>{ const at=Date.now()+2000; let said=false; return ()=>{ if(!said&&Date.now()>at&&process.stderr.isTTY){ said=true; process.stderr.write(`${text}\n`); } }; };
    async function settle(ids:string[]) {
      const deadline=Date.now()+2*engine.config.timeout+10000, note=patience(`Waiting for the running supervisor (pid ${s.holder()?.pid}) to apply it…`);
      while(engine.pending(ids)) {
        const unlock=tryLock();
        if(unlock) { try { await engine.applyRequests(ids); } finally { unlock(); } continue; }
        if(Date.now()>deadline) break;
        note(); await sleep(200);
      }
      return ids.map(key=>engine.requestView(s.get('SELECT * FROM requests WHERE id=?',key)!));
    }
    const taskOf=(r:string)=>engine.resolveTask(r);
    if(cmd===undefined||cmd==='inbox') { const x=inbox(s,engine.supervisor()); emit(x,()=>renderInbox(x,repoName)); }
    else if(cmd==='say'||cmd==='submit') {
      let text=positional.join(' '), target=flags.task?taskOf(flags.task):undefined;
      const direct=cmd==='say'?/^#(\d+)[:,]?(?:\s+|$)([\s\S]*)$/.exec(text.trim()):null;
      if(direct) { if(target) throw new Error('Give the task either as #N or with --task, not both'); target=taskOf(direct[1]); text=direct[2]; }
      const event=await engine.submit(text,target,flags.id) as Row;
      if(cmd==='submit') emit(event,()=>`Recorded input ${event.id}; the supervisor routes it on its next pass`);
      else {
        // Route now, so the answer is immediate: here if nothing holds the lock, else by the running supervisor.
        const deadline=Date.now()+engine.config.timeout+5000, note=patience('Routing…');
        while(s.get('SELECT state FROM events WHERE id=?',event.id)!.state==='pending'&&Date.now()<deadline) {
          const holder=s.holder(), unlock=holder?undefined:tryLock();
          if(unlock) { if(!target&&process.stderr.isTTY) process.stderr.write('Asking the Router…\n'); try { await engine.routePending(); } finally { unlock(); } }
          else { note(); await sleep(200); }
        }
        const x=inputView(s,event.id,engine.supervisor()); emit(x,()=>renderInput(x));
      }
    }
    else if(cmd==='status') emit(engine.status());
    else if(cmd==='history') emit(s.all('SELECT * FROM audit ORDER BY seq'));
    else if(cmd==='report') emit(engine.report(Object.fromEntries(['task','token','event','id','outcome','summary','evidence'].map(k=>[k,required(k)]))));
    else if(cmd==='show') { const x=detail(s,taskOf(ref??process.env.SWITCHYARD_TASK!)); emit(x,()=>renderDetail(x)); }
    else if(cmd==='diff') {
      const t=s.get('SELECT * FROM tasks WHERE id=?',taskOf(ref??process.env.SWITCHYARD_TASK!))!, base=engine.config.base, color=!json&&process.stdout.isTTY?'--color=always':'--color=never';
      const live=existsSync(t.worktree)&&await engine.worktreeValid(t);
      const extra=flags.stat?['--stat']:[];
      const diff=live?await command('git',['-C',t.worktree,'diff',color,...extra,base]):await command('git',['-C',engine.config.repo,'diff',color,...extra,`${base}...refs/heads/${t.branch}`]).catch(()=>{throw new Error(`Task #${t.num} has no worktree and its branch ${t.branch} is gone`);});
      const untracked=live?(await command('git',['-C',t.worktree,'ls-files','--others','--exclude-standard'])).split('\n').filter(Boolean):[];
      if(json) emit({task:t.id,num:t.num,base,source:live?'worktree':'branch',diff,untracked});
      else process.stdout.write(`${diff||`No changes in #${t.num} against ${base.slice(0,12)}\n`}${untracked.length?`\nUntracked files (not in the diff above):\n${untracked.map(f=>`  ${f}`).join('\n')}\n`:''}${live?'':`(worktree removed; showing committed changes on ${t.branch})\n`}`);
    }
    else if(cmd==='du') { const x=await engine.du(ref?taskOf(ref):undefined); emit(x,()=>renderDu(x)); }
    else if(cmd==='gc'&&flags['dry-run']) { const x={dryRun:true,...await engine.gcPlan(await engine.resolveInto(flags.into))}; emit(x,()=>renderGc(x)); }
    else if(cmd==='close'||cmd==='drop'||cmd==='gc') {
      let ids:string[], plan:any;
      if(cmd==='gc') {
        plan=await engine.gcPlan(await engine.resolveInto(flags.into));
        ids=plan.eligible.map((x:any)=>engine.request(x.task,'drop',{into:plan.into,abandon:false,discardChanges:false,discardUnmerged:false}).id);
      } else {
        const options={into:cmd==='drop'?await engine.resolveInto(flags.into):null,abandon:!!flags.abandon,discardChanges:!!flags['discard-changes'],discardUnmerged:!!flags['discard-unmerged']};
        ids=[engine.request(taskOf(ref!),cmd,options).id];
      }
      const requests=await settle(ids);
      if(cmd==='gc') { const x={into:plan.into,dropped:requests.filter(r=>r.state==='done').map(r=>r.result),failed:requests.filter(r=>!['done','pending'].includes(r.state)).map(r=>({task:r.task,state:r.state,error:r.error})),pending:requests.filter(r=>r.state==='pending').map(r=>r.id),skipped:plan.skipped}; emit(x,()=>renderGc(x)); }
      else if(['rejected','failed'].includes(requests[0].state)) throw new Error(requests[0].error);
      else if(requests[0].state==='done') emit(requests[0].result,()=>renderLifecycle(requests[0].result));
      else emit({pending:true,request:requests[0]},()=>`Requested ${cmd} of ${ref}; the running supervisor applies it between passes (request ${requests[0].id})`);
    }
    else if(cmd==='retry-route') { engine.retryRoute(required('event')); emit(engine.status(),()=>`Input ${flags.event} will be routed again on the next supervisor pass${engine.supervisor()?'':'; start `sy up`'}`); }
    else if(cmd==='resolve') {
      const unlock=tryLock();
      try { if(unlock) await engine.reconcile(); engine.resolveDelivery(required('event'),required('action')); }
      finally { unlock?.(); }
      emit(engine.status(),()=>flags.action==='retry'?`Input ${flags.event} will be sent to the worker again`:`Input ${flags.event} marked delivered; waiting for the worker's report`);
    }
    else if(cmd==='recover') {
      const unlock=tryLock(), taskId=ref?taskOf(ref):undefined;
      if(unlock) {
        try {
          await engine.reconcile();
          if(taskId&&engine.offline) throw new Error(`${engine.offline}; start Herdr, then retry`);
          let recovered:unknown;
          if(taskId&&flags.respawn) recovered=await engine.respawn(taskId);
          else if(taskId&&flags.ref) await engine.recover(taskId,required('ref'),required('session'));
          else if(taskId) recovered=await engine.reverify(taskId);
          const out={...(recovered?{recovered}:{}),...engine.status(),...(engine.offline?{transport:{ok:false,error:engine.offline}}:{})};
          emit(out,()=>engine.offline?`Herdr is unreachable (${engine.offline}); nothing was changed`:taskId?`#${s.get('SELECT num FROM tasks WHERE id=?',taskId)!.num}: worker ${(recovered as any)?.worker??'adopted'}${(recovered as any)?.pane?` (pane ${(recovered as any).pane})`:''}`:renderInbox(inbox(s,null),repoName));
        } finally { unlock(); }
      } else if(!taskId) emit({supervisor:engine.supervisor()},()=>'A supervisor is running and reconciles every pass; use `sy recover TASK` for a task that needs you');
      else if(flags.ref) throw new Error('Explicit adoption needs exclusive access; stop the supervisor (Ctrl-C in its pane) first');
      else {
        // The running supervisor executes it between passes; it never races a dispatch or a lifecycle change.
        const [r]=await settle([engine.request(taskId,flags.respawn?'respawn':'recover',{}).id]);
        if(r.state==='failed') throw new Error(r.error);
        emit(r.state==='done'?{recovered:r.result}:{pending:true,request:r},()=>r.state==='done'?`#${s.get('SELECT num FROM tasks WHERE id=?',taskId)!.num}: worker ${r.result.worker}${r.result.pane?` (pane ${r.result.pane})`:''}`:`Requested; the supervisor applies it once Herdr is reachable (request ${r.id})`);
      }
    }
    else if(cmd==='run') {
      const unlock=s.lock('run');
      let stopped=false; const stop=()=>{stopped=true;}; process.on('SIGINT',stop); process.on('SIGTERM',stop);
      try { let output:any; const passes=integer(flags.passes,1),interval=integer(flags.interval,2000);
        for(let i=0;i<passes&&!stopped;i++){output=await engine.pass(); if(i+1<passes&&!stopped) await sleep(interval);}
        emit(output,()=>renderInbox(inbox(s,null),repoName));
      } finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); unlock(); }
    }
    else if(cmd==='serve'||cmd==='up') {
      const holder=s.holder();
      if(holder?.role==='serve') throw new Error(`Supervisor already active (pid ${holder.pid}); refusing lock takeover`);
      // A one-off command (routing, close, recover) may hold the lock briefly: wait for it instead of failing.
      let unlock=tryLock('serve');
      if(!unlock&&!json) console.log(`Waiting for pid ${s.holder()?.pid} to finish…`);
      while(!unlock) { await sleep(300); const h=s.holder(); if(h?.role==='serve') throw new Error(`Supervisor already active (pid ${h.pid}); refusing lock takeover`); unlock=tryLock('serve'); }
      const notify=cmd==='up'?!flags['no-notify']:!!flags.notify;
      let stopped=false; const stop=()=>{stopped=true;}; process.on('SIGINT',stop); process.on('SIGTERM',stop);
      try {
        const passes=integer(flags.passes,100000),interval=integer(flags.interval,2000);
        if(!json) console.log(`${clock()} Switchyard supervising ${repoName}${notify?' (Herdr notifications on)':''}. Send work from another pane: sy "describe the change". Ctrl-C stops.`);
        let last='', before:ReturnType<typeof snapshot>|null=null, offline:string|null=null;
        for(let i=0;i<passes&&!stopped;i++){
          const output=await engine.pass();
          if(json) { const line=JSON.stringify(output); if(line!==last) console.log(line); last=line; }
          else {
            if(engine.offline!==offline) console.log(`${clock()} ${engine.offline?`Herdr unreachable (${engine.offline}); routing continues, workers wait`:'Herdr reachable again'}`);
            offline=engine.offline;
            const after=snapshot(s);
            for(const c of changes(s,before,after)) {
              console.log(`${clock()} ${c.text}`);
              if(notify&&c.notify) await engine.backend.notify(`Switchyard ${c.notify.ref}: ${c.notify.bucket==='review'?'ready for review':c.notify.bucket==='failed'?'failed':'needs you'}`,`${c.notify.title}: ${c.notify.why}`).catch((e:any)=>console.log(`${clock()} notification failed: ${e.message}`));
            }
            before=after;
          }
          if(i+1<passes&&!stopped) await sleep(interval);
        }
      } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);unlock();}
    } else throw new Error(`Unknown command ${cmd}\n${help}`);
  }
} catch(e:any) {console.error(e.message);process.exitCode=1;} finally {store?.close();}
