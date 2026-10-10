import * as path from 'path';
import * as vscode from 'vscode';
import type { Config } from './config';
import type { Worktree } from './core/git';
import type { Chat } from './core/history';
import type { AgentProcess, Origin } from './core/processes';
import type { AgentState } from './core/status';
import { AGENT_ICON, AGENT_LABEL, formatDateTime, relativeTime, repoShortName, tildify } from './core/util';
import type { ChatGroup, HistoryModel, Model, RepoGroup, RepoInfo, Session } from './model';

// ---- Sessions ------------------------------------------------------------------------------------

export type SessionNode =
  | { type: 'repo'; group: RepoGroup }
  | { type: 'session'; session: Session }
  | { type: 'worktree'; repo: string; worktree: Worktree }
  | { type: 'other'; sessions: Session[] };

const STATE: Record<AgentState | 'exited' | 'unknown', { text: string; icon: vscode.ThemeIcon }> = {
  waiting: { text: 'waiting for you', icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('notificationsWarningIcon.foreground')) },
  running: { text: 'working', icon: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue')) },
  idle: { text: 'done, your turn', icon: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')) },
  ended: { text: 'ended', icon: new vscode.ThemeIcon('circle-outline') },
  exited: { text: 'agent exited', icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')) },
  unknown: { text: 'agent active · no status', icon: new vscode.ThemeIcon('robot') },
};

export function sessionState(s: Session): keyof typeof STATE {
  if (s.agent && s.processes.length === 0) return 'exited';
  return s.status?.state ?? 'unknown';
}

export class SessionsProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: Model, private readonly cfg: () => Config) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: SessionNode): SessionNode[] {
    const snap = this.model.snapshot;
    if (!node) {
      const nodes: SessionNode[] = snap.groups.map((group) => ({ type: 'repo', group }));
      if (snap.otherSessions.length) nodes.push({ type: 'other', sessions: snap.otherSessions });
      return nodes;
    }
    if (node.type === 'repo') {
      return [
        ...node.group.sessions.map((session): SessionNode => ({ type: 'session', session })),
        ...node.group.idleWorktrees.map((worktree): SessionNode => ({ type: 'worktree', repo: node.group.repo, worktree })),
      ];
    }
    if (node.type === 'other') return node.sessions.map((session) => ({ type: 'session', session }));
    return [];
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    switch (node.type) {
      case 'repo': {
        const item = new vscode.TreeItem(path.basename(node.group.repo), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `repo:${node.group.repo}`;
        item.description = tildify(path.dirname(node.group.repo));
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'repo';
        return item;
      }
      case 'other': {
        const hasAgents = node.sessions.some((s) => s.processes.length > 0);
        const item = new vscode.TreeItem('Other tmux sessions', hasAgents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = 'other';
        item.iconPath = new vscode.ThemeIcon('terminal-tmux');
        item.tooltip = 'tmux sessions not started by Devbox Agents';
        return item;
      }
      case 'worktree': {
        const wt = node.worktree;
        const item = new vscode.TreeItem(path.basename(wt.path), vscode.TreeItemCollapsibleState.None);
        item.id = `wt:${wt.path}`;
        item.description = `${wt.branch ?? (wt.detached ? 'detached' : '')} · no session`;
        item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('disabledForeground'));
        item.tooltip = `Worktree ${tildify(wt.path)} has no tmux session.\nStart an agent in it, or remove it.`;
        item.contextValue = 'worktree';
        return item;
      }
      case 'session':
        return this.sessionItem(node.session);
    }
  }

