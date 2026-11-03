import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
export const DEFAULT_MIN_FREE_MB = 10240;
export type Usage = { bytes: number; files: number; errors: number };
// Allocated bytes under root, like `du`: no symlink following, hard links counted once.
export function usage(root: string): Usage {
  const seen = new Set<string>(), stack = [root];
  let bytes = 0, files = 0, errors = 0;
  while (stack.length) {
    const path = stack.pop()!;
    let st;
    try { st = lstatSync(path); } catch { errors++; continue; }
    if (!st.isDirectory() && st.nlink > 1) { const key = `${st.dev}:${st.ino}`; if (seen.has(key)) continue; seen.add(key); }
    bytes += typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
    if (st.isDirectory()) { try { for (const name of readdirSync(path)) stack.push(join(path, name)); } catch { errors++; } }
    else files++;
  }
  return { bytes, files, errors };
}
// Lowest available space among existing paths (state, worktrees, repository may be different volumes).
export function freeSpace(paths: string[]): { bytes: number; path: string } {
  let low = { bytes: Number.POSITIVE_INFINITY, path: '' };
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const s = statfsSync(path), bytes = Number(s.bavail) * Number(s.bsize);
    if (bytes < low.bytes) low = { bytes, path };
  }
  return low;
}
export function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}
