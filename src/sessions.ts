import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Config } from './config';
import * as git from './core/git';
import type { Chat } from './core/history';
import { deleteStatus } from './core/status';
import { OPT, SESSION_ENV } from './core/tmux';
import { AGENT_LABEL, expandHome, isWithin, randomSlug, repoShortName, shQuote, slugify, tildify, tmuxSafe, type AgentKind } from './core/util';
import type { Model, Session } from './model';

const TERMINAL_PREFIX = 'agent: ';
const PENDING_FOCUS = 'pendingFocus';

function agentWorkspaceFile(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devbox-agents', 'agents.code-workspace');
}

function inAgentWorkspace(): boolean {
  const ws = vscode.workspace.workspaceFile;
  return ws?.scheme === 'file' && ws.fsPath === agentWorkspaceFile();
}

function workspaceFolderName(worktreesRoot: string, dir: string): string | undefined {
  return isWithin(dir, worktreesRoot) ? `${path.relative(worktreesRoot, dir).split(path.sep).join(' › ')} (agent)` : undefined;
}

/** Everything that changes state on the server: creating, focusing, stopping and cleaning up sessions. */
export class SessionActions {
  private declinedWorkspaceSwitch = false;
  /** Folder updates run one at a time: VS Code ignores a new one until the previous has applied. */
  private folderSync: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly model: Model,
    private readonly cfg: () => Config,
    private readonly log: vscode.OutputChannel,
    /** Remembers the last repository and agent, so Enter repeats the previous choice. */
    private readonly state: vscode.Memento,
  ) {}

  // ---- creating ---------------------------------------------------------------------------------

  /**
   * One quick pick: the input holds a random session name (editable), the items are the agents,
   * plus repository and base branch with sensible defaults that can be changed from there.
   */
  async newSession(repoHint?: string): Promise<void> {
    const cfg = this.cfg();
    const repos = git.findRepos(cfg.repoRoots, cfg.repoScanDepth, cfg.extraRepos);
    if (repos.length === 0) {
      const open = 'Open Settings';
      if ((await vscode.window.showWarningMessage(`No git repositories found in ${cfg.repoRoots.map(tildify).join(', ')}.`, open)) === open) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'devboxAgents.repo');
      }
      return;
    }
    const agents = this.enabledAgents();
    if (agents.length === 0) return void vscode.window.showErrorMessage('Both agents are disabled in the settings.');

    let repo = repoHint ?? this.defaultRepo(repos);
    let base = await this.defaultBase(repo);
    let name = randomSlug();
    let message: string | undefined;

    for (;;) {
      const pick = await this.newSessionPick({ repo, base, name, agents, message });
      if (!pick) return;
      name = pick.name;
      message = undefined;
      if (pick.action !== 'agent') {
        if (pick.action === 'repo') {
          const r = await this.pickRepo(repos);
          if (r && r !== repo) {
            repo = r;
            base = await this.defaultBase(repo);
          }
        } else {
          base = (await this.pickBase(repo)) ?? base;
        }
        continue;
      }

      const slug = slugify(name);
      const branch = `${cfg.branchPrefix}${slug}`;
      const dir = path.join(cfg.worktreesRoot, path.basename(repo), slug);
      if (!slug) message = 'Use letters, digits or dashes in the name.';
      else if (fs.existsSync(dir)) message = `${tildify(dir)} already exists. Pick another name.`;
      else if (await git.branchExists(repo, branch)) message = `Branch ${branch} already exists. Pick another name.`;
      if (message) continue;

      await this.state.update('lastRepo', repo);
      await this.state.update('lastAgent', pick.agent);
      return this.createSession(repo, pick.agent, base, slug);
    }
  }

  private async newSessionPick(o: { repo: string; base: string; name: string; agents: AgentKind[]; message?: string }): Promise<
    { action: 'agent'; agent: AgentKind; name: string } | { action: 'repo' | 'base'; name: string } | undefined
  > {
    const cfg = this.cfg();
    type Item = vscode.QuickPickItem & { action?: 'agent' | 'repo' | 'base'; agent?: AgentKind };
    const last = this.state.get<AgentKind>('lastAgent');
    const agents = [...o.agents].sort((a, b) => Number(b === last) - Number(a === last));
    const items: Item[] = [
      ...agents.map((k): Item => ({ label: `$(robot) ${AGENT_LABEL[k]}`, description: 'start', action: 'agent', agent: k, alwaysShow: true })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(repo) ${path.basename(o.repo)}`, description: 'repository · change…', action: 'repo', alwaysShow: true },
      { label: `$(git-branch) ${o.base}`, description: 'base branch · change…', action: 'base', alwaysShow: true },
    ];
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = o.message ? `New Agent Session: ${o.message}` : 'New Agent Session';
    qp.placeholder = 'Session name';
    qp.value = o.name;
    qp.items = items;
    qp.matchOnDescription = false;
    qp.ignoreFocusOut = true;
    const updatePrompt = () => {
      const slug = slugify(qp.value);
      qp.prompt = slug
        ? `Branch ${cfg.branchPrefix}${slug} from ${o.base} · worktree ${tildify(path.join(cfg.worktreesRoot, path.basename(o.repo), slug))}`
        : 'Type a session name (letters, digits, dashes)';
    };
    updatePrompt();
    return new Promise((resolve) => {
      let done = false;
      qp.onDidChangeValue(() => {
        updatePrompt();
        // Typing filters the list; keep the agent selected so Enter starts it.
        qp.activeItems = [items[0]];
      });
      qp.onDidAccept(() => {
        const item = qp.activeItems[0] ?? items[0];
        done = true;
        qp.hide();
        if (item.action === 'agent' && item.agent) resolve({ action: 'agent', agent: item.agent, name: qp.value });
        else resolve({ action: item.action === 'repo' ? 'repo' : 'base', name: qp.value });
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
      qp.activeItems = [items[0]];
    });
  }

  private async createSession(repo: string, agent: AgentKind, base: string, slug: string): Promise<void> {
    const cfg = this.cfg();
    const branch = `${cfg.branchPrefix}${slug}`;
    const dir = path.join(cfg.worktreesRoot, path.basename(repo), slug);
    const name = await this.freeSessionName(`${repoShortName(repo, cfg.repoAliases)}-${slug}`);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${slug}…` }, async (progress) => {
        if (cfg.fetchBeforeNewSession && base.includes('/')) {
          progress.report({ message: `fetching ${base}` });
          if (!(await git.fetch(repo))) this.log.appendLine(`[new] git fetch failed in ${repo}, using local refs`);
        }
        progress.report({ message: `worktree ${tildify(dir)}` });
        await git.addWorktree(repo, dir, branch, base);
      });
      this.log.appendLine(`[new] worktree ${dir} (${branch} from ${base})`);
      await this.startTmux({ name, dir, agent, agentArgs: [], repo, worktree: dir, branch, base });
    } catch (e) {
      return void this.fail('Could not create the session', e);
    }
    await this.model.refresh();
    const session = this.model.findSession(name);
    if (session) await this.focus(session);
  }

  private defaultRepo(repos: string[]): string {
    const last = this.state.get<string>('lastRepo');
    if (last && repos.includes(last)) return last;
    const open = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    return repos.find((r) => open.some((f) => isWithin(f, r))) ?? repos[0];
  }

  /** `origin/<defaultBaseBranch>` if it exists, else the local branch, else the repo's default. */
  private async defaultBase(repo: string): Promise<string> {
    const wanted = this.cfg().defaultBaseBranch;
    for (const ref of [`origin/${wanted}`, wanted]) {
      if (await git.refExists(repo, ref)) return ref;
    }
    return (await git.defaultBranch(repo)) ?? 'HEAD';
  }

  // ---- repositories ------------------------------------------------------------------------------

  /** Paste a link, press Enter: cloned on the server into <repoRoot>/<owner>/<repo>. */
  async addRepository(): Promise<void> {
    const cfg = this.cfg();
    const root = cfg.repoRoots[0];
    if (!root) return void vscode.window.showErrorMessage('No repo root configured (devboxAgents.repoRoots).');
    const target = (link: git.RepoLink) =>
      cfg.repoScanDepth >= 2 && link.owner ? path.join(root, link.owner, link.name) : path.join(root, link.name);

    const input = await vscode.window.showInputBox({
      title: 'Add Repository',
      placeHolder: 'Paste a GitHub, GitLab, Bitbucket or Azure DevOps link',
      prompt: `Cloned on the server into ${tildify(root)}/<owner>/<repo>, with the server's git credentials.`,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v.trim()) return undefined;
        const link = git.parseRepoLink(v);
        if (!link) return 'Not a repository link';
        const dir = target(link);
        if (fs.existsSync(dir)) return `${tildify(dir)} already exists`;
        return { message: `Clones into ${tildify(dir)}`, severity: vscode.InputBoxValidationSeverity.Info };
      },
    });
    const link = input ? git.parseRepoLink(input) : undefined;
    if (!link) return;
    const dir = target(link);

    let used: string;
    try {
      used = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Cloning ${link.owner ? link.owner + '/' : ''}${link.name} into ${tildify(dir)}…` },
        () => git.clone(link.urls, dir),
      );
      this.log.appendLine(`[repos] cloned ${used} into ${dir}`);
    } catch (e) {
      this.log.appendLine(`[repos] clone failed:\n${(e as Error).message}`);
      const show = 'Show Details';
      const pick = await vscode.window.showErrorMessage(
        `Could not clone ${link.name}. Does the server have access (ssh key or credential helper for this host)?`,
        show,
      );
      if (pick === show) this.log.show(true);
      return;
    }
    if (!git.findRepos(cfg.repoRoots, cfg.repoScanDepth, cfg.extraRepos).includes(dir)) {
      await vscode.workspace.getConfiguration('devboxAgents').update('extraRepos', [...cfg.extraRepos.map(tildify), tildify(dir)], vscode.ConfigurationTarget.Global);
    }
    await this.model.refresh();

    const alias = 'Set Alias…';
    const setup = this.enabledAgents().map((k) => `Set Up with ${AGENT_LABEL[k]}`);
    const pick = await vscode.window.showInformationMessage(`Cloned ${link.name} into ${tildify(dir)}.`, ...setup, alias);
    if (pick === alias) return this.setAlias(dir);
    const agent = this.enabledAgents().find((k) => pick === `Set Up with ${AGENT_LABEL[k]}`);
    if (agent) await this.startInRepo(dir, agent);
  }

  async setAlias(repo: string): Promise<void> {
    const cfg = this.cfg();
    const base = path.basename(repo);
    const value = await vscode.window.showInputBox({
      title: `Alias for ${base}`,
      prompt: 'Short name used in tmux session names. Leave empty to remove the alias.',
      value: cfg.repoAliases[base] ?? '',
      validateInput: (v) => (!v.trim() || slugify(v) ? undefined : 'Use letters, digits or dashes'),
    });
    if (value === undefined) return;
    await this.saveAlias(repo, value);
    await this.model.refresh();
  }

  /** Aliases are keyed by folder name and stored in the (remote) machine settings. */
  private async saveAlias(repo: string, alias: string): Promise<void> {
    const conf = vscode.workspace.getConfiguration('devboxAgents');
    const aliases = { ...(conf.inspect<Record<string, string>>('repoAliases')?.globalValue ?? {}) };
    const slug = slugify(alias);
    if (slug) aliases[path.basename(repo)] = slug;
    else delete aliases[path.basename(repo)];
    await conf.update('repoAliases', aliases, vscode.ConfigurationTarget.Global);
  }

  /** Agent directly on the repository's main checkout, e.g. to install dependencies or manage the repo. */
  async startInRepo(repo: string, agent: AgentKind): Promise<void> {
    const existing = this.model.snapshot.repoInfos.find((r) => r.path === repo)?.sessions.find((s) => s.agent === agent);
    if (existing) {
      const open = 'Open Existing';
      const pick = await vscode.window.showInformationMessage(
        `${AGENT_LABEL[agent]} is already running on ${path.basename(repo)} (${existing.name}).`,
        open,
        'Start Another',
      );
      if (pick === open) return this.focus(existing);
      if (pick === undefined) return;
    }
    const cfg = this.cfg();
    const branch = (await git.repoStatus(repo).catch(() => undefined))?.branch;
    const name = await this.freeSessionName(`${repoShortName(repo, cfg.repoAliases)}-${slugify(branch ?? 'main') || 'main'}`);
    try {
      await this.startTmux({ name, dir: repo, agent, agentArgs: [], repo, branch });
    } catch (e) {
      return void this.fail('Could not start the agent', e);
    }
    await this.state.update('lastAgent', agent);
    await this.model.refresh();
    const s = this.model.findSession(name);
    if (s) await this.focus(s);
  }

  async startInWorktree(repo: string, wt: git.Worktree): Promise<void> {
    const agent = await this.pickAgent();
    if (!agent) return;
    const cfg = this.cfg();
    const name = await this.freeSessionName(`${repoShortName(repo, cfg.repoAliases)}-${path.basename(wt.path)}`);
    try {
      await this.startTmux({ name, dir: wt.path, agent, agentArgs: [], repo, worktree: wt.path, branch: wt.branch });
    } catch (e) {
      return void this.fail('Could not start the agent', e);
    }
    await this.model.refresh();
    const s = this.model.findSession(name);
    if (s) await this.focus(s);
  }

  async resume(chat: Chat): Promise<void> {
    const running = this.findRunningChat(chat);
    if (running) {
      void vscode.window.showInformationMessage(`This chat is already running in tmux session ${running.name}.`);
      return this.focus(running);
    }
    if (!chat.cwd || !fs.existsSync(chat.cwd)) {
      return void vscode.window.showErrorMessage(
        `Cannot resume: the chat's directory ${chat.cwd ? tildify(chat.cwd) : '(unknown)'} no longer exists. ${AGENT_LABEL[chat.agent]} can only resume a chat in the directory it was started in.`,
      );
    }
    const cfg = this.cfg();
    const repo = await git.mainRepoOf(chat.cwd);
    const inWorktree = isWithin(chat.cwd, cfg.worktreesRoot) && chat.cwd !== cfg.worktreesRoot;
    const short = repo ? repoShortName(repo, cfg.repoAliases) : tmuxSafe(path.basename(chat.cwd));
    const name = await this.freeSessionName(inWorktree ? `${short}-${path.basename(chat.cwd)}` : `${short}-${chat.id.slice(0, 8)}`);
    const branch = repo ? (await git.listWorktrees(repo).catch(() => [])).find((w) => w.path === chat.cwd)?.branch : undefined;
    try {
      await this.startTmux({ name, dir: chat.cwd, agent: chat.agent, resumeId: chat.id, agentArgs: [], repo, worktree: inWorktree ? chat.cwd : undefined, branch });
    } catch (e) {
      return void this.fail('Could not resume the chat', e);
    }
    await this.model.refresh();
    const s = this.model.findSession(name);
    if (s) await this.focus(s);
  }

  private findRunningChat(chat: Chat): Session | undefined {
    for (const s of this.model.allSessions()) {
      if (s.status?.chatId === chat.id) return s;
      if (s.processes.some((p) => p.args.includes(chat.id))) return s;
    }
    return undefined;
  }

  /**
   * The agent runs in a login shell inside a detached tmux session, never as a child of the
   * extension host, so it survives disconnects without a time limit. When the agent exits, the
   * shell stays so the session (and its scrollback) remain available.
   */
  private async startTmux(o: {
    name: string;
    dir: string;
    agent: AgentKind;
    agentArgs: string[];
    resumeId?: string;
    repo?: string;
    worktree?: string;
    branch?: string;
    base?: string;
  }): Promise<void> {
    const cfg = this.cfg();
    const ac = cfg.agents[o.agent];
    const args =
      o.agent === 'claude'
        ? [...ac.args, ...(o.resumeId ? ['--resume', o.resumeId] : []), ...o.agentArgs]
        : [...ac.args, ...(o.resumeId ? ['resume', o.resumeId] : []), ...o.agentArgs];
    const cmd = [ac.command, ...args].map(shQuote).join(' ');
    const script = `${cmd}; printf '\\n[%s exited. This shell stays open; the tmux session is %s.]\\n' ${shQuote(AGENT_LABEL[o.agent])} ${shQuote(o.name)}; exec ${shQuote(cfg.shell)} -l`;
    this.log.appendLine(`[tmux] new-session ${o.name} in ${o.dir}: ${cmd}`);
    await this.model.tmux.newSession({
      name: o.name,
      cwd: o.dir,
      argv: [cfg.shell, '-lc', script],
      env: { ...cfg.sessionEnv, [SESSION_ENV]: o.name },
      options: { [OPT.agent]: o.agent, [OPT.repo]: o.repo, [OPT.worktree]: o.worktree, [OPT.branch]: o.branch, [OPT.base]: o.base },
    });
  }

  private async freeSessionName(wanted: string): Promise<string> {
    const base = tmuxSafe(wanted);
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!(await this.model.tmux.hasSession(name))) return name;
    }
  }

  private async pickRepo(repos: string[]): Promise<string | undefined> {
    const current = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const isOpen = (r: string) => current.some((c) => isWithin(c, r));
    const sorted = [...repos].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));
    const pick = await vscode.window.showQuickPick(
      sorted.map((r) => ({ label: path.basename(r), description: tildify(path.dirname(r)), repo: r })),
      { title: 'New agent session: repository', matchOnDescription: true },
    );
    return pick?.repo;
  }

  private enabledAgents(): AgentKind[] {
    const cfg = this.cfg();
    return (['claude', 'codex'] as AgentKind[]).filter((k) => cfg.agents[k].enabled);
  }

  private async pickAgent(): Promise<AgentKind | undefined> {
    const cfg = this.cfg();
    const kinds = this.enabledAgents();
    if (kinds.length === 0) return void vscode.window.showErrorMessage('Both agents are disabled in the settings.');
    if (kinds.length === 1) return kinds[0];
    const pick = await vscode.window.showQuickPick(
      kinds.map((k) => ({ label: AGENT_LABEL[k], description: cfg.agents[k].command, agent: k })),
      { title: 'New agent session: agent' },
    );
    return pick?.agent;
  }

  private async pickBase(repo: string): Promise<string | undefined> {
    const cfg = this.cfg();
    const load = async () => {
      if (cfg.fetchBeforeNewSession && !(await git.fetch(repo))) this.log.appendLine(`[new] git fetch failed in ${repo}, using local refs`);
      return Promise.all([git.listBranches(repo), git.defaultBranch(repo)]);
    };
    let branches: git.Branch[];
    let def: string | undefined;
    try {
      [branches, def] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: cfg.fetchBeforeNewSession ? `Fetching ${path.basename(repo)}…` : 'Reading branches…' },
        load,
      );
    } catch (e) {
      return void this.fail('Could not read branches', e);
    }
    const items = branches
      .sort((a, b) => Number(b.name === def) - Number(a.name === def))
      .map((b) => ({
        label: b.name,
        description: b.name === def ? 'default' : b.remote ? 'remote' : 'local',
        detail: `${b.date.toISOString().slice(0, 10)} · ${b.subject}`,
        ref: b.name,
      }));
    const pick = await vscode.window.showQuickPick(items, { title: 'New agent session: base branch', matchOnDetail: true });
    return pick?.ref;
  }

  // ---- focusing ---------------------------------------------------------------------------------

  /** Terminal attached to the session, plus its worktree in the explorer. */
  async focus(s: Session): Promise<void> {
    const cfg = this.cfg();
    if (!(await this.stillExists(s))) return;
    this.openTerminal(s); // first: a terminal survives an extension host restart caused by folder changes
    if (!s.dir || !fs.existsSync(s.dir)) return;
    const added = await this.showFolder(s, s.dir);
    if (cfg.connectIdeOnFocus && added && s.agent === 'claude' && s.processes.length > 0 && s.status?.state !== 'running') {
      await this.connectIde(s);
    }
  }

  async attach(s: Session): Promise<void> {
    if (await this.stillExists(s)) this.openTerminal(s);
  }

  /** The tree can be up to one refresh behind; check before acting on a session. */
  private async stillExists(s: Session): Promise<boolean> {
    if (await this.model.tmux.hasSession(s.name)) return true;
    void vscode.window.showInformationMessage(`tmux session "${s.name}" no longer exists.`);
    await this.model.refresh();
    return false;
  }

  openTerminal(s: Session): vscode.Terminal {
    const cfg = this.cfg();
    let t = this.findTerminal(s.name);
    if (!t) {
      t = vscode.window.createTerminal({
        name: TERMINAL_PREFIX + s.name,
        // Explicit shell: the user's default profile may itself attach to some other tmux session.
        shellPath: cfg.tmuxPath,
        shellArgs: ['attach-session', '-t', `=${s.name}`],
        cwd: s.dir && fs.existsSync(s.dir) ? s.dir : undefined,
        env: { TMUX: null, TMUX_PANE: null },
        iconPath: new vscode.ThemeIcon('robot'),
        location: cfg.terminalLocation === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
      });
    }
    t.show();
    return t;
  }

  private findTerminal(name: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find((t) => t.name === TERMINAL_PREFIX + name && t.exitStatus === undefined);
  }

  /** Returns true if the folder was added to the workspace. */
  private async showFolder(s: Session, dir: string): Promise<boolean> {
    const cfg = this.cfg();
    const uri = vscode.Uri.file(dir);
    if (cfg.focusMode === 'terminalOnly') return false;
    if (cfg.focusMode === 'newWindow') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      return false;
    }
    if (cfg.focusMode === 'activeSessions') {
      if (!s.managed) return false; // only agent sessions get a folder; others just get the terminal
      if (!inAgentWorkspace()) {
        await this.switchToAgentWorkspace(s, dir);
        return false;
      }
      const added = await this.syncWorkspaceFolders(dir);
      if (added && isWithin(dir, cfg.worktreesRoot)) void this.trustTip();
      await this.revealFolder(vscode.Uri.file(dir));
      return added;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const present = folders.some((f) => f.uri.fsPath === dir);
    if (!present && (!vscode.workspace.workspaceFile || folders.length === 0)) {
      // In an empty or single-folder window, adding a folder makes VS Code enter a new untitled
      // workspace, which reloads the whole window. Switch to a saved workspace once instead.
      await this.switchToAgentWorkspace(s, dir);
      return false;
    }
    let added = false;
    if (!present) {
      // swapFolder: replace the trailing block of agent worktree folders (never folder 0,
      // changing that restarts the extension host).
      let start = folders.length;
      if (cfg.focusMode === 'swapFolder' && s.managed) {
        while (start > 1 && isWithin(folders[start - 1].uri.fsPath, cfg.worktreesRoot)) start--;
      }
      const name = workspaceFolderName(cfg.worktreesRoot, dir);
      const changed = new Promise<void>((resolve) => {
        const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => (sub.dispose(), resolve()));
        setTimeout(() => (sub.dispose(), resolve()), 3000);
      });
      added = vscode.workspace.updateWorkspaceFolders(start, folders.length - start, { uri, name });
      if (!added) this.log.appendLine(`[focus] could not add workspace folder ${dir}`);
      else {
        await changed;
        if (isWithin(dir, cfg.worktreesRoot)) void this.trustTip();
      }
    }
    await this.revealFolder(uri);
    return added;
  }

  private async revealFolder(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }

  /** Directories of the running sessions started by this extension: their worktree, or the checkout. */
  private activeSessionDirs(): string[] {
    return [...new Set(this.model.allSessions().flatMap((s) => (s.managed && s.dir && fs.existsSync(s.dir) ? [s.dir] : [])))];
  }

  /**
   * activeSessions mode: makes the agent workspace show exactly the running sessions' directories
   * (plus `extra`, a session that may not be in the snapshot yet). Existing folders keep their place
   * and new ones go last, so folder 0 (changing it restarts the extension host) only changes when its
   * session ends. Returns true if `extra` was added.
   */
  syncWorkspaceFolders(extra?: string): Promise<boolean> {
    const run = this.folderSync.then(() => this.applyWorkspaceFolders(extra));
    this.folderSync = run.catch(() => undefined);
    return run;
  }

  private async applyWorkspaceFolders(extra?: string): Promise<boolean> {
    if (this.cfg().focusMode !== 'activeSessions' || !inAgentWorkspace()) return false;
    const snap = this.model.snapshot;
    if (snap.error || !snap.tmuxAvailable) return false; // a failed read is not "no sessions"
    const current = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const active = this.activeSessionDirs();
    if (extra && !active.includes(extra)) active.push(extra);
    const want = [...current.filter((d) => active.includes(d)), ...active.filter((d) => !current.includes(d))];
    if (want.length === current.length && want.every((d, i) => d === current[i])) return false;

    const start = current.length && want[0] === current[0] ? 1 : 0;
    const root = this.cfg().worktreesRoot;
    const changed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => (sub.dispose(), resolve()));
      setTimeout(() => (sub.dispose(), resolve()), 3000);
    });
    const ok = vscode.workspace.updateWorkspaceFolders(
      start,
      current.length - start,
      ...want.slice(start).map((d) => ({ uri: vscode.Uri.file(d), name: workspaceFolderName(root, d) ?? path.basename(d) })),
    );
    const removed = current.filter((d) => !want.includes(d));
    const added = want.filter((d) => !current.includes(d));
    this.log.appendLine(
      ok
        ? `[focus] workspace folders: ${[...added.map((d) => `+${tildify(d)}`), ...removed.map((d) => `-${tildify(d)}`)].join(' ')}`
        : '[focus] could not update workspace folders',
    );
    if (!ok) return false;
    await changed;
    return !!extra && added.includes(extra);
  }

  private async switchToAgentWorkspace(s: Session, dir: string, confirmed = false): Promise<void> {
    if (this.declinedWorkspaceSwitch) return;
    const file = agentWorkspaceFile();
    const open = 'Open Agent Workspace';
    const notNow = 'Not Now';
    const pick = confirmed ? open : await vscode.window.showInformationMessage(
      'Show agent worktrees in the explorer?',
      {
        modal: true,
        detail:
          `This window has no multi-root workspace, so adding a folder would reload the window every time.\n\n` +
          `Devbox Agents can switch this window to ${tildify(file)} once (one reload, then this session opens again). ` +
          `After that, focusing a session swaps the folder without reloading.\n\n` +
          `The terminal is already open. Set "devboxAgents.focusMode" to "terminalOnly" to stop asking.`,
      },
      open,
      notNow,
    );
    if (pick !== open) {
      // Escape or closing the dialog asks again on the next focus; only "Not Now" sticks for this window.
      this.log.appendLine(`[focus] workspace switch ${pick === notNow ? 'declined for this window' : 'dismissed'}; ${tildify(dir)} not shown in the explorer`);
      if (pick !== notNow) return;
      this.declinedWorkspaceSwitch = true;
      const show = 'Show in Explorer';
      if ((await vscode.window.showInformationMessage('Agent worktrees stay out of the explorer in this window.', show)) === show) {
        this.declinedWorkspaceSwitch = false;
        await this.switchToAgentWorkspace(s, dir, true);
      }
      return;
    }

    const current = vscode.workspace.workspaceFolders?.[0]?.uri;
    const anchor = current && current.fsPath !== dir ? current.fsPath : s.tmux.repo;
    let ws: { folders?: unknown[]; [k: string]: unknown } = {};
    try {
      ws = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // new file, or not plain JSON: start fresh
    }
    const name = (d: string) => workspaceFolderName(this.cfg().worktreesRoot, d) ?? path.basename(d);
    // activeSessions: only the running sessions. Otherwise folder 0 is a stable anchor (changing it
    // restarts the extension host) and agent worktrees go after it.
    ws.folders = this.cfg().focusMode === 'activeSessions'
      ? [dir, ...this.activeSessionDirs().filter((d) => d !== dir)].map((d) => ({ path: d, name: name(d) }))
      : [...(anchor && anchor !== dir ? [{ path: anchor }] : []), { path: dir, name: workspaceFolderName(this.cfg().worktreesRoot, dir) }];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(ws, null, 2) + '\n');
    } catch (e) {
      return void this.fail('Could not write the agent workspace', e);
    }
    await this.state.update(PENDING_FOCUS, { name: s.name, at: Date.now() });
    this.log.appendLine(`[focus] switching window to ${file}`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceReuseWindow: true });
  }

  /** After the one-time switch to the agent workspace, focus the session that triggered it. */
  async resumePendingFocus(): Promise<void> {
    const pending = this.state.get<{ name: string; at: number }>(PENDING_FOCUS);
    if (!pending) return;
    await this.state.update(PENDING_FOCUS, undefined);
    if (Date.now() - pending.at > 2 * 60_000) return;
    const s = this.model.findSession(pending.name);
    if (s) await this.focus(s);
  }

  /**
   * VS Code asks "Do you trust the authors…" for every new folder in a trusted workspace.
   * There is no API to trust a folder, but trusting the worktrees root once (Manage Workspace
   * Trust → Add Folder) covers every worktree inside it. Point that out once.
   */
  private async trustTip(): Promise<void> {
    if (this.state.get('trustTipShown')) return;
    await this.state.update('trustTipShown', true);
    const how = 'Trust Worktrees Folder…';
    if ((await vscode.window.showInformationMessage(`Asked to trust every new worktree? Trust ${tildify(this.cfg().worktreesRoot)} once to cover them all.`, how)) === how) {
      await this.trustFolders();
    }
  }

  async trustFolders(): Promise<void> {
    const cfg = this.cfg();
    const dirs = [cfg.worktreesRoot, ...cfg.repoRoots];
    await vscode.env.clipboard.writeText(dirs[0]);
    await vscode.commands.executeCommand('workbench.trust.manage');
    void vscode.window.showInformationMessage(
      `Under "Trusted Folders & Workspaces", click "Add Folder" and choose ${dirs.map(tildify).join(' and ')}. ` +
        `Trusting a folder trusts everything inside it, so new worktrees no longer ask. (${dirs[0]} is on your clipboard.)`,
    );
  }

  async connectIde(s: Session): Promise<void> {
    if (s.agent !== 'claude' || !(await this.stillExists(s))) return;
    try {
      await this.model.tmux.sendLine(s.name, '/ide');
      this.openTerminal(s);
    } catch (e) {
      this.fail('Could not send /ide', e);
    }
  }

  // ---- stopping and cleaning up -----------------------------------------------------------------

  async stop(s: Session): Promise<void> {
    if (!(await this.stillExists(s))) return;
    const agents = s.processes.map((p) => `${p.kind} (pid ${p.pid})`).join(', ');
    const ok = await vscode.window.showWarningMessage(
      `Stop tmux session "${s.name}"?`,
      { modal: true, detail: `${agents ? `This terminates ${agents}. ` : ''}${s.tmux.worktree ? `The worktree ${tildify(s.tmux.worktree)} is kept.` : ''}` },
      'Stop Session',
    );
    if (ok !== 'Stop Session') return;
    try {
      await this.model.tmux.killSession(s.name);
      this.findTerminal(s.name)?.dispose();
      deleteStatus(this.cfg().statusDir, s.name);
    } catch (e) {
      this.fail('Could not stop the session', e);
    }
    await this.model.refresh();
  }

  async cleanup(s: Session): Promise<void> {
    const wt = s.tmux.worktree;
    const repo = s.tmux.repo;
    if (!wt || !repo) return this.stop(s);
    if (!(await this.model.tmux.hasSession(s.name)) && !fs.existsSync(wt)) {
      void vscode.window.showInformationMessage(`"${s.name}" was already cleaned up.`);
      return this.model.refresh();
    }
    if (!(await this.ensureClean(wt))) return;
    const ahead = s.tmux.base ? await git.commitsAhead(wt, s.tmux.base) : undefined;
    const branchNote = s.tmux.branch
      ? `Branch ${s.tmux.branch} is kept${ahead ? ` (${ahead} commit${ahead === 1 ? '' : 's'} not in ${s.tmux.base})` : ''}.`
      : '';
    const ok = await vscode.window.showWarningMessage(
      `Clean up "${s.name}"?`,
      { modal: true, detail: `Stops the tmux session${s.processes.length ? ' and the agent in it' : ''} and removes the worktree ${tildify(wt)}. ${branchNote}` },
      'Clean Up',
    );
    if (ok !== 'Clean Up') return;
    try {
      if (await this.model.tmux.hasSession(s.name)) await this.model.tmux.killSession(s.name);
      this.findTerminal(s.name)?.dispose();
      deleteStatus(this.cfg().statusDir, s.name);
    } catch (e) {
      return void this.fail('Could not stop the session', e);
    }
    await this.removeWorktreeChecked(repo, wt);
    await this.model.refresh();
  }

  async removeWorktree(repo: string, wt: git.Worktree): Promise<void> {
    if (!(await this.ensureClean(wt.path))) return;
    const ok = await vscode.window.showWarningMessage(
      `Remove worktree ${tildify(wt.path)}?`,
      { modal: true, detail: wt.branch ? `Branch ${wt.branch} is kept.` : undefined },
      'Remove',
    );
    if (ok !== 'Remove') return;
    await this.removeWorktreeChecked(repo, wt.path);
    await this.model.refresh();
  }

  /** Refuses (with a message) when the worktree has uncommitted or untracked changes. */
  private async ensureClean(dir: string): Promise<boolean> {
    if (!fs.existsSync(dir)) return true;
    let changes: string[];
    try {
      changes = await git.uncommittedChanges(dir);
    } catch (e) {
      this.fail('Could not check the worktree for changes', e);
      return false;
    }
    if (changes.length === 0) return true;
    this.log.appendLine(`[cleanup] refused, uncommitted changes in ${dir}:\n  ${changes.join('\n  ')}`);
    const show = 'Show Changes';
    const pick = await vscode.window.showWarningMessage(
      `Not removed: ${tildify(dir)} has ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}. Commit or discard them first.`,
      show,
    );
    if (pick === show) this.log.show(true);
    return false;
  }

  private async removeWorktreeChecked(repo: string, dir: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const idx = folders.findIndex((f) => f.uri.fsPath === dir);
    if (idx > 0) vscode.workspace.updateWorkspaceFolders(idx, 1);
    if (!fs.existsSync(dir)) {
      // Already deleted from disk: only git's bookkeeping is left.
      await git.pruneWorktrees(repo).catch((e) => this.log.appendLine(`[cleanup] prune failed: ${(e as Error).message}`));
      return;
    }
    try {
      // No --force: git refuses by itself if anything changed since our check.
      await git.removeWorktree(repo, dir);
      this.log.appendLine(`[cleanup] removed worktree ${dir}`);
      void vscode.window.showInformationMessage(`Removed worktree ${tildify(dir)}.`);
    } catch (e) {
      this.fail('Worktree not removed', e);
    }
  }

  private fail(what: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.log.appendLine(`[error] ${what}: ${msg}`);
    void vscode.window.showErrorMessage(`${what}: ${msg}`);
  }
}
