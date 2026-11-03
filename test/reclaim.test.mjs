import {execFileSync,execFile,spawn} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,waitFor} from './helpers.mjs';

const git=(cwd,...args)=>execFileSync('git',['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.invalid',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const commit=(t,file,text)=>{writeFileSync(join(t.worktree,file),text);git(t.worktree,'add',file);git(t.worktree,'commit','-qm',file);return git(t.worktree,'rev-parse','HEAD').trim();};
const hasBranch=(f,t)=>git(f.repo,'branch','--list',t.branch).includes(t.branch);
const paneCloses=f=>f.fake().calls.filter(c=>c[0]==='pane'&&c[1]==='close').length;
const pane=t=>JSON.parse(t.ref).pane;
const setConfig=(f,key,value)=>f.db(d=>d.prepare('INSERT OR REPLACE INTO config VALUES(?,?)').run(key,JSON.stringify(value)));
function ready(f,...titles){
 setConfig(f,'concurrency',Math.max(2,titles.length));
 for(const title of titles)f.cli('submit',[title,'--id',title]);
 const s=f.cli('run'),tasks=titles.map(title=>s.tasks.find(t=>t.title===title));
 for(const t of tasks)f.report(t,t.title);
 return tasks;
}

test('close: verified pane closed, ignored build output reclaimed, branch kept, task leaves routing',()=>{
 const f=fixture();try{
 // .git/info/exclude is shared by all worktrees, like a committed .gitignore for build output.
 mkdirSync(join(f.repo,'.git','info'),{recursive:true});appendFileSync(join(f.repo,'.git','info','exclude'),'build/\n');
 const [t]=ready(f,'Alpha');
 mkdirSync(join(t.worktree,'build'));writeFileSync(join(t.worktree,'build','out.bin'),Buffer.alloc(1<<20,1));
 const du=f.cli('du');assert.equal(du.tasks[0].dirty,false);assert(du.tasks[0].bytes>=1<<20);assert(du.free.bytes>0);assert(du.database.bytes>0);
 const r=f.cli('close',['--task',t.id]);
 assert.equal(r.worker.worker,'closed');assert(r.reclaimed>=1<<20);assert.equal(r.branch.kept,true);
 assert(!existsSync(t.worktree));assert(hasBranch(f,t));assert.equal(paneCloses(f),1);assert.equal(f.fake().agents[pane(t)],undefined);
 let s=f.cli('status');assert.equal(s.tasks[0].lifecycle,'closed');assert.equal(s.tasks[0].status,'ready');assert.equal(s.requests[0].state,'done');
 assert.match(f.cli('submit',['more','--task',t.id],1),/Task is closed/);
 f.cli('submit',['continue Alpha','--id','c']);s=f.cli('run');
 assert.equal(s.tasks.length,2);assert.notEqual(s.events.find(e=>e.id==='c').task,t.id);
 assert.equal(f.cli('close',['--task',t.id]).already,'closed');assert.equal(paneCloses(f),1);
 assert.equal(f.cli('recover').tasks.find(x=>x.id===t.id).provision,'started');
 assert.match(f.cli('recover',['--task',t.id,'--ref',t.ref,'--session',t.session],1),/Task is closed/);
 }finally{f.cleanup();}
});

test('close refuses uncommitted work with no side effects; --discard-changes removes it',()=>{
 const f=fixture();try{
 const [t]=ready(f,'Alpha');writeFileSync(join(t.worktree,'notes.txt'),'unsaved');
 const calls=f.fake().calls.length;
 assert.match(f.cli('close',['--task',t.id],1),/uncommitted or untracked changes/);
 assert.equal(f.fake().calls.length,calls);assert(existsSync(join(t.worktree,'notes.txt')));
 let s=f.cli('status');assert.equal(s.tasks[0].lifecycle,'open');assert.equal(s.requests[0].state,'rejected');
 f.cli('submit',['more','--task',t.id,'--id','b']);s=f.cli('run');assert.equal(s.tasks[0].inflight,'b');f.report(t,'b');
 const r=f.cli('close',['--task',t.id,'--discard-changes']);assert.equal(r.worker.worker,'closed');assert(!existsSync(t.worktree));
 }finally{f.cleanup();}
});

test('close --abandon releases the slot of a task frozen mid-turn; late reports are stale',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);f.cli('submit',['Beta','--id','b']);let s=f.cli('run');const a=s.tasks.find(t=>t.title==='Alpha');
 git(f.repo,'worktree','remove','--force',a.worktree);
 f.cli('submit',['Gamma','--id','g']);s=f.cli('run');
 assert.equal(s.tasks.find(t=>t.id===a.id).provision,'unknown');assert.equal(s.events.find(e=>e.id==='g').state,'queued');
 assert.match(f.cli('close',['--task',a.id],1),/active input turn.*--abandon/);
 const r=f.cli('close',['--task',a.id,'--abandon']);assert.equal(r.abandoned,1);assert.equal(r.worker.worker,'closed');
 const token=f.db(d=>d.prepare('SELECT token FROM tasks WHERE id=?').get(a.id).token);
 assert.match(f.cli('report',['--id','late','--task',a.id,'--token',token,'--event','a','--outcome','ready','--summary','late','--evidence','late'],1),/Stale/);
 s=f.cli('run');assert.equal(s.events.find(e=>e.id==='g').state,'sent');
 assert.equal(s.events.find(e=>e.id==='a').state,'abandoned');assert.equal(s.tasks.find(t=>t.id===a.id).status,'abandoned');
 assert(s.deliveries.filter(d=>d.event==='a').every(d=>d.state==='abandoned'));
 }finally{f.cleanup();}
});

