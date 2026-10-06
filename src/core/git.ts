import * as fs from 'fs';
import * as path from 'path';
import { run, runOk } from './exec';

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

export interface Branch {
  name: string;
  remote: boolean;
  date: Date;
  subject: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Main repositories (with a `.git` directory, so worktrees are excluded) below the roots.
 * A root is always searched, never counted itself: a stray `git init` in `~/repos` would hide every repo in it.
 */
export function findRepos(roots: string[], depth: number, extra: string[] = []): string[] {
  const found = new Set<string>();
  const walk = (dir: string, level: number) => {
    if (level > 0 && isDir(path.join(dir, '.git'))) {
      found.add(dir);
      return;
    }
    if (level >= depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), level + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  for (const r of extra) if (isDir(path.join(r, '.git'))) found.add(r);
  return [...found].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), detached: false, prunable: false };
      list.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  return list;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  return parseWorktrees(await runOk('git', ['-C', repo, 'worktree', 'list', '--porcelain']));
}

export async function fetch(repo: string): Promise<boolean> {
  return (await run('git', ['-C', repo, 'fetch', '--prune', '--quiet'], { timeout: 60_000 })).code === 0;
}

export async function listBranches(repo: string): Promise<Branch[]> {
  const out = await runOk('git', [
    '-C', repo, 'for-each-ref', '--sort=-committerdate',
    '--format=%(refname)%09%(committerdate:unix)%09%(contents:subject)',
    'refs/heads', 'refs/remotes',
  ]);
  const branches: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, date, subject] = line.split('\t');
    if (ref.endsWith('/HEAD')) continue;
    const remote = ref.startsWith('refs/remotes/');
    branches.push({
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      remote,
      date: new Date(Number(date) * 1000),
      subject: subject ?? '',
    });
  }
  return branches;
}

/** e.g. `origin/main`, or the current branch when there is no remote HEAD. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const r = await run('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  const cur = await run('git', ['-C', repo, 'branch', '--show-current']);
  return cur.stdout.trim() || undefined;
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // --no-track: the new branch must never push to/pull from the base branch by accident
  await runOk('git', ['-C', repo, 'worktree', 'add', '--no-track', '-b', branch, dir, base], { timeout: 120_000 });
}

/** `git status --porcelain` lines (modified, staged and untracked files). */
export async function uncommittedChanges(dir: string): Promise<string[]> {
  const out = await runOk('git', ['-C', dir, 'status', '--porcelain']);
  return out.split('\n').filter(Boolean);
}

export async function commitsAhead(dir: string, base: string): Promise<number | undefined> {
  const r = await run('git', ['-C', dir, 'rev-list', '--count', `${base}..HEAD`]);
  return r.code === 0 ? Number(r.stdout.trim()) : undefined;
}

/** Without --force: git itself refuses when the worktree is dirty. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await runOk('git', ['-C', repo, 'worktree', 'remove', dir]);
}

export interface RepoStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Modified, staged and untracked files. */
  changes: number;
}

