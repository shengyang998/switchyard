import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

// Worker continuity across transport outages, transport restarts and agent exits (fake Herdr only).
const pane=t=>JSON.parse(t.ref).pane;
const sessionValue=t=>JSON.parse(t.session).value;
const task=(f,id)=>f.cli('status').tasks.find(t=>t.id===id);
const event=(s,id)=>s.events.find(e=>e.id===id);
const audits=(f,kind)=>f.db(d=>d.prepare('SELECT * FROM audit WHERE kind=? ORDER BY seq').all(kind));
const calls=(f,...prefix)=>f.fake().calls.filter(c=>prefix.every((p,i)=>c[i]===p));
const prompts=f=>calls(f,'agent','prompt').length;
// A started worker that finished its first turn.
function ready(f,title='Alpha'){f.cli('submit',[title,'--id',title]);const t=f.cli('run').tasks.find(x=>x.title===title);f.report(t,title);return task(f,t.id);}
// A worker in the middle of a follow-up turn.
function busy(f,id='b'){const t=ready(f);f.cli('submit',['followup','--task',t.id,'--id',id]);const s=f.cli('run');assert.equal(event(s,id).state,'sent');return task(f,t.id);}
const herdrRestart=(f,t,terminal='term-restored')=>f.mutate(x=>{x.agents[pane(t)].terminal_id=terminal;});
const agentExit=(f,t)=>f.mutate(x=>{const a=x.agents[pane(t)];delete a.agent;delete a.agent_session;});

test('launch pins the pane resume command so a Herdr restart keeps the configured arguments',()=>{
 const f=fixture();try{
  const t=ready(f),pin=f.fake().agents[pane(t)].agent_resume;
  assert.deepEqual(pin,{source:'switchyard',agent:'claude',argv:['claude','--resume',sessionValue(t),'--permission-mode','manual']});
  assert.deepEqual(calls(f,'pane','report-agent-session')[0].slice(0,9),['pane','report-agent-session','--source','switchyard','--agent','claude','--agent-session-id',sessionValue(t),pane(t)]);
  // Pinning is best effort: a rejected pin is audited and the worker is used normally.
  f.mutate(x=>{x.fail='pin';});f.cli('submit',['Beta','--id','Beta']);
  const s=f.cli('run'),b=s.tasks.find(x=>x.title==='Beta');
  assert.equal(b.provision,'started');assert.equal(event(s,'Beta').state,'sent');
  assert.equal(audits(f,'pin-failed').length,1);assert.equal(audits(f,'pin-failed')[0].task,b.id);
 }finally{f.cleanup();}
});

test('transport outage: nothing freezes, routing continues, dispatch resumes when Herdr is back',()=>{
 const f=fixture();try{
  const t=ready(f);f.cli('submit',['followup','--task',t.id,'--id','b']);f.cli('submit',['Beta','--id','c']);
  f.mutate(x=>{x.down=true;});
  let s=f.cli('run');
  assert.equal(s.transport.ok,false);assert.match(s.transport.error,/server_not_running/);
  assert.equal(s.tasks.find(x=>x.id===t.id).provision,'started');assert.equal(s.tasks.find(x=>x.id===t.id).error,null);
  assert.equal(event(s,'b').state,'queued');assert.equal(event(s,'c').state,'queued');assert(event(s,'c').task,'routing does not need the transport');
  s=f.cli('run');assert.equal(s.transport.ok,false);assert.equal(audits(f,'transport-offline').length,2,'one audit per process that saw the outage');
  assert.match(f.cli('recover',['--task',t.id],1),/unavailable.*start Herdr/);
  f.mutate(x=>{x.down=false;});
  s=f.cli('run');
  assert.equal(s.transport,undefined);assert.equal(event(s,'b').state,'sent');assert.equal(event(s,'c').state,'sent');
  assert(s.tasks.every(x=>x.provision==='started'));
 }finally{f.cleanup();}
});

test('Herdr restart: same pane and native session on a new terminal is rebound, not frozen',()=>{
 const f=fixture();try{
  const t=ready(f);herdrRestart(f,t);f.cli('submit',['followup','--task',t.id,'--id','b']);
  let s=f.cli('run'),x=s.tasks[0];
  assert.equal(x.provision,'started');assert.equal(x.instance,'term-restored');assert.equal(x.session,t.session);
  const [r]=audits(f,'rebind');assert.equal(r.task,t.id);assert.deepEqual(JSON.parse(r.detail),{from:t.instance,to:'term-restored',session:t.session});
  assert.equal(event(s,'b').state,'sent');
  f.report(x,'b');s=f.cli('run');assert.equal(audits(f,'rebind').length,1,'a verified rebind is recorded once');
 }finally{f.cleanup();}
});

