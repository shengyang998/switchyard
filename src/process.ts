import { spawn } from 'node:child_process';
export async function command(exe: string, args: string[], options: { cwd?: string; input?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let out = '', err = '', finished = false, aborted: string | undefined;
    const abort = (reason:string) => {
      if (aborted) return; aborted=reason; child.kill('SIGTERM');
      setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 500).unref();
    };
    const timer = setTimeout(() => abort('Command timed out'), options.timeout ?? 120000);
    child.stdout.on('data', d => { if (aborted) return; if (out.length+d.length>8e6) abort('Command output limit exceeded'); else out+=d; });
    child.stderr.on('data', d => { if (!aborted) err = (err + d).slice(-16000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { finished = true; clearTimeout(timer); if(aborted) reject(new Error(`${aborted}: ${exe}`)); else code === 0 ? resolve(out) : reject(new Error(`${exe} exited ${code}: ${err || out.slice(-4000)}`)); });
    child.stdin.on('error', () => {}); child.stdin.end(options.input);
  });
}
