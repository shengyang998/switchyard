import {execFileSync} from 'node:child_process';
import {chmodSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,waitFor} from './helpers.mjs';
import {Store} from '../dist/store.js';
import {Engine} from '../dist/engine.js';
import {command} from '../dist/process.js';

test('offline CLI: alternate router + claude worker, two tasks, ack, queued followup, restart, reply',()=>{
 const f=fixture();try{
 const a=f.cli('submit',['Alpha','--id','a']);f.cli('submit',['Beta','--id','b']);
 assert.equal(f.cli('submit',['Alpha','--id','a']).id,a.id);
 f.cli('submit',['different','--id','a'],1);
 let s=f.cli('run'),alpha=s.tasks.find(t=>t.title==='Alpha'),beta=s.tasks.find(t=>t.title==='Beta');
 assert.equal(s.deliveries.length,2);assert.equal(new Set(s.tasks.map(t=>t.worktree)).size,2);
 f.report(alpha,'a','ack');f.cli('submit',['continue Alpha','--id','c']);s=f.cli('run');
 assert.equal(s.events.find(e=>e.id==='c').task,alpha.id);assert.equal(s.events.find(e=>e.id==='c').state,'queued');assert.equal(s.deliveries.length,2);
 f.report(alpha,'a');f.report(beta,'b');assert.equal(f.report(alpha,'a').duplicate,true);
 s=f.cli('run');assert.equal(s.deliveries.length,3);
 const resumed=s.tasks.find(t=>t.id===alpha.id);for(const key of ['ref','instance','session','worktree'])assert.equal(resumed[key],alpha[key]);
 assert.equal(f.fake().calls.filter(c=>c[0]==='workspace').length,2);
 const starts=f.fake().calls.filter(c=>c[1]==='start');assert.equal(starts.length,2);assert(starts.every(c=>c[c.indexOf('--kind')+1]==='claude'&&!c.includes('--sandbox')));
 f.report(alpha,'c');f.cli('submit',['hello','--id','hello']);s=f.cli('run');assert.equal(s.events.find(e=>e.id==='hello').state,'replied');assert.equal(s.tasks.length,2);
 assert.equal(f.cli('report',['--id','stale','--task',alpha.id,'--token','bad','--event','c','--outcome','ready','--summary','bad','--evidence','bad'],1).includes('Stale'),true);
 }finally{f.cleanup();}
});

test('ambiguous send is not replayed; explicit retry preserves input ID',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);f.mutate(x=>x.fail='prompt');let s=f.cli('run');assert.equal(s.events[0].state,'uncertain');
 f.mutate(x=>delete x.fail);s=f.cli('run');assert.equal(f.fake().calls.filter(c=>c[1]==='prompt').length,1);assert.equal(s.tasks[0].inflight,'a');
 f.cli('resolve',['--event','a','--action','retry']);s=f.cli('run');assert.equal(s.events[0].state,'sent');assert.equal(s.deliveries.length,2);assert(s.deliveries.every(d=>d.event==='a'));
 }finally{f.cleanup();}
});

for(const stage of ['create','start'])test(`ambiguous ${stage} freezes launch until verified recovery`,()=>{
 const f=fixture();try{f.cli('submit',['Alpha']);f.mutate(x=>x.fail=stage);let s=f.cli('run');assert.equal(s.tasks[0].provision,'unknown');const calls=f.fake().calls.length;f.cli('run');assert.equal(f.fake().calls.length,calls);
 if(stage==='start'){const t=s.tasks[0],a=Object.values(f.fake().agents)[0],session=JSON.stringify({agent:a.agent,kind:a.agent_session.kind,value:a.agent_session.value});f.mutate(x=>delete x.fail);f.cli('recover',['--task',t.id,'--ref',JSON.stringify({pane:a.pane_id}),'--session',session]);s=f.cli('run');assert.equal(s.deliveries.length,1);assert.equal(f.fake().calls.filter(c=>c[1]==='start').length,1);}
 }finally{f.cleanup();}
});

test('crash sending intent, identity change, malformed routes fail closed',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);let s=f.cli('run'),t=s.tasks[0];
 f.db(d=>{d.prepare("UPDATE deliveries SET state='sending'").run();d.prepare("UPDATE events SET state='sending'").run();});s=f.cli('recover');assert.equal(s.events[0].state,'uncertain');assert.equal(f.fake().calls.filter(c=>c[1]==='prompt').length,1);
 f.mutate(x=>Object.values(x.agents)[0].agent_session.value='other');s=f.cli('recover');assert.equal(s.tasks[0].provision,'unknown');
 f.cli('submit',['malformed','--id','m']);f.cli('submit',['bad target','--id','bad']);s=f.cli('run');assert.equal(s.tasks.length,1);assert(s.events.filter(e=>['m','bad'].includes(e.id)).every(e=>e.state==='route-error'&&e.error));
 }finally{f.cleanup();}
});

