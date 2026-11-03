import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, id, type Row } from './store.js';
import { transport, route, TransportUnavailable, WorkerAbsent, type Inspection, type WorkerTransport } from './adapters.js';
import { command } from './process.js';
import { DEFAULT_MIN_FREE_MB, freeSpace, human, usage } from './disk.js';
import { commitOf, dirty, merged, worktrees, type Worktree } from './git.js';
type Facts = { registered: boolean; exists: boolean; stray: boolean; dirty: boolean; sha: string | null; merged: boolean | null; checkedOut: string[] };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export class Engine {
  config: Row; backend: WorkerTransport;
  // Set by reconcile when the transport server is unreachable; scheduling and lifecycle work wait for it.
  offline: string | null = null;
  constructor(public store: Store) { this.config = store.config(); if (!this.config.repo) throw new Error('Run init first'); this.backend = transport(this.config); }
  async submit(text: string, target?: string, key = id('input')) {
    if (!text.trim()) throw new Error('Input must not be empty');
    return this.store.tx(() => {
      const old = this.store.get('SELECT * FROM events WHERE id=?', key);
      if (old) { if (old.text !== text || (old.target ?? undefined) !== target) throw new Error('Idempotency key reused with different input'); return old; }
      if (target) { const t = this.store.get('SELECT lifecycle FROM tasks WHERE id=?', target); if (!t) throw new Error('Unknown task'); if (t.lifecycle !== 'open') throw new Error(`Task is ${t.lifecycle}; submit without --task to start new work`); }
      this.store.run('INSERT INTO events(id,text,target,created) VALUES(?,?,?,?)', key, text, target ?? null, Date.now());
      return this.store.get('SELECT * FROM events WHERE id=?', key);
    });
  }
  async routePending() {
    for (const event of this.store.all("SELECT * FROM events WHERE state='pending' ORDER BY created,rowid")) {
      try {
        const decision = event.target ? { action: 'followup', task: event.target, title: '', reply: '' } : await route(this.config, event.text, this.store.all("SELECT * FROM tasks WHERE lifecycle='open'"));
        this.store.tx(() => {
          if (this.store.get('SELECT state FROM events WHERE id=?', event.id)?.state !== 'pending') return;
          let taskId = decision.task;
          if (decision.action === 'followup' && this.store.get('SELECT lifecycle FROM tasks WHERE id=?', taskId)?.lifecycle !== 'open') throw new Error('Follow-up target task is not open');
          if (decision.action === 'new') {
            taskId = id('task');
            const num = Number(this.store.get('SELECT COALESCE(MAX(num),0)+1 n FROM tasks')!.n);
            this.store.run('INSERT INTO tasks(id,num,title,branch,worktree,worker,token,created) VALUES(?,?,?,?,?,?,?,?)', taskId, num, decision.title, `switchyard/${taskId}`, join(this.store.dir, 'worktrees', taskId!), `sy-${taskId!.slice(-24)}`, randomBytes(24).toString('hex'), Date.now());
          }
          this.store.run('UPDATE events SET task=?,state=?,route=?,reply=?,error=NULL WHERE id=?', taskId, decision.action === 'reply' ? 'replied' : 'queued', JSON.stringify(decision), decision.reply, event.id);
          this.store.audit('routed', taskId, event.id, decision);
        });
      } catch (e: any) { this.store.run("UPDATE events SET state='route-error',error=? WHERE id=?", e.message, event.id); }
    }
  }
  // Accepts #3, 3, a full task ID or a unique prefix of one (with or without `task_`).
  resolveTask(ref: string): string {
    const s = ref.trim(), n = s.replace(/^#/, '');
    if (/^\d+$/.test(n)) { const t = this.store.get('SELECT id FROM tasks WHERE num=?', Number(n)); if (!t) throw new Error(`No task #${n}`); return t.id; }
    if (this.store.get('SELECT 1 FROM tasks WHERE id=?', s)) return s;
    const prefix = s.startsWith('task_') ? s : `task_${s}`;
    const matches = s.length >= 4 ? this.store.all('SELECT id FROM tasks WHERE substr(id,1,?)=?', prefix.length, prefix) : [];
    if (matches.length === 1) return matches[0].id;
    throw new Error(matches.length ? `Task reference ${s} is ambiguous` : `Unknown task ${s}`);
  }
  // A running `serve`/`up`, not a one-off command that briefly holds the lock.
  supervisor(): Row | null { const h = this.store.holder(); return h?.role === 'serve' ? h : null; }
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
    let launched = false;
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
        t.provision = 'started'; launched = true;
      }
      if (t.provision === 'started') {
        // An existing worker is inspected by the dispatcher; only a fresh launch waits for its session report.
        if (launched) { const a = await this.settle(t); this.adopt(t, a, 'rebind'); await this.pin(t, a.session); }
        return this.store.get('SELECT * FROM tasks WHERE id=?', t.id);
      }
    } catch (e: any) { this.freeze(t, e.message); }
  }
  async reconcile() {
    this.backend.preflight();
    // Any interrupted write-ahead intent is ambiguous. Never recreate/re-prompt automatically.
    this.store.tx(() => {
      for (const t of this.store.all("SELECT * FROM tasks WHERE provision IN ('creating','starting') AND lifecycle='open'")) this.freeze(t, 'Interrupted external launch; inspect and recover explicitly');
      for (const d of this.store.all("SELECT * FROM deliveries WHERE state='sending'")) {
        this.store.run("UPDATE deliveries SET state='uncertain',detail='Interrupted prompt submission' WHERE id=?", d.id);
        this.store.run("UPDATE events SET state='uncertain' WHERE id=?", d.event);
      }
    });
    for (const t of this.store.all("SELECT * FROM tasks WHERE provision='started' AND lifecycle='open'")) {
      try {
        if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch does not match saved task');
        const a = await this.backend.inspect(t);
        this.adopt(t, a, 'rebind');
        if (a.rebound) await this.pin(t, a.session);
      } catch (e: any) {
        // An unreachable server says nothing about worker identity: wait for it instead of freezing every task.
        if (e instanceof TransportUnavailable) { if (this.offline !== e.message) this.store.audit('transport-offline', null, null, e.message); this.offline = e.message; return; }
        if (e instanceof WorkerAbsent) { this.absent(t, e.message); continue; }
        this.freeze(t, e.message);
      }
    }
    if (this.offline) this.store.audit('transport-online', null, null, this.offline);
    this.offline = null;
  }
  // Inspect right after a launch: the agent's integration may report its native session a moment after readiness.
  async settle(t: Row): Promise<Inspection> {
    const until = Date.now() + Math.min(this.config.timeout, 15000);
    for (;;) {
      try { return await this.backend.inspect(t); }
      catch (e: any) { if (!(e instanceof WorkerAbsent || /Missing\/mismatched worker pane\/session identity/.test(e.message)) || Date.now() > until) throw e; await sleep(500); }
    }
  }
  // Record a verified inspection. A rebound worker (same pane and native session on a new terminal) lost the
  // process that was handling any in-flight turn, so that turn becomes uncertain for the operator; never resent.
  adopt(t: Row, a: Inspection, kind: string, detail: Row = {}) {
    this.store.tx(() => {
      this.store.run('UPDATE tasks SET instance=?,session=?,error=NULL WHERE id=?', a.instance, a.session, t.id);
      if (a.rebound) this.store.audit(kind, t.id, t.inflight ?? null, { from: t.instance, to: a.instance, session: a.session, ...detail });
      if (a.rebound && t.inflight) this.interrupt(t.id, 'Worker restarted during this turn; its progress is unknown');
    });
  }
  // No agent (or no reported session) in the saved pane. Its process is gone or not yet restored, so an in-flight
  // turn is no longer being worked on; a late report from a restored worker is still accepted.
  absent(t: Row, reason: string) {
    if (t.error === reason) return;
    this.store.tx(() => {
      this.store.run('UPDATE tasks SET error=? WHERE id=?', reason, t.id);
      this.store.audit('worker-absent', t.id, t.inflight ?? null, reason);
      if (t.inflight) this.interrupt(t.id, 'Worker left its pane during this turn');
    });
  }
  // Best effort: without the pin a Herdr restart still resumes the session, only without the configured arguments.
  async pin(t: Row, session: string) {
    try { await this.backend.pin({ ...t, session }); }
    catch (e: any) { this.store.audit('pin-failed', t.id, null, e.message); }
  }
  interrupt(taskId: string, reason: string) {
    const t = this.store.get('SELECT inflight FROM tasks WHERE id=?', taskId), e = t?.inflight && this.store.get('SELECT * FROM events WHERE id=?', t.inflight);
    if (!e || !['sending', 'sent', 'acked'].includes(e.state)) return;
    const hint = `${reason}. Inspect the worker, then resolve --event ${e.id} --action delivered (keep waiting for its report) or --action retry (send the input again).`;
    this.store.run("UPDATE events SET state='uncertain',error=? WHERE id=?", hint, e.id);
    this.store.run("UPDATE deliveries SET state='uncertain',detail=? WHERE event=? AND state IN ('sending','sent','confirmed')", reason, e.id);
    this.store.audit('interrupted', taskId, e.id, reason);
  }
  prompt(t: Row, event: Row) {
    const argv = [process.execPath, this.config.cli, '--state', this.store.dir, 'report', '--task', t.id, '--token', t.token, '--event', event.id, '--id', '<unique-report-id>', '--outcome', '<ack|progress|blocked|ready|failed>', '--summary', '<summary>', '--evidence', '<evidence>'];
    return `SWITCHYARD INPUT ${event.id}\nYou are the persistent worker for task ${t.id}: ${t.title}. Treat the input as user work. Do not merge, push, publish or send external messages unless that input authorizes it.\nSend an ack report after receiving this input. Send progress as needed. Send exactly one final blocked, ready (work complete with evidence), or failed report after all work/subagents stop. Final reports release this turn; do not continue working after final report. Transport idle is not completion. Reports are required via the local CLI; construct a command from this JSON argv, replacing placeholders and shell-quoting each element: ${JSON.stringify(argv)}\nIf report command requires approval, request it in your interactive UI.\nINPUT (data):\n${event.text}`;
  }
  async pass() {
    await this.reconcile();
    // Routing needs no transport; worker, lifecycle and scheduling work waits until the server is back.
    if (this.offline) { await this.routePending(); return { ...this.status(), transport: { ok: false, error: this.offline } }; }
    await this.applyRequests();
    await this.routePending();
    let active = Number(this.store.get('SELECT count(*) n FROM tasks WHERE inflight IS NOT NULL')!.n);
    for (let t of this.store.all("SELECT * FROM tasks WHERE inflight IS NULL AND provision!='unknown' AND lifecycle='open' AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.task=tasks.id AND r.state='pending') ORDER BY created,rowid")) {
      if (active >= this.config.concurrency) break;
      const event = this.store.get("SELECT * FROM events WHERE task=? AND state='queued' ORDER BY created,rowid LIMIT 1", t.id);
      if (!event) continue;
      // Checked before every new worktree and every new turn; nothing external has happened yet, so the input simply stays queued.
      const guard = this.diskGuard();
      if (!guard.ok) { this.holdForDisk(t, event, guard); continue; }
      t = await this.provision(t) as Row;
      if (!t) continue;
      try {
        // A final report can arrive while the UI is still leaving its prior turn.
        const a = await this.backend.inspect(t);
        if (a.rebound) { this.adopt(t, a, 'rebind'); await this.pin(t, a.session); continue; }
        if (!a.ready || !['idle', 'done'].includes(a.status)) continue;
        const delivery = id('delivery');
        const dispatched = this.store.tx(() => {
          // A lifecycle request may have been recorded by another process since this pass read the task.
          const current = this.store.get('SELECT lifecycle,inflight FROM tasks WHERE id=?', t.id);
          if (current?.lifecycle !== 'open' || current.inflight || this.store.get("SELECT 1 FROM requests WHERE task=? AND state='pending'", t.id)) return false;
          const attempt = Number(this.store.get('SELECT count(*) n FROM deliveries WHERE event=?', event.id)!.n) + 1;
          this.store.run("INSERT INTO deliveries VALUES(?,?,?,'sending',?,NULL,?)", delivery, event.id, t.id, attempt, Date.now());
          this.store.run("UPDATE events SET state='sending',error=NULL WHERE id=?", event.id);
          this.store.run("UPDATE tasks SET inflight=?,status='active' WHERE id=?", event.id, t.id);
          return true;
        });
        if (!dispatched) continue;
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
      } catch (e: any) {
        if (e instanceof TransportUnavailable) { this.offline = e.message; break; }
        if (e instanceof WorkerAbsent) { this.absent(t, e.message); continue; }
        this.freeze(t, e.message);
      }
    }
    return this.offline ? { ...this.status(), transport: { ok: false, error: this.offline } } : this.status();
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
    if (t.lifecycle !== 'open') throw new Error(`Task is ${t.lifecycle}; recovery applies only to open tasks`);
    if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch mismatch; repair it before recovery');
    if (t.ref && t.ref !== ref) throw new Error('Recovery cannot replace a saved worker reference');
    if (t.session && t.session !== session) throw new Error('Recovery cannot replace a saved worker session');
    const a = await this.backend.inspect({ ...t, ref, session });
    // Preserve the task token and inflight event: adopting a verified same logical worker is not a new generation.
    this.store.run("UPDATE tasks SET ref=?,provision='started' WHERE id=?",ref,t.id);
    this.adopt({ ...t, ref }, a, 'manual-rebind');
    this.store.audit('manual-recover',t.id,null,{ref,session});
    await this.pin({ ...t, ref }, a.session);
  }
  openTask(taskId: string, request?: string) {
    const t = this.store.get('SELECT * FROM tasks WHERE id=?', taskId); if (!t) throw new Error('Unknown task');
    if (t.lifecycle !== 'open') throw new Error(`Task is ${t.lifecycle}; recovery applies only to open tasks`);
    const other = this.store.get("SELECT action FROM requests WHERE task=? AND state='pending' AND id IS NOT ?", t.id, request ?? null);
    if (other) throw new Error(`Task has a pending ${other.action} request`);
    return t;
  }
  // Re-verify a frozen task against its saved pane and native session (read-only), e.g. after a transport outage.
  async reverify(taskId: string, request?: string) {
    const t = this.openTask(taskId, request);
    if (!t.ref || !t.session) throw new Error('Task has no saved worker reference/session; use recover --task ID --ref JSON --session JSON');
    if (!['unknown', 'started'].includes(t.provision)) throw new Error(`Task provision is ${t.provision}; nothing to re-verify yet`);
    if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch mismatch; repair it before recovery');
    const a = await this.backend.inspect(t);
    this.store.run("UPDATE tasks SET provision='started' WHERE id=?", t.id);
    this.adopt(t, a, 'manual-rebind');
    this.store.audit('manual-reverify', t.id, null, { rebound: a.rebound });
    await this.pin(t, a.session);
    return { task: t.id, worker: a.rebound ? 'rebound' : 'verified' };
  }
  // Start the agent again on its saved native session: in the saved pane if it is our worktree's shell, or in a
  // new background workspace if the pane is gone. Refuses any pane occupied by another agent or session.
  async respawn(taskId: string, request?: string) {
    const t = this.openTask(taskId, request);
    if (!t.session) throw new Error('Task has no saved native session to resume; close it and start a new task');
    if (!['unknown', 'started'].includes(t.provision)) throw new Error(`Task provision is ${t.provision}; respawn applies to a started or frozen worker`);
    if (!(await this.worktreeValid(t))) throw new Error('Worktree/branch mismatch; repair it before recovery');
    const p = t.ref ? await this.backend.probe(t) : { pane: 'missing' as const };
    if (p.pane === 'agent') {
      if (p.session !== t.session) throw new Error(`Saved pane is occupied by ${p.agent} with ${p.session ? 'another session' : 'no reported session'}; Switchyard will not replace it. Inspect it yourself.`);
      return { ...(await this.reverify(taskId, request)), pane: 'running' };
    }
    if (p.pane === 'shell' && resolve(p.cwd) !== resolve(t.worktree)) throw new Error(`Saved pane is now in ${p.cwd}, not the task worktree; not starting an agent there`);
    // Write-ahead: an interrupted respawn is ambiguous and freezes like any interrupted launch.
    this.store.tx(() => { this.store.audit('respawn-start', t.id, t.inflight ?? null, { pane: p.pane }); this.interrupt(t.id, 'Worker was restarted on its saved session during this turn'); });
    let current = { ...t };
    try {
      if (p.pane === 'missing') {
        this.store.run("UPDATE tasks SET provision='creating',error=NULL WHERE id=?", t.id);
        const ref = await this.backend.create(current, this.store.dir);
        this.store.run("UPDATE tasks SET ref=?,provision='created' WHERE id=?", ref, t.id); current.ref = ref;
      }
      this.store.run("UPDATE tasks SET provision='starting',error=NULL WHERE id=?", t.id);
      await this.backend.resume(current);
      this.store.run("UPDATE tasks SET provision='started' WHERE id=?", t.id);
      const a = await this.settle(current);
      this.adopt(current, { ...a, rebound: true }, 'respawn', { pane: p.pane });
    } catch (e: any) { this.freeze(current, e.message); throw e; }
    await this.pin(current, t.session);
    return { task: t.id, worker: 'respawned', pane: p.pane === 'missing' ? 'created' : 'reused' };
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
    return { tasks: this.store.all('SELECT id,num,title,status,lifecycle,provision,branch,worktree,worker,ref,instance,session,inflight,error FROM tasks ORDER BY created,rowid'), events: this.store.all('SELECT id,text,target,task,state,route,reply,error FROM events ORDER BY created,rowid'), deliveries: this.store.all('SELECT * FROM deliveries ORDER BY created,rowid'), reports: this.store.all('SELECT id,task,event,outcome,summary,evidence,created FROM reports ORDER BY created,rowid'), requests: this.store.all('SELECT * FROM requests ORDER BY created,rowid').map(r => this.requestView(r)) };
  }
  diskGuard() {
    const minFree = Number(this.config.minFreeMb ?? DEFAULT_MIN_FREE_MB) * 1024 * 1024;
    const free = freeSpace([this.store.dir, join(this.store.dir, 'worktrees'), this.config.repo]);
    return { ok: minFree === 0 || free.bytes >= minFree, free: free.bytes, path: free.path, minFree };
  }
  holdForDisk(t: Row, event: Row, guard: Row) {
    // Stable text, so repeated passes neither rewrite the input nor flood the audit log.
    const message = `Disk guard: free space at ${guard.path} is below ${human(guard.minFree)}; input stays queued until space is freed`;
    if (event.error === message) return;
    this.store.tx(() => {
      this.store.run("UPDATE events SET error=? WHERE id=? AND state='queued'", message, event.id);
      this.store.audit('disk-guard', t.id, event.id, { free: guard.free, minFree: guard.minFree, path: guard.path });
    });
  }
  requestView(r: Row): Row { return { ...r, options: JSON.parse(r.options), result: r.result ? JSON.parse(r.result) : null }; }
  // Lifecycle changes are durable requests. Only the supervisor-lock holder executes them, so they never
  // race provisioning or dispatch; a CLI without a running supervisor takes the lock and executes directly.
  request(taskId: string, action: 'close' | 'drop' | 'recover' | 'respawn', options: Row): Row {
    return this.store.tx(() => {
      const t = this.store.get('SELECT * FROM tasks WHERE id=?', taskId);
      if (!t) throw new Error('Unknown task');
      const opts = JSON.stringify(options), pending = this.store.get("SELECT * FROM requests WHERE task=? AND state='pending'", taskId);
      if (pending) { if (pending.action === action && pending.options === opts) return pending; throw new Error(`Another ${pending.action} request is pending for this task`); }
      const key = id('request');
      this.store.run('INSERT INTO requests(id,task,action,options,created) VALUES(?,?,?,?,?)', key, taskId, action, opts, Date.now());
      this.store.audit('lifecycle-request', taskId, null, { id: key, action, options });
      return this.store.get('SELECT * FROM requests WHERE id=?', key)!;
    });
  }
  pending(ids: string[]) { return ids.some(key => this.store.get('SELECT state FROM requests WHERE id=?', key)?.state === 'pending'); }
  async applyRequests(ids?: string[]) {
    for (const r of this.store.all("SELECT * FROM requests WHERE state='pending' ORDER BY created,rowid")) if (!ids || ids.includes(r.id)) await this.applyRequest(r);
  }
  finish(r: Row, state: string, result: Row | null, error?: string) {
    this.store.run('UPDATE requests SET state=?,result=?,error=?,finished=? WHERE id=?', state, result ? JSON.stringify(result) : null, error ?? null, Date.now(), r.id);
  }
  // Read-only validation first; then the intent (closing/dropping) is persisted before any external effect.
  // A failure after that keeps the task out of scheduling, and rerunning the command resumes idempotently.
  async applyRequest(r: Row) {
    if (r.action === 'recover' || r.action === 'respawn') return this.applyRecovery(r);
    const o = JSON.parse(r.options), drop = r.action === 'drop', t = this.store.get('SELECT * FROM tasks WHERE id=?', r.task)!;
    let started = false;
    try {
      if (t.lifecycle === 'dropped' || (!drop && t.lifecycle === 'closed')) return this.finish(r, 'done', { action: r.action, task: t.id, already: t.lifecycle });
      if (!drop && t.lifecycle === 'dropping') throw new Error('Task is being dropped; rerun drop');
      const queued = Number(this.store.get("SELECT count(*) n FROM events WHERE task=? AND state='queued'", t.id)!.n);
      if ((t.inflight || queued) && !o.abandon) throw new Error(`${t.inflight ? 'Task has an active input turn' : `Task has ${queued} queued input(s)`}; wait for its final report or rerun with --abandon`);
      // 'closing'/'dropping' always mean teardown is unfinished; a closed task only has its branch left.
      const teardown = t.lifecycle !== 'closed', f = await this.facts(t, drop ? o.into : undefined);
      if (teardown && f.dirty && !o.discardChanges) throw new Error('Worktree has uncommitted or untracked changes; commit them or rerun with --discard-changes');
      if (teardown && f.stray && !o.discardChanges) throw new Error(`Unregistered directory remains at ${t.worktree}; inspect it or rerun with --discard-changes`);
      if (drop && f.sha && !f.merged && !o.discardUnmerged) throw new Error(`Branch ${t.branch} has commits not in ${String(o.into).slice(0, 12)}; merge it or rerun with --discard-unmerged`);
      if (drop && f.sha && f.checkedOut.length) throw new Error(`Branch ${t.branch} is checked out at ${f.checkedOut.join(', ')}`);
      if (teardown && t.ref) this.backend.preflight();
      const abandoned = this.store.tx(() => {
        let n = 0;
        if (o.abandon) {
          n = Number(this.store.run("UPDATE events SET state='abandoned',error=? WHERE task=? AND state IN ('queued','sending','sent','uncertain','acked')", `Abandoned by ${r.id}`, t.id).changes);
          this.store.run("UPDATE deliveries SET state='abandoned' WHERE task=? AND state IN ('sending','sent','uncertain')", t.id);
          if (t.inflight) this.store.run("UPDATE tasks SET inflight=NULL,status='abandoned' WHERE id=?", t.id);
        }
        if (teardown) this.store.run('UPDATE tasks SET lifecycle=?,error=NULL WHERE id=?', drop ? 'dropping' : 'closing', t.id);
        this.store.audit('lifecycle-start', t.id, null, { request: r.id, action: r.action, abandoned: n });
        return n;
      });
      started = true;
      const result: Row = { action: r.action, task: t.id, num: t.num, title: t.title, abandoned };
      if (teardown) {
        result.worker = t.ref ? await this.backend.close(t) : t.provision === 'unknown'
          ? { worker: 'unrecorded', detail: `No saved worker reference; close any Herdr workspace labelled ${t.worker} yourself` }
          : { worker: 'none' };
        result.reclaimed = await this.removeWorktree(t, !!o.discardChanges);
        result.reclaimedHuman = human(result.reclaimed);
        // Checkpoint: teardown is complete, so a resumed drop only has the (atomic) branch deletion left.
        if (drop) this.store.run("UPDATE tasks SET lifecycle='closed' WHERE id=? AND lifecycle='dropping'", t.id);
      }
      if (!drop) result.branch = { name: t.branch, kept: true };
      else if (!f.sha) result.branch = { name: t.branch, missing: true };
      else {
        // Compare-and-delete: refuses if the branch moved after validation.
        await command('git', ['-C', this.config.repo, 'update-ref', '-d', `refs/heads/${t.branch}`, f.sha]);
        result.branch = { name: t.branch, deleted: f.sha, restore: `git branch ${t.branch} ${f.sha}` };
      }
      this.store.tx(() => {
        this.store.run('UPDATE tasks SET lifecycle=?,error=NULL WHERE id=?', drop ? 'dropped' : 'closed', t.id);
        this.finish(r, 'done', result);
        this.store.audit(r.action, t.id, null, result);
      });
    } catch (e: any) {
      this.store.tx(() => {
        if (started) this.store.run('UPDATE tasks SET error=? WHERE id=?', e.message, t.id);
        this.finish(r, started ? 'failed' : 'rejected', null, e.message);
        this.store.audit(`${r.action}-${started ? 'failed' : 'rejected'}`, t.id, null, { request: r.id, error: e.message });
      });
    }
  }
  // recover/respawn requested while a supervisor runs: executed by that supervisor between passes.
  async applyRecovery(r: Row) {
    try { this.finish(r, 'done', r.action === 'respawn' ? await this.respawn(r.task, r.id) : await this.reverify(r.task, r.id)); }
    catch (e: any) { this.finish(r, 'failed', null, e.message); this.store.audit(`${r.action}-failed`, r.task, null, { request: r.id, error: e.message }); }
  }
  async facts(t: Row, into?: string, list?: Worktree[]): Promise<Facts> {
    list ??= await worktrees(this.config.repo);
    const entry = list.find(w => w.path === t.worktree), exists = existsSync(t.worktree);
    const sha = await commitOf(this.config.repo, `refs/heads/${t.branch}`);
    return {
      registered: !!entry, exists, stray: !entry && exists,
      dirty: !!entry && exists && await dirty(t.worktree),
      sha, merged: sha && into ? await merged(this.config.repo, sha, into) : null,
      checkedOut: list.filter(w => w.branch === `refs/heads/${t.branch}` && w.path !== t.worktree).map(w => w.path),
    };
  }
  async removeWorktree(t: Row, discard: boolean): Promise<number> {
    const entry = (await worktrees(this.config.repo)).find(w => w.path === t.worktree), exists = existsSync(t.worktree);
    const bytes = exists ? usage(t.worktree).bytes : 0;
    // Without --force Git itself refuses modified/untracked files; ignored build output is removed.
    if (entry) await command('git', ['-C', this.config.repo, 'worktree', 'remove', ...(discard && exists ? ['--force'] : []), t.worktree], { timeout: Math.max(this.config.timeout, 600000) });
    else if (exists) {
      if (!discard || !resolve(t.worktree).startsWith(join(this.store.dir, 'worktrees') + sep)) throw new Error(`Refusing to delete unregistered directory ${t.worktree}`);
      rmSync(t.worktree, { recursive: true, force: true });
    }
    return bytes;
  }
  async resolveInto(ref = 'HEAD') { const sha = await commitOf(this.config.repo, ref); if (!sha) throw new Error(`Unknown commit ${ref}`); return sha; }
  // Why gc --merged must keep a task (null: collectable). Blocked tasks wait for the user and are kept.
  async gcVerdict(t: Row, into: string, list: Worktree[]): Promise<{ reason: string | null; facts?: Facts }> {
    if (t.lifecycle === 'dropped') return { reason: 'dropped' };
    if (['closing', 'dropping'].includes(t.lifecycle)) return { reason: `interrupted ${t.lifecycle}; rerun close or drop` };
    if (this.store.get("SELECT 1 FROM requests WHERE task=? AND state='pending'", t.id)) return { reason: 'lifecycle request pending' };
    if (t.inflight) return { reason: 'active input turn' };
    if (this.store.get("SELECT 1 FROM events WHERE task=? AND state='queued'", t.id)) return { reason: 'queued input' };
    if (t.status === 'blocked') return { reason: 'blocked: waiting for you' };
    let facts: Facts;
    try { facts = await this.facts(t, into, list); } catch (e: any) { return { reason: `inspection failed: ${e.message}` }; }
    if (facts.stray) return { reason: 'unregistered directory at worktree path', facts };
    if (facts.dirty) return { reason: 'uncommitted changes', facts };
    if (!facts.sha) return { reason: 'branch missing', facts };
    if (!facts.merged) return { reason: 'not merged', facts };
    if (facts.checkedOut.length) return { reason: `branch checked out at ${facts.checkedOut.join(', ')}`, facts };
    return { reason: null, facts };
  }
  async gcPlan(into: string) {
    const list = await worktrees(this.config.repo), eligible: Row[] = [], skipped: Row[] = [];
    for (const t of this.store.all("SELECT * FROM tasks WHERE lifecycle!='dropped' ORDER BY created,rowid")) {
      const v = await this.gcVerdict(t, into, list);
      if (v.reason) { skipped.push({ task: t.id, num: t.num, title: t.title, reason: v.reason }); continue; }
      const bytes = v.facts!.exists ? usage(t.worktree).bytes : 0;
      eligible.push({ task: t.id, num: t.num, title: t.title, branch: t.branch, sha: v.facts!.sha, bytes, human: human(bytes) });
    }
    return { into, eligible, skipped };
  }
  async du(taskId?: string) {
    const list = await worktrees(this.config.repo), head = await this.resolveInto('HEAD'), guard = this.diskGuard();
    const tasks = this.store.all('SELECT * FROM tasks ORDER BY created,rowid').filter(t => taskId ? t.id === taskId : t.lifecycle !== 'dropped');
    if (taskId && !tasks.length) throw new Error('Unknown task');
    const rows: Row[] = [];
    for (const t of tasks) {
      const v = await this.gcVerdict(t, head, list), f = v.facts ?? await this.facts(t, head, list).catch(() => undefined);
      const exists = existsSync(t.worktree), u = exists ? usage(t.worktree) : { bytes: 0, files: 0 };
      rows.push({ id: t.id, num: t.num, title: t.title, lifecycle: t.lifecycle, status: t.status, worktree: t.worktree, exists, bytes: u.bytes, human: human(u.bytes), files: u.files,
        dirty: f?.dirty ?? null, branch: t.branch, branchExists: f ? !!f.sha : null, mergedIntoHead: f?.merged ?? null, gc: v.reason ? `kept: ${v.reason}` : 'reclaimable' });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    const sum = (xs: Row[]) => xs.reduce((n, r) => n + r.bytes, 0), collectable = rows.filter(r => r.gc === 'reclaimable');
    const database = ['state.db', 'state.db-wal', 'state.db-shm'].reduce((n, name) => { try { return n + statSync(join(this.store.dir, name)).size; } catch { return n; } }, 0);
    return {
      free: { bytes: guard.free, human: human(guard.free), path: guard.path },
      guard: { minFree: guard.minFree, human: human(guard.minFree), ok: guard.ok },
      database: { bytes: database, human: human(database) },
      worktrees: { count: rows.filter(r => r.exists).length, bytes: sum(rows), human: human(sum(rows)) },
      gcMerged: { into: 'HEAD', tasks: collectable.length, bytes: sum(collectable), human: human(sum(collectable)) },
      tasks: rows,
    };
  }
}
