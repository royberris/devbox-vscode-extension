import * as fs from 'fs';
import { run } from './exec';
import { shQuote } from './util';

/**
 * Whether an agent CLI can be started: an executable absolute path, or a name on the PATH of a
 * login shell (agents run in `<shell> -lc`, so ~/.profile additions count).
 */
export async function commandAvailable(command: string, shell: string, timeout = 15_000): Promise<boolean> {
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  const r = await run(shell, ['-lc', `command -v -- ${shQuote(command)} >/dev/null`], { timeout });
  return r.code === 0;
}
