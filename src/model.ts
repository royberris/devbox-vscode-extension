import * as path from 'path';
import * as vscode from 'vscode';
import type { Config } from './config';
import { findRepos, listWorktrees, missingDependencies, repoStatus, type RepoStatus, type Worktree } from './core/git';
import { readAgyHistory, readClaudeHistory, readCodexHistory, type Chat } from './core/history';
import { scanAgentProcesses, type AgentProcess, type ProcessKind } from './core/processes';
import { readStatuses, type AgentStatus } from './core/status';
import { Tmux, type TmuxPane, type TmuxSession } from './core/tmux';
import { isWithin, type AgentKind } from './core/util';

export interface Session {
  tmux: TmuxSession;
  name: string;
  /** Started by this extension (tagged with tmux user options). */
  managed: boolean;
  agent?: AgentKind;
  /** Directory to show in the explorer: the worktree, else the active pane's cwd. */
  dir?: string;
  processes: AgentProcess[];
  status?: AgentStatus;
}

export interface RepoGroup {
  repo: string;
  sessions: Session[];
  /** Worktrees below worktreesRoot without a running session. */
  idleWorktrees: Worktree[];
}

export interface RepoInfo {
  path: string;
  status?: RepoStatus;
  missingDeps: string[];
  /** Agent sessions started on the main checkout (no worktree). */
  sessions: Session[];
}

export interface Snapshot {
  tmuxAvailable: boolean;
  repos: string[];
  repoInfos: RepoInfo[];
  groups: RepoGroup[];
  otherSessions: Session[];
  processes: AgentProcess[];
  statuses: AgentStatus[];
  error?: string;
}

const EMPTY: Snapshot = { tmuxAvailable: true, repos: [], repoInfos: [], groups: [], otherSessions: [], processes: [], statuses: [] };

function agentOfKind(kind: ProcessKind): AgentKind | undefined {
  if (kind === 'claude' || kind === 'claude-acp') return 'claude';
  if (kind === 'codex' || kind === 'codex-acp') return 'codex';
  if (kind === 'agy') return 'agy';
  return undefined;
}

function flatten(ps: AgentProcess[]): AgentProcess[] {
  return ps.flatMap((p) => [p, ...flatten(p.children)]);
}

/** Live state, read from the server (tmux, git, /proc, status files) on every refresh. */
export class Model implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.emitter.event;
  snapshot: Snapshot = EMPTY;
  private running: Promise<void> | undefined;
  private again = false;
  private lastError: string | undefined;

  constructor(private cfg: () => Config, private readonly log: vscode.OutputChannel) {}

  get tmux(): Tmux {
    return new Tmux(this.cfg().tmuxPath);
  }

  /** Coalesces concurrent calls: at most one refresh runs, plus one queued. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          this.snapshot = await this.collect();
        } catch (e) {
          // Never keep showing the previous state: a session listed as running that no
          // longer exists is worse than an empty list with an error.
          const error = (e as Error).message;
          this.snapshot = { ...EMPTY, tmuxAvailable: this.snapshot.tmuxAvailable, repos: this.snapshot.repos, error };
        }
        if (this.snapshot.error && this.snapshot.error !== this.lastError) this.log.appendLine(`[refresh] ${this.snapshot.error}`);
        this.lastError = this.snapshot.error;
        this.emitter.fire(this.snapshot);
      } while (this.again);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async collect(): Promise<Snapshot> {
    const cfg = this.cfg();
    const tmux = new Tmux(cfg.tmuxPath);
    const tmuxAvailable = await tmux.available();
    let sessions: TmuxSession[] = [];
    let panes: TmuxPane[] = [];
    let error: string | undefined;
    if (tmuxAvailable) {
      try {
        sessions = await tmux.listSessions();
        if (sessions.length) panes = await tmux.listPanes();
      } catch (e) {
        error = (e as Error).message;
        sessions = [];
      }
    }

    const paneSessions = new Map(panes.map((p) => [p.pid, p.session]));
    const processes = scanAgentProcesses(paneSessions);
    const statuses = readStatuses(cfg.statusDir);
    const repos = findRepos(cfg.repoRoots, cfg.repoScanDepth, cfg.extraRepos);

    const toSession = (t: TmuxSession): Session => {
      const procs = processes.filter((p) => p.origin === 'tmux' && p.session === t.name);
      const activePane = panes.find((p) => p.session === t.name && p.active) ?? panes.find((p) => p.session === t.name);
      const agent = t.agent ?? procs.map((p) => agentOfKind(p.kind)).find(Boolean);
      let status = statuses.find((s) => s.key === t.name || s.tmuxSession === t.name);
      if (!status && agent) {
        // Agents not started by us report under their chat id; match them by working directory.
        const cwds = new Set(flatten(procs).map((p) => p.cwd));
        status = statuses.filter((s) => !s.tmuxSession && s.agent === agent && cwds.has(s.cwd)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      }
      if (status && procs.length === 0) status = undefined; // agent is gone, the record is stale
      return { tmux: t, name: t.name, managed: !!t.agent, agent, dir: t.worktree ?? (t.agent ? t.repo : undefined) ?? activePane?.cwd, processes: procs, status };
    };

    const all = sessions.map(toSession);
    const groups = new Map<string, RepoGroup>();
    const group = (repo: string) => {
      let g = groups.get(repo);
      if (!g) groups.set(repo, (g = { repo, sessions: [], idleWorktrees: [] }));
      return g;
    };
    for (const s of all) if (s.managed && s.tmux.repo) group(s.tmux.repo).sessions.push(s);

    const sessionDirs = new Set(all.map((s) => s.tmux.worktree).filter(Boolean));
    await Promise.all(
      repos.map(async (repo) => {
        try {
          for (const wt of await listWorktrees(repo)) {
            if (wt.path !== repo && isWithin(wt.path, cfg.worktreesRoot) && !sessionDirs.has(wt.path)) group(repo).idleWorktrees.push(wt);
          }
        } catch (e) {
          this.log.appendLine(`[worktrees] ${repo}: ${(e as Error).message}`);
        }
      }),
    );

    const repoInfos = await Promise.all(
      repos.map(async (repo): Promise<RepoInfo> => ({
        path: repo,
        status: await repoStatus(repo).catch(() => undefined),
        missingDeps: missingDependencies(repo),
        sessions: all.filter((s) => s.managed && s.tmux.repo === repo && !s.tmux.worktree),
      })),
    );

    return {
      tmuxAvailable,
      repos,
      repoInfos,
      groups: [...groups.values()].sort((a, b) => path.basename(a.repo).localeCompare(path.basename(b.repo))),
      otherSessions: all.filter((s) => !s.managed || !s.tmux.repo),
      processes,
      statuses,
      error,
    };
  }

  findSession(name: string): Session | undefined {
    const s = this.snapshot;
    return [...s.groups.flatMap((g) => g.sessions), ...s.otherSessions].find((x) => x.name === name);
  }

  allSessions(): Session[] {
    return [...this.snapshot.groups.flatMap((g) => g.sessions), ...this.snapshot.otherSessions];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export interface ChatGroup {
  label: string;
  /** Directory the chats ran in, when they share one (worktree or repo). */
  dir?: string;
  chats: Chat[];
}

