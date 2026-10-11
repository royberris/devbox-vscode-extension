import * as vscode from 'vscode';
import type { Config } from './config';
import * as git from './core/git';
import { findMergedPull, GitHubError, parseGitHubRemote, type MergedPull } from './core/github';
import type { Model, Session } from './model';
import type { SessionActions } from './sessions';

/** Scope sets other extensions sign in with (GitHub Pull Requests first); a session is only reused on an exact match. */
const SCOPE_SETS = [['read:user', 'user:email', 'repo', 'workflow'], ['read:user', 'user:email', 'repo'], ['repo']];
/** A branch is asked about at most this often, however often git or the window says something changed. */
const MIN_RECHECK_MS = 60_000;
const POLL_MS = 5 * 60_000;
const DISMISSED = 'devboxAgents.mergePromptDismissed';

/** Minimal shape of the built-in git extension's API (`vscode.git`, getAPI(1)). */
interface GitApi {
  repositories: { state: { onDidChange: vscode.Event<void> } }[];
  onDidOpenRepository: vscode.Event<{ state: { onDidChange: vscode.Event<void> } }>;
}

/**
 * Notices when the PR of a managed session's branch was merged on GitHub (wherever it was merged)
 * and offers to clean up the session. Uses VS Code's own GitHub sign-in and git API; the GitHub
 * Pull Requests extension is not needed.
 */
export class MergeWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a session turns out to be merged (to update the tree). */
  readonly onDidChange = this.emitter.event;
  private readonly merged = new Map<string, MergedPull>();
  private readonly checkedAt = new Map<string, number>();
  private readonly prompted = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private timer: NodeJS.Timeout | undefined;
  private pending: NodeJS.Timeout | undefined;
  private running = false;
  private authLogged = false;
  private apiError: string | undefined;

  constructor(
    private readonly model: Model,
    private readonly cfg: () => Config,
    private readonly log: vscode.OutputChannel,
    private readonly state: vscode.Memento,
    private readonly actions: SessionActions,
  ) {
    this.timer = setInterval(() => this.check(), POLL_MS);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((e) => e.focused && this.soon()),
      vscode.authentication.onDidChangeSessions((e) => e.provider.id === 'github' && this.soon()),
    );
    void this.watchGit();
  }

  /** The merged PR of a session, once known. */
  mergedPull(s: Session): MergedPull | undefined {
    return this.merged.get(this.key(s));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    for (const d of this.disposables) d.dispose();
  }

  /** After a merge the GitHub Pull Requests extension (or the user) fetches: the repository state changes. */
  private async watchGit(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      if (!ext) return;
      const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
      const watch = (r: { state: { onDidChange: vscode.Event<void> } }) => this.disposables.push(r.state.onDidChange(() => this.soon()));
      api.repositories.forEach(watch);
      this.disposables.push(api.onDidOpenRepository(watch));
    } catch (e) {
      // git disabled or its API changed: the timer and window focus still trigger checks
      this.log.appendLine(`[merge] not watching the git extension: ${(e as Error).message}`);
    }
  }

  /** Debounced check, for events that come in bursts. */
  soon(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.check(), 2000);
  }

  check(): void {
    if (this.running || !this.cfg().promptCleanupOnMerge) return;
    this.running = true;
    void this.run()
      .catch((e) => this.log.appendLine(`[merge] ${(e as Error).message}`))
      .finally(() => (this.running = false));
  }

  private key(s: Session): string {
    return `${s.tmux.repo}\0${s.tmux.branch}`;
  }

  private async run(): Promise<void> {
    const now = Date.now();
    const candidates = this.model
      .allSessions()
      .filter((s) => s.managed && s.tmux.worktree && s.tmux.repo && s.tmux.branch)
      .filter((s) => !this.merged.has(this.key(s)) && now - (this.checkedAt.get(this.key(s)) ?? 0) >= MIN_RECHECK_MS);
    if (candidates.length === 0) return;

    const remotes = new Map<string, { owner: string; repo: string } | undefined>();
    for (const repo of new Set(candidates.map((s) => s.tmux.repo!))) remotes.set(repo, parseGitHubRemote((await git.remoteUrl(repo)) ?? ''));
    const onGitHub = candidates.filter((s) => remotes.get(s.tmux.repo!));
    if (onGitHub.length === 0) return;
    const token = await this.token();
    if (!token) return;

    for (const s of onGitHub) {
      const gh = remotes.get(s.tmux.repo!)!;
      const branch = s.tmux.branch!;
      this.checkedAt.set(this.key(s), now);
      let pr: MergedPull | undefined;
      try {
        pr = await findMergedPull(gh.owner, gh.repo, branch, token);
        this.apiError = undefined;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg !== this.apiError) this.log.appendLine(`[merge] ${msg}`);
        this.apiError = msg;
        if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) return;
        continue;
      }
      if (!pr) continue;
      // Work after the merge (or an old PR of a reused branch name) is not merged: no prompt.
      const head = await git.branchHead(s.tmux.repo!, branch);
      if (head && !(await git.isAncestor(s.tmux.repo!, head, pr.headSha))) continue;
      this.log.appendLine(`[merge] ${branch} was merged in ${gh.owner}/${gh.repo}#${pr.number}`);
      this.merged.set(this.key(s), pr);
      this.emitter.fire();
      void this.prompt(s, pr);
    }
  }

  /** Reuses an existing GitHub sign-in without ever showing a dialog. */
  private async token(): Promise<string | undefined> {
    for (const scopes of SCOPE_SETS) {
      try {
        const session = await vscode.authentication.getSession('github', scopes, { silent: true });
        if (session) return session.accessToken;
      } catch (e) {
        this.log.appendLine(`[merge] GitHub sign-in unavailable: ${(e as Error).message}`);
        return undefined;
      }
    }
    if (!this.authLogged) {
      this.authLogged = true;
      this.log.appendLine('[merge] not signed in to GitHub: merged pull requests are not detected (sign in via the Accounts menu)');
      // Without `silent` VS Code shows a sign-in entry in the Accounts menu; still no dialog.
      void Promise.resolve(vscode.authentication.getSession('github', ['repo'], {})).catch(() => undefined);
    }
    return undefined;
  }

  private async prompt(s: Session, pr: MergedPull): Promise<void> {
    const id = `${s.name}\0${s.tmux.branch}\0${pr.number}`;
    const dismissed = this.state.get<string[]>(DISMISSED, []);
    if (this.prompted.has(id) || dismissed.includes(id)) return;
    this.prompted.add(id);
    const cleanUp = 'Clean Up';
    const notNow = 'Not Now';
    const open = 'Open PR';
    const branchNote = (await git.branchHead(s.tmux.repo!, s.tmux.branch!)) ? ` and deletes branch ${s.tmux.branch}` : '';
    const pick = await vscode.window.showInformationMessage(
      `PR #${pr.number} of "${s.name}" was merged. Clean up? This stops the session, removes the worktree${branchNote}.`,
      cleanUp,
      notNow,
      open,
    );
    if (pick === cleanUp) {
      const current = this.model.findSession(s.name);
      if (current) await this.actions.cleanup(current, pr, true);
    } else if (pick === notNow) {
      await this.state.update(DISMISSED, [...dismissed, id].slice(-200));
    } else if (pick === open) {
      void vscode.env.openExternal(vscode.Uri.parse(pr.url));
    }
  }
}
