import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tmuxSafe } from './util';

/** Images pasted from the laptop's clipboard; the agent workspace shows this folder second. */
export function defaultPasteDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'devbox-agents', 'paste');
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Writes a pasted image as `<session>-<timestamp>.<ext>` and returns its path. */
export function saveImage(dir: string, session: string, mime: string, base64: string, now = new Date()): string {
  const ext = EXT[mime];
  if (!ext) throw new Error(`Unsupported image type ${mime || '(unknown)'}`);
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw new Error('The image is empty');
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace(/[:T]/g, '-');
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${tmuxSafe(session)}-${stamp}${i === 1 ? '' : `-${i}`}.${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Removes pasted images older than `days`. Only touches image files directly in `dir`. */
export function pruneImages(dir: string, days: number, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const exts = new Set(Object.values(EXT));
  for (const name of names) {
    if (!exts.has(path.extname(name).slice(1))) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && now - st.mtimeMs > days * 86_400_000) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch {
      // gone or unreadable: skip
    }
  }
  return removed;
}
