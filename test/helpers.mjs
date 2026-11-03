import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
export function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'switchyard test-'))),repo=join(root,'repo'),state=join(root,'state'),fakeFile=join(root,'herdr.json');
 execFileSync('git',['-c','init.templateDir=','init','-q',repo]);execFileSync('git',['-C',repo,'config','core.hooksPath','/dev/null']);execFileSync('git',['-C',repo,'config','commit.gpgSign','false']);writeFileSync(join(repo,'README.md'),'fixture\n');
 execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Test','-c','core.hooksPath=/dev/null','-c','user.email=test@example.invalid','commit','-qm','fixture']);
 writeFileSync(fakeFile,JSON.stringify({next:1,agents:{},calls:[]}));
 const herdr=resolve('test/fake-herdr.mjs');chmodSync(herdr,0o755);
 const env={...process.env,HERDR_ENV:'1',SWITCHYARD_FAKE_FILE:fakeFile};
 const args=(cmd,rest=[])=>[resolve('dist/cli.js'),'--state',state,cmd,...rest];
 function cli(cmd,rest=[],expected=0){let result;try{result=execFileSync(process.execPath,args(cmd,rest),{env,encoding:'utf8',stdio:['pipe','pipe','pipe']});if(expected!==0)throw Error('Expected failure');}catch(e){if(expected===0)throw Error(e.stderr?.toString()||e.message);return e.stderr.toString();}return JSON.parse(result);}
 cli('init',['--repo',repo,'--router-command',JSON.stringify([process.execPath,resolve('test/fake-router.mjs')]),'--worker-kind','claude','--worker-args','["--permission-mode","manual"]','--herdr',herdr,'--min-free-mb','0']);
 return {root,repo,state,env,args,cli,spawn:(cmd,rest=[])=>spawn(process.execPath,args(cmd,rest),{env,stdio:['ignore','pipe','pipe']}),fake:()=>JSON.parse(readFileSync(fakeFile,'utf8')),mutate(fn){const x=JSON.parse(readFileSync(fakeFile,'utf8'));fn(x);writeFileSync(fakeFile,JSON.stringify(x));},db(fn){const d=new DatabaseSync(join(state,'state.db'));try{return fn(d);}finally{d.close();}},report(t,event,outcome='ready',key=`report-${event}-${outcome}`){const token=this.db(d=>d.prepare('SELECT token FROM tasks WHERE id=?').get(t.id).token);return cli('report',['--id',key,'--task',t.id,'--token',token,'--event',event,'--outcome',outcome,'--summary',`${outcome} test`,'--evidence','offline assertion']);},cleanup(){rmSync(root,{recursive:true,force:true});}};
}
export const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out');};
