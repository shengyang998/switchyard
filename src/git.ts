import { command } from './process.js';
export type Worktree = { path: string; branch?: string };
export async function worktrees(repo: string): Promise<Worktree[]> {
  const output = await command('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z']);
  return output.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    return { path: fields.find(f => f.startsWith('worktree '))!.slice(9), branch: fields.find(f => f.startsWith('branch '))?.slice(7) };
  }).filter(w => w.path);
}
export async function commitOf(repo: string, ref: string): Promise<string | null> {
  if (ref.startsWith('-')) throw new Error('Invalid Git reference');
  try { return (await command('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null; } catch { return null; }
}
// Merged means no commit on `sha` is missing from `into`: ancestry first, then patch equivalence
// (rebase/cherry-pick). Squash merges are not detectable and need an explicit discard.
export async function merged(repo: string, sha: string, into: string): Promise<boolean> {
  try { await command('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, into]); return true; } catch {}
  const cherry = await command('git', ['-C', repo, 'cherry', into, sha]);
  return !cherry.split('\n').some(line => line.startsWith('+'));
}
export async function dirty(worktree: string): Promise<boolean> {
  return (await command('git', ['-C', worktree, 'status', '--porcelain', '-z', '--untracked-files=normal'])).length > 0;
}
