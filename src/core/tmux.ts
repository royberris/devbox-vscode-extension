import { run, runOk } from './exec';
import { isAgentKind, type AgentKind } from './util';

/** tmux user options that mark a session as managed by this extension. */
export const OPT = {
  agent: '@devbox_agent',
  repo: '@devbox_repo',
  worktree: '@devbox_worktree',
  branch: '@devbox_branch',
  base: '@devbox_base',
} as const;

/** Environment variable set in every managed session; the status hook uses it as key. */
export const SESSION_ENV = 'DEVBOX_AGENTS_SESSION';

export interface TmuxSession {
  name: string;
  created: Date;
  attachedClients: number;
  agent?: AgentKind;
  repo?: string;
  worktree?: string;
  branch?: string;
  base?: string;
}

export interface TmuxPane {
  pid: number;
  session: string;
  cwd: string;
  command: string;
  active: boolean;
}

const SEP = '\t';
const SESSION_FIELDS = [
  '#{session_name}',
  '#{session_created}',
  '#{session_attached}',
  `#{${OPT.agent}}`,
  `#{${OPT.repo}}`,
  `#{${OPT.worktree}}`,
  `#{${OPT.branch}}`,
  `#{${OPT.base}}`,
];
const PANE_FIELDS = ['#{pane_pid}', '#{session_name}', '#{pane_current_path}', '#{pane_current_command}', '#{&&:#{window_active},#{pane_active}}'];

export function parseSessions(out: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, agent, repo, worktree, branch, base] = line.split(SEP);
    sessions.push({
      name,
      created: new Date(Number(created) * 1000),
      attachedClients: Number(attached) || 0,
      agent: isAgentKind(agent) ? agent : undefined,
      repo: repo || undefined,
      worktree: worktree || undefined,
      branch: branch || undefined,
      base: base || undefined,
    });
  }
  return sessions;
}

export function parsePanes(out: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [pid, session, cwd, command, active] = line.split(SEP);
    panes.push({ pid: Number(pid), session, cwd, command, active: active === '1' });
  }
  return panes;
}

/**
 * Errors that just mean "there are no sessions": no server, or (with `exit-empty off`) a
 * server without sessions, where `list-panes -a` fails with "no current target".
 */
export function isEmptyServerError(stderr: string): boolean {
  return /no server running|error connecting|no sessions|no current target/i.test(stderr);
}

export class Tmux {
  /** `socket` selects a separate tmux server (`tmux -L`), used by tests. */
  constructor(private readonly bin: string, private readonly socket?: string) {}

  private exec(args: string[]) {
    return run(this.bin, this.socket ? ['-L', this.socket, ...args] : args);
  }

  private execOk(args: string[]) {
    return runOk(this.bin, this.socket ? ['-L', this.socket, ...args] : args);
  }

  async available(): Promise<boolean> {
    return (await run(this.bin, ['-V'])).code === 0;
  }

  async listSessions(): Promise<TmuxSession[]> {
    const r = await this.exec(['list-sessions', '-F', SESSION_FIELDS.join(SEP)]);
    if (r.code !== 0) {
      if (isEmptyServerError(r.stderr)) return [];
      throw new Error(`tmux list-sessions: ${r.stderr.trim()}`);
    }
    return parseSessions(r.stdout);
  }

  async listPanes(): Promise<TmuxPane[]> {
    const r = await this.exec(['list-panes', '-a', '-F', PANE_FIELDS.join(SEP)]);
    if (r.code !== 0) {
      if (isEmptyServerError(r.stderr)) return [];
      throw new Error(`tmux list-panes: ${r.stderr.trim()}`);
    }
    return parsePanes(r.stdout);
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.exec(['has-session', '-t', `=${name}`])).code === 0;
  }

  /**
   * Create a detached session that runs `argv` (no shell parsing by tmux) and tag it
   * with user options, in one tmux invocation so a refresh never sees it untagged.
   */
  async newSession(opts: { name: string; cwd: string; argv: string[]; env: Record<string, string>; options: Record<string, string | undefined> }): Promise<void> {
    const args = ['new-session', '-d', '-s', opts.name, '-c', opts.cwd];
    for (const [k, v] of Object.entries(opts.env)) args.push('-e', `${k}=${v}`);
    args.push(...opts.argv);
    for (const [k, v] of Object.entries(opts.options)) {
      if (v !== undefined && v !== '') args.push(';', 'set-option', '-t', `=${opts.name}:`, k, v);
    }
    await this.execOk(args);
  }

  async killSession(name: string): Promise<void> {
    await this.execOk(['kill-session', '-t', `=${name}`]);
  }

  /** Type literal text into the session's active pane, followed by Enter. */
  async sendLine(name: string, text: string): Promise<void> {
    const target = `=${name}:`;
    await this.execOk(['send-keys', '-t', target, '-l', text, ';', 'send-keys', '-t', target, 'Enter']);
  }
}
