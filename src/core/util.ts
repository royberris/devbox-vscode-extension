import * as os from 'os';
import * as path from 'path';

export type AgentKind = 'claude' | 'codex';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/** True if `child` is `parent` or lies below it. */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Quote a string for POSIX shells. */
export function shQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function slugify(s: string, max = 40): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

const ADJECTIVES = ['amber', 'brave', 'calm', 'eager', 'fuzzy', 'gentle', 'happy', 'jolly', 'keen', 'lucky', 'mellow', 'nimble', 'plucky', 'quiet', 'rapid', 'sunny', 'tidy', 'witty'];
const NOUNS = ['otter', 'falcon', 'badger', 'heron', 'lynx', 'marten', 'newt', 'orca', 'puffin', 'quokka', 'raven', 'seal', 'tapir', 'walrus', 'wombat', 'yak', 'zebra', 'gecko'];

export function randomSlug(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** tmux session names may not contain '.' or ':'. */
export function tmuxSafe(name: string): string {
  return name.replace(/[.:\s]+/g, '-');
}

export function repoShortName(repoDir: string, aliases: Record<string, string>): string {
  const base = path.basename(repoDir);
  return tmuxSafe(aliases[base] ?? slugify(base, 24)) || 'repo';
}

export function oneLine(s: string, max = 90): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
