import * as vscode from 'vscode';
import type { Config } from './config';
import { commandAvailable } from './core/agents';
import { AGENT_KINDS, type AgentKind } from './core/util';

/** A missing CLI is checked again after this long, so an agent installed later shows up. */
const RECHECK_MISSING_MS = 60_000;

/** Which agents are enabled in the settings and installed on this machine. */
export class AgentAvailability {
  private readonly cache = new Map<string, { at: number; available: Promise<boolean> }>();

  constructor(private readonly cfg: () => Config, private readonly log: vscode.OutputChannel) {}

  clear(): void {
    this.cache.clear();
  }

  async isInstalled(kind: AgentKind): Promise<boolean> {
    const c = this.cfg();
    const command = c.agents[kind].command;
    const key = `${c.shell}\0${command}`;
    const hit = this.cache.get(key);
    // installed stays installed until clear(); a missing one is checked again after a while
    if (hit && ((await hit.available) || Date.now() - hit.at < RECHECK_MISSING_MS)) return hit.available;
    return this.check(key, kind, command, c.shell);
  }

  private check(key: string, kind: AgentKind, command: string, shell: string): Promise<boolean> {
    const available = commandAvailable(command, shell).then((ok) => {
      this.log.appendLine(`[agents] ${kind}: ${command} ${ok ? 'found' : 'not found'}`);
      return ok;
    });
    this.cache.set(key, { at: Date.now(), available });
    return available;
  }

  async available(): Promise<AgentKind[]> {
    const c = this.cfg();
    const kinds = AGENT_KINDS.filter((k) => c.agents[k].enabled);
    const ok = await Promise.all(kinds.map((k) => this.isInstalled(k)));
    return kinds.filter((_, i) => ok[i]);
  }

  /** Context keys `devboxAgents.agent.<kind>` drive the per-agent menu entries. */
  async updateContext(): Promise<AgentKind[]> {
    const kinds = await this.available();
    for (const k of AGENT_KINDS) void vscode.commands.executeCommand('setContext', `devboxAgents.agent.${k}`, kinds.includes(k));
    return kinds;
  }
}
