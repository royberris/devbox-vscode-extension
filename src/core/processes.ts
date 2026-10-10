import * as fs from 'fs';
import * as path from 'path';

/**
 * Finds claude/codex/agy processes by reading /proc (Linux only), and works out where each one
 * comes from. Read-only: this module never signals a process.
 */

export type ProcessKind = 'claude' | 'claude-acp' | 'codex' | 'codex-acp' | 'codex-daemon' | 'agy';

/**
 * tmux: inside a tmux pane · ssh: started from a plain ssh shell · vscode: child of the VS Code
 * server (e.g. the Claude extension or a terminal without tmux) · orphan: parent is init or the
 * systemd user manager · daemon: Codex's managed app-server, detached on purpose · other.
 */
export type Origin = 'tmux' | 'ssh' | 'vscode' | 'orphan' | 'daemon' | 'other';

export interface AgentProcess {
  pid: number;
  ppid: number;
  kind: ProcessKind;
  origin: Origin;
  /** tmux session name when origin is tmux ('?' if the pane could not be matched). */
  session?: string;
  cwd?: string;
  started?: Date;
  args: string;
  /** Agent processes started by this one (e.g. Codex's native binary under its node wrapper). */
  children: AgentProcess[];
}

interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
  startTicks: number;
}

const CLK_TCK = 100;

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readlink(file: string): string | undefined {
  try {
    return fs.readlinkSync(file);
  } catch {
    return undefined;
  }
}

export function parseStat(stat: string): { ppid: number; startTicks: number } | undefined {
  // "pid (comm) state ppid ..." — comm may contain spaces and parentheses
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(' ');
  return { ppid: Number(fields[1]), startTicks: Number(fields[19]) };
}

/** Port of the classification in the `agents` helper script. */
export function kindOf(exe: string, args: string): ProcessKind | undefined {
  const exePath = exe.replace(/ \(deleted\)$/, '');
  const base = path.basename(exePath);
  if (exePath.includes('/claude/versions/') || base === 'claude') return 'claude';
  // agy replaces its binary on update; a running old one shows as agy.<n>.old (deleted)
  if (base === 'agy' || /^agy\.\d+\.old$/.test(base)) return 'agy';
  if (!(base === 'node' || base === 'codex' || base.startsWith('codex-'))) return undefined;
  if (/codex app-server.*--managed-daemon/.test(args) || args.includes('codex app-server daemon')) return 'codex-daemon';
  if (args.includes('claude-agent-acp')) return 'claude-acp';
  if (args.includes('@openai/codex') || /\/bin\/codex( |$)/.test(args)) return 'codex';
  if (args.includes('codex-acp')) return 'codex-acp';
  if (base === 'codex' || base.startsWith('codex-')) return 'codex';
  return undefined;
}

export function processScanSupported(): boolean {
  return process.platform === 'linux' && fs.existsSync('/proc/self/stat');
}

export function scanAgentProcesses(paneSessions: Map<number, string>): AgentProcess[] {
  if (!processScanSupported()) return [];
  const uid = process.getuid?.();
  const bootTime = Number(/^btime (\d+)/m.exec(read('/proc/stat') ?? '')?.[1] ?? 0);
  const cache = new Map<number, ProcInfo | null>();

  const info = (pid: number): ProcInfo | undefined => {
    if (cache.has(pid)) return cache.get(pid) ?? undefined;
    const stat = read(`/proc/${pid}/stat`);
    const parsed = stat ? parseStat(stat) : undefined;
    const value = parsed
      ? {
          pid,
          ppid: parsed.ppid,
          startTicks: parsed.startTicks,
          comm: (read(`/proc/${pid}/comm`) ?? '').trim(),
          args: (read(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).join(' '),
        }
      : null;
    cache.set(pid, value);
    return value ?? undefined;
  };

  const originOf = (pid: number): { origin: Origin; session?: string } => {
    let cur = pid;
    for (let first = true, i = 0; i < 128; first = false, i++) {
      const session = paneSessions.get(cur);
      if (session) return { origin: 'tmux', session };
      const parent = info(cur)?.ppid ?? 0;
      const p = info(parent);
      if (first && (parent === 1 || p?.args.startsWith('/usr/lib/systemd/systemd --user') || p?.args.startsWith('/lib/systemd/systemd --user'))) {
        return { origin: 'orphan' };
      }
      if (p?.comm === 'tmux: server') return { origin: 'tmux', session: '?' };
      if (p?.comm === 'sshd' || p?.comm === 'sshd-session') return { origin: 'ssh' };
      if (p && /\/\.vscode-server(-insiders)?\/|\/\.cursor-server\/|\/\.vscodium-server\//.test(p.args)) return { origin: 'vscode' };
      if (parent <= 1) return { origin: 'other' };
      cur = parent;
    }
    return { origin: 'other' };
  };

  const found: AgentProcess[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      if (uid !== undefined && fs.statSync(`/proc/${pid}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const exe = readlink(`/proc/${pid}/exe`);
    if (!exe) continue;
    const p = info(pid);
    if (!p) continue;
    const kind = kindOf(exe, p.args);
    if (!kind) continue;
    const { origin, session } = kind === 'codex-daemon' ? { origin: 'daemon' as Origin, session: undefined } : originOf(pid);
    found.push({
      pid,
      ppid: p.ppid,
      kind,
      origin,
      session,
      cwd: readlink(`/proc/${pid}/cwd`),
      started: bootTime ? new Date((bootTime + p.startTicks / CLK_TCK) * 1000) : undefined,
      args: p.args,
      children: [],
    });
  }

  // Nest agent processes under the nearest agent ancestor.
  const byPid = new Map(found.map((a) => [a.pid, a]));
  const roots: AgentProcess[] = [];
  for (const a of found) {
    let parent: AgentProcess | undefined;
    for (let cur = a.ppid, i = 0; cur > 1 && i < 128; cur = info(cur)?.ppid ?? 0, i++) {
      parent = byPid.get(cur);
      if (parent) break;
    }
    (parent ? parent.children : roots).push(a);
  }
  roots.sort((x, y) => (x.started?.getTime() ?? 0) - (y.started?.getTime() ?? 0));
  return roots;
}

/** Processes worth a second look: never killed automatically, only highlighted. */
export function isSuspicious(p: AgentProcess): boolean {
  return p.origin === 'orphan' || p.origin === 'vscode' || (p.origin === 'tmux' && p.session === '?');
}
