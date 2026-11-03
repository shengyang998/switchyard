// Stand-in interactive agent for the opt-in live Herdr smoke test (never part of `npm test`).
// Herdr sees it as `codex` because it is launched through a symlink named codex. It reports its
// session exactly like Herdr's official Codex integration and follows Switchyard's report protocol
// deterministically, so a real Herdr server can be exercised without a model or an account.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), resumed = args[0] === 'resume' ? args[1] : null;
const session = resumed ?? randomUUID(), herdr = process.env.HERDR_BIN_PATH, pane = process.env.HERDR_PANE_ID;
const log = (m) => { if (process.env.SMOKE_AGENT_LOG) appendFileSync(process.env.SMOKE_AGENT_LOG, `${new Date().toISOString()} ${pane} ${session} ${m}\n`); };
const draw = (line) => process.stdout.write(`\x1b[2J\x1b[H${line}\n\n› Ask Codex to do anything\n`);
const git = (...a) => execFileSync('git', ['-c', 'user.name=Smoke Agent', '-c', 'user.email=smoke@example.invalid', ...a], { encoding: 'utf8' }).trim();
log(`start argv=${JSON.stringify(args)} cwd=${process.cwd()}`);
if (herdr && pane) execFileSync(herdr, ['pane', 'report-agent-session', '--source', 'herdr:codex', '--agent', 'codex', '--agent-session-id', session, '--session-start-source', resumed ? 'resume' : 'startup', pane]);
draw(resumed ? `resumed ${session}` : `session ${session}`);
let buffer = '', turns = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function handle(text) {
  const event = /^SWITCHYARD INPUT (\S+)/m.exec(text)?.[1], argvText = /shell-quoting each element: (\[.*\])$/m.exec(text)?.[1];
  log(`turn event=${event ?? 'none'}`);
  if (!event || !argvText) return draw('no Switchyard envelope; ignored');
  const argv = JSON.parse(argvText), body = text.split('INPUT (data):\n')[1] ?? '';
  const report = (outcome, summary, evidence) => {
    const filled = argv.map((x) => ({ '<unique-report-id>': `${event}-${outcome}-${randomUUID()}`, '<ack|progress|blocked|ready|failed>': outcome, '<summary>': summary, '<evidence>': evidence })[x] ?? x);
    log(`report ${outcome}: ${execFileSync(filled[0], filled.slice(1), { encoding: 'utf8' }).replace(/\s+/g, ' ').slice(0, 160)}`);
  };
  report('ack', 'received', `pid ${process.pid}`);
  if (/\bHANG\b/.test(body)) return draw('working without a final report');
  if (/\bSLOW\b/.test(body)) await sleep(4000);
  if (/\bBLOCK\b/.test(body)) { report('blocked', 'needs a decision', 'smoke'); return draw('blocked'); }
  const file = `smoke-${++turns}-${process.pid}.txt`;
  writeFileSync(file, body);
  git('add', file); git('commit', '-qm', `smoke: ${file}`);
  report('ready', `wrote ${file}`, `commit ${git('rev-parse', '--short', 'HEAD')}`);
  draw(`done ${file}`);
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  buffer += d.toString();
  if (buffer.includes('\x03')) process.exit(0);
  // Herdr writes the prompt text then a carriage return; strip bracketed-paste markers if present.
  const at = buffer.lastIndexOf('\r');
  if (at < 0) return;
  const text = buffer.slice(0, at).replace(/\x1b\[20[01]~/g, ''); buffer = buffer.slice(at + 1);
  if (text.trim()) handle(text).catch((e) => { log(`error ${e.message}`); draw(`error ${e.message}`); });
});
setInterval(() => {}, 1 << 30);
