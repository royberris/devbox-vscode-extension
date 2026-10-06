import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { findRepos, missingDependencies, parseRepoLink, parseStatus as parseGitStatus, parseWorktrees } from '../core/git';
import { parseClaudeLines, parseCodexLines, readClaudeHistory, readCodexHistory } from '../core/history';
import { kindOf, parseStat } from '../core/processes';
import { hookScript, mergeClaudeHooks, mergeCodexNotify, parseStatus, readStatuses } from '../core/status';
import { isEmptyServerError, parsePanes, parseSessions } from '../core/tmux';
import { isWithin, repoShortName, shQuote, slugify, tmuxSafe } from '../core/util';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-agents-test-'));

test('util', () => {
  assert.equal(shQuote('plain/path-1.2'), 'plain/path-1.2');
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(slugify('  Fix Login: café! '), 'fix-login-cafe');
  assert.equal(tmuxSafe('a.b:c d'), 'a-b-c-d');
  assert.equal(repoShortName('/r/org/web_Thing', {}), 'web-thing');
  assert.equal(repoShortName('/r/org/web_Thing', { web_Thing: 'thing' }), 'thing');
  assert.ok(isWithin('/a/b/c', '/a/b'));
  assert.ok(!isWithin('/a/bc', '/a/b'));
});

test('tmux parsing', () => {
  const s = parseSessions('main\t1791270611\t1\t\t\t\t\t\nproj-x\t1791270000\t0\tclaude\t/r/proj\t/w/proj/x\tagent/x\torigin/main\n');
  assert.equal(s.length, 2);
  assert.equal(s[0].agent, undefined);
  assert.equal(s[1].agent, 'claude');
  assert.equal(s[1].worktree, '/w/proj/x');
  assert.equal(s[1].created.getTime(), 1791270000_000);
  assert.ok(isEmptyServerError('no current target'));
  assert.ok(isEmptyServerError('no server running on /tmp/tmux-1000/default'));
  assert.ok(!isEmptyServerError("can't find session: x"));
  const p = parsePanes('123\tmain\t/home/u\tbash\t1\n');
  assert.deepEqual(p[0], { pid: 123, session: 'main', cwd: '/home/u', command: 'bash', active: true });
});

test('git worktree parsing', () => {
  const w = parseWorktrees('worktree /r/a\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/a/x\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.equal(w.length, 2);
  assert.equal(w[0].branch, 'main');
  assert.ok(w[1].detached && w[1].prunable);
});

test('git status parsing', () => {
  assert.deepEqual(parseGitStatus('## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\n'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changes: 2 });
  assert.deepEqual(parseGitStatus('## feature/x\n'), { branch: 'feature/x', upstream: undefined, ahead: 0, behind: 0, changes: 0 });
  assert.deepEqual(parseGitStatus('## No commits yet on main\n'), { branch: 'main', upstream: undefined, ahead: 0, behind: 0, changes: 0 });
  assert.equal(parseGitStatus('## HEAD (no branch)\n').branch, undefined);
});

test('repository link parsing', () => {
  const gh = { owner: 'acme', name: 'my-api', urls: ['https://github.com/acme/my-api.git', 'git@github.com:acme/my-api.git'] };
  assert.deepEqual(parseRepoLink('https://github.com/acme/my-api'), gh);
  assert.deepEqual(parseRepoLink('https://github.com/acme/my-api.git'), gh);
  assert.deepEqual(parseRepoLink('https://github.com/acme/my-api/tree/main/src?x=1#L3'), gh);
  assert.deepEqual(parseRepoLink('https://github.com/acme/my-api/pull/12'), gh);
  assert.deepEqual(parseRepoLink('github.com/acme/my-api'), gh);
  assert.deepEqual(parseRepoLink('git@github.com:acme/my-api.git'), { owner: 'acme', name: 'my-api', urls: ['git@github.com:acme/my-api.git'] });
  assert.deepEqual(parseRepoLink('https://gitlab.com/group/sub/proj/-/tree/main'), {
    owner: 'sub', name: 'proj', urls: ['https://gitlab.com/group/sub/proj.git', 'git@gitlab.com:group/sub/proj.git'],
  });
  assert.deepEqual(parseRepoLink('https://acme@dev.azure.com/acme/My%20Project/_git/web_App?path=/x'), {
    owner: 'acme', name: 'web_App', urls: ['https://dev.azure.com/acme/My%20Project/_git/web_App', 'git@ssh.dev.azure.com:v3/acme/My%20Project/web_App'],
  });
  assert.equal(parseRepoLink('git@ssh.dev.azure.com:v3/acme/Project/web_App')?.owner, 'acme');
  assert.equal(parseRepoLink('ssh://git@host.example/team/repo.git')?.name, 'repo');
  assert.equal(parseRepoLink(''), undefined);
  assert.equal(parseRepoLink('https://github.com/acme'), undefined);
});

test('missing dependencies', () => {
  const dir = tmp();
  assert.deepEqual(missingDependencies(dir), []);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.deepEqual(missingDependencies(dir), ['node_modules']);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.deepEqual(missingDependencies(dir), []);
});

test('findRepos skips worktrees and dot dirs', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'org/repo1/.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'org/.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'org/wt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'org/wt/.git'), 'gitdir: /x');
  assert.deepEqual(findRepos([root], 2), [path.join(root, 'org/repo1')]);
  assert.deepEqual(findRepos([root], 1), []);
  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(findRepos([root], 2), [path.join(root, 'org/repo1')], 'a root with its own .git is still searched');
});

