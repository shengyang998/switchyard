// Human-facing read models and text rendering. Read-only: nothing here changes state or talks to a transport.
import type { Row, Store } from './store.js';

export type Bucket = 'needs-you' | 'in-progress' | 'review' | 'failed' | 'closed';
export const BUCKETS: [Bucket, string][] = [['needs-you', 'Needs you'], ['in-progress', 'In progress'], ['review', 'Ready for review'], ['failed', 'Failed']];
export type TaskView = { id: string; num: number; ref: string; title: string; bucket: Bucket; why: string; next: string | null; since: number };

const first = (text: string, n = 80) => { const line = String(text ?? '').split('\n').find(l => l.trim()) ?? ''; return line.length > n ? `${line.slice(0, n - 1)}…` : line; };
export const tag = (t: Row) => `#${t.num}`;
// Generated IDs shortened for reading; commands that need the full ID are printed in full.
export const short = (key: string) => String(key).replace(/^([a-z]+_[0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '$1…');

// Shorter wording for engine errors that have a dedicated next step.
const reason = (error: string) => /^No agent in worker pane/.test(error) ? 'worker exited; its session is saved' : first(error);

// One state per task, in the order a human has to act on it.
export function classify(store: Store, t: Row): TaskView {
  const base = { id: t.id, num: t.num, ref: tag(t), title: t.title };
  const last = store.get('SELECT * FROM reports WHERE task=? ORDER BY created DESC,rowid DESC LIMIT 1', t.id);
  const final = store.get("SELECT * FROM reports WHERE task=? AND outcome IN ('ready','blocked','failed') ORDER BY created DESC,rowid DESC LIMIT 1", t.id);
  const since = Math.max(t.created, last?.created ?? 0);
  const view = (bucket: Bucket, why: string, next: string | null = null): TaskView => ({ ...base, bucket, why, next, since });
  if (t.lifecycle === 'closed' || t.lifecycle === 'dropped') return view('closed', t.lifecycle);
  const request = store.get("SELECT action FROM requests WHERE task=? AND state='pending'", t.id);
  if (request) return view('in-progress', `${request.action} requested`);
  if (t.lifecycle !== 'open') {
    const verb = t.lifecycle === 'dropping' ? 'drop' : 'close';
    return view('needs-you', `${verb} unfinished${t.error ? `: ${first(t.error)}` : ''}`, `sy ${verb} ${t.num}`);
  }
  if (t.provision === 'unknown') return view('needs-you', `frozen: ${first(t.error)}`, `sy show ${t.num}`);
  const uncertain = store.get("SELECT id FROM events WHERE task=? AND state='uncertain' ORDER BY created LIMIT 1", t.id);
  if (uncertain) return view('needs-you', `unsure whether the worker got input ${short(uncertain.id)}`, `sy show ${t.num}`);
  if (t.error && /has not reported its native session yet/.test(t.error)) return view('in-progress', 'worker restarting');
  if (t.error) return view('needs-you', reason(t.error), /--respawn/.test(t.error) ? `sy recover ${t.num} --respawn` : `sy show ${t.num}`);
  const held = store.get("SELECT error FROM events WHERE task=? AND state='queued' AND error IS NOT NULL LIMIT 1", t.id);
  if (held) return view('needs-you', first(held.error), 'sy du');
  const queued = Number(store.get("SELECT count(*) n FROM events WHERE task=? AND state='queued'", t.id)!.n);
  if (t.inflight) return view('in-progress', last && last.event === t.inflight ? `${last.outcome}: ${first(last.summary)}` : 'sent; waiting for the worker to acknowledge');
  if (queued) return view('in-progress', t.provision === 'started' ? `${queued} input(s) queued` : 'starting a worker');
  if (final?.outcome === 'blocked') return view('needs-you', `blocked: ${first(final.summary)}`, `sy "#${t.num} <answer>"`);
  if (final?.outcome === 'ready') return view('review', first(final.summary), `sy diff ${t.num}`);
  if (final?.outcome === 'failed') return view('failed', first(final.summary), `sy show ${t.num}`);
  return view('in-progress', 'waiting');
}

export function inbox(store: Store, supervisor: Row | null) {
  const tasks = store.all('SELECT * FROM tasks ORDER BY num').map(t => classify(store, t));
  const latest = store.get('SELECT id FROM events ORDER BY created DESC,rowid DESC LIMIT 1');
  const replies = store.all("SELECT id,text,reply,created FROM events WHERE state='replied' ORDER BY created,rowid").filter(e => e.id === latest?.id);
  return {
    supervisor: supervisor ? { pid: supervisor.pid, since: supervisor.started } : null,
    groups: Object.fromEntries(BUCKETS.map(([b]) => [b, tasks.filter(t => t.bucket === b)])) as Record<Bucket, TaskView[]>,
    closed: tasks.filter(t => t.bucket === 'closed').length,
    inputs: {
      pending: Number(store.get("SELECT count(*) n FROM events WHERE state='pending'")!.n),
      routeErrors: store.all("SELECT id,text,error,created FROM events WHERE state='route-error' ORDER BY created,rowid"),
      replies,
    },
  };
}

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
// Truncate to the terminal; piped text keeps more of each line.
const width = () => process.stdout.isTTY ? Math.max(60, Math.min(process.stdout.columns || 100, 160)) : 160;

export function renderInbox(x: ReturnType<typeof inbox>, repo: string) {
  const out = [`Switchyard · ${repo} · ${x.supervisor ? `supervisor running (pid ${x.supervisor.pid})` : 'supervisor not running: start it with `sy up` in a Herdr pane'}`];
  const w = width();
  if (x.inputs.replies.length) out.push('', 'Router', ...x.inputs.replies.map(e => `  ${first(e.reply, w - 4)}`));
  for (const [bucket, label] of BUCKETS) {
    const rows = x.groups[bucket].map(t => {
      const head = `  ${pad(t.ref, 5)} ${pad(t.title, 26)} ${ago(t.since).padStart(3)}  `, hint = t.next ? `  → ${t.next}` : '';
      return head + first(t.why, Math.max(20, w - head.length - hint.length)) + hint;
    });
    if (bucket === 'needs-you') for (const e of x.inputs.routeErrors) rows.push(`  input "${first(e.text, 30)}" was not routed: ${first(e.error, 50)}  → sy retry-route --event ${e.id}`);
    if (rows.length) out.push('', label, ...rows);
  }
  const open = BUCKETS.some(([b]) => x.groups[b].length) || x.inputs.routeErrors.length;
  if (x.inputs.pending) out.push('', `${x.inputs.pending} input(s) waiting to be routed${x.supervisor ? '' : '; start `sy up`'}`);
  if (!open && !x.inputs.pending) out.push('', 'No open tasks. Send work with: sy "describe the change"');
  if (x.closed) out.push('', `${x.closed} closed task(s) not shown`);
  return out.join('\n');
}

// Everything known about one task, oldest first.
export function detail(store: Store, taskId: string) {
  const t = store.get('SELECT * FROM tasks WHERE id=?', taskId)!;
  const v = classify(store, t), timeline: Row[] = [];
  for (const e of store.all('SELECT * FROM events WHERE task=? ORDER BY created,rowid', t.id)) timeline.push({ at: e.created, kind: 'input', event: e.id, text: e.text, state: e.state, error: e.error });
  for (const d of store.all('SELECT * FROM deliveries WHERE task=? ORDER BY created,rowid', t.id)) timeline.push({ at: d.created, kind: 'delivery', event: d.event, attempt: d.attempt, state: d.state });
  for (const r of store.all('SELECT * FROM reports WHERE task=? ORDER BY created,rowid', t.id)) timeline.push({ at: r.created, kind: r.outcome, event: r.event, summary: r.summary, evidence: r.evidence });
  for (const a of store.all("SELECT * FROM audit WHERE task=? AND kind NOT IN ('routed','report') ORDER BY seq", t.id)) timeline.push({ at: a.created, kind: `audit:${a.kind}`, event: a.event, detail: JSON.parse(a.detail) });
  timeline.sort((a, b) => a.at - b.at);
  const ref = t.ref ? JSON.parse(t.ref) : null, session = t.session ? JSON.parse(t.session) : null;
  return {
    task: { id: t.id, num: t.num, title: t.title, lifecycle: t.lifecycle, provision: t.provision, status: t.status, branch: t.branch, worktree: t.worktree, pane: ref?.pane ?? null, session: session?.value ?? null, agent: session?.agent ?? null, inflight: t.inflight, error: t.error },
    bucket: v.bucket, why: v.why, next: nextSteps(store, t, v), timeline,
  };
}

function nextSteps(store: Store, t: Row, v: TaskView): string[] {
  const n = t.num, uncertain = store.get("SELECT id FROM events WHERE task=? AND state='uncertain' LIMIT 1", t.id);
  if (v.bucket === 'closed') return t.lifecycle === 'closed' ? [`branch ${t.branch} kept; merge it, then \`sy gc --merged\`, or \`sy drop ${n} --discard-unmerged\``] : [];
  if (t.lifecycle !== 'open') return [`sy ${t.lifecycle === 'dropping' ? 'drop' : 'close'} ${n}   resume the unfinished ${t.lifecycle.replace(/ing$/, '')}`];
  if (t.provision === 'unknown') return [`inspect the Herdr pane${t.ref ? ` ${JSON.parse(t.ref).pane}` : ''}, then:`, `sy recover ${n}   re-verify against the saved pane and session`, `sy recover ${n} --respawn   resume the saved session if the agent is gone`];
  if (uncertain) return [`look at the worker pane: did it receive input ${uncertain.id}?`, `sy resolve --event ${uncertain.id} --action delivered   it did; wait for its report`, `sy resolve --event ${uncertain.id} --action retry   it did not; send it again`];
  if (t.error && /--respawn/.test(t.error)) return [`sy recover ${n} --respawn   resume the saved session`];
  if (v.bucket === 'needs-you' && /^blocked/.test(v.why)) return [`sy "#${n} <your answer>"   reply to the worker`];
  if (v.bucket === 'review') return [`sy diff ${n}   review the change`, `sy "#${n} <feedback>"   ask for changes`, `merge ${t.branch} yourself, then \`sy gc --merged\`; or \`sy close ${n}\` to keep only the branch`];
  if (v.bucket === 'failed') return [`sy "#${n} <instructions>"   try again in the same worker`, `sy drop ${n} --discard-unmerged   give up and remove everything`];
  return [];
}

export function renderDetail(x: ReturnType<typeof detail>) {
  const t = x.task, out = [`#${t.num} ${t.title}  [${BUCKETS.find(([b]) => b === x.bucket)?.[1] ?? x.bucket}] ${x.why}`];
  out.push(`  id       ${t.id}`, `  branch   ${t.branch}`, `  worktree ${t.worktree}`);
  out.push(`  worker   ${t.agent ?? 'agent'} in pane ${t.pane ?? '(none yet)'}${t.session ? `, session ${t.session}` : ''}`);
  out.push(`  state    lifecycle ${t.lifecycle}, provision ${t.provision}${t.inflight ? `, turn ${short(t.inflight)} in flight` : ''}`);
  if (t.error) out.push(`  error    ${t.error}`);
  out.push('', 'Timeline');
  for (const e of x.timeline) {
    const time = new Date(e.at).toTimeString().slice(0, 8);
    if (e.kind === 'input') out.push(`  ${time}  input     ${short(e.event)}: "${first(e.text, 70)}" (${e.state}${e.error ? `: ${first(e.error, 50)}` : ''})`);
    else if (e.kind === 'delivery') out.push(`  ${time}  delivery  ${short(e.event)} attempt ${e.attempt}: ${e.state}`);
    else if (e.kind.startsWith('audit:')) out.push(`  ${time}  ${e.kind.slice(6).padEnd(9)} ${first(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail), 90)}`);
    else out.push(`  ${time}  ${e.kind.padEnd(9)} ${first(e.summary, 90)}${e.evidence && !['ack', 'progress'].includes(e.kind) ? `\n                      evidence: ${first(e.evidence, 80)}` : ''}`);
  }
  if (x.next.length) {
    // Steps are "command   what it does"; align the descriptions however long the task number is.
    const rows = x.next.map(s => s.match(/^(.*?\S)\s{3,}(\S.*)$/)?.slice(1) ?? [s, '']), w = Math.max(...rows.filter(r => r[1]).map(r => r[0].length), 0);
    out.push('', 'Next', ...rows.map(([c, d]) => d ? `  ${c.padEnd(w)}   ${d}` : `  ${c}`));
  }
  return out.join('\n');
}

// What happened to one submitted input, for immediate feedback.
export function inputView(store: Store, eventId: string, supervisor: Row | null) {
  const e = store.get('SELECT * FROM events WHERE id=?', eventId)!;
  const t = e.task ? store.get('SELECT * FROM tasks WHERE id=?', e.task) : null;
  const route = e.route ? JSON.parse(e.route) : null;
  return { input: e.id, state: e.state, action: route?.action ?? null, task: t ? { id: t.id, num: t.num, title: t.title, busy: !!t.inflight && t.inflight !== e.id } : null, reply: e.reply ?? null, error: e.error ?? null, supervisor: !!supervisor };
}

export function renderInput(x: ReturnType<typeof inputView>) {
  const later = x.supervisor ? '' : '; start workers with `sy up`';
  if (x.state === 'pending') return `Recorded input ${x.input}; the supervisor will route it${later}`;
  if (x.state === 'route-error') return `Could not route input ${x.input}: ${x.error}\nFix the router, then: sy retry-route --event ${x.input}`;
  if (x.state === 'replied') return `Router: ${x.reply}`;
  const t = x.task!;
  if (x.action === 'new') return `→ new task #${t.num} "${t.title}"${later}`;
  return `→ #${t.num} "${t.title}": ${t.busy ? 'delivered after its current turn' : 'queued for the worker'}${later}`;
}

// Supervisor log lines: one line per change a human cares about.
export function snapshot(store: Store) {
  const tasks = new Map(store.all('SELECT * FROM tasks').map(t => { const v = classify(store, t); return [t.id, v]; }));
  const inputs = new Map(store.all('SELECT id,state FROM events').map(e => [e.id, e.state]));
  return { tasks, inputs };
}
export function changes(store: Store, before: ReturnType<typeof snapshot> | null, after: ReturnType<typeof snapshot>) {
  const lines: { text: string; notify: TaskView | null }[] = [];
  for (const [id, v] of after.tasks) {
    const old = before?.tasks.get(id);
    if (old && old.bucket === v.bucket && old.why === v.why) continue;
    if (!before && v.bucket === 'closed') continue;
    const label = BUCKETS.find(([b]) => b === v.bucket)?.[1] ?? v.bucket;
    const alert = ['needs-you', 'review', 'failed'].includes(v.bucket) && old?.bucket !== v.bucket;
    lines.push({ text: `${v.ref} ${v.title}: ${label.toLowerCase()} · ${v.why}${v.next && alert ? `  → ${v.next}` : ''}`, notify: before && alert ? v : null });
  }
  for (const [id, state] of before ? after.inputs : []) {
    if (before!.inputs.get(id) === state) continue;
    if (state === 'replied' || state === 'route-error') {
      const x = inputView(store, id, null);
      lines.push({ text: state === 'replied' ? `Router: ${x.reply}` : `input ${id} could not be routed: ${x.error}`, notify: null });
    }
  }
  return lines;
}

// Disk report: free space first, then the biggest worktrees.
export function renderDu(x: Row) {
  const out = [`Free ${x.free.human} at ${x.free.path}; disk guard ${x.guard.minFree ? `${x.guard.human}: ${x.guard.ok ? 'ok' : 'NEW WORK IS HELD'}` : 'off'}`];
  out.push(`${x.worktrees.count} worktree(s), ${x.worktrees.human}; state database ${x.database.human}`);
  out.push(x.gcMerged.tasks ? `sy gc --merged would reclaim ${x.gcMerged.human} from ${x.gcMerged.tasks} merged task(s)` : 'sy gc --merged has nothing to reclaim yet (no clean task merged into HEAD)');
  if (x.tasks.length) out.push('');
  for (const t of x.tasks) out.push(`  ${pad(`#${t.num}`, 5)} ${pad(t.title, 26)} ${(t.exists ? t.human : '-').padStart(9)}  ${t.lifecycle}${t.dirty ? ', uncommitted changes' : ''}  ${t.gc}`);
  return out.join('\n');
}
const label = (r: Row) => `#${r.num} "${r.title}"`;
export function renderLifecycle(r: Row) {
  const verb = r.action === 'drop' ? 'Dropped' : 'Closed';
  if (r.already) return `${label(r)} was already ${r.already}`;
  const w = r.worker?.worker ?? r.worker, parts: string[] = [];
  if (w) parts.push(w === 'closed' ? 'worker pane closed' : w === 'none' ? 'no worker pane' : w === 'absent' ? 'worker pane already gone' : `worker pane ${w}${r.worker?.detail ? ` (${r.worker.detail})` : ''}`);
  if (r.reclaimed !== undefined) parts.push(`worktree removed (${r.reclaimedHuman} reclaimed)`);
  if (r.abandoned) parts.push(`${r.abandoned} input(s) abandoned`);
  const b = r.branch ?? {};
  parts.push(b.kept ? `branch ${b.name} kept` : b.deleted ? `branch ${b.name} deleted; restore with: ${b.restore}` : `branch ${b.name} was already gone`);
  return `${verb} ${label(r)}: ${parts.join('; ')}`;
}
export function renderGc(x: Row) {
  const out: string[] = [];
  if (x.dryRun) out.push(x.eligible.length ? `Would drop ${x.eligible.length} task(s):` : 'Nothing to drop.', ...x.eligible.map((r: Row) => `  ${label(r)}  ${r.human}  ${r.branch}`));
  else {
    out.push(x.dropped.length ? `Dropped ${x.dropped.length} task(s):` : 'Nothing dropped.', ...x.dropped.map((r: Row) => `  ${renderLifecycle(r)}`));
    for (const f of x.failed) out.push(`  failed ${f.task}: ${f.error}`);
    if (x.pending.length) out.push(`  ${x.pending.length} request(s) still pending with the supervisor`);
  }
  if (x.skipped.length) out.push('Kept:', ...x.skipped.map((r: Row) => `  ${label(r)}  ${r.reason}`));
  return out.join('\n');
}