test('close never closes a pane it cannot prove is the saved worker',()=>{
 const f=fixture();try{
 const [a,b]=ready(f,'Alpha','Beta');
 f.mutate(x=>{x.agents[pane(a)].terminal_id='reused-by-someone-else';delete x.agents[pane(b)];});
 const ra=f.cli('close',['--task',a.id]),rb=f.cli('close',['--task',b.id]);
 assert.equal(ra.worker.worker,'unverified');assert.match(ra.worker.detail,/left open/);assert(f.fake().agents[pane(a)]);
 assert.equal(rb.worker.worker,'absent');assert.equal(paneCloses(f),0);
 assert(!existsSync(a.worktree));assert(!existsSync(b.worktree));
 }finally{f.cleanup();}
});

test('a close that fails mid-way stays out of scheduling and resumes idempotently',()=>{
 const f=fixture();try{
 const [t]=ready(f,'Alpha');f.mutate(x=>x.fail='close');
 assert.match(f.cli('close',['--task',t.id],1),/ambiguous close/);
 let s=f.cli('status');assert.equal(s.tasks[0].lifecycle,'closing');assert.equal(s.requests[0].state,'failed');assert(existsSync(t.worktree));
 assert.match(f.cli('submit',['more','--task',t.id],1),/Task is closing/);
 f.mutate(x=>delete x.fail);
 const r=f.cli('close',['--task',t.id]);assert.equal(r.worker.worker,'closed');assert(!existsSync(t.worktree));
 assert.equal(f.cli('status').tasks[0].lifecycle,'closed');
 }finally{f.cleanup();}
});

test('an interrupted drop resumes teardown before deleting the branch, and never repeats it',()=>{
 const f=fixture();try{
 const [a,b]=ready(f,'Alpha','Beta');
 f.mutate(x=>x.fail='close');
 assert.match(f.cli('drop',['--task',a.id],1),/ambiguous close/);
 let s=f.cli('status');assert.equal(s.tasks.find(t=>t.id===a.id).lifecycle,'dropping');assert(existsSync(a.worktree));assert(hasBranch(f,a));
 f.mutate(x=>delete x.fail);
 let r=f.cli('drop',['--task',a.id]);assert.equal(r.worker.worker,'closed');assert(!existsSync(a.worktree));assert(!hasBranch(f,a));
 // A held ref lock makes only the final branch deletion fail; teardown is checkpointed as closed.
 const lock=join(f.repo,'.git','refs','heads',b.branch+'.lock');mkdirSync(join(lock,'..'),{recursive:true});writeFileSync(lock,'');
 assert.match(f.cli('drop',['--task',b.id],1),/lock/);
 s=f.cli('status');assert.equal(s.tasks.find(t=>t.id===b.id).lifecycle,'closed');assert(!existsSync(b.worktree));assert(hasBranch(f,b));
 rmSync(lock);const calls=f.fake().calls.length;
 r=f.cli('drop',['--task',b.id]);assert.equal(r.worker,undefined);assert(!hasBranch(f,b));assert.equal(f.fake().calls.length,calls);
 assert.equal(f.cli('status').tasks.find(t=>t.id===b.id).lifecycle,'dropped');
 }finally{f.cleanup();}
});