test('process classification', () => {
  assert.equal(kindOf('/home/u/.local/share/claude/versions/2.1.291', 'claude'), 'claude');
  assert.equal(kindOf('/home/u/.local/share/claude/versions/2.1.290 (deleted)', 'claude'), 'claude');
  assert.equal(kindOf('/home/u/.vscode-server/extensions/anthropic.claude-code-2/resources/native-binary/claude', 'claude'), 'claude');
  assert.equal(kindOf('/usr/bin/node', 'node /home/u/.npm-global/bin/codex'), 'codex');
  assert.equal(kindOf('/x/codex-x86_64-unknown-linux-musl', '/x/codex app-server --managed-daemon'), 'codex-daemon');
  assert.equal(kindOf('/usr/bin/node', 'node /home/u/.vscode-server/bin/x/out/server-main.js'), undefined);
  assert.equal(kindOf('/usr/bin/bash', 'bash -lc claude'), undefined);
  assert.deepEqual(parseStat('42 (tmux: server) S 1 42 42 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 98765 1 2'), { ppid: 1, startTicks: 98765 });
});

test('claude history parsing', () => {
  const lines = [
    '{"type":"mode","mode":"normal","sessionId":"s1"}',
    '{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x"},"cwd":"/r/a","sessionId":"s1","timestamp":"2026-10-06T08:00:00Z"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"make it work"}]},"cwd":"/r/a","sessionId":"s1","timestamp":"2026-10-06T08:01:00Z"}',
  ];
  let m = parseClaudeLines(lines, []);
  assert.equal(m.id, 's1');
  assert.equal(m.cwd, '/r/a');
  assert.equal(m.title, 'make it work');
  m = parseClaudeLines(lines, ['{"type":"ai-title","aiTitle":"First","sessionId":"s1"}', '{"type":"ai-title","aiTitle":"Better","sessionId":"s1"}']);
  assert.equal(m.title, 'Better');
  m = parseClaudeLines(lines, ['{"type":"custom-title","customTitle":"Mine"}', '{"type":"ai-title","aiTitle":"Better"}']);
  assert.equal(m.title, 'Mine');
});

test('codex history parsing', () => {
  const m = parseCodexLines([
    '{"type":"session_meta","payload":{"id":"c1","cwd":"/r/b","timestamp":"2026-10-06T07:28:36Z"}}',
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /r/b"}]}}',
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}',
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list versions"}]}}',
  ]);
  assert.deepEqual([m.id, m.cwd, m.firstPrompt], ['c1', '/r/b', 'list versions']);
});

