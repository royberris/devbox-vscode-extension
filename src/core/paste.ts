import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Images pasted from the laptop's clipboard; the agent workspace shows this folder second. */
export function defaultPasteDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'devbox-agents', 'paste');
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_EXTS = new Set(Object.values(EXT));
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** One folder per tmux session, so the images go away with the session. */
export function sessionPasteDir(root: string, session: string): string {
  return path.join(root, session.replace(/[^A-Za-z0-9_-]+/g, '-') || 'session');
}

/** Writes a pasted image as `<timestamp>.<ext>` in `dir` and returns its path. */
export function saveImage(dir: string, mime: string, base64: string, now = new Date()): string {
  const ext = EXT[mime];
  if (!ext) throw new Error(`Unsupported image type ${mime || '(unknown)'}`);
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw new Error('The image is empty');
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace(/[:T]/g, '-');
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${stamp}${i === 1 ? '' : `-${i}`}.${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/**
 * Removes the images of sessions that no longer exist, and loose images directly in `root`.
 * Only image files are deleted; a session folder is removed once it is empty, so anything else
 * put there by hand stays.
 */
export function removeStaleImages(root: string, liveSessions: string[]): string[] {
  const live = new Set(liveSessions.map((s) => sessionPasteDir(root, s)));
  const removed: string[] = [];
  const images = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).slice(1)));
    } catch {
      return [];
    }
  };
  const remove = (file: string) => {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      // already gone
    }
  };
  for (const e of images(root)) remove(path.join(root, e.name));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    const dir = path.join(root, e.name);
    if (!e.isDirectory() || live.has(dir)) continue;
    for (const f of images(dir)) remove(path.join(dir, f.name));
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty: something else is in it, leave it
    }
  }
  return removed;
}
