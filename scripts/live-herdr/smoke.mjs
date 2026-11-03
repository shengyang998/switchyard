#!/usr/bin/env node
// Opt-in live smoke test against a real Herdr server. Never part of `npm test`.
//
//   HERDR_BIN=/path/to/herdr npm run smoke:herdr
//   SMOKE_KEEP=1 keeps the scratch directory; SMOKE_HOLD=1 also leaves a failed run's Herdr session running.
//
// Everything is isolated: a scratch HOME, a named Herdr session, a scratch Git repo with hooks disabled,
// the offline command router, and a deterministic stand-in agent (agent.mjs) that Herdr detects as `codex`.
// No model, account or network is used. The test drives the real Herdr socket API through:
//   1. two new tasks and a follow-up, end to end
//   2. a Herdr server restart while `serve` keeps running and one turn is in flight; Herdr must resume
//      each worker on its saved session with the configured arguments (the pinned resume command)
//   3. an agent exit, `recover --respawn` on the saved native session, and a follow-up to it
//   4. close, a merge, and gc --merged
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url)), repoRoot = resolve(here, '..', '..');
const herdrBin = process.env.HERDR_BIN;
if (!herdrBin || !existsSync(herdrBin)) { console.error('Set HERDR_BIN to a Herdr 0.9+ binary. This test starts its own named session.'); process.exit(2); }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'switchyard-smoke-')));
const home = join(root, 'home'), bin = join(root, 'bin'), repo = join(root, 'repo'), state = join(root, 'state'), agentLog = join(root, 'agent.log'), serveLog = join(root, 'serve.log');
const session = `sy-smoke-${process.pid}`, cli = join(repoRoot, 'dist', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observations = [];
const step = (m) => console.log(`ok - ${m}`);
const note = (m) => { observations.push(m); console.log(`# ${m}`); };
function check(condition, message, detail) { if (!condition) throw new Error(`${message}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 1)}`}`); }

// A `codex` on the server PATH: a shell wrapper exec'ing a symlink to node named codex, so Herdr's process
// detection sees `codex` while the stand-in agent runs.
mkdirSync(home); mkdirSync(join(bin, '.real'), { recursive: true });
symlinkSync(process.execPath, join(bin, '.real', 'codex'));
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${join(bin, '.real', 'codex')}" "${join(here, 'agent.mjs')}" "$@"\n`); chmodSync(join(bin, 'codex'), 0o755);
// Switchyard's transport executable: the real Herdr CLI pinned to the scratch HOME and session.
writeFileSync(join(bin, 'herdr'), `#!/bin/sh\nHOME="${home}" exec "${resolve(herdrBin)}" --session ${session} "$@"\n`); chmodSync(join(bin, 'herdr'), 0o755);
const serverEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SMOKE_AGENT_LOG: agentLog };
const herdr = (...args) => JSON.parse(execFileSync(join(bin, 'herdr'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null');
const herdrError = (...args) => { try { herdr(...args); return null; } catch (e) { return String(e.stderr); } };

async function startServer() {
  spawn(herdrBin, ['--session', session, 'server'], { env: serverEnv, detached: true, stdio: 'ignore' }).unref();
  await waitFor('Herdr server', () => herdr('workspace', 'list'), 20000);
}
function stopServer() { execFileSync(herdrBin, ['session', 'stop', session], { env: serverEnv, stdio: 'ignore' }); }

// Switchyard outside Herdr: HERDR_ENV=1 stands in for running inside a managed pane.
const syEnv = { ...process.env, HERDR_ENV: '1' };
function sy(...args) {
  try { return JSON.parse(execFileSync(process.execPath, [cli, '--state', state, ...args], { env: syEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { throw new Error(`switchyard ${args.join(' ')} failed: ${e.stderr || e.message}`); }
}
let serve = null;
function startServe() {
  serve = spawn(process.execPath, [cli, '--state', state, 'serve', '--interval', '400'], { env: syEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  serve.stdout.on('data', (d) => appendFileSync(serveLog, d)); serve.stderr.on('data', (d) => appendFileSync(serveLog, d));
}
async function stopServe() { if (!serve) return; const s = serve; serve = null; if (s.exitCode === null) { s.kill('SIGTERM'); await new Promise((r) => s.once('exit', r)); } }

async function waitFor(what, fn, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    let value; try { value = fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}
const status = () => sy('status');
const audits = (kind, task) => sy('history').filter((a) => a.kind === kind && (!task || a.task === task));
const taskOf = (eventId) => { const s = status(), e = s.events.find((x) => x.id === eventId); return e?.task && s.tasks.find((t) => t.id === e.task); };
const final = (eventId, outcome = 'ready') => status().reports.find((r) => r.event === eventId && r.outcome === outcome);
const pane = (t) => JSON.parse(t.ref).pane;
const sessionId = (t) => JSON.parse(t.session).value;
const starts = (p) => readFileSync(agentLog, 'utf8').split('\n').filter((l) => l.includes(` ${p} `) && l.includes(' start argv='));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', ...args], { encoding: 'utf8' }).trim();

let failed = false;
try {
  console.log(`# scratch ${root}, Herdr session ${session}`);
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'core.hooksPath', '/dev/null'); git(repo, 'config', 'commit.gpgSign', 'false');
  writeFileSync(join(repo, 'README.md'), 'smoke\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  await startServer();
  sy('init', '--repo', repo, '--router-command', JSON.stringify([process.execPath, join(repoRoot, 'test', 'fake-router.mjs')]), '--worker-kind', 'codex', '--herdr', join(bin, 'herdr'), '--min-free-mb', '0');
  const db = new DatabaseSync(join(state, 'state.db'));
  const workerArgs = JSON.parse(db.prepare("SELECT value FROM config WHERE key='worker'").get().value).args; db.close();
  startServe();

  // 1. New tasks and a follow-up on the real transport.
  sy('submit', 'Alpha', '--id', 'e-alpha'); sy('submit', 'Beta', '--id', 'e-beta');
  await waitFor('both first turns ready', () => final('e-alpha') && final('e-beta'));
  let alpha = taskOf('e-alpha'), beta = taskOf('e-beta');
  check(pane(alpha) !== pane(beta), 'tasks share a pane', [alpha, beta]);
  sy('submit', 'first follow-up', '--task', alpha.id, '--id', 'e-alpha-2');
  await waitFor('follow-up ready', () => final('e-alpha-2'));
  check(git(alpha.worktree, 'rev-list', '--count', `main..${alpha.branch}`) === '2', 'alpha should have two worker commits');
  step('two tasks and a follow-up completed through real Herdr panes');

  // 2. Herdr restart while serve keeps running and Beta's turn is in flight.
  sy('submit', 'SLOW in-flight work', '--task', beta.id, '--id', 'e-beta-slow');
  await waitFor('slow turn acknowledged', () => final('e-beta-slow', 'ack'));
  stopServer();
  await waitFor('serve to notice the outage', () => audits('transport-offline').length, 20000);
  await sleep(1500);
  check(status().tasks.every((t) => t.provision === 'started'), 'outage froze a task', status().tasks);
  step('Herdr stopped: serve waits; no task frozen');
  await startServer();
  await waitFor('both workers rebound on new terminals', () => { const s = status(); return [alpha, beta].every((t) => { const x = s.tasks.find((y) => y.id === t.id); return x.instance !== t.instance && !x.error; }); }, 120000);
  const restored = status(); alpha = restored.tasks.find((t) => t.id === alpha.id); beta = restored.tasks.find((t) => t.id === beta.id);
  check(alpha.provision === 'started' && beta.provision === 'started', 'restart froze a task', restored.tasks);
  check(alpha.session === taskOf('e-alpha').session, 'session changed');
  const slow = restored.events.find((e) => e.id === 'e-beta-slow');
  check(slow.state === 'uncertain' && !final('e-beta-slow'), 'in-flight turn should be uncertain, not completed or resent', slow);
  check(restored.deliveries.filter((d) => d.event === 'e-beta-slow').length === 1, 'in-flight turn was resent');
  const path = audits('worker-absent', beta.id).length ? 'agent seen absent, then rebound' : 'rebound directly';
  note(`restart: ${audits('rebind').length} rebind audit(s); Beta ${path}`);
  // Herdr reports the persisted agent identity at once; the resumed process starts a moment later.
  // Switchyard pinned each pane's resume command, so Herdr resumes the session with the configured arguments.
  const resumed = JSON.stringify(['resume', sessionId(beta), ...workerArgs]);
  const restoreArgv = await waitFor('Herdr to resume the saved session', () => starts(pane(beta)).find((l) => l.includes('"resume"')), 30000);
  check(restoreArgv.includes(`argv=${resumed} `), 'Herdr restore should use the pinned resume command', restoreArgv);
  note(`Herdr restore argv: ${restoreArgv.split('argv=')[1].split(' cwd=')[0]}`);
  step('Herdr restarted: same panes and sessions rebound automatically; in-flight turn marked uncertain, not resent');

  sy('submit', 'after restart', '--task', alpha.id, '--id', 'e-alpha-3');
  await waitFor('follow-up to the restored worker', () => final('e-alpha-3'));
  await stopServe(); sy('resolve', '--event', 'e-beta-slow', '--action', 'retry'); startServe();
  await waitFor('operator-approved retry of the interrupted turn', () => final('e-beta-slow'));
  step('restored worker took a follow-up; interrupted turn completed after explicit retry');

  // 3. Agent exits in its pane; respawn resumes the saved native session there.
  herdr('pane', 'send-keys', pane(alpha), 'ctrl+c');
  await waitFor('Alpha shown as absent', () => /No agent in worker pane/.test(status().tasks.find((t) => t.id === alpha.id).error ?? ''), 30000);
  check(status().tasks.find((t) => t.id === alpha.id).provision === 'started', 'agent exit froze the task');
  await stopServe();
  const respawn = sy('recover', '--task', alpha.id, '--respawn');
  check(respawn.recovered?.worker === 'respawned' && respawn.recovered.pane === 'reused', 'respawn result', respawn.recovered);
  const respawnArgv = starts(pane(alpha)).at(-1);
  check(respawnArgv.includes(JSON.stringify(['resume', sessionId(alpha), ...workerArgs])), 'respawn argv should be resume + configured args', respawnArgv);
  startServe();
  sy('submit', 'after respawn', '--task', alpha.id, '--id', 'e-alpha-4');
  await waitFor('follow-up to the respawned worker', () => final('e-alpha-4'));
  step('agent exit paused the task; respawn resumed its saved session with the configured args; follow-up completed');

  // 4. Reclaim: close Beta, merge Alpha and collect it.
  const closed = sy('close', '--task', beta.id);
  check(closed.worker?.worker === 'closed' && !existsSync(beta.worktree), 'close', closed);
  check(/pane_not_found/.test(herdrError('pane', 'get', pane(beta)) ?? ''), 'Beta pane still open');
  git(repo, 'merge', '-q', '--no-edit', alpha.branch);
  const gc = sy('gc', '--merged');
  check(gc.dropped.length === 1 && gc.dropped[0].task === alpha.id && !existsSync(alpha.worktree), 'gc --merged', gc);
  check(/pane_not_found/.test(herdrError('pane', 'get', pane(alpha)) ?? ''), 'Alpha pane still open');
  step('close and gc --merged closed the panes and removed the worktrees');
  const frozen = audits('uncertain');
  check(frozen.length === 0, 'unexpected freezes', frozen);
} catch (e) {
  failed = true; console.error(`not ok - ${e.message}`);
  console.error(`# kept ${root} (serve.log, agent.log, state/) for inspection`);
} finally {
  await stopServe();
  // SMOKE_HOLD=1 leaves a failed run's Herdr session up for inspection through the scratch bin/herdr wrapper.
  if (failed && process.env.SMOKE_HOLD) console.error(`# Herdr session left running: ${join(bin, 'herdr')} workspace list`);
  else {
    try { stopServer(); } catch {}
    try { execFileSync(herdrBin, ['session', 'delete', session], { env: serverEnv, stdio: 'ignore' }); } catch {}
  }
  if (!failed && !process.env.SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
}
if (observations.length) console.log(`# observations:\n${observations.map((o) => `#   ${o}`).join('\n')}`);
process.exit(failed ? 1 : 0);