  private sessionItem(s: Session): vscode.TreeItem {
    const cfg = this.cfg();
    const state = STATE[sessionState(s)];
    const short = s.tmux.repo ? repoShortName(s.tmux.repo, cfg.repoAliases) + '-' : '';
    const label = s.managed && s.name.startsWith(short) ? s.name.slice(short.length) : s.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${s.name}`;
    const parts = [s.agent ? AGENT_LABEL[s.agent] : 'shell', s.tmux.branch, s.agent ? state.text : undefined].filter(Boolean);
    item.description = parts.join(' · ');
    item.iconPath = s.agent ? state.icon : new vscode.ThemeIcon('terminal');
    // managed = own worktree (can be cleaned up), main = agent on a main checkout
    item.contextValue = `session.${s.managed ? (s.tmux.worktree ? 'managed' : 'main') : 'other'}${s.agent ? '.' + s.agent : ''}`;
    item.command = { command: 'devboxAgents.focusSession', title: 'Focus Session', arguments: [{ type: 'session', session: s }] };

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${s.name}**${s.agent ? ` — ${AGENT_LABEL[s.agent]}` : ''}\n\n`);
    if (s.status?.message) md.appendMarkdown(`> ${s.status.message.replace(/\n/g, ' ').slice(0, 300)}\n\n`);
    const rows: [string, string | undefined][] = [
      ['State', s.agent ? `${state.text}${s.status ? ` (${relativeTime(s.status.at)})` : ''}` : undefined],
      ['Directory', s.dir ? tildify(s.dir) : undefined],
      ['Branch', s.tmux.branch],
      ['Based on', s.tmux.base],
      ['Started', formatDateTime(s.tmux.created)],
      ['Attached clients', String(s.tmux.attachedClients)],
      ['Agent PIDs', s.processes.map((p) => p.pid).join(', ') || undefined],
    ];
    for (const [k, v] of rows) if (v) md.appendMarkdown(`${k}: \`${v}\`  \n`);
    if (s.agent && !s.status && s.processes.length) {
      md.appendMarkdown(
        s.agent === 'agy'
          ? `\n_Antigravity does not report its status to Devbox Agents yet._`
          : `\n_No status reported. Run "Install Status Hooks" to see when this agent waits for you._`,
      );
    }
    item.tooltip = md;
    return item;
  }
}

// ---- Repositories --------------------------------------------------------------------------------

export type RepoNode = { type: 'repoInfo'; info: RepoInfo } | { type: 'session'; session: Session };

export class ReposProvider implements vscode.TreeDataProvider<RepoNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: Model, private readonly sessions: SessionsProvider, private readonly cfg: () => Config) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: RepoNode): RepoNode[] {
    if (!node) return this.model.snapshot.repoInfos.map((info) => ({ type: 'repoInfo', info }));
    if (node.type === 'repoInfo') return node.info.sessions.map((session) => ({ type: 'session', session }));
    return [];
  }

  getTreeItem(node: RepoNode): vscode.TreeItem {
    if (node.type === 'session') {
      const item = this.sessions.getTreeItem(node);
      item.id = `repos:${item.id}`;
      return item;
    }
    const { info } = node;
    const st = info.status;
    const alias = this.cfg().repoAliases[path.basename(info.path)];
    const item = new vscode.TreeItem(
      alias ? `${path.basename(info.path)} (${alias})` : path.basename(info.path),
      info.sessions.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `repoInfo:${info.path}`;
    const parts = [
      st ? (st.branch ?? 'detached') : 'status unknown',
      st && (st.ahead || st.behind) ? `↑${st.ahead} ↓${st.behind}` : undefined,
      st?.changes ? `${st.changes} changed` : undefined,
      info.missingDeps.length ? `${info.missingDeps.join(', ')} missing` : undefined,
    ];
    item.description = parts.filter(Boolean).join(' · ');
    item.iconPath = info.missingDeps.length
      ? new vscode.ThemeIcon('repo', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
      : new vscode.ThemeIcon('repo');
    item.contextValue = 'repoInfo';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${path.basename(info.path)}** \`${tildify(info.path)}\`\n\n`);
    if (st) {
      md.appendMarkdown(`Branch: \`${st.branch ?? 'detached'}\`${st.upstream ? ` → \`${st.upstream}\` (${st.ahead} ahead, ${st.behind} behind)` : ''}  \n`);
      md.appendMarkdown(`Uncommitted changes: ${st.changes}  \n`);
    }
    if (info.missingDeps.length) md.appendMarkdown(`\nNot installed: ${info.missingDeps.join(', ')}. Start an agent on this checkout to set it up.`);
    if (alias) md.appendMarkdown(`\n\nAlias: \`${alias}\``);
    item.tooltip = md;
    return item;
  }
}

// ---- Processes -----------------------------------------------------------------------------------

