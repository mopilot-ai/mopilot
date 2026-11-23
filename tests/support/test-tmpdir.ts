// Give each test process its own temp folder (TMPDIR) and remove it when the process exits, so fixtures that never clean up cannot fill the OS temp folder.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Set to the folder a test process owns; a test process it starts (which inherits TMPDIR) keeps using that folder
 * instead of nesting one more, and leaves removing it to its owner.
 */
export const OWNED = 'MOPILOT_TEST_TMPDIR';
/** Short, so socket paths that tests build under os.tmpdir() stay within the 104-byte limit for a Unix socket. */
export const PARENT = 'mpt';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
};

/**
 * Point os.tmpdir() at a new `<tmp>/mpt/<pid>-XXXXXX` for this process and remove it on exit. A process killed
 * before its exit handler ran (a timeout's SIGKILL) leaves its folder; the next test process removes every folder
 * whose pid is gone. Returns the folder this process uses.
 */
export function isolateTmpdir({
  env = process.env,
  fs = nodeFs,
  pid = process.pid,
  isAlive = alive,
  onExit = (handler: () => void) => process.on('exit', handler),
}: {
  env?: Record<string, string | undefined>;
  fs?: Pick<typeof nodeFs, 'mkdirSync' | 'mkdtempSync' | 'readdirSync' | 'rmSync'>;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  onExit?: (handler: () => void) => unknown;
} = {}) {
  const inherited = env[OWNED];
  if (inherited && env.TMPDIR === inherited) return inherited;
  const parent = path.join(os.tmpdir(), PARENT);
  fs.mkdirSync(parent, { recursive: true });
  for (const name of fs.readdirSync(parent)) {
    const owner = Number(name.split('-')[0]);
    if (!Number.isInteger(owner) || owner === pid || isAlive(owner)) continue;
    try {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    } catch {
      /* a folder a killed test left unwritable: leave it rather than fail every test process that starts after it */
    }
  }
  const dir = fs.mkdtempSync(path.join(parent, `${pid}-`));
  env.TMPDIR = dir;
  env[OWNED] = dir;
  onExit(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a file still held open: the next test process removes the folder once this pid is gone */
    }
  });
  return dir;
}