test('history readers on disk', () => {
  const claude = tmp();
  fs.mkdirSync(path.join(claude, 'projects/-r-a'), { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'projects/-r-a/s1.jsonl'),
    '{"type":"user","message":{"role":"user","content":"hello"},"cwd":"/r/a","sessionId":"s1","timestamp":"2026-10-06T08:01:00Z"}\n',
  );
  fs.writeFileSync(path.join(claude, 'projects/-r-a/empty.jsonl'), '{"type":"mode","sessionId":"e"}\n');
  const chats = readClaudeHistory(claude, new Date(0));
  assert.equal(chats.length, 1);
  assert.equal(chats[0].title, 'hello');

  const codex = tmp();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = path.join(codex, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-x-01a1101d-4661-7231-80a6-ac426b880568.jsonl'), '{"type":"session_meta","payload":{"id":"01a1101d-4661-7231-80a6-ac426b880568","cwd":"/r/b"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"do it"}}\n');
  fs.writeFileSync(path.join(codex, 'session_index.jsonl'), '{"id":"01a1101d-4661-7231-80a6-ac426b880568","thread_name":"Named thread"}\n');
  const cx = readCodexHistory(codex, new Date(now.getTime() - 3_600_000), now);
  assert.equal(cx.length, 1);
  assert.equal(cx[0].title, 'Named thread');
});

test('status parsing', () => {
  const st = (input: object, agent = 'claude', tmuxSession = 'p-x') => parseStatus('k', JSON.stringify({ agent, tmuxSession, ts: 100, input }));
  assert.equal(st({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })?.state, 'waiting');
  assert.equal(st({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })?.state, 'idle');
  assert.equal(st({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })?.state, 'idle');
  assert.equal(st({ hook_event_name: 'Stop' })?.state, 'idle');
  assert.equal(st({ hook_event_name: 'PostToolUse' })?.state, 'running');
  assert.equal(st({ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': 'ok' }, 'codex')?.state, 'idle');
  assert.equal(st({ hook_event_name: 'Stop' })?.tmuxSession, 'p-x');
  assert.equal(st({ hook_event_name: 'Stop' }, 'claude', '')?.tmuxSession, undefined);
});

test('hook script end to end', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const statusDir = path.join(dir, 'status');
  const script = path.join(dir, 'agent-hook.sh');
  fs.writeFileSync(script, hookScript(statusDir), { mode: 0o755 });
  execFileSync('bash', ['-n', script]);
  const env = { ...process.env, DEVBOX_AGENTS_SESSION: 'proj-fix' };
  execFileSync(script, ['claude'], { input: '{"session_id":"abc","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","cwd":"/r/a"}', env });
  const env2 = { ...process.env };
  delete env2.DEVBOX_AGENTS_SESSION;
  execFileSync(script, ['claude'], { input: '{"session_id": "abc-123", "hook_event_name": "Stop"}', env: env2 });
  execFileSync(script, ['codex', '{"type":"agent-turn-complete","thread-id":"t-9","cwd":"/r/b"}'], { env: env2 });
  execFileSync(script, ['claude'], { input: 'not json', env: env2 });
  const all = readStatuses(statusDir).sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(
    all.map((s) => [s.key, s.agent, s.state, s.tmuxSession ?? '']),
    [
      ['claude-abc-123', 'claude', 'idle', ''],
      ['codex-t-9', 'codex', 'idle', ''],
      ['proj-fix', 'claude', 'waiting', 'proj-fix'],
    ],
  );
  assert.deepEqual(fs.readdirSync(statusDir).filter((f) => f.startsWith('.')), []);
});

test('claude hooks merge keeps existing settings', () => {
  const existing = JSON.stringify({ permissions: { deny: ['Read(~/.ssh/**)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  const merged = mergeClaudeHooks(existing, '/h/devbox-agents/agent-hook.sh')!;
  const o = JSON.parse(merged);
  assert.deepEqual(o.permissions, { deny: ['Read(~/.ssh/**)'] });
  assert.equal(o.hooks.Stop.length, 2);
  assert.equal(o.hooks.PostToolUse[0].matcher, '*');
  assert.equal(o.hooks.Notification[0].hooks[0].command, '/h/devbox-agents/agent-hook.sh claude');
  assert.equal(mergeClaudeHooks(merged, '/h/devbox-agents/agent-hook.sh'), undefined);
  assert.throws(() => mergeClaudeHooks('{ broken', '/x'));
});

test('codex notify merge', () => {
  const r = mergeCodexNotify('approval_policy = "on-request"\n[tui]\nx = 1\n', '/h/devbox-agents/agent-hook.sh');
  assert.equal(r.kind, 'updated');
  if (r.kind === 'updated') {
    assert.ok(r.text.indexOf('notify =') < r.text.indexOf('[tui]'));
    assert.equal(mergeCodexNotify(r.text, '/h/devbox-agents/agent-hook.sh').kind, 'unchanged');
  }
  assert.equal(mergeCodexNotify('notify = ["other"]\n', '/x').kind, 'conflict');
});
