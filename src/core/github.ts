/** Owner and name of a GitHub repository, from a remote URL (https, ssh or scp-style). */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/:]+@)(?:www\.)?github\.com(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export interface MergedPull {
  number: number;
  title: string;
  url: string;
  /** Last commit of the PR branch; the local branch is only deleted when it contains nothing newer. */
  headSha: string;
}

interface ApiPull {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

/** The most recently merged PR from `branch` in `owner/repo` itself (not a fork). */
export function pickMergedPull(pulls: ApiPull[], owner: string, repo: string, branch: string): MergedPull | undefined {
  const full = `${owner}/${repo}`.toLowerCase();
  const p = pulls
    .filter((p) => p.merged_at && p.head.ref === branch && p.head.repo?.full_name.toLowerCase() === full)
    .sort((a, b) => Date.parse(b.merged_at!) - Date.parse(a.merged_at!))[0];
  return p && { number: p.number, title: p.title, url: p.html_url, headSha: p.head.sha };
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Asks the GitHub REST API for a merged PR from `branch`. */
export async function findMergedPull(owner: string, repo: string, branch: string, token: string, fetchFn: typeof fetch = fetch): Promise<MergedPull | undefined> {
  const q = new URLSearchParams({ state: 'closed', head: `${owner}:${branch}`, sort: 'updated', direction: 'desc', per_page: '20' });
  const res = await fetchFn(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${q}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devbox-agents' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new GitHubError(`GitHub API ${res.status} for ${owner}/${repo}`, res.status);
  return pickMergedPull((await res.json()) as ApiPull[], owner, repo, branch);
}
