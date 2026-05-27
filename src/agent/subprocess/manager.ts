import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export class SubprocessManager {
  private running: Map<string, ChildProcess> = new Map();

  async run(opts: SpawnOptions): Promise<SpawnResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const id = `${child.pid}-${Date.now()}`;
      this.running.set(id, child);

      const timer = setTimeout(() => {
        timedOut = true;
        if (!settled) {
          settled = true;
          this.kill(id);
          resolve({ stdout, stderr, exitCode: null, timedOut: true, durationMs: Date.now() - start });
        }
      }, timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          settled = true;
          this.kill(id);
          resolve({ stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - start });
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            this.kill(id);
            resolve({ stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - start });
          }
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (opts.input) {
        const drain = !child.stdin!.write(opts.input);
        if (drain) {
          child.stdin!.once('drain', () => child.stdin!.end());
        } else {
          child.stdin!.end();
        }
      } else {
        child.stdin?.end();
      }

      const stdoutRl = createInterface({ input: child.stdout! });
      stdoutRl.on('line', (line) => {
        stdout += line + '\n';
      });

      const stderrRl = createInterface({ input: child.stderr! });
      stderrRl.on('line', (line) => {
        stderr += line + '\n';
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.running.delete(id);
        if (!settled) {
          settled = true;
          resolve({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: code,
            timedOut,
            durationMs: Date.now() - start,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.running.delete(id);
        if (!settled) {
          settled = true;
          resolve({
            stdout: stdout.trimEnd(),
            stderr: `${stderr}\n${err.message}`.trim(),
            exitCode: -1,
            timedOut: false,
            durationMs: Date.now() - start,
          });
        }
      });
    });
  }

  kill(id: string): boolean {
    const child = this.running.get(id);
    if (!child) return false;
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5000);
    } catch {
      return false;
    }
    this.running.delete(id);
    return true;
  }

  async healthCheck(command: string): Promise<boolean> {
    try {
      const checkCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
      execSync(checkCmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, child] of this.running) {
      try { child.kill('SIGTERM'); } catch {}
    }
    this.running.clear();
  }
}