/** Parses `git status --porcelain=v1 --branch`. */
export function parseStatus(out: string): RepoStatus {
  const lines = out.split('\n').filter(Boolean);
  const st: RepoStatus = { ahead: 0, behind: 0, changes: 0 };
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : undefined;
  if (head) {
    const m = /^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
    if (m) {
      st.branch = m[1].startsWith('HEAD (no branch)') ? undefined : m[1];
      st.upstream = m[2];
      st.ahead = Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
      st.behind = Number(/behind (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
    }
  }
  st.changes = lines.length;
  return st;
}

export async function repoStatus(repo: string): Promise<RepoStatus> {
  return parseStatus(await runOk('git', ['-C', repo, 'status', '--porcelain=v1', '--branch']));
}

/** Dependency folders that a project file asks for but that are not installed yet. */
export function missingDependencies(dir: string): string[] {
  const missing: string[] = [];
  if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) missing.push('node_modules');
  return missing;
}

export interface RepoLink {
  owner?: string;
  name: string;
  /** Clone URLs to try in order: the link as https, then its ssh equivalent (when known). */
  urls: string[];
}

/**
 * Understands what people paste: clone URLs (https, ssh, scp-style) and browser links to a repo,
 * branch, PR or file on GitHub, GitLab, Bitbucket and Azure DevOps.
 */
export function parseRepoLink(input: string): RepoLink | undefined {
  const u = input.trim().replace(/[?#].*$/, '');
  if (!u) return undefined;

  // scp-style: git@host:owner/repo.git (clone it exactly as given)
  const scp = /^([\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u);
  if (scp) {
    const parts = scp[3].replace(/\.git\/?$/, '').split('/').filter(Boolean);
    if (parts.length === 0) return undefined;
    const name = parts[parts.length - 1];
    const owner = parts[0] === 'v3' && parts.length >= 4 ? parts[1] : parts.length >= 2 ? parts[parts.length - 2] : undefined;
    return { owner, name, urls: [u] };
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return undefined;

  if (url.protocol === 'ssh:') {
    const name = parts[parts.length - 1];
    const owner = parts[0] === 'v3' && parts.length >= 4 ? parts[1] : parts.length >= 2 ? parts[parts.length - 2] : undefined;
    return { owner, name, urls: [u] };
  }

  // Azure DevOps: https://[org@]dev.azure.com/<org>/<project>/_git/<repo>[/...]
  const gitIdx = parts.indexOf('_git');
  if ((host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) && gitIdx >= 1 && parts[gitIdx + 1]) {
    const org = host === 'dev.azure.com' ? parts[0] : host.split('.')[0];
    const project = parts[gitIdx - 1];
    const name = parts[gitIdx + 1];
    const https = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`;
    return { owner: org, name, urls: [https, `git@ssh.dev.azure.com:v3/${org}/${encodeURIComponent(project)}/${encodeURIComponent(name)}`] };
  }

  // GitHub / Bitbucket: owner/repo, anything after it is a page within the repo.
  if (host === 'github.com' || host === 'www.github.com' || host === 'bitbucket.org') {
    if (parts.length < 2) return undefined;
    const [owner, name] = parts;
    const h = host.replace(/^www\./, '');
    return { owner, name, urls: [`https://${h}/${owner}/${name}.git`, `git@${h}:${owner}/${name}.git`] };
  }

  // GitLab (and similar): nested groups; pages within the repo start at "/-/".
  const dash = parts.indexOf('-');
  const repoParts = dash > 0 ? parts.slice(0, dash) : parts;
  if (repoParts.length < 1) return undefined;
  const name = repoParts[repoParts.length - 1];
  const owner = repoParts.length >= 2 ? repoParts[repoParts.length - 2] : undefined;
  const p = repoParts.join('/');
  const urls = [`${url.protocol}//${url.host}/${p}.git`];
  if (host === 'gitlab.com' || dash > 0) urls.push(`git@${url.hostname}:${p}.git`);
  return { owner, name, urls };
}

function isAuthError(message: string): boolean {
  return /could not read Username|Authentication failed|terminal prompts disabled|Permission denied|403|401|could not read from remote|Repository not found/i.test(message);
}

/**
 * Clones without ever prompting (there is no terminal to answer). When the first URL fails on
 * authentication, the next one is tried (e.g. ssh after https). Returns the URL that worked.
 */
export async function clone(urls: string[], dir: string): Promise<string> {
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
  const errors: string[] = [];
  for (const url of urls) {
    try {
      await runOk('git', ['clone', '--', url, dir], { timeout: 30 * 60_000, env });
      return url;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${url}: ${msg}`);
      fs.rmSync(dir, { recursive: true, force: true }); // a failed clone can leave an empty folder
      if (!isAuthError(msg)) break;
    }
  }
  throw new Error(errors.join('\n'));
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await runOk('git', ['-C', repo, 'worktree', 'prune']);
}

/** Main repository of a worktree (or the repo itself). */
export async function mainRepoOf(dir: string): Promise<string | undefined> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) return undefined;
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : undefined;
}
