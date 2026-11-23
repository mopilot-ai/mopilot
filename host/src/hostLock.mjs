// The Host's data-dir lock, `host.lock`: one Host per data dir. A pid alone cannot say who holds it, since after a reboot the same number can be any other process (or this one), so the holder also has to have started before the lock was written.
import fs from 'node:fs';
import net from 'node:net';
import { isAlive, startedAfterWriting } from './children.mjs';

/** How long a socket may stay silent before it counts as a Host answering. */
const ANSWER_MS = 1000;

/** Whether something answers on the Host's socket; silence counts as yes, since refusing a start is safer than two Hosts. @param {string} socketPath @param {typeof net.connect} connect @param {number} answerMs @returns {Promise<boolean>} */
function socketAnswers(socketPath, connect, answerMs) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const done = (/** @type {boolean} */ answer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(true), answerMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Take the lock, replacing one a dead process left behind or one whose pid has since become another process. A holder that started before the lock was written holds it, also before it listens (a Host still starting); so does one the core can't date. One that started later holds it only if the socket answers.
 * @param {object} o
 * @param {string} o.lockPath
 * @param {string} o.socketPath
 * @param {(pid: number) => Promise<number | null> | number | null} [o.startOf]
 * @param {typeof net.connect} [o.connect]
 * @param {number} [o.answerMs]
 */
export async function takeLock({ lockPath, socketPath, startOf, connect = net.connect, answerMs = ANSWER_MS }) {
  const write = () => fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    write();
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
    const holder = Number(fs.readFileSync(lockPath, 'utf8'));
    // 0 or below is no process (kill(0, 0) would ask about this Host's own group): what a crash between creating the lock and writing it leaves
    if (Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)) {
      const held = new Error(`Another Host (pid ${holder}) already uses this data dir.`);
      const writtenAt = fs.statSync(lockPath).mtimeMs;
      if (!(await startedAfterWriting(holder, writtenAt, startOf)) || (await socketAnswers(socketPath, connect, answerMs))) throw held;
      // the socket check waited: a lock another starter wrote meanwhile is that starter's
      if (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs !== writtenAt) throw held;
    }
    // renaming the stale lock away succeeds for one starter only; the others find nothing to move and then fail to create it
    try {
      fs.renameSync(lockPath, `${lockPath}.stale.${process.pid}`);
      fs.rmSync(`${lockPath}.stale.${process.pid}`, { force: true });
    } catch {
      // another starter already moved it
    }
    write();
  }
}
