import * as fs from 'fs';
import * as path from 'path';
import { oneLine, type AgentKind } from './util';

/**
 * Reads chat history written by the agents themselves:
 *  - Claude Code: <configDir>/projects/<encoded-cwd>/<session-id>.jsonl
 *  - Codex:       <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl (+ session_index.jsonl for names)
 * Only the head and tail of each file are read; transcripts can be large.
 */

export interface Chat {
  agent: AgentKind;
  id: string;
  cwd?: string;
  title: string;
  started?: Date;
  updated: Date;
  file: string;
}

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 128 * 1024;

function readSlices(file: string, size: number): { head: string[]; tail: string[] } {
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const headLines = head.toString('utf8').split('\n');
    if (headLen < size) headLines.pop(); // last line is probably cut off
    let tailLines: string[] = [];
    if (size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, size - headLen);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      tailLines = tail.toString('utf8').split('\n');
      tailLines.shift(); // first line is probably cut off
    }
    return { head: headLines, tail: tailLines };
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line: string): any {
  if (!line || line[0] !== '{') return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c.text === 'string' && (c.type === 'text' || c.type === 'input_text')) return c.text;
    }
  }
  return undefined;
}

/** Skip injected context, slash-command wrappers and the like. */
function isRealPrompt(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('# AGENTS.md') && !t.startsWith('Caveat:');
}

export interface ClaudeMeta {
  id?: string;
  cwd?: string;
  title?: string;
  firstPrompt?: string;
  started?: Date;
}

export function parseClaudeLines(head: string[], tail: string[]): ClaudeMeta {
  const meta: ClaudeMeta = {};
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let summary: string | undefined;
  for (const line of [...head, ...tail]) {
    const o = parse(line);
    if (!o) continue;
    if (!meta.id && typeof o.sessionId === 'string') meta.id = o.sessionId;
    if (!meta.cwd && typeof o.cwd === 'string') meta.cwd = o.cwd;
    if (!meta.started && typeof o.timestamp === 'string' && o.type === 'user') meta.started = new Date(o.timestamp);
    // later lines win: titles get refined over the course of a chat
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
    if (o.type === 'summary' && typeof o.summary === 'string') summary = o.summary;
    if (!meta.firstPrompt && o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const text = textOf(o.message?.content);
      if (text && isRealPrompt(text)) meta.firstPrompt = text;
    }
  }
  meta.title = customTitle ?? aiTitle ?? summary ?? meta.firstPrompt;
  return meta;
}

export interface CodexMeta {
  id?: string;
  cwd?: string;
  firstPrompt?: string;
  started?: Date;
}

export function parseCodexLines(head: string[]): CodexMeta {
  const meta: CodexMeta = {};
  for (const line of head) {
    const o = parse(line);
    if (!o) continue;
    const p = o.payload;
    if (o.type === 'session_meta' && p) {
      meta.id ??= p.id ?? p.session_id;
      meta.cwd ??= p.cwd;
      if (!meta.started && p.timestamp) meta.started = new Date(p.timestamp);
    } else if (!meta.firstPrompt && o.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
      const text = textOf(p.content);
      if (text && isRealPrompt(text)) meta.firstPrompt = text;
    } else if (!meta.firstPrompt && o.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string') {
      if (isRealPrompt(p.message)) meta.firstPrompt = p.message;
    }
    if (meta.id && meta.cwd && meta.firstPrompt) break;
  }
  return meta;
}

export function readClaudeHistory(configDir: string, since: Date): Chat[] {
  const projects = path.join(configDir, 'projects');
  const chats: Chat[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return chats;
  }
  for (const dir of dirs) {
    const full = path.join(projects, dir);
    let files: string[];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      try {
        const st = fs.statSync(file);
        if (st.mtime < since || st.size === 0) continue;
        const { head, tail } = readSlices(file, st.size);
        const m = parseClaudeLines(head, tail);
        if (!m.title && !m.firstPrompt) continue; // opened and closed without a prompt
        chats.push({
          agent: 'claude',
          id: m.id ?? path.basename(f, '.jsonl'),
          cwd: m.cwd,
          title: oneLine(m.title ?? '(untitled)'),
          started: m.started,
          updated: st.mtime,
          file,
        });
      } catch {
        // unreadable or vanished file: skip
      }
    }
  }
  return chats;
}

function readCodexNames(codexHome: string): Map<string, string> {
  const names = new Map<string, string>();
  const text = (() => {
    try {
      return fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8');
    } catch {
      return '';
    }
  })();
  for (const line of text.split('\n')) {
    const o = parse(line);
    if (o && typeof o.id === 'string' && typeof o.thread_name === 'string') names.set(o.id, o.thread_name);
  }
  return names;
}

export function readCodexHistory(codexHome: string, since: Date, now = new Date()): Chat[] {
  const chats: Chat[] = [];
  const names = readCodexNames(codexHome);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Day folders are named after the chat's local start date. Walk one extra day on both sides
  // so timezone differences don't drop a folder.
  const DAY = 86_400_000;
  for (let t = since.getTime() - DAY; t <= now.getTime() + DAY; t += DAY) {
    const day = new Date(t);
    const dir = path.join(codexHome, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.mtime < since) continue;
        const m = parseCodexLines(readSlices(file, st.size).head);
        const id = m.id ?? /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(f)?.[1];
        if (!id) continue;
        const title = names.get(id) ?? m.firstPrompt;
        if (!title) continue;
        chats.push({ agent: 'codex', id, cwd: m.cwd, title: oneLine(title), started: m.started, updated: st.mtime, file });
      } catch {
        // unreadable or vanished file: skip
      }
    }
  }
  return chats;
}
