import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { oneLine, type AgentKind } from './util';

/**
 * Reads chat history written by the agents themselves:
 *  - Claude Code: <configDir>/projects/<encoded-cwd>/<session-id>.jsonl
 *  - Codex:       <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl (+ session_index.jsonl for names)
 *  - Antigravity: <dataDir>/conversations/<conversation-id>.db (SQLite with protobuf blobs)
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

// ---- Antigravity (agy) ----------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true });

function readVarint(buf: Uint8Array, pos: number): [number, number] | undefined {
  let value = 0;
  for (let shift = 0; shift < 64 && pos < buf.length; shift += 7) {
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [value, pos];
  }
  return undefined;
}

function asText(buf: Uint8Array): string | undefined {
  try {
    const s = utf8.decode(buf);
    // printable text: no control characters except whitespace
    return s.length > 0 && !/[\x00-\x08\x0e-\x1f\x7f]/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text fields of a protobuf message, depth-first and in order. agy's schema is not public,
 * so this walks the wire format and treats every length-delimited field that is printable UTF-8
 * as text, and every other one as a nested message.
 */
export function protoStrings(buf: Uint8Array, out: string[] = [], depth = 0): string[] {
  const walk = (b: Uint8Array, d: number, acc: string[]): boolean => {
    let pos = 0;
    while (pos < b.length) {
      const key = readVarint(b, pos);
      if (!key || key[0] === 0) return false;
      pos = key[1];
      switch (key[0] % 8) {
        case 0: {
          const v = readVarint(b, pos);
          if (!v) return false;
          pos = v[1];
          break;
        }
        case 1:
          pos += 8;
          break;
        case 5:
          pos += 4;
          break;
        case 2: {
          const len = readVarint(b, pos);
          if (!len || len[1] + len[0] > b.length) return false;
          const sub = b.subarray(len[1], len[1] + len[0]);
          pos = len[1] + len[0];
          const text = asText(sub);
          if (text !== undefined) acc.push(text);
          else if (d < 12) {
            const nested: string[] = [];
            if (walk(sub, d + 1, nested)) acc.push(...nested);
          }
          break;
        }
        default:
          return false;
      }
      if (pos > b.length) return false;
    }
    return true;
  };
  const acc: string[] = [];
  if (walk(buf, depth, acc)) out.push(...acc);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace of a conversation: the first file:// URI in its metadata. */
export function agyCwd(strings: string[]): string | undefined {
  for (const s of strings) {
    const m = /^\s*(file:\/\/\/\S+)/.exec(s);
    if (!m) continue;
    try {
      return fileURLToPath(m[1]);
    } catch {
      // not a valid file URI
    }
  }
  return undefined;
}

/** The user's prompt in a user-input step: the first text field that reads like a sentence. */
export function agyPrompt(strings: string[]): string | undefined {
  return strings.find((s) => {
    const t = s.trim();
    return t.length > 1 && !UUID.test(t) && !/^[\[{]/.test(t) && !/^file:\/\//.test(t) && /\s/.test(t) && isRealPrompt(t);
  });
}

/** Step type of the user's input in agy's `steps` table. */
const AGY_USER_INPUT = 14;

type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => any };
let sqlite: SqliteModule | null | undefined;

/** node:sqlite exists from Node 22.5; older VS Code versions run an older Node. */
function loadSqlite(): SqliteModule | null {
  if (sqlite === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sqlite = require('node:sqlite') as SqliteModule;
    } catch {
      sqlite = null;
    }
  }
  return sqlite;
}

export interface AgyMeta {
  cwd?: string;
  prompt?: string;
}

export function readAgyConversation(file: string): AgyMeta {
  const mod = loadSqlite();
  if (mod) {
    const db = new mod.DatabaseSync(file, { readOnly: true });
    try {
      const meta = db.prepare('SELECT data FROM trajectory_metadata_blob').all() as { data?: Uint8Array }[];
      const step = db.prepare('SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx LIMIT 1').get(AGY_USER_INPUT) as
        | { step_payload?: Uint8Array }
        | undefined;
      return {
        cwd: agyCwd(meta.flatMap((r) => (r.data ? protoStrings(r.data) : []))),
        prompt: step?.step_payload ? agyPrompt(protoStrings(step.step_payload)) : undefined,
      };
    } finally {
      db.close();
    }
  }
  // Without SQLite: the workspace URI is stored as plain text somewhere in the file.
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /file:\/\/\/[^\s"'\x00-\x1f\x7f-\xff]+/.exec(buf.toString('latin1'));
    return { cwd: m ? agyCwd([m[0]]) : undefined };
  } finally {
    fs.closeSync(fd);
  }
}

export function readAgyHistory(dataDir: string, since: Date): Chat[] {
  const dir = path.join(dataDir, 'conversations');
  const chats: Chat[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  } catch {
    return chats;
  }
  const withSqlite = loadSqlite() !== null;
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      if (st.mtime < since || st.size === 0) continue;
      const m = readAgyConversation(file);
      if (withSqlite && !m.prompt) continue; // no user input: an empty or internal conversation
      chats.push({
        agent: 'agy',
        id: path.basename(f, '.db'),
        cwd: m.cwd,
        title: oneLine(m.prompt ?? '(Antigravity chat)'),
        started: st.birthtime.getTime() > 0 ? st.birthtime : undefined,
        updated: st.mtime,
        file,
      });
    } catch {
      // locked, unreadable or vanished file: skip
    }
  }
  return chats;
}
