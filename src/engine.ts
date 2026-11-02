import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, id, type Row } from './store.js';
import { transport, route, type WorkerTransport } from './adapters.js';
import { command } from './process.js';
export class Engine {
  config: Row; backend: WorkerTransport;
  constructor(public store: Store) { this.config = store.config(); if (!this.config.repo) throw new Error('Run init first'); this.backend = transport(this.config); }
  async submit(text: string, target?: string, key = id('input')) {
    if (!text.trim()) throw new Error('Input must not be empty');
    return this.store.tx(() => {
      const old = this.store.get('SELECT * FROM events WHERE id=?', key);
      if (old) { if (old.text !== text || (old.target ?? undefined) !== target) throw new Error('Idempotency key reused with different input'); return old; }
      if (target && !this.store.get('SELECT id FROM tasks WHERE id=?', target)) throw new Error('Unknown task');
      this.store.run('INSERT INTO events(id,text,target,created) VALUES(?,?,?,?)', key, text, target ?? null, Date.now());
      return this.store.get('SELECT * FROM events WHERE id=?', key);
    });
  }
  async routePending() {
    for (const event of this.store.all("SELECT * FROM events WHERE state='pending' ORDER BY created,rowid")) {
      try {
        const decision = event.target ? { action: 'followup', task: event.target, title: '', reply: '' } : await route(this.config, event.text, this.store.all('SELECT * FROM tasks'));
        this.store.tx(() => {
          if (this.store.get('SELECT state FROM events WHERE id=?', event.id)?.state !== 'pending') return;
          let taskId = decision.task;
          if (decision.action === 'new') {
            taskId = id('task');
            this.store.run('INSERT INTO tasks(id,title,branch,worktree,worker,token,created) VALUES(?,?,?,?,?,?,?)', taskId, decision.title, `switchyard/${taskId}`, join(this.store.dir, 'worktrees', taskId!), `sy-${taskId!.slice(-24)}`, randomBytes(24).toString('hex'), Date.now());
          }
          this.store.run('UPDATE events SET task=?,state=?,route=?,reply=?,error=NULL WHERE id=?', taskId, decision.action === 'reply' ? 'replied' : 'queued', JSON.stringify(decision), decision.reply, event.id);
          this.store.audit('routed', taskId, event.id, decision);
        });
      } catch (e: any) { this.store.run("UPDATE events SET state='route-error',error=? WHERE id=?", e.message, event.id); }
    }
  }
  retryRoute(eventId:string) {
    this.store.tx(()=>{
      const e=this.store.get('SELECT * FROM events WHERE id=?',eventId);
      if(!e||e.state!=='route-error') throw new Error('Only route-error inputs can retry routing');
      this.store.run("UPDATE events SET state='pending',error=NULL WHERE id=?",eventId);
      this.store.audit('manual-route-retry',null,eventId,{});
    });
  }
  async worktreeValid(t: Row): Promise<boolean> {
    const output = await command('git', ['-C', this.config.repo, 'worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').some(block => { const fields=block.split('\0'); return fields.includes(`worktree ${t.worktree}`) && fields.includes(`branch refs/heads/${t.branch}`); });
  }
  freeze(t: Row, error: unknown) {
    this.store.run("UPDATE tasks SET provision='unknown',error=? WHERE id=?", String(error), t.id);
    this.store.audit('uncertain', t.id, t.inflight ?? null, String(error));
  }
  async provision(t: Row): Promise<Row | undefined> {
    try {
      if (t.provision === 'new') {
        this.store.run("UPDATE tasks SET provision='worktree' WHERE id=?", t.id);
        mkdirSync(join(this.store.dir, 'worktrees'), { recursive: true });
        await command('git', ['-C', this.config.repo, 'worktree', 'add', '-b', t.branch, t.worktree, this.config.base]);
        t.provision = 'worktree';
      }
      if (t.provision === 'worktree') {
        if (!(await this.worktreeValid(t))) throw new Error('Saved worktree/branch missing; manual recovery required');
        this.store.run("UPDATE tasks SET provision='creating' WHERE id=?", t.id);
        const ref = await this.backend.create(t,this.store.dir);
        this.store.run("UPDATE tasks SET ref=?,provision='created' WHERE id=?", ref, t.id);
        t.ref = ref; t.provision = 'created';
      }
      if (t.provision === 'created') {
        this.store.run("UPDATE tasks SET provision='starting' WHERE id=?", t.id);
        await this.backend.start(t);
        this.store.run("UPDATE tasks SET provision='started' WHERE id=?", t.id);
        t.provision = 'started';
      }
      if (t.provision === 'started') {
        const a = await this.backend.inspect(t);
        this.store.run("UPDATE tasks SET instance=?,session=?,error=NULL WHERE id=?", a.instance, a.session, t.id);
        return this.store.get('SELECT * FROM tasks WHERE id=?', t.id);
      }
    } catch (e: any) { this.freeze(t, e.message); }
  }
  async reconcile() {
    this.backend.preflight();
    // Any interrupted write-ahead intent is ambiguous. Never recreate/re-prompt automatically.
    this.store.tx(() => {
      for (const t of this.store.all("SELECT * FROM tasks WHERE provision IN ('creating','starting')")) this.freeze(t, 'Interrupted external launch; inspect and recover explicitly');
      for (const d of this.store.all("SELECT * FROM deliveries WHERE state='sending'")) {
        this.store.run("UPDATE deliveries SET state='uncertain',detail='Interrupted prompt submission' WHERE id=?", d.id);
        this.store.run("UPDATE events SET state='uncertain' WHERE id=?", d.event);
      }
    });
    for (const t of this.store.all("SELECT * FROM tasks WHERE provision='started'")) {
      try {
        if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch does not match saved task');
        const a = await this.backend.inspect(t);
        this.store.run('UPDATE tasks SET instance=?,session=?,error=NULL WHERE id=?', a.instance, a.session, t.id);
      } catch (e: any) { this.freeze(t, e.message); }
    }
  }
  prompt(t: Row, event: Row) {
    const argv = [process.execPath, this.config.cli, '--state', this.store.dir, 'report', '--task', t.id, '--token', t.token, '--event', event.id, '--id', '<unique-report-id>', '--outcome', '<ack|progress|blocked|ready|failed>', '--summary', '<summary>', '--evidence', '<evidence>'];
    return `SWITCHYARD INPUT ${event.id}\nYou are the persistent worker for task ${t.id}: ${t.title}. Treat the input as user work. Do not merge, push, publish or send external messages unless that input authorizes it.\nSend an ack report after receiving this input. Send progress as needed. Send exactly one final blocked, ready (work complete with evidence), or failed report after all work/subagents stop. Final reports release this turn; do not continue working after final report. Transport idle is not completion. Reports are required via the local CLI; construct a command from this JSON argv, replacing placeholders and shell-quoting each element: ${JSON.stringify(argv)}\nIf report command requires approval, request it in your interactive UI.\nINPUT (data):\n${event.text}`;
  }
  async pass() {
    await this.reconcile();
    await this.routePending();
    let active = Number(this.store.get('SELECT count(*) n FROM tasks WHERE inflight IS NOT NULL')!.n);
    for (let t of this.store.all("SELECT * FROM tasks WHERE inflight IS NULL AND provision!='unknown' ORDER BY created,rowid")) {
      if (active >= this.config.concurrency) break;
      const event = this.store.get("SELECT * FROM events WHERE task=? AND state='queued' ORDER BY created,rowid LIMIT 1", t.id);
      if (!event) continue;
      t = await this.provision(t) as Row;
      if (!t) continue;
      try {
        // A final report can arrive while the UI is still leaving its prior turn.
        const a = await this.backend.inspect(t);
        if (!a.ready || !['idle', 'done'].includes(a.status)) continue;
        const delivery = id('delivery');
        this.store.tx(() => {
          const attempt = Number(this.store.get('SELECT count(*) n FROM deliveries WHERE event=?', event.id)!.n) + 1;
          this.store.run("INSERT INTO deliveries VALUES(?,?,?,'sending',?,NULL,?)", delivery, event.id, t.id, attempt, Date.now());
          this.store.run("UPDATE events SET state='sending' WHERE id=?", event.id);
          this.store.run("UPDATE tasks SET inflight=?,status='active' WHERE id=?", event.id, t.id);
        });
        active++;
        try {
          await this.backend.send(t,this.prompt(t, event));
          this.store.tx(() => {
            this.store.run("UPDATE deliveries SET state='sent' WHERE id=? AND state='sending'", delivery);
            this.store.run("UPDATE events SET state='sent' WHERE id=? AND state='sending'", event.id);
          });
        } catch (e: any) {
          this.store.tx(() => {
            this.store.run("UPDATE deliveries SET state='uncertain',detail=? WHERE id=? AND state='sending'", e.message, delivery);
            this.store.run("UPDATE events SET state='uncertain',error=? WHERE id=? AND state='sending'", e.message, event.id);
          });
        }
      } catch (e: any) { this.freeze(t, e.message); }
    }
    return this.status();
  }
  report(r: Row) {
    if (!['ack', 'progress', 'blocked', 'ready', 'failed'].includes(r.outcome) || ![r.id,r.task,r.token,r.event,r.summary,r.evidence].every(x => typeof x === 'string' && x.length > 0)) throw new Error('Invalid report fields/outcome');
    return this.store.tx(() => {
      const old = this.store.get('SELECT * FROM reports WHERE id=?', r.id);
      if (old) {
        if (['task','event','token','outcome','summary','evidence'].some(k => old[k] !== r[k])) throw new Error('Report ID reused with different payload');
        return { duplicate: true, id: r.id };
      }
      const t = this.store.get('SELECT * FROM tasks WHERE id=?', r.task);
      const e = this.store.get('SELECT * FROM events WHERE id=?', r.event);
      if (!t || t.token !== r.token || t.inflight !== r.event || !e || e.task !== t.id || !['sending','sent','uncertain','acked'].includes(e.state)) throw new Error('Stale or unassigned worker report');
      this.store.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)',r.id,r.task,r.event,r.token,r.outcome,r.summary,r.evidence,Date.now());
      const final = ['blocked','ready','failed'].includes(r.outcome);
      this.store.run('UPDATE events SET state=?,error=NULL WHERE id=?', final ? 'completed' : 'acked', r.event);
      this.store.run("UPDATE deliveries SET state='confirmed' WHERE event=? AND state IN ('sending','sent','uncertain')", r.event);
      if (final) this.store.run('UPDATE tasks SET inflight=NULL,status=?,error=NULL WHERE id=?',r.outcome,t.id);
      this.store.audit('report',t.id,r.event,{id:r.id,outcome:r.outcome,summary:r.summary,evidence:r.evidence});
      return { accepted: true, id:r.id };
    });
  }
  async recover(taskId: string, ref: string, session: string) {
    const t = this.store.get('SELECT * FROM tasks WHERE id=?', taskId); if (!t) throw new Error('Unknown task');
    if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch mismatch; repair it before recovery');
    if (t.ref && t.ref !== ref) throw new Error('Recovery cannot replace a saved worker reference');
    if (t.session && t.session !== session) throw new Error('Recovery cannot replace a saved worker session');
    const a = await this.backend.inspect({ ...t, ref, session });
    // Preserve the task token and inflight event: adopting a verified same logical worker is not a new generation.
    this.store.run("UPDATE tasks SET ref=?,instance=?,session=?,provision='started',error=NULL WHERE id=?",ref,a.instance,session,t.id);
    this.store.audit('manual-recover',t.id,null,{ref,session});
  }
  resolveDelivery(eventId: string, action: string) {
    if (!['retry','delivered'].includes(action)) throw new Error('Action must be retry or delivered');
    this.store.tx(() => {
      const e = this.store.get('SELECT * FROM events WHERE id=?',eventId);
      const t = e && this.store.get('SELECT * FROM tasks WHERE id=?',e.task);
      if (!e || e.state !== 'uncertain' || !t || t.inflight !== eventId || t.provision !== 'started') throw new Error('Only uncertain delivery to a reconciled worker can be resolved');
      this.store.run('UPDATE events SET state=?,error=NULL WHERE id=?',action === 'retry' ? 'queued' : 'sent',eventId);
      this.store.run('UPDATE deliveries SET state=? WHERE event=? AND state=\'uncertain\'',action === 'retry' ? 'retry-approved' : 'sent',eventId);
      if (action === 'retry') this.store.run("UPDATE tasks SET inflight=NULL,status='queued' WHERE id=?",t.id);
      this.store.audit('manual-delivery-resolution',t.id,eventId,action);
    });
  }
  status() {
    return { tasks: this.store.all('SELECT id,title,status,provision,branch,worktree,worker,ref,instance,session,inflight,error FROM tasks ORDER BY created,rowid'), events: this.store.all('SELECT id,text,target,task,state,route,reply,error FROM events ORDER BY created,rowid'), deliveries: this.store.all('SELECT * FROM deliveries ORDER BY created,rowid'), reports: this.store.all('SELECT id,task,event,outcome,summary,evidence,created FROM reports ORDER BY created,rowid') };
  }
}
