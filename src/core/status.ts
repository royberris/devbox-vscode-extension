import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shQuote, type AgentKind } from './util';
import { SESSION_ENV } from './tmux';

/**
 * Waiting-agent detection. Agents call a small hook script on state changes; the script dumps
 * the raw hook payload into <statusDir>/<key>.json and this module interprets it. The script
 * needs only bash and coreutils (no jq), so it works on any box.
 */

export type AgentState = 'running' | 'waiting' | 'idle' | 'ended';

export interface AgentStatus {
  key: string;
  agent: AgentKind;
  /** tmux session the agent runs in, when started by this extension. */
  tmuxSession?: string;
  state: AgentState;
  message?: string;
  cwd?: string;
  chatId?: string;
  at: Date;
}

export function defaultStatusDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'devbox-agents', 'status');
}

export function defaultHookScriptPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devbox-agents', 'agent-hook.sh');
}

export function hookScript(statusDir: string): string {
  return `#!/usr/bin/env bash
# Installed by the Devbox Agents VS Code extension. Records an agent's state so the
# extension can show which agents are running, waiting for you, or done.
#   Claude Code hook:  agent-hook.sh claude      (hook JSON on stdin)
#   Codex notify:      agent-hook.sh codex '<json>'
# Always exits 0 and prints nothing, so it can never block or alter the agent.
dir=${shQuote(statusDir)}
agent=\${1:-claude}
if [[ $agent == codex ]]; then input=\${2:-}; else input=$(cat); fi
[[ $input == "{"* ]] || exit 0
mkdir -p "$dir" 2>/dev/null || exit 0
key=\${${SESSION_ENV}:-}
if [[ -z $key ]]; then
  id=$(printf '%s' "$input" | grep -o -m1 -E '"(session_id|thread-id|thread_id)" *: *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\\1/')
  key="$agent-\${id:-pid$PPID}"
fi
key=\${key//[^A-Za-z0-9_.-]/_}
tmux_session=\${${SESSION_ENV}:-}
tmux_session=\${tmux_session//[^A-Za-z0-9_.@+-]/_}
tmp="$dir/.$key.$$"
printf '{"agent":"%s","tmuxSession":"%s","ts":%s,"input":%s}\\n' "$agent" "$tmux_session" "$(date +%s)" "$input" > "$tmp" 2>/dev/null \\
  && mv -f "$tmp" "$dir/$key.json" 2>/dev/null
rm -f "$tmp" 2>/dev/null
exit 0
`;
}

/** Interpret one status file. */
export function parseStatus(key: string, text: string): AgentStatus | undefined {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  const input = o?.input ?? {};
  const agent: AgentKind = o.agent === 'codex' ? 'codex' : 'claude';
  const base = {
    key,
    agent,
    tmuxSession: typeof o.tmuxSession === 'string' && o.tmuxSession ? o.tmuxSession : undefined,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    at: new Date((Number(o.ts) || 0) * 1000),
  };
  if (agent === 'codex') {
    const type = String(input.type ?? '');
    const chatId = input['thread-id'] ?? input.thread_id;
    const last = input['last-assistant-message'];
    if (/approval|permission|elicitation/.test(type)) return { ...base, chatId, state: 'waiting', message: typeof input.message === 'string' ? input.message : 'Codex needs your approval' };
    if (type === 'agent-turn-complete') return { ...base, chatId, state: 'idle', message: typeof last === 'string' ? last : undefined };
    return undefined;
  }
  const chatId = typeof input.session_id === 'string' ? input.session_id : undefined;
  const msg = typeof input.message === 'string' ? input.message : undefined;
  switch (input.hook_event_name) {
    case 'Notification': {
      const idle = input.notification_type === 'idle_prompt' || /waiting for your input/i.test(msg ?? '');
      return { ...base, chatId, state: idle ? 'idle' : 'waiting', message: msg };
    }
    case 'PermissionRequest':
      return { ...base, chatId, state: 'waiting', message: msg ?? `Claude wants to use ${input.tool_name ?? 'a tool'}` };
    case 'Stop':
    case 'SessionStart':
      return { ...base, chatId, state: 'idle' };
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return { ...base, chatId, state: 'running' };
    case 'SessionEnd':
      return { ...base, chatId, state: 'ended' };
    default:
      return undefined;
  }
}

export function readStatuses(dir: string): AgentStatus[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const out: AgentStatus[] = [];
  for (const f of files) {
    try {
      const s = parseStatus(f.slice(0, -5), fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s) out.push(s);
    } catch {
      // vanished between readdir and read
    }
  }
  return out;
}

export function deleteStatus(dir: string, key: string): void {
  try {
    fs.unlinkSync(path.join(dir, `${key}.json`));
  } catch {
    // already gone
  }
}

// ---- installers -------------------------------------------------------------------------------

const CLAUDE_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
];

const MARKER = 'devbox-agents/agent-hook.sh';

/**
 * Returns the new settings.json text with our hooks merged in, or undefined when they are
 * already present. Throws when the existing file is not valid JSON (we never overwrite it then).
 */
export function mergeClaudeHooks(existing: string | undefined, scriptPath: string): string | undefined {
  const settings = existing && existing.trim() ? JSON.parse(existing) : {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error('settings.json is not a JSON object');
  const command = `${shQuote(scriptPath)} claude`;
  settings.hooks ??= {};
  let changed = false;
  for (const { event, matcher } of CLAUDE_EVENTS) {
    const groups: any[] = (settings.hooks[event] ??= []);
    const present = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(MARKER)));
    if (present) continue;
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
    changed = true;
  }
  return changed ? JSON.stringify(settings, null, 2) + '\n' : undefined;
}

export type CodexMergeResult = { kind: 'unchanged' } | { kind: 'conflict'; line: string } | { kind: 'updated'; text: string };

/** Adds a top-level `notify = [...]` to config.toml unless one exists. */
export function mergeCodexNotify(existing: string | undefined, scriptPath: string): CodexMergeResult {
  const text = existing ?? '';
  const line = text.split('\n').find((l) => /^\s*notify\s*=/.test(l));
  if (line) return line.includes(MARKER) ? { kind: 'unchanged' } : { kind: 'conflict', line: line.trim() };
  // Top-level keys must come before the first [table], so prepend.
  const entry = `# Devbox Agents: report when Codex finishes a turn\nnotify = [${JSON.stringify(scriptPath)}, "codex"]\n\n`;
  return { kind: 'updated', text: entry + text };
}
