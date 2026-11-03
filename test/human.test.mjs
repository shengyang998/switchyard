import {execFileSync,execFile,spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,waitFor} from './helpers.mjs';

// The human CLI: state discovery, short task numbers, immediate routing, inbox/show/diff, readable supervisor
// output with notifications, and recovery while a supervisor runs (fake Herdr, command Router, scratch Git only).
const cliPath=resolve('dist/cli.js'),router=JSON.stringify([process.execPath,resolve('test/fake-router.mjs')]);
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.invalid',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const text=(f,args,options={})=>execFileSync(process.execPath,[cliPath,'--state',f.state,'--format','text',...args],{env:f.env,encoding:'utf8',stdio:['ignore','pipe','pipe'],...options});
const say=(f,...args)=>JSON.parse(execFileSync(process.execPath,[cliPath,'--state',f.state,...args],{env:f.env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const fails=(f,args)=>{try{execFileSync(process.execPath,[cliPath,'--state',f.state,...args],{env:f.env,stdio:['ignore','pipe','pipe']});}catch(e){return e.stderr.toString();}throw Error('Expected failure');};
const byNum=(f,num)=>f.cli('status').tasks.find(t=>t.num===num);
const pane=t=>JSON.parse(t.ref).pane;
const audits=(f,kind)=>f.db(d=>d.prepare('SELECT * FROM audit WHERE kind=? ORDER BY seq').all(kind));
const children=new Set();
// Never leave a supervisor running after a failed assertion.
const reap=()=>{for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');children.clear();};
function serve(f,args=[],passes=4000){
 const child=spawn(process.execPath,[cliPath,'--state',f.state,'serve','--passes',String(passes),'--interval','50',...args],{env:f.env,stdio:['ignore','pipe','pipe']});
 children.add(child);child.out='';child.err='';child.stdout.on('data',d=>child.out+=d);child.stderr.on('data',d=>child.err+=d);
 child.stop=async()=>{child.kill('SIGTERM');const code=await new Promise(r=>child.exitCode!==null?r(child.exitCode):child.on('close',r));assert.equal(code,0,child.err);};
 return child;
}
const running=f=>waitFor(()=>f.db(d=>!!d.prepare("SELECT 1 FROM supervisor WHERE owner LIKE 'serve:%'").get()));
const run=promisify(execFile);

test('discovery: subdirectories, task worktrees, linked worktrees, SWITCHYARD_STATE and no state',()=>{
 const f=fixture();try{
  const xdg=join(f.root,'xdg'),env={...f.env,XDG_STATE_HOME:xdg,HOME:join(f.root,'home')},sub=join(f.repo,'src');mkdirSync(sub);
  const sy=(args,cwd=sub,extra={})=>execFileSync(process.execPath,[cliPath,...args],{cwd,env:{...env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const init=JSON.parse(sy(['init','--router-command',router,'--worker-kind','claude','--herdr',resolve('test/fake-herdr.mjs'),'--min-free-mb','0'])),state=init.initialized;
  // A private per-repository directory outside the repository; --repo defaults to the main checkout.
  assert.equal(state,join(xdg,'switchyard',`${basename(f.repo)}-${createHash('sha256').update(f.repo).digest('hex').slice(0,10)}`));assert.equal(init.config.repo,f.repo);
  assert.throws(()=>sy(['init','--router-command',router]),/already initialized/);
  assert.equal(JSON.parse(sy(['Alpha task'])).task.num,1);
  const t=JSON.parse(sy(['run'])).tasks[0];assert(t.worktree.startsWith(state));
  // From inside the task worktree (where workers run) and from a linked worktree of the project.
  assert.equal(JSON.parse(sy(['status'],t.worktree)).tasks[0].id,t.id);
  git(f.repo,'worktree','add','-q','-b','mine',join(f.root,'linked'));
  assert.equal(JSON.parse(sy(['status'],join(f.root,'linked'))).tasks[0].id,t.id);
  // SWITCHYARD_STATE wins over the search; --state wins over both.
  assert.equal(JSON.parse(sy(['status'],sub,{SWITCHYARD_STATE:f.state})).tasks.length,0);
  assert.equal(JSON.parse(sy(['--state',state,'status'],sub,{SWITCHYARD_STATE:f.state})).tasks.length,1);
  // Outside any repository: bare `sy` prints help with a hint; other commands explain how to start.
  const outside=join(f.root,'outside');mkdirSync(outside);
  assert.match(sy([],outside),/No Switchyard state found[\s\S]*sy init/);
  assert.throws(()=>sy(['status'],outside),/No Switchyard state found.*sy init/);
  assert.throws(()=>sy(['init'],outside),/Not inside a Git repository/);
 }finally{f.cleanup();}
});

test('tasks have short numbers; references accept #N, N, IDs and unique prefixes; old state is backfilled',()=>{
 const f=fixture();try{
  f.cli('submit',['Alpha','--id','a']);f.cli('submit',['Beta','--id','b']);f.cli('run');
  const [a,b]=[byNum(f,1),byNum(f,2)];assert.equal(a.title,'Alpha');assert.equal(b.title,'Beta');
  for(const ref of ['1','#1',a.id,a.id.slice(0,12),a.id.slice(5,13)])assert.equal(f.cli('show',[ref]).task.id,a.id,ref);
  assert.equal(f.cli('show',['--task','2']).task.id,b.id);
  assert.match(f.cli('show',['7'],1),/No task #7/);assert.match(f.cli('show',['1','--task','2'],1),/either as an argument or with --task/);
  f.db(d=>{for(const [id,num] of [['task_ffff0001',90],['task_ffff0002',91]])d.prepare("INSERT INTO tasks(id,num,title,branch,worktree,worker,token,created) VALUES(?,?,'x','b','/nonexistent','w','t',?)").run(id,num,Date.now());});
  assert.match(f.cli('show',['ffff'],1),/ambiguous/);assert.equal(f.cli('show',['ffff0002']).task.num,91);
  f.db(d=>d.exec("DELETE FROM tasks WHERE id LIKE 'task_ffff%'"));
  // Workers run inside STATE/worktrees/task_…: that state is found even when it is not the repository default.
  const found=JSON.parse(execFileSync(process.execPath,[cliPath,'status'],{cwd:join(a.worktree),env:{...f.env,XDG_STATE_HOME:join(f.root,'empty')},encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(found.tasks.length,2);
  // --task on other commands takes the same references.
  f.report(a,'a');f.cli('submit',['more','--task','#1','--id','m']);assert.equal(f.cli('status').events.find(e=>e.id==='m').target,a.id);
  // A state from before task numbers gets them in creation order.
  f.db(d=>{d.exec('DROP INDEX tasks_num');d.exec('ALTER TABLE tasks DROP COLUMN num');});
  assert.deepEqual(f.cli('status').tasks.map(t=>[t.title,t.num]),[['Alpha',1],['Beta',2]]);
  f.cli('submit',['Gamma','--id','g']);f.cli('run');assert.equal(f.cli('status').tasks.find(t=>t.title==='Gamma').num,3);
 }finally{f.cleanup();}
});

test('bare text is routed at once; #N goes straight to that task; replies are shown',()=>{
 const f=fixture();try{
  let x=say(f,'Add export');assert.equal(x.state,'queued');assert.equal(x.action,'new');assert.equal(x.task.num,1);assert.equal(x.supervisor,false);
  assert.match(text(f,['Add import']),/→ new task #2 "Add import"; start workers with `sy up`/);
  // `#N text` never calls the Router: a Router-breaking input still reaches task #1.
  x=say(f,'#1 malformed');assert.equal(x.state,'queued');assert.equal(x.action,'followup');assert.equal(x.task.num,1);
  assert.equal(f.cli('status').events.find(e=>e.id===x.input).text,'malformed');
  assert.match(text(f,['#2','continue','please']),/→ #2 "Add import": queued for the worker/);
  // Router decisions: a follow-up by name, a reply, and a routing failure.
  assert.match(text(f,['continue Add export']),/→ #1 "Add export"/);
  assert.match(text(f,['--','hello']),/^Router: Hello from the offline router/);
  assert.match(text(f,[]),/Router\n  Hello from the offline router/);
  x=say(f,'--','malformed');assert.equal(x.state,'route-error');
  assert.match(text(f,['--','malformed']),/Could not route input .*\nFix the router, then: sy retry-route --event input_/);
  assert.doesNotMatch(text(f,[]),/Hello from the offline router/,'a reply is shown only until newer input');
  assert.match(text(f,[]),/was not routed.*sy retry-route --event input_/);
  // A single unknown word is a mistyped command, not input; explicit IDs and --task still work.
  assert.match(fails(f,['statsu']),/Unknown command statsu\. To send it as input instead: sy -- statsu/);
  x=say(f,'one more thing','--task','2','--id','mine');assert.equal(x.input,'mine');assert.equal(x.task.num,2);
  assert.match(fails(f,['#1 x','--task','2']),/either as #N or with --task/);
  assert.match(fails(f,['#9 x']),/No task #9/);
  // submit keeps persist-only semantics.
  assert.equal(f.cli('submit',['Later','--id','later']).state,'pending');
 }finally{f.cleanup();}
});

test('bare text is routed by a running supervisor instead of a second router call',async()=>{
 const f=fixture();try{
  const s=serve(f);await running(f);
  const {stdout}=await run(process.execPath,[cliPath,'--state',f.state,'Alpha task'],{env:f.env});
  const x=JSON.parse(stdout);assert.equal(x.state,'queued');assert.equal(x.task.num,1);assert.equal(x.supervisor,true);
  assert.equal(audits(f,'routed').length,1);
  await s.stop();
 }finally{reap();f.cleanup();}
});

test('inbox groups tasks by what they need from you',()=>{
 const f=fixture();try{
  f.db(d=>d.prepare("INSERT OR REPLACE INTO config VALUES('concurrency','7')").run());
  for(const t of ['Ready','Blocked','Failed','Working','Frozen','Unsure','Closed'])f.cli('submit',[t,'--id',t]);
  f.mutate(x=>{x.fail=null;});let s=f.cli('run');const t=title=>s.tasks.find(x=>x.title===title);
  f.report(t('Ready'),'Ready','ready');f.report(t('Blocked'),'Blocked','blocked');f.report(t('Failed'),'Failed','failed');f.report(t('Closed'),'Closed','ready');
  f.report(t('Working'),'Working','progress');f.report(t('Unsure'),'Unsure','ready');
  f.cli('close',['--task',t('Closed').id]);
  f.db(d=>d.prepare("UPDATE tasks SET provision='unknown',error='Interrupted external launch; inspect and recover explicitly' WHERE id=?").run(t('Frozen').id));
  f.mutate(x=>{x.fail='prompt';});f.cli('submit',['again','--task',t('Unsure').id,'--id','u2']);f.cli('run');f.mutate(x=>{delete x.fail;});
  f.cli('submit',['malformed','--id','bad']);f.cli('run');
  const x=f.cli('inbox'),nums=b=>x.groups[b].map(v=>v.title);
  assert.deepEqual(nums('needs-you'),['Blocked','Frozen','Unsure']);assert.deepEqual(nums('in-progress'),['Working']);
  assert.deepEqual(nums('review'),['Ready']);assert.deepEqual(nums('failed'),['Failed']);assert.equal(x.closed,1);
  assert.equal(x.supervisor,null);assert.deepEqual(x.inputs.routeErrors.map(e=>e.id),['bad']);
  assert.match(x.groups['in-progress'][0].why,/^progress: progress test/);
  assert.equal(x.groups['needs-you'].find(v=>v.title==='Blocked').next,`sy "#${t('Blocked').num} <answer>"`);
  const out=text(f,[]);
  assert.match(out,/supervisor not running: start it with `sy up`/);
  for(const heading of ['Needs you','In progress','Ready for review','Failed'])assert.match(out,new RegExp(`\\n${heading}\\n`));
  assert.ok(out.indexOf('Needs you')<out.indexOf('In progress')&&out.indexOf('In progress')<out.indexOf('Ready for review'));
  assert.match(out,/#\d+\s+Frozen .*frozen: Interrupted external launch.*→ sy show \d+/);
  assert.match(out,/#\d+\s+Unsure .*unsure whether the worker got input u2/);
  assert.match(out,/#\d+\s+Ready .*ready test\s+→ sy diff \d+/);
  assert.match(out,/1 closed task\(s\) not shown/);
  // An exited worker points at respawn.
  f.mutate(x=>{const a=x.agents[pane(t('Ready'))];delete a.agent;delete a.agent_session;});f.cli('run');
  assert.match(text(f,[]),/Ready .*worker exited; its session is saved\s+→ sy recover \d+ --respawn/);
 }finally{f.cleanup();}
});

test('show gives a timeline with next steps; diff shows worktree or branch changes',()=>{
 const f=fixture();try{
  f.cli('submit',['Alpha','--id','a']);let t=f.cli('run').tasks[0];f.report(t,'a','ack');f.report(t,'a','ready');
  const x=f.cli('show',['1']);
  assert.equal(x.bucket,'review');assert.deepEqual(x.timeline.map(e=>e.kind).filter(k=>!k.startsWith('audit:')),['input','delivery','ack','ready']);
  assert.equal(x.timeline.find(e=>e.kind==='ready').evidence,'offline assertion');assert.equal(x.task.pane,pane(t));
  let out=text(f,['show','1']);
  assert.match(out,/^#1 Alpha  \[Ready for review\] ready test/);assert.match(out,/Timeline\n.*input\s+a: "Alpha" \(completed\)/);
  assert.match(out,/evidence: offline assertion/);assert.match(out,/Next\n  sy diff 1            review the change\n  sy "#1 <feedback>"   ask for changes\n/);
  // Node's SQLite experimental warning is hidden from humans; stdout and stderr stay clean.
  const env={...f.env};delete env.NODE_NO_WARNINGS;delete env.NODE_OPTIONS;
  const plain=spawnSync(process.execPath,[cliPath,'--state',f.state,'--format','text','show','1'],{env,encoding:'utf8'});
  assert.equal(plain.status,0);assert.equal(plain.stderr,'');assert.equal(plain.stdout,out);
  assert.match(text(f,['diff','1']),/^No changes in #1/);
  writeFileSync(join(t.worktree,'README.md'),'fixture\nchanged\n');writeFileSync(join(t.worktree,'new.txt'),'new\n');
  out=text(f,['diff','1']);assert.match(out,/\+changed/);assert.match(out,/Untracked files \(not in the diff above\):\n  new.txt/);
  assert.match(text(f,['diff','1','--stat']),/README.md \| 1 \+/);
  assert.equal(f.cli('diff',['1']).source,'worktree');
  // Closed: the worktree is gone, the committed branch remains.
  git(t.worktree,'add','.');git(t.worktree,'commit','-qm','work');f.cli('close',['1']);
  const d=f.cli('diff',['1']);assert.equal(d.source,'branch');assert.match(d.diff,/\+changed/);assert.match(d.diff,/new.txt/);
  assert.match(text(f,['diff','1']),/worktree removed; showing committed changes on switchyard\/task_/);
  mkdirSync(t.worktree);assert.equal(f.cli('diff',['1']).source,'branch','an unregistered directory is not the worktree');rmSync(t.worktree,{recursive:true});
  assert.match(text(f,['show','1']),/\[closed\][\s\S]*merge it, then `sy gc --merged`/);
  // Frozen and uncertain tasks explain the exact recovery commands.
  f.cli('submit',['Beta','--id','b']);t=f.cli('run').tasks.find(x=>x.title==='Beta');f.report(t,'b');
  f.mutate(x=>{x.fail='prompt';});f.cli('submit',['more','--task','2','--id','c']);f.cli('run');f.mutate(x=>{delete x.fail;});
  out=text(f,['show','2']);assert.match(out,/  sy resolve --event c --action delivered   it did; wait for its report\n  sy resolve --event c --action retry       it did not; send it again\n/);
 }finally{f.cleanup();}
});

test('serve prints status only when it changes; text mode logs transitions and notifies through Herdr',async()=>{
 const f=fixture();try{
  f.cli('submit',['Alpha','--id','a']);f.cli('run');
  let s=serve(f,[],8);assert.equal(await new Promise(r=>s.on('close',r)),0,s.err);
  const lines=s.out.trim().split('\n');assert.equal(lines.length,1,'unchanged passes print nothing');assert.equal(JSON.parse(lines[0]).tasks[0].title,'Alpha');
  s=serve(f,['--format','text','--notify']);await running(f);
  await waitFor(()=>/#1 Alpha: in progress/.test(s.out));
  f.report(f.cli('status').tasks[0],'a','progress');await waitFor(()=>/in progress · progress: progress test/.test(s.out));
  f.report(f.cli('status').tasks[0],'a','ready');await waitFor(()=>/#1 Alpha: ready for review · ready test  → sy diff 1/.test(s.out));
  await waitFor(()=>(f.fake().notifications??[]).length===1);
  assert.deepEqual(f.fake().notifications[0],{title:'Switchyard #1: ready for review',body:'Alpha: ready test'});
  // A failed notification is reported in the log and the supervisor keeps going.
  f.mutate(x=>{x.fail='notify';});f.cli('submit',['more','--task','1','--id','m']);
  await waitFor(()=>/#1 Alpha: in progress/.test(s.out.split('ready for review').at(-1)));
  const t=f.cli('status').tasks[0];f.report(t,'m','blocked');
  await waitFor(()=>/notification failed/.test(s.out));
  assert.match(s.out,/#1 Alpha: needs you · blocked: blocked test/);
  f.mutate(x=>{delete x.fail;});
  // Still needs you, for another reason: logged, but not notified again.
  f.db(d=>d.prepare("UPDATE tasks SET provision='unknown',error='Interrupted external launch; inspect and recover explicitly' WHERE id=?").run(t.id));
  await waitFor(()=>/#1 Alpha: needs you · frozen: Interrupted external launch; inspect and recover explicitly\n/.test(s.out));
  await new Promise(r=>setTimeout(r,200));assert.equal(f.fake().notifications.length,1);await s.stop();
  assert.match(s.out,/^\d\d:\d\d:\d\d Switchyard supervising .* \(Herdr notifications on\)/);
  // Without --notify, transitions are only logged.
  f.cli('recover',['1']);f.cli('submit',['again','--task','1','--id','g']);
  s=serve(f,['--format','text']);await running(f);
  await waitFor(()=>f.cli('status').events.find(e=>e.id==='g').state==='sent');f.report(f.cli('status').tasks[0],'g','ready');
  await waitFor(()=>/#1 Alpha: ready for review/.test(s.out));await new Promise(r=>setTimeout(r,200));
  assert.equal(f.fake().notifications.length,1);
  // A second supervisor is refused at once; a one-off command holding the lock is waited for.
  assert.match(fails(f,['serve','--passes','1']),/Supervisor already active/);
  await s.stop();
  f.db(d=>d.prepare("INSERT INTO supervisor VALUES(1,?,?,'cli:test',?)").run(process.pid,hostname(),Date.now()));
  assert.equal(f.cli('inbox').supervisor,null,'a one-off command is not a supervisor');
  s=serve(f,['--format','text'],1);await waitFor(()=>/Waiting for pid \d+ to finish/.test(s.out));
  assert.equal(s.exitCode,null);f.db(d=>d.exec('DELETE FROM supervisor'));
  assert.equal(await new Promise(r=>s.on('close',r)),0,s.err);assert.match(s.out,/Switchyard supervising/);
  f.db(d=>d.prepare("INSERT INTO supervisor VALUES(1,?,?,'serve:test',?)").run(process.pid,hostname(),Date.now()));
  assert.equal(f.cli('inbox').supervisor.pid,process.pid);assert.match(fails(f,['serve','--passes','1']),/Supervisor already active/);
  f.db(d=>d.exec('DELETE FROM supervisor'));
 }finally{reap();f.cleanup();}
});

test('recover, respawn and resolve work while the supervisor runs, through that supervisor',async()=>{
 const f=fixture();try{
  f.cli('submit',['Alpha','--id','a']);let t=f.cli('run').tasks[0];f.report(t,'a');
  f.db(d=>d.prepare("UPDATE tasks SET provision='unknown',error='Interrupted external launch; inspect and recover explicitly' WHERE id=?").run(t.id));
  const s=serve(f);await running(f);const pid=s.pid;
  let {stdout}=await run(process.execPath,[cliPath,'--state',f.state,'recover','1'],{env:f.env});
  assert.deepEqual(JSON.parse(stdout).recovered,{task:t.id,worker:'verified'});
  assert.equal(f.cli('status').tasks[0].provision,'started');assert.equal(audits(f,'manual-reverify').length,1);
  // Agent exit, then respawn in the saved pane: applied by the running supervisor.
  f.mutate(x=>{const a=x.agents[pane(t)];delete a.agent;delete a.agent_session;});
  await waitFor(()=>/No agent/.test(f.cli('status').tasks[0].error??''));
  // A refused respawn is an error, recorded in history; nothing is started.
  f.mutate(x=>{x.agents[pane(t)].foreground_cwd='/tmp';});
  await assert.rejects(run(process.execPath,[cliPath,'--state',f.state,'recover','1','--respawn'],{env:f.env}),/now in \/tmp, not the task worktree/);
  assert.equal(audits(f,'respawn-failed').length,1);f.mutate(x=>{x.agents[pane(t)].foreground_cwd=t.worktree;});
  ({stdout}=await run(process.execPath,[cliPath,'--state',f.state,'--format','text','recover','#1','--respawn'],{env:f.env}));
  assert.match(stdout,/^#1: worker respawned \(pane reused\)/);assert.equal(f.cli('status').tasks[0].error,null);
  // Uncertain delivery resolved without stopping serve.
  f.mutate(x=>{x.fail='prompt';});f.cli('submit',['more','--task','1','--id','u']);
  await waitFor(()=>f.cli('status').events.find(e=>e.id==='u').state==='uncertain');f.mutate(x=>{delete x.fail;});
  ({stdout}=await run(process.execPath,[cliPath,'--state',f.state,'--format','text','resolve','--event','u','--action','retry'],{env:f.env}));
  assert.match(stdout,/Input u will be sent to the worker again/);
  await waitFor(()=>f.cli('status').events.find(e=>e.id==='u').state==='sent');
  // Explicit adoption still needs exclusive access; bare recover is a no-op while serve reconciles.
  t=f.cli('status').tasks[0];
  await assert.rejects(run(process.execPath,[cliPath,'--state',f.state,'recover','1','--ref',t.ref,'--session',t.session],{env:f.env}),/stop the supervisor/);
  ({stdout}=await run(process.execPath,[cliPath,'--state',f.state,'recover'],{env:f.env}));assert.equal(JSON.parse(stdout).supervisor.pid,pid);
  assert.equal(f.db(d=>d.prepare('SELECT pid FROM supervisor').get().pid),pid,'serve kept the lock throughout');
  await s.stop();
  assert.equal(f.cli('status').requests.filter(r=>['recover','respawn'].includes(r.action)).map(r=>r.state).join(),'done,failed,done');
 }finally{reap();f.cleanup();}
});

test('text renderers for disk and reclaim commands name tasks by number',()=>{
 const f=fixture();try{
  f.cli('submit',['Alpha','--id','a']);f.cli('submit',['Beta','--id','b']);let s=f.cli('run');
  for(const t of s.tasks)f.report(t,t.title==='Alpha'?'a':'b');
  const [a,b]=s.tasks;
  assert.match(text(f,['du']),/^Free .* disk guard off\n2 worktree\(s\), .*\n.*gc --merged would reclaim .* from 2 merged task\(s\)\n\n  #1 /);
  assert.match(text(f,['du','2']),/#2\s+Beta/);
  assert.match(text(f,['gc','--merged','--dry-run']),/^Would drop 2 task\(s\):\n  #1 "Alpha"/);
  assert.match(text(f,['close','1']),/^Closed #1 "Alpha": worker pane closed; worktree removed \(.* reclaimed\); branch switchyard\/task_.* kept/);
  assert.match(text(f,['drop','#2']),/^Dropped #2 "Beta": .*branch switchyard\/task_.* deleted; restore with: git branch /);
  assert.match(text(f,['gc','--merged']),/^Dropped 1 task\(s\):\n  Dropped #1 "Alpha"/);
  assert.equal(f.cli('status').tasks.every(t=>t.lifecycle==='dropped'),true);assert(!existsSync(a.worktree)&&!existsSync(b.worktree));
 }finally{f.cleanup();}
});