test('an unregistered directory at the worktree path is deleted only on explicit discard',()=>{
 const f=fixture();try{
 const [t]=ready(f,'Alpha');git(f.repo,'worktree','remove',t.worktree);mkdirSync(t.worktree);writeFileSync(join(t.worktree,'partial'),'x');
 assert.match(f.cli('close',['--task',t.id],1),/Unregistered directory/);assert(existsSync(join(t.worktree,'partial')));
 f.cli('close',['--task',t.id,'--discard-changes']);assert(!existsSync(t.worktree));
 }finally{f.cleanup();}
});

test('drop deletes only merged branches unless told otherwise and prints a restore command',()=>{
 const f=fixture();try{
 const [a,b,c]=ready(f,'Alpha','Beta','Gamma');
 const shaA=commit(a,'a.txt','a'),shaB=commit(b,'b.txt','b'),shaC=commit(c,'c.txt','c');
 const calls=f.fake().calls.length;
 assert.match(f.cli('drop',['--task',a.id],1),/has commits not in/);assert.equal(f.fake().calls.length,calls);assert(existsSync(a.worktree));assert(hasBranch(f,a));
 git(f.repo,'merge','--ff-only','-q',a.branch);
 let r=f.cli('drop',['--task',a.id]);assert.equal(r.branch.deleted,shaA);assert.equal(r.branch.restore,`git branch ${a.branch} ${shaA}`);assert(!hasBranch(f,a));assert(!existsSync(a.worktree));
 git(f.repo,'cherry-pick',shaB);
 r=f.cli('drop',['--task',b.id]);assert.equal(r.branch.deleted,shaB);
 f.cli('close',['--task',c.id]);const before=f.fake().calls.length;
 const main=git(f.repo,'branch','--show-current').trim();git(f.repo,'switch','-q',c.branch);
 assert.match(f.cli('drop',['--task',c.id,'--discard-unmerged'],1),/checked out at/);git(f.repo,'switch','-q',main);
 assert.match(f.cli('drop',['--task',c.id],1),/has commits not in/);
 r=f.cli('drop',['--task',c.id,'--discard-unmerged']);assert.equal(r.branch.deleted,shaC);assert.equal(f.fake().calls.length,before);
 git(f.repo,'branch',c.branch,shaC);assert(hasBranch(f,c));
 assert.equal(f.cli('drop',['--task',c.id]).already,'dropped');
 }finally{f.cleanup();}
});

test('gc --merged collects finished clean merged tasks, explains every skip, and du predicts it',()=>{
 const f=fixture();try{
 setConfig(f,'concurrency',10);
 const titles=['Merged','Unmerged','Dirty','Blocked','Empty','Active'];
 for(const title of titles)f.cli('submit',[title,'--id',title]);
 const s0=f.cli('run'),t=Object.fromEntries(titles.map(x=>[x,s0.tasks.find(y=>y.title===x)]));
 for(const x of ['Merged','Unmerged','Dirty','Empty'])f.report(t[x],x);f.report(t.Blocked,'Blocked','blocked');
 commit(t.Merged,'m.txt','m');git(f.repo,'merge','--ff-only','-q',t.Merged.branch);
 commit(t.Unmerged,'u.txt','u');writeFileSync(join(t.Dirty.worktree,'wip.txt'),'wip');
 assert.match(f.cli('gc',[],1),/requires --merged/);
 const calls=f.fake().calls.length,dry=f.cli('gc',['--merged','--dry-run']);
 assert.deepEqual(dry.eligible.map(x=>x.title),['Merged','Empty']);
 assert.deepEqual(Object.fromEntries(dry.skipped.map(x=>[x.title,x.reason])),{Unmerged:'not merged',Dirty:'uncommitted changes',Blocked:'blocked: waiting for you',Active:'active input turn'});
 assert.equal(f.fake().calls.length,calls);assert(titles.every(x=>existsSync(t[x].worktree)));
 const du=f.cli('du');assert.equal(du.gcMerged.tasks,2);assert.equal(du.gcMerged.bytes,dry.eligible.reduce((n,x)=>n+x.bytes,0));
 assert.equal(du.tasks.find(x=>x.title==='Unmerged').gc,'kept: not merged');
 assert.equal(f.cli('du',['--task',t.Dirty.id]).tasks[0].dirty,true);assert.match(f.cli('du',['--task','missing'],1),/Unknown task/);
 const r=f.cli('gc',['--merged']);
 assert.deepEqual(r.dropped.map(x=>x.title),['Merged','Empty']);assert.deepEqual(r.failed,[]);assert.equal(r.skipped.length,4);
 assert(!hasBranch(f,t.Merged)&&!hasBranch(f,t.Empty));assert(['Unmerged','Dirty','Blocked','Active'].every(x=>hasBranch(f,t[x])&&existsSync(t[x].worktree)));
 assert.equal(paneCloses(f),2);assert.equal(f.cli('du').gcMerged.tasks,0);
 }finally{f.cleanup();}
});

