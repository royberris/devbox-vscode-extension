import { execFile } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export class ExecError extends Error {
  constructor(message: string, readonly result: ExecResult) {
    super(message);
  }
}

/** Run a program without a shell. Never rejects; inspect `code`. */
export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (typeof e.code === 'number') return resolve({ stdout, stderr, code: e.code });
        // spawn errors (ENOENT, timeout kill, ...) have no exit code
        resolve({ stdout, stderr: stderr || e.message, code: e.code === 'ENOENT' ? 127 : 1 });
      },
    );
  });
}

/** Run a program and return stdout; throws ExecError on a non-zero exit. */
export async function runOk(file: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(file, args, opts);
  if (r.code !== 0) {
    // git prints progress before the actual error; prefer its fatal:/error: lines
    const errors = r.stderr.split('\n').filter((l) => /^(fatal|error):/.test(l));
    const detail = errors.join('\n') || r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`;
    throw new ExecError(detail, r);
  }
  return r.stdout;
}