/** Chat history from the agents' own transcript files. Refreshed on demand / slowly. */
export class HistoryModel implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  groups: ChatGroup[] = [];

  constructor(private cfg: () => Config, private readonly repos: () => string[], private readonly log: vscode.OutputChannel) {}

  async refresh(): Promise<void> {
    const cfg = this.cfg();
    const since = new Date(Date.now() - cfg.historyDays * 86_400_000);
    await new Promise((r) => setImmediate(r));
    let chats: Chat[] = [];
    try {
      chats = [...readClaudeHistory(cfg.claudeConfigDir, since), ...readCodexHistory(cfg.codexHome, since), ...readAgyHistory(cfg.agyDataDir, since)];
    } catch (e) {
      this.log.appendLine(`[history] ${(e as Error).message}`);
    }
    const repos = this.repos();
    const byLabel = new Map<string, ChatGroup>();
    for (const chat of chats) {
      const { label, dir } = locate(chat.cwd, repos, cfg.worktreesRoot);
      let g = byLabel.get(label);
      if (!g) byLabel.set(label, (g = { label, dir, chats: [] }));
      g.chats.push(chat);
    }
    for (const g of byLabel.values()) {
      g.chats.sort((a, b) => b.updated.getTime() - a.updated.getTime());
      g.chats = g.chats.slice(0, cfg.historyMaxPerGroup);
    }
    this.groups = [...byLabel.values()].sort((a, b) => b.chats[0].updated.getTime() - a.chats[0].updated.getTime());
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Human label for a chat's working directory: "repo", "repo › worktree" or the path. */
export function locate(cwd: string | undefined, repos: string[], worktreesRoot: string): { label: string; dir?: string } {
  if (!cwd) return { label: '(unknown directory)' };
  if (isWithin(cwd, worktreesRoot) && cwd !== worktreesRoot) {
    const [repo, slug] = path.relative(worktreesRoot, cwd).split(path.sep);
    if (slug) return { label: `${repo} › ${slug}`, dir: path.join(worktreesRoot, repo, slug) };
  }
  const repo = repos.find((r) => isWithin(cwd, r));
  if (repo) return { label: path.basename(repo), dir: repo };
  const home = process.env.HOME ?? '';
  return { label: home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd, dir: cwd };
}