test('disk guard holds new worktrees and new turns, then resumes when space returns',()=>{
 const f=fixture();try{
 setConfig(f,'minFreeMb',1e9);
 f.cli('submit',['Alpha','--id','a']);let s=f.cli('run');
 assert.equal(s.tasks[0].provision,'new');assert.equal(f.fake().calls.length,0);assert(!existsSync(s.tasks[0].worktree));
 assert.equal(s.events[0].state,'queued');assert.match(s.events[0].error,/Disk guard/);
 f.cli('run');assert.equal(f.cli('history').filter(x=>x.kind==='disk-guard').length,1);assert.equal(f.cli('du').guard.ok,false);
 setConfig(f,'minFreeMb',0);s=f.cli('run');assert.equal(s.events[0].state,'sent');assert.equal(s.events[0].error,null);
 const t=s.tasks[0];f.report(t,'a');setConfig(f,'minFreeMb',1e9);f.cli('submit',['more','--task',t.id,'--id','b']);
 s=f.cli('run');assert.equal(s.events.find(e=>e.id==='b').state,'queued');assert.equal(f.fake().calls.filter(c=>c[1]==='prompt').length,1);
 setConfig(f,'minFreeMb',0);f.cli('run');assert.equal(f.fake().calls.filter(c=>c[1]==='prompt').length,2);
 const cli=new URL('../dist/cli.js',import.meta.url).pathname;
 assert.throws(()=>execFileSync(process.execPath,[cli,'--state',f.state+'-bad','init','--repo',f.repo,'--min-free-mb','-1'],{stdio:'pipe'}));
 const out=JSON.parse(execFileSync(process.execPath,[cli,'--state',f.state+'-default','init','--repo',f.repo],{encoding:'utf8'}));assert.equal(out.config.minFreeMb,10240);
 }finally{f.cleanup();}
});

test('close while serve is running is applied by that supervisor, not a second writer',async()=>{
 const f=fixture();try{
 const [t]=ready(f,'Alpha');
 const serve=spawn(process.execPath,f.args('serve',['--passes','2000','--interval','50']),{env:f.env,stdio:['ignore','ignore','pipe']});
 let errors='';serve.stderr.on('data',d=>errors+=d);
 await waitFor(()=>f.db(d=>!!d.prepare('SELECT * FROM supervisor').get()));
 const {stdout}=await promisify(execFile)(process.execPath,f.args('close',['--task',t.id]),{env:f.env});
 assert.equal(JSON.parse(stdout).worker.worker,'closed');
 assert.equal(f.db(d=>d.prepare('SELECT pid FROM supervisor').get().pid),serve.pid);
 serve.kill('SIGTERM');assert.equal(await new Promise(r=>serve.on('close',r)),0,errors);
 assert.equal(f.cli('status').tasks[0].lifecycle,'closed');assert.equal(paneCloses(f),1);
 }finally{f.cleanup();}
});

test('v0.1 state without lifecycle tracking migrates in place',()=>{
 const f=fixture();try{
 f.cli('submit',['Alpha','--id','a']);let s=f.cli('run');
 f.db(d=>{d.exec('DROP TABLE requests');d.exec('ALTER TABLE tasks DROP COLUMN lifecycle');});
 s=f.cli('status');assert.equal(s.tasks[0].lifecycle,'open');assert.deepEqual(s.requests,[]);
 f.report(s.tasks[0],'a');assert.equal(f.cli('close',['--task',s.tasks[0].id]).worker.worker,'closed');
 }finally{f.cleanup();}
});