test('Herdr restart: a restored agent that has not reported its session yet is waited for, not frozen',()=>{
 const f=fixture();try{
  const t=ready(f),saved=f.fake().agents[pane(t)].agent_session;herdrRestart(f,t);f.mutate(x=>{x.agents[pane(t)].agent_session=null;});
  f.cli('submit',['followup','--task',t.id,'--id','b']);
  let s=f.cli('run');assert.equal(s.tasks[0].provision,'started');assert.match(s.tasks[0].error,/has not reported its native session/);assert.equal(event(s,'b').state,'queued');
  f.mutate(x=>{x.agents[pane(t)].agent_session=saved;});
  s=f.cli('run');assert.equal(s.tasks[0].error,null);assert.equal(s.tasks[0].instance,'term-restored');assert.equal(event(s,'b').state,'sent');
 }finally{f.cleanup();}
});

test('Herdr restart during a turn: the turn becomes uncertain, is never resent, and the operator decides',()=>{
 const f=fixture();try{
  const t=busy(f,'b'),sent=prompts(f);herdrRestart(f,t);
  let s=f.cli('run');
  assert.equal(event(s,'b').state,'uncertain');assert.match(event(s,'b').error,/resolve --event b --action delivered.*--action retry/);
  assert.deepEqual(s.deliveries.filter(d=>d.event==='b').map(d=>d.state),['uncertain']);
  assert.equal(s.tasks[0].provision,'started');assert.equal(s.tasks[0].inflight,'b');assert.equal(audits(f,'interrupted').length,1);
  s=f.cli('run');assert.equal(prompts(f),sent,'no automatic resend');
  // A restored worker may still finish the turn: its late report is accepted.
  f.report(t,'b');s=f.cli('status');assert.equal(event(s,'b').state,'completed');assert.equal(s.tasks[0].inflight,null);
  // Or the operator retries explicitly.
  f.cli('submit',['second','--task',t.id,'--id','c']);f.cli('run');herdrRestart(f,t,'term-again');
  s=f.cli('run');assert.equal(event(s,'c').state,'uncertain');
  f.cli('resolve',['--event','c','--action','retry']);s=f.cli('run');
  assert.equal(event(s,'c').state,'sent');assert.equal(s.deliveries.filter(d=>d.event==='c').length,2);
 }finally{f.cleanup();}
});

test('a new terminal with a different session is a different worker and still freezes',()=>{
 const f=fixture();try{
  const t=ready(f);herdrRestart(f,t);f.mutate(x=>{x.agents[pane(t)].agent_session.value='someone-else';});
  f.cli('submit',['followup','--task',t.id,'--id','b']);
  let s=f.cli('run');assert.equal(s.tasks[0].provision,'unknown');assert.match(s.tasks[0].error,/session differs/);assert.equal(event(s,'b').state,'queued');
  assert.match(f.cli('recover',['--task',t.id],1),/session differs/);assert.equal(task(f,t.id).provision,'unknown');
  assert.equal(audits(f,'rebind').length,0);
 }finally{f.cleanup();}
});

test('recover --task re-verifies a task frozen by an outage before this release',()=>{
 const f=fixture();try{
  const t=ready(f);f.db(d=>d.prepare("UPDATE tasks SET provision='unknown',error=? WHERE id=?").run('herdr exited 1: {"error":{"code":"server_unavailable"}}',t.id));
  f.cli('submit',['followup','--task',t.id,'--id','b']);
  assert.equal(event(f.cli('run'),'b').state,'queued','frozen tasks are not dispatched');
  herdrRestart(f,t);
  const r=f.cli('recover',['--task',t.id]);
  assert.deepEqual(r.recovered,{task:t.id,worker:'rebound'});assert.equal(r.tasks[0].provision,'started');assert.equal(r.tasks[0].error,null);assert.equal(r.tasks[0].instance,'term-restored');
  assert.equal(event(f.cli('run'),'b').state,'sent');
  assert.equal(f.cli('recover',['--task',t.id]).recovered.worker,'verified');
  assert.match(f.cli('recover',['--respawn'],1),/require --task/);
  assert.match(f.cli('recover',['--task',t.id,'--respawn','--ref',t.ref,'--session',t.session],1),/cannot be combined/);
 }finally{f.cleanup();}
});

