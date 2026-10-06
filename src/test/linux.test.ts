import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, test } from 'node:test';
import * as git from '../core/git';
import { processScanSupported, scanAgentProcesses } from '../core/processes';
import { OPT, SESSION_ENV, Tmux } from '../core/tmux';

/** Separate tmux server per test run, so tests never touch the user's sessions. */
const SOCKET = `devbox-agents-test-${process.pid}`;
const tmuxCmd = (...args: string[]) => execFileSync('tmux', ['-L', SOCKET, ...args]).toString();
after(() => {
  // tmux leaves the socket file behind after its server exits.
  const dir = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`);
  fs.rmSync(path.join(dir, SOCKET), { force: true });
});

/** Runs against real git, tmux and /proc. Skipped where those are not available (e.g. macOS without tmux). */

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

test('worktree lifecycle refuses dirty worktrees', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-agents-git-'));
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = path.join(base, 'worktrees', 'repo', 'task');
  await git.addWorktree(repo, wt, 'agent/task', 'main');
  assert.deepEqual((await git.listWorktrees(repo)).map((w) => w.branch), ['main', 'agent/task']);
  assert.equal(await git.mainRepoOf(wt), fs.realpathSync(repo));
  assert.ok(await git.branchExists(repo, 'agent/task'));

  fs.writeFileSync(path.join(wt, 'new.txt'), 'x');
  assert.deepEqual(await git.uncommittedChanges(wt), ['?? new.txt']);
  await assert.rejects(git.removeWorktree(repo, wt), /modified or untracked/);
  assert.ok(fs.existsSync(wt));

  fs.unlinkSync(path.join(wt, 'new.txt'));
  await git.removeWorktree(repo, wt);
  assert.ok(!fs.existsSync(wt));
  fs.rmSync(base, { recursive: true, force: true });
});

test('tmux session lifecycle and process scan', { skip: !hasTmux || !processScanSupported() }, async () => {
  const tmux = new Tmux('tmux', SOCKET);
  const name = 'agent-session';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-agents-tmux-'));
  await tmux.newSession({
    name,
    cwd: dir,
    argv: ['/bin/sh', '-c', 'sleep 60'],
    env: { [SESSION_ENV]: name },
    options: { [OPT.agent]: 'claude', [OPT.worktree]: dir, [OPT.branch]: 'agent/x', [OPT.repo]: undefined },
  });
  try {
    const s = (await tmux.listSessions()).find((x) => x.name === name);
    assert.ok(s, 'session listed');
    assert.equal(s.agent, 'claude');
    assert.equal(s.worktree, dir);
    assert.equal(s.repo, undefined);
    const pane = (await tmux.listPanes()).find((p) => p.session === name);
    assert.ok(pane && pane.pid > 0);
    assert.equal(tmuxCmd('show-environment', '-t', name, SESSION_ENV).trim(), `${SESSION_ENV}=${name}`);
    // No agents run on CI; this checks the /proc walk itself does not throw and returns a list.
    assert.ok(Array.isArray(scanAgentProcesses(new Map([[pane.pid, name]]))));
  } finally {
    await tmux.killSession(name);
  }
  assert.equal(await tmux.hasSession(name), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server without sessions counts as empty, not as an error', { skip: !hasTmux }, async () => {
  const tmux = new Tmux('tmux', SOCKET);
  assert.deepEqual(await tmux.listSessions(), [], 'no server running');
  assert.deepEqual(await tmux.listPanes(), [], 'no server running');
  // With exit-empty off the server stays up after its last session is gone; then
  // `list-panes -a` fails with "no current target" (seen in the wild, issue: stale session list).
  tmuxCmd('start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
  try {
    assert.deepEqual(await tmux.listSessions(), []);
    assert.deepEqual(await tmux.listPanes(), []);
    assert.equal(await tmux.hasSession('gone'), false);
  } finally {
    tmuxCmd('kill-server');
  }
});
