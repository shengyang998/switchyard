#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.SWITCHYARD_FAKE_FILE;
if(!file) throw Error('Fake Herdr requires isolated state file');
let state=JSON.parse(readFileSync(file,'utf8')),args=process.argv.slice(2);
const option=k=>args[args.indexOf(k)+1];
const save=()=>writeFileSync(file,JSON.stringify(state));
const ok=result=>{save();console.log(JSON.stringify({id:'test',result}));};
// Mirrors Herdr 0.9 errors: JSON on stderr with a stable code, nonzero exit.
const fail=(code,message)=>{save();console.error(JSON.stringify({error:{code,message},id:'test'}));process.exit(1);};
state.calls.push(args);
if(args[0]==='workspace'&&args[1]==='create'){
 const pane=`fake:p${state.next++}`;state.agents[pane]={pane_id:pane,workspace_id:`fake:w${state.next-1}`,terminal_id:`term-${pane}`,cwd:option('--cwd'),foreground_cwd:option('--cwd'),agent_status:'idle',interactive_ready:true,launch_pending:false};
 if(state.fail==='create'){save();console.error('ambiguous create');process.exit(1);} ok({root_pane:{pane_id:pane}});
}else if(args[0]==='agent'&&args[1]==='start'){
 const a=state.agents[option('--pane')];a.agent=option('--kind');a.agent_session={source:'integration',agent:a.agent,kind:'id',value:`session-${a.pane_id}`};
 if(state.fail==='start'){save();console.error('ambiguous start');process.exit(1);}ok({agent:a});
}else if(args[0]==='agent'&&args[1]==='get'){
 const a=state.agents[args[2]];if(!a){save();console.error('missing worker');process.exit(1);}ok({agent:a});
}else if(args[0]==='agent'&&args[1]==='prompt'){
 if(state.delay) await new Promise(r=>setTimeout(r,state.delay));
 if(state.fail==='prompt'){save();console.error('ambiguous prompt');process.exit(1);}ok({submitted:true});
}else if(args[0]==='pane'&&args[1]==='get'){
 const a=state.agents[args[2]];if(!a)fail('pane_not_found',`pane ${args[2]} not found`);
 ok({type:'pane_info',pane:{pane_id:a.pane_id,workspace_id:a.workspace_id,terminal_id:a.terminal_id,cwd:a.cwd,foreground_cwd:a.foreground_cwd,agent_status:a.agent_status}});
}else if(args[0]==='pane'&&args[1]==='close'){
 if(state.fail==='close'){save();console.error('ambiguous close');process.exit(1);}
 if(!state.agents[args[2]])fail('pane_not_found',`pane ${args[2]} not found`);
 delete state.agents[args[2]];ok({type:'ok'});
}else throw Error(`Unsupported fake command ${JSON.stringify(args)}`);
