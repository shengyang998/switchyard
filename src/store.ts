import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
export type Row = Record<string, any>;
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export class Store {
  db: DatabaseSync;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'state.db'));
    chmodSync(join(dir, 'state.db'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',provision TEXT NOT NULL DEFAULT 'new',branch TEXT NOT NULL,worktree TEXT NOT NULL,worker TEXT NOT NULL,token TEXT NOT NULL,ref TEXT,instance TEXT,session TEXT,inflight TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,text TEXT NOT NULL,target TEXT,task TEXT REFERENCES tasks(id),state TEXT NOT NULL DEFAULT 'pending',route TEXT,reply TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY,event TEXT NOT NULL REFERENCES events(id),task TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,attempt INTEGER NOT NULL,detail TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,task TEXT NOT NULL,event TEXT NOT NULL,token TEXT NOT NULL,outcome TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,task TEXT,event TEXT,detail TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor (singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,host TEXT NOT NULL,owner TEXT NOT NULL,started INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,task TEXT NOT NULL REFERENCES tasks(id),action TEXT NOT NULL,options TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,error TEXT,created INTEGER NOT NULL,finished INTEGER);`);
    // Additive, idempotent migration for v0.1 state: lifecycle is open|closing|closed|dropping|dropped.
    this.tx(() => {
      if (!this.all('PRAGMA table_info(tasks)').some(c => c.name === 'lifecycle')) this.db.exec("ALTER TABLE tasks ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'open'");
    });
  }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  get(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  config(): Row { return Object.fromEntries(this.all('SELECT * FROM config').map(x => [x.key, JSON.parse(x.value)])); }
  audit(kind: string, task: string | null, event: string | null, detail: unknown) { this.run('INSERT INTO audit(kind,task,event,detail,created) VALUES(?,?,?,?,?)', kind, task, event, JSON.stringify(detail), Date.now()); }
  lock(): () => void {
    const owner = id('owner');
    this.tx(() => {
      const old = this.get('SELECT * FROM supervisor');
      if (old) {
        if (old.host !== hostname()) throw new Error('State belongs to another host; shared state is unsupported');
        let alive = true; try { process.kill(old.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
        if (alive) throw new Error(`Supervisor already active (pid ${old.pid}); refusing lock takeover`);
        this.run('DELETE FROM supervisor');
      }
      this.run('INSERT INTO supervisor VALUES(1,?,?,?,?)', process.pid, hostname(), owner, Date.now());
    });
    return () => { this.run('DELETE FROM supervisor WHERE owner=?', owner); };
  }
  close() { this.db.close(); }
}
