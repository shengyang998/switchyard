// Where a command's state lives, so humans can run `sy` from anywhere in a project (or a task worktree)
// without repeating --state. Explicit always wins; nothing here creates state.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { command } from './process.js';

export const stateHome = () => process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');

// The main checkout of the repository containing `cwd`, also from inside a linked worktree.
export async function mainRoot(cwd: string): Promise<string | null> {
  try {
    const common = (await command('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (basename(common) === '.git') return realpathSync(dirname(common));
    return realpathSync((await command('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim());
  } catch { return null; }
}

// Private per-repository default outside the repository: nothing to add to .gitignore, one state per checkout.
export const defaultState = (root: string) => join(stateHome(), 'switchyard', `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`);

export type Located = { state: string; from: 'flag' | 'env' | 'nearby' | 'repo' };
export async function locate(flag: string | undefined, cwd = process.cwd()): Promise<Located | null> {
  if (flag) return { state: resolve(flag), from: 'flag' };
  if (process.env.SWITCHYARD_STATE) return { state: resolve(process.env.SWITCHYARD_STATE), from: 'env' };
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    // A legacy `.switchyard` next to the code, or the state that owns this task worktree (STATE/worktrees/task_…).
    if (existsSync(join(dir, '.switchyard', 'state.db'))) return { state: join(dir, '.switchyard'), from: 'nearby' };
    if (basename(dirname(dir)) === 'worktrees' && basename(dir).startsWith('task_') && existsSync(join(dirname(dirname(dir)), 'state.db'))) return { state: dirname(dirname(dir)), from: 'nearby' };
    if (dirname(dir) === dir) break;
  }
  const root = await mainRoot(cwd);
  return root && existsSync(join(defaultState(root), 'state.db')) ? { state: defaultState(root), from: 'repo' } : null;
}