test('supervisor PID lock prevents duplicate concurrent dispatch',async()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha']);f.mutate(x=>x.delay=700);const child=f.spawn('run');let errors='';child.stderr.on('data',d=>errors+=d);
 await waitFor(()=>f.db(d=>!!d.prepare('SELECT * FROM supervisor').get()));
 assert.match(f.cli('run',[],1),/Supervisor already active/);
 const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,errors);assert.equal(f.fake().calls.filter(c=>c[1]==='prompt').length,1);
 }finally{f.cleanup();}
});

test('subprocess timeout/output caps reject even graceful exit after SIGTERM',async()=>{
 await assert.rejects(command(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],{timeout:120}),/timed out/);
 await assert.rejects(command(process.execPath,['-e',"process.stdout.write('x'.repeat(9000000));setInterval(()=>{},1000)"],{timeout:2000}),/output limit/);
});

test('built-in Codex Router invokes installed structured-exec contract via isolated fake',()=>{
 const f=fixture();try{
 chmodSync(new URL('./fake-codex.mjs',import.meta.url),0o755);
 f.db(d=>d.prepare("UPDATE config SET value=? WHERE key='router'").run(JSON.stringify({type:'codex',executable:new URL('./fake-codex.mjs',import.meta.url).pathname,model:'test-model'})));
 f.cli('submit',['Use structured router']);const s=f.cli('run');assert.equal(s.tasks[0].title,'Codex routed');assert.equal(s.deliveries.length,1);
 }finally{f.cleanup();}
});

test('readiness gate, exact branch validation, and saved-identity recovery rejection',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);let s=f.cli('run'),t=s.tasks[0];f.report(t,'a');f.cli('submit',['followup','--task',t.id,'--id','b']);
 f.mutate(x=>Object.values(x.agents)[0].agent_status='working');s=f.cli('run');assert.equal(s.deliveries.length,1);
 f.mutate(x=>Object.values(x.agents)[0].agent_status='idle');s=f.cli('run');assert.equal(s.deliveries.length,2);
 f.mutate(x=>Object.values(x.agents)[0].agent_session.value='replacement');
 assert.match(f.cli('recover',['--task',t.id,'--ref',t.ref,'--session',JSON.stringify({agent:'claude',kind:'id',value:'replacement'})],1),/cannot replace a saved worker session/);
 f.mutate(x=>Object.values(x.agents)[0].agent_session=JSON.parse(t.session));
 f.cli('recover',['--task',t.id,'--ref',t.ref,'--session',t.session]);
 execFileSync('git',['-C',t.worktree,'branch','-m',`${t.branch}-wrong`]);
 s=f.cli('recover');assert.match(s.tasks[0].error,/Worktree\/branch/);
 }finally{f.cleanup();}
});

test('failed routing needs explicit retry and help/init retries are usable',()=>{
 const f=fixture();try{
 assert.match(execFileSync(process.execPath,[...f.args('help')],{encoding:'utf8'}),/Usage:/);
 assert.match(execFileSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'init','--help'],{encoding:'utf8'}),/Usage:/);
 assert.match(f.cli('init',['--work-kind','claude'],1),/Unknown option/);
 f.cli('submit',['malformed','--id','m']);let s=f.cli('run');assert.equal(s.events[0].state,'route-error');
 const error=s.events[0].error;s=f.cli('run');assert.equal(s.events[0].error,error);
 s=f.cli('retry-route',['--event','m']);assert.equal(s.events[0].state,'pending');
 const state2=f.state+'-retry';
 assert.throws(()=>execFileSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'--state',state2,'init','--repo',f.repo,'--concurrency','0'],{stdio:'pipe'}));
 const out=execFileSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'--state',state2,'init','--repo',f.repo],{encoding:'utf8'});assert(JSON.parse(out).initialized);
 }finally{f.cleanup();}
});

test('Herdr environment preflight preserves pending input before routing or worktree writes',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);
 assert.throws(()=>execFileSync(process.execPath,f.args('run'),{env:{...f.env,HERDR_ENV:''},stdio:'pipe'}),/Command failed/);
 const s=f.cli('status');assert.equal(s.tasks.length,0);assert.equal(s.events[0].state,'pending');assert.equal(f.fake().calls.length,0);
 }finally{f.cleanup();}
});

for(const failure of [false,true])test(`report arriving before send ${failure?'error':'success'} preserves confirmed completion`,async()=>{
 const f=fixture();const store=new Store(f.state);
 try{
 const engine=new Engine(store);await engine.submit('Alpha',undefined,'race');
 engine.backend={preflight(){},async create(){return 'opaque-ref';},async start(){},async inspect(){return {instance:'instance',session:'session',ready:true,status:'idle'};},async send(t){
   engine.report({id:'race-report',task:t.id,event:'race',token:t.token,outcome:'ready',summary:'done',evidence:'race assertion'});
   if(failure)throw Error('transport returned error after receipt');
 }};
 const s=await engine.pass();assert.equal(s.events[0].state,'completed');assert.equal(s.deliveries[0].state,'confirmed');assert.equal(s.tasks[0].inflight,null);
 }finally{store.close();f.cleanup();}
});