const ORIGIN: Record<Origin, { text: string; icon: vscode.ThemeIcon }> = {
  tmux: { text: 'tmux', icon: new vscode.ThemeIcon('terminal-tmux') },
  ssh: { text: 'ssh shell', icon: new vscode.ThemeIcon('remote') },
  vscode: { text: 'VS Code server', icon: new vscode.ThemeIcon('vm', new vscode.ThemeColor('charts.yellow')) },
  orphan: { text: 'ORPHANED', icon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('notificationsWarningIcon.foreground')) },
  daemon: { text: 'daemon', icon: new vscode.ThemeIcon('server-process') },
  other: { text: 'other', icon: new vscode.ThemeIcon('question') },
};

export class ProcessesProvider implements vscode.TreeDataProvider<AgentProcess> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: Model) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(p?: AgentProcess): AgentProcess[] {
    return p ? p.children : this.model.snapshot.processes;
  }

  getTreeItem(p: AgentProcess): vscode.TreeItem {
    const origin = ORIGIN[p.origin];
    const item = new vscode.TreeItem(`${p.kind}  ${p.pid}`, p.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `pid:${p.pid}`;
    const where = p.origin === 'tmux' ? `tmux:${p.session}` : origin.text;
    item.description = [where, p.cwd ? tildify(p.cwd) : undefined, p.started ? relativeTime(p.started) : undefined].filter(Boolean).join(' · ');
    item.iconPath = origin.icon;
    item.contextValue = `process.${p.origin}`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${p.kind}** pid \`${p.pid}\`, parent \`${p.ppid}\`\n\n`);
    md.appendMarkdown(`Origin: ${where}  \n`);
    if (p.cwd) md.appendMarkdown(`Directory: \`${tildify(p.cwd)}\`  \n`);
    if (p.started) md.appendMarkdown(`Started: ${formatDateTime(p.started)}  \n`);
    md.appendCodeblock(p.args.slice(0, 500), 'sh');
    if (p.origin === 'orphan') md.appendMarkdown('\nIts parent process is gone. It is still running, maybe left over after a reconnect. It is never terminated automatically.');
    if (p.origin === 'vscode') md.appendMarkdown('\nStarted by the VS Code server (e.g. the Claude extension). It stops after VS Code is disconnected for a while (`remote.SSH.reconnectionGraceTime`), and may be left over after a reconnect.');
    item.tooltip = md;
    return item;
  }
}

// ---- History -------------------------------------------------------------------------------------

export type HistoryNode = { type: 'group'; group: ChatGroup } | { type: 'chat'; chat: Chat };

export class HistoryProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly history: HistoryModel) {
    history.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) return this.history.groups.map((group) => ({ type: 'group', group }));
    if (node.type === 'group') return node.group.chats.map((chat) => ({ type: 'chat', chat }));
    return [];
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.type === 'group') {
      const g = node.group;
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `hist:${g.label}`;
      item.description = `${g.chats.length} chat${g.chats.length === 1 ? '' : 's'} · ${relativeTime(g.chats[0].updated)}`;
      item.iconPath = new vscode.ThemeIcon(g.label.includes(' › ') ? 'git-branch' : 'folder');
      item.tooltip = g.dir ? tildify(g.dir) : undefined;
      return item;
    }
    const c = node.chat;
    const item = new vscode.TreeItem(c.title, vscode.TreeItemCollapsibleState.None);
    item.id = `chat:${c.agent}:${c.id}`;
    item.description = `${AGENT_LABEL[c.agent]} · ${relativeTime(c.updated)}`;
    item.iconPath = new vscode.ThemeIcon(AGENT_ICON[c.agent]);
    item.contextValue = 'chat';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.title}**\n\n`);
    md.appendMarkdown(`${AGENT_LABEL[c.agent]} chat \`${c.id}\`  \n`);
    if (c.cwd) md.appendMarkdown(`Directory: \`${tildify(c.cwd)}\`  \n`);
    if (c.started) md.appendMarkdown(`Started: ${formatDateTime(c.started)}  \n`);
    md.appendMarkdown(`Last activity: ${formatDateTime(c.updated)}`);
    item.tooltip = md;
    return item;
  }
}
