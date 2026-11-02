import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
const f=fixture();
try{
 f.cli('submit',['Alpha','--id','input-alpha']);f.cli('submit',['Beta','--id','input-beta']);
 let s=f.cli('run');const alpha=s.tasks.find(t=>t.title==='Alpha'),beta=s.tasks.find(t=>t.title==='Beta');
 f.report(alpha,'input-alpha','ack');f.cli('submit',['continue Alpha','--id','followup-alpha']);
 s=f.cli('run');assert.equal(s.deliveries.length,2);
 f.report(alpha,'input-alpha');f.report(beta,'input-beta');
 s=f.cli('run');assert.equal(s.deliveries.length,3);assert.equal(s.tasks.find(t=>t.id===alpha.id).session,alpha.session);
 f.report(alpha,'followup-alpha');s=f.cli('recover');
 console.log(JSON.stringify({offline:true,router:'command',worker:'claude',tasks:s.tasks.map(t=>({title:t.title,status:t.status,ref:t.ref,session:t.session})),inputs:s.events.map(e=>({id:e.id,state:e.state})),launches:f.fake().calls.filter(c=>c[1]==='start').length,prompts:f.fake().calls.filter(c=>c[1]==='prompt').length,restart:'same worktree, worker, session retained'},null,2));
}finally{f.cleanup();}
