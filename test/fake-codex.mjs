#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);let input='';for await(const d of process.stdin)input+=d;
assert.equal(args[0],'exec');assert(args.includes('--ephemeral'));assert(args.includes('--ignore-user-config'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.equal(args.at(-1),'-');
const schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));assert.equal(schema.additionalProperties,false);assert.match(input,/routing classifier/);
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({action:'new',task:null,title:'Codex routed',reply:''}));console.log(JSON.stringify({type:'turn.completed'}));
