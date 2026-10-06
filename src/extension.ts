import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig } from './config';
import type { Worktree } from './core/git';
import type { Chat } from './core/history';
import type { AgentProcess } from './core/processes';
import { defaultHookScriptPath, hookScript, mergeClaudeHooks, mergeCodexNotify, type AgentStatus } from './core/status';
import { AGENT_LABEL, oneLine, tildify } from './core/util';
import { HistoryModel, Model, type RepoGroup, type Session } from './model';
import { SessionActions } from './sessions';
import { HistoryProvider, ProcessesProvider, ReposProvider, SessionsProvider, sessionState } from './views';

type SessionArg = { type: 'session'; session: Session };
type WorktreeArg = { type: 'worktree'; repo: string; worktree: Worktree };
type RepoArg = { type: 'repo'; group: RepoGroup };
type ChatArg = { type: 'chat'; chat: Chat };

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Devbox Agents');
  const cfg = readConfig;
  const model = new Model(cfg, log);
  const history = new HistoryModel(cfg, () => model.snapshot.repos, log);
  const actions = new SessionActions(model, cfg, log, context.globalState);

  const sessionsProvider = new SessionsProvider(model, cfg);
  const sessionsView = vscode.window.createTreeView('devboxAgents.sessions', { treeDataProvider: sessionsProvider, showCollapseAll: true });
  const reposView = vscode.window.createTreeView('devboxAgents.repos', { treeDataProvider: new ReposProvider(model, sessionsProvider, cfg) });
  const processesView = vscode.window.createTreeView('devboxAgents.processes', { treeDataProvider: new ProcessesProvider(model) });
  const historyView = vscode.window.createTreeView('devboxAgents.history', { treeDataProvider: new HistoryProvider(history), showCollapseAll: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'devboxAgents.sessions.focus';
  context.subscriptions.push(log, model, history, sessionsView, reposView, processesView, historyView, statusBar);

  // ---- refresh loop ---------------------------------------------------------------------------

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void model.refresh(), cfg().refreshInterval * 1000);
  };
  schedule();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  let historyTimer: NodeJS.Timeout | undefined = setInterval(() => historyView.visible && void history.refresh(), 60_000);
  context.subscriptions.push({ dispose: () => historyTimer && clearInterval(historyTimer) });
  historyView.onDidChangeVisibility((e) => e.visible && void history.refresh(), null, context.subscriptions);

  // Status files change when an agent starts working, waits or finishes: refresh right away.
  let watcher: fs.FSWatcher | undefined;
  const watchStatus = () => {
    watcher?.close();
    const dir = cfg().statusDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let pending: NodeJS.Timeout | undefined;
      watcher = fs.watch(dir, () => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => void model.refresh(), 250);
      });
    } catch (e) {
      log.appendLine(`[status] cannot watch ${dir}: ${(e as Error).message}`);
    }
  };
  watchStatus();
  context.subscriptions.push({ dispose: () => watcher?.close() });

  vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (!e.affectsConfiguration('devboxAgents')) return;
      if (e.affectsConfiguration('devboxAgents.refreshInterval')) schedule();
      if (e.affectsConfiguration('devboxAgents.statusDir')) watchStatus();
      void model.refresh();
      void history.refresh();
    },
    null,
    context.subscriptions,
  );

  // ---- badges, status bar, notifications ------------------------------------------------------

  const seen = new Map<string, AgentStatus>();
  let firstSnapshot = true;
  model.onDidChange((snap) => {
    void vscode.commands.executeCommand('setContext', 'devboxAgents.available', snap.tmuxAvailable);
    const sessions = model.allSessions();
    const withAgent = sessions.filter((s) => s.agent && s.processes.length > 0);
    const waiting = withAgent.filter((s) => sessionState(s) === 'waiting');

    sessionsView.message = snap.error ? `⚠ Could not read tmux sessions: ${snap.error}` : undefined;
    sessionsView.badge = waiting.length ? { value: waiting.length, tooltip: `${waiting.length} agent${waiting.length === 1 ? '' : 's'} waiting for you` } : undefined;
    const orphans = snap.processes.filter((p) => p.origin === 'orphan').length;
    processesView.description = orphans ? `${orphans} orphaned` : undefined;

    if (withAgent.length || waiting.length) {
      statusBar.text = `$(robot) ${withAgent.length}${waiting.length ? `  $(bell-dot) ${waiting.length}` : ''}`;
      statusBar.tooltip = [
        `${withAgent.length} agent session${withAgent.length === 1 ? '' : 's'} running`,
        ...waiting.map((s) => `${s.name}: waiting for you`),
      ].join('\n');
      statusBar.backgroundColor = waiting.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      statusBar.show();
    } else {
      statusBar.hide();
    }

    void actions.syncWorkspaceFolders();

    if (firstSnapshot) {
      firstSnapshot = false;
      void actions.resumePendingFocus();
      void offerHooks(cfg, log, context.globalState);
      for (const s of snap.statuses) seen.set(s.key, s);
      if (waiting.length) {
        void vscode.window
          .showWarningMessage(`${waiting.length} agent${waiting.length === 1 ? ' is' : 's are'} waiting for you: ${waiting.map((s) => s.name).join(', ')}`, 'Show')
          .then((pick) => pick && vscode.commands.executeCommand('devboxAgents.sessions.focus'));
      }
      return;
    }
    const notify = cfg().notify;
    for (const st of snap.statuses) {
      const prev = seen.get(st.key);
      seen.set(st.key, st);
      if (prev && (prev.at.getTime() === st.at.getTime() || prev.state === st.state)) continue;
      if (!notify.includes(st.state) || Date.now() - st.at.getTime() > 10 * 60_000) continue;
      // Only for agents in tmux sessions; chats in e.g. the Claude extension panel are already in view.
      const session = sessions.find((s) => s.status?.key === st.key);
      if (!session) continue;
      const text = `${session.name} (${AGENT_LABEL[st.agent]}): ${st.state === 'waiting' ? 'waiting for you' : 'finished its turn'}${st.message ? ` — ${oneLine(st.message, 140)}` : ''}`;
      const show = st.state === 'waiting' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(text, 'Open').then((pick) => pick && actions.focus(model.findSession(session.name) ?? session));
    }
  });

  // ---- commands -------------------------------------------------------------------------------

  const sessionOf = (arg?: SessionArg): Session | undefined => arg?.session ?? sessionsView.selection.find((n): n is SessionArg => n.type === 'session')?.session;
  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  type RepoInfoArg = { type: 'repoInfo'; info: { path: string } };
  reg('devboxAgents.startClaudeInRepo', (arg: RepoInfoArg) => actions.startInRepo(arg.info.path, 'claude'));
  reg('devboxAgents.startCodexInRepo', (arg: RepoInfoArg) => actions.startInRepo(arg.info.path, 'codex'));
  reg('devboxAgents.trustFolders', () => actions.trustFolders());
  reg('devboxAgents.addRepository', () => actions.addRepository());
  reg('devboxAgents.setAlias', (arg: RepoInfoArg) => actions.setAlias(arg.info.path));
  reg('devboxAgents.newSessionForRepo', (arg: RepoInfoArg) => actions.newSession(arg.info.path));
  reg('devboxAgents.newSession', (arg?: RepoArg) => actions.newSession(arg?.type === 'repo' ? arg.group.repo : undefined));
  reg('devboxAgents.refresh', () => Promise.all([model.refresh(), history.refresh()]));
  reg('devboxAgents.focusSession', (arg?: SessionArg) => {
    const s = sessionOf(arg);
    if (s) return actions.focus(model.findSession(s.name) ?? s);
  });
  reg('devboxAgents.openTerminal', (arg?: SessionArg) => {
    const s = sessionOf(arg);
    if (s) return actions.attach(s);
  });
  reg('devboxAgents.connectIde', (arg?: SessionArg) => {
    const s = sessionOf(arg);
    if (s) return actions.connectIde(s);
  });
  reg('devboxAgents.stopSession', (arg?: SessionArg) => {
    const s = sessionOf(arg);
    if (s) return actions.stop(s);
  });
  reg('devboxAgents.cleanupSession', (arg?: SessionArg) => {
    const s = sessionOf(arg);
    if (s) return actions.cleanup(s);
  });
  reg('devboxAgents.startInWorktree', (arg: WorktreeArg) => actions.startInWorktree(arg.repo, arg.worktree));
  reg('devboxAgents.removeWorktree', (arg: WorktreeArg) => actions.removeWorktree(arg.repo, arg.worktree));
  reg('devboxAgents.resumeChat', (arg: ChatArg) => actions.resume(arg.chat));
  reg('devboxAgents.openTranscript', (arg: ChatArg) => vscode.window.showTextDocument(vscode.Uri.file(arg.chat.file), { preview: true }));
  reg('devboxAgents.copyChatId', (arg: ChatArg) => vscode.env.clipboard.writeText(arg.chat.id));
  reg('devboxAgents.copyPid', (p: AgentProcess) => vscode.env.clipboard.writeText(String(p.pid)));
  reg('devboxAgents.revealProcess', (p: AgentProcess) => {
    const s = p.session ? model.findSession(p.session) : undefined;
    if (s) return actions.focus(s);
    void vscode.window.showInformationMessage(`Process ${p.pid} is not in a known tmux session.`);
  });
  reg('devboxAgents.terminateProcess', async (p: AgentProcess) => {
    const ok = await vscode.window.showWarningMessage(
      `Send SIGTERM to ${p.kind} process ${p.pid}?`,
      { modal: true, detail: `${p.cwd ? `Directory: ${tildify(p.cwd)}\n` : ''}${p.args.slice(0, 300)}` },
      'Terminate',
    );
    if (ok !== 'Terminate') return;
    try {
      process.kill(p.pid, 'SIGTERM');
      log.appendLine(`[process] sent SIGTERM to ${p.pid} (${p.kind}, ${p.origin})`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not terminate ${p.pid}: ${(e as Error).message}`);
    }
    setTimeout(() => void model.refresh(), 1000);
  });
  reg('devboxAgents.installHooks', () => installHooks(cfg, log));
  reg('devboxAgents.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:royberris.devbox-agents'));
  reg('devboxAgents.showLog', () => log.show());

  void model.refresh();
  void history.refresh();
}

export function deactivate(): void {}

const HOOKS_PROMPT_DISMISSED = 'devboxAgents.hooksPromptDismissed';

/** True when Claude is enabled but its status hooks (or the script they call) are missing. */
function claudeHooksMissing(c: ReturnType<typeof readConfig>): boolean {
  if (!c.agents.claude.enabled) return false;
  const script = defaultHookScriptPath();
  if (!fs.existsSync(script)) return true;
  try {
    const settings = path.join(c.claudeConfigDir, 'settings.json');
    return mergeClaudeHooks(fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : undefined, script) !== undefined;
  } catch {
    return false; // unreadable settings: installing would fail too
  }
}

/** Without hooks every session shows "no status"; offer to install them (again, e.g. after a setup script reset settings.json). */
async function offerHooks(cfg: typeof readConfig, log: vscode.OutputChannel, state: vscode.Memento): Promise<void> {
  if (state.get<boolean>(HOOKS_PROMPT_DISMISSED) || !claudeHooksMissing(cfg())) return;
  log.appendLine('[hooks] Claude status hooks are not installed');
  const install = 'Install';
  const never = "Don't Ask Again";
  const pick = await vscode.window.showInformationMessage(
    'Devbox Agents cannot see whether agents are working, waiting for you or done: the status hooks are not installed.',
    install,
    never,
  );
  if (pick === install) await installHooks(cfg, log);
  else if (pick === never) await state.update(HOOKS_PROMPT_DISMISSED, true);
}

async function installHooks(cfg: typeof readConfig, log: vscode.OutputChannel): Promise<void> {
  const c = cfg();
  const script = defaultHookScriptPath();
  const claudeSettings = path.join(c.claudeConfigDir, 'settings.json');
  const codexConfig = path.join(c.codexHome, 'config.toml');
  const withCodex = c.agents.codex.enabled && fs.existsSync(c.codexHome);
  const ok = await vscode.window.showInformationMessage(
    'Install status hooks?',
    {
      modal: true,
      detail: [
        'Agents will report when they are working, waiting for you or done, so you get notified even after being away.',
        '',
        `• Writes ${tildify(script)} (bash only; writes to ${tildify(c.statusDir)})`,
        c.agents.claude.enabled ? `• Adds hooks to ${tildify(claudeSettings)} (a backup is saved next to it)` : '',
        withCodex ? `• Adds "notify" to ${tildify(codexConfig)} if it has none (Codex only reports finished turns)` : '',
        '',
        'Applies to agents started from now on.',
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join('\n'),
    },
    'Install',
  );
  if (ok !== 'Install') return;

  const done: string[] = [];
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, hookScript(c.statusDir), { mode: 0o755 });
    fs.chmodSync(script, 0o755);
    done.push(`script ${tildify(script)}`);

    if (c.agents.claude.enabled) {
      const existing = fs.existsSync(claudeSettings) ? fs.readFileSync(claudeSettings, 'utf8') : undefined;
      const merged = mergeClaudeHooks(existing, script);
      if (merged) {
        if (existing !== undefined) fs.copyFileSync(claudeSettings, `${claudeSettings}.devbox-agents.bak`);
        fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
        fs.writeFileSync(claudeSettings, merged);
        done.push(`Claude hooks in ${tildify(claudeSettings)}`);
      } else {
        done.push('Claude hooks (already present)');
      }
    }

    if (withCodex) {
      const existing = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : undefined;
      const r = mergeCodexNotify(existing, script);
      if (r.kind === 'updated') {
        if (existing !== undefined) fs.copyFileSync(codexConfig, `${codexConfig}.devbox-agents.bak`);
        fs.writeFileSync(codexConfig, r.text);
        done.push(`Codex notify in ${tildify(codexConfig)}`);
      } else if (r.kind === 'conflict') {
        void vscode.window.showWarningMessage(
          `Codex already has a notify program (${r.line}). Not changed: Codex supports only one. Call "${script} codex <json>" from your own notify program to get Codex statuses.`,
        );
      } else {
        done.push('Codex notify (already present)');
      }
    }
  } catch (e) {
    log.appendLine(`[hooks] ${(e as Error).message}`);
    return void vscode.window.showErrorMessage(`Installing hooks failed: ${(e as Error).message}`);
  }
  log.appendLine(`[hooks] installed: ${done.join(', ')}`);
  void vscode.window.showInformationMessage(`Installed: ${done.join(', ')}. Restart running agents to pick up the hooks.`);
}