test('agent exit mid-turn: task waits unfrozen; respawn resumes the saved session in the same pane',()=>{
 const f=fixture();try{
  const t=busy(f,'b'),starts=calls(f,'agent','start').length;agentExit(f,t);f.cli('submit',['later','--task',t.id,'--id','c']);
  let s=f.cli('run'),x=s.tasks[0];
  assert.equal(x.provision,'started');assert.match(x.error,/No agent in worker pane .*--respawn/);
  assert.equal(event(s,'b').state,'uncertain');assert.equal(event(s,'c').state,'queued');
  f.cli('run');assert.equal(audits(f,'worker-absent').length,1,'absence is recorded once');
  const r=f.cli('recover',['--task',t.id,'--respawn']);
  assert.deepEqual(r.recovered,{task:t.id,worker:'respawned',pane:'reused'});
  const start=calls(f,'agent','start').at(-1);assert.equal(calls(f,'agent','start').length,starts+1);
  assert.deepEqual(start.slice(start.indexOf('--')+1),['--resume',sessionValue(t),'--permission-mode','manual']);assert.equal(start[start.indexOf('--pane')+1],pane(t));
  x=r.tasks[0];assert.equal(x.provision,'started');assert.equal(x.error,null);assert.equal(x.ref,t.ref);assert.equal(x.session,t.session);
  assert.equal(JSON.parse(audits(f,'respawn')[0].detail).pane,'shell');
  f.report(t,'b');s=f.cli('run');assert.equal(event(s,'b').state,'completed');assert.equal(event(s,'c').state,'sent');
 }finally{f.cleanup();}
});

test('an exiting agent seen in Herdr\'s brief no-agent window is absent, not a mismatch',()=>{
 const f=fixture();try{
  const t=ready(f);agentExit(f,t);f.mutate(x=>{x.lingering=true;});
  const s=f.cli('run');assert.equal(s.tasks[0].provision,'started');assert.match(s.tasks[0].error,/No agent in worker pane .* \(exited\)/);
  assert.equal(f.cli('recover',['--task',t.id,'--respawn']).recovered.worker,'respawned');
 }finally{f.cleanup();}
});

test('respawn into a new background workspace when the saved pane is gone',()=>{
 const f=fixture();try{
  const t=ready(f);f.mutate(x=>{delete x.agents[pane(t)];});f.cli('submit',['followup','--task',t.id,'--id','b']);
  let s=f.cli('run');assert.equal(s.tasks[0].provision,'started');assert.match(s.tasks[0].error,/No agent/);
  const r=f.cli('recover',['--task',t.id,'--respawn']);assert.equal(r.recovered.pane,'created');
  const x=r.tasks[0],create=calls(f,'workspace','create').at(-1);
  assert.notEqual(x.ref,t.ref);assert.equal(create[create.indexOf('--cwd')+1],t.worktree);assert.equal(x.session,t.session);assert.equal(x.provision,'started');
  const start=calls(f,'agent','start').at(-1);assert.equal(start[start.indexOf('--pane')+1],pane(x));assert(start.includes('--resume'));
  assert.deepEqual(f.fake().agents[pane(x)].agent_resume.argv,['claude','--resume',sessionValue(t),'--permission-mode','manual']);
  s=f.cli('run');assert.equal(event(s,'b').state,'sent');assert.equal(calls(f,'agent','prompt').at(-1)[2],pane(x));
 }finally{f.cleanup();}
});

test('respawn refuses panes it cannot prove are ours',()=>{
 const f=fixture();try{
  const t=ready(f),starts=()=>calls(f,'agent','start').length,before=starts();
  f.mutate(x=>{x.agents[pane(t)].agent_session.value='another';});
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/occupied by claude with another session/);
  f.mutate(x=>{x.agents[pane(t)].agent_session=null;});
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/no reported session/);
  agentExit(f,t);f.mutate(x=>{x.agents[pane(t)].foreground_cwd='/tmp';});
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/now in \/tmp, not the task worktree/);
  assert.equal(starts(),before,'no agent was started anywhere');
  f.mutate(x=>{x.agents[pane(t)].foreground_cwd=t.worktree;});
  f.db(d=>d.prepare('UPDATE tasks SET session=NULL WHERE id=?').run(t.id));
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/no saved native session/);
 }finally{f.cleanup();}
});

test('respawn is write-ahead: an ambiguous start or a different resumed session freezes',()=>{
 const f=fixture();try{
  const t=ready(f);agentExit(f,t);f.mutate(x=>{x.fail='start';});
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/ambiguous start/);
  let x=task(f,t.id);assert.equal(x.provision,'unknown');assert.equal(audits(f,'respawn-start').length,1);
  f.cli('submit',['followup','--task',t.id,'--id','b']);assert.equal(event(f.cli('run'),'b').state,'queued');
  // The agent did start on the saved session despite the ambiguous answer: plain re-verification adopts it.
  f.mutate(x=>{delete x.fail;});assert.equal(f.cli('recover',['--task',t.id]).recovered.worker,'verified');
  agentExit(f,t);f.mutate(x=>{x.resumeAs='fresh-session';});
  assert.match(f.cli('recover',['--task',t.id,'--respawn'],1),/session differs/);
  x=task(f,t.id);assert.equal(x.provision,'unknown');assert.equal(x.session,t.session,'saved identity is never replaced');
 }finally{f.cleanup();}
});
