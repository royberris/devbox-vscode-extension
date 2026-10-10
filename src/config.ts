import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultStatusDir } from './core/status';
import { expandHome, type AgentKind } from './core/util';

export interface AgentConfig {
  enabled: boolean;
  command: string;
  args: string[];
}

export interface Config {
  repoRoots: string[];
  repoScanDepth: number;
  extraRepos: string[];
  worktreesRoot: string;
  branchPrefix: string;
  defaultBaseBranch: string;
  fetchBeforeNewSession: boolean;
  repoAliases: Record<string, string>;
  agents: Record<AgentKind, AgentConfig>;
  claudeConfigDir: string;
  codexHome: string;
  agyDataDir: string;
  tmuxPath: string;
  shell: string;
  sessionEnv: Record<string, string>;
  focusMode: 'activeSessions' | 'swapFolder' | 'addFolder' | 'newWindow' | 'terminalOnly';
  terminalLocation: 'panel' | 'editor';
  connectIdeOnFocus: boolean;
  refreshInterval: number;
  historyDays: number;
  historyMaxPerGroup: number;
  statusDir: string;
  notify: string[];
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('devboxAgents');
  const str = (key: string, fallback: string) => (c.get<string>(key) || '').trim() || fallback;
  const agent = (kind: AgentKind): AgentConfig => ({
    enabled: c.get<boolean>(`${kind}.enabled`, true),
    command: expandHome(str(`${kind}.command`, kind)),
    args: c.get<string[]>(`${kind}.args`, []),
  });
  return {
    repoRoots: c.get<string[]>('repoRoots', ['~/repos']).map(expandHome),
    repoScanDepth: c.get<number>('repoScanDepth', 2),
    extraRepos: c.get<string[]>('extraRepos', []).map(expandHome),
    worktreesRoot: expandHome(str('worktreesRoot', '~/worktrees')),
    branchPrefix: c.get<string>('branchPrefix', 'agent/'),
    defaultBaseBranch: str('defaultBaseBranch', 'main'),
    fetchBeforeNewSession: c.get<boolean>('fetchBeforeNewSession', true),
    repoAliases: c.get<Record<string, string>>('repoAliases', {}),
    agents: { claude: agent('claude'), codex: agent('codex'), agy: agent('agy') },
    claudeConfigDir: expandHome(str('claude.configDir', process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))),
    codexHome: expandHome(str('codex.home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))),
    agyDataDir: expandHome(str('agy.dataDir', path.join(os.homedir(), '.gemini', 'antigravity-cli'))),
    tmuxPath: expandHome(str('tmuxPath', 'tmux')),
    shell: expandHome(str('shell', process.env.SHELL || '/bin/bash')),
    sessionEnv: c.get<Record<string, string>>('sessionEnv', {}),
    focusMode: c.get('focusMode', 'activeSessions'),
    terminalLocation: c.get('terminalLocation', 'panel'),
    connectIdeOnFocus: c.get<boolean>('connectIdeOnFocus', false),
    refreshInterval: Math.max(1, c.get<number>('refreshInterval', 5)),
    historyDays: Math.max(1, c.get<number>('history.days', 30)),
    historyMaxPerGroup: Math.max(1, c.get<number>('history.maxPerGroup', 50)),
    statusDir: expandHome(str('statusDir', defaultStatusDir())),
    notify: c.get<string[]>('notify', ['waiting', 'idle']),
  };
}
