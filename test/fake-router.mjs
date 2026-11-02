#!/usr/bin/env node
let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
if(input.input==='malformed'){console.log('{');process.exit(0);}
if(input.input==='bad target'){console.log(JSON.stringify({action:'followup',task:'missing',title:'',reply:''}));process.exit(0);}
const match=/continue (.+)/i.exec(input.input);
const task=match&&input.tasks.find(t=>t.title===match[1]);
console.log(JSON.stringify(input.input==='hello'?{action:'reply',task:null,title:'',reply:'Hello from the offline router'}:task?{action:'followup',task:task.id,title:'',reply:''}:{action:'new',task:null,title:input.input,reply:''}));
