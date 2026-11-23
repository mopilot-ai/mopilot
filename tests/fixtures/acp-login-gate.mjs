// Coordinates fake ACP terminal login completion with the test that observes its embedded terminal.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const holdPath = (state) => path.join(state, 'login-hold');
const readHold = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** One harness owns this state directory. Overlapping holds are rejected, and stale releases cannot delete a newer token. */
export function holdAcpLogin(state) {
  fs.mkdirSync(state, { recursive: true });
  const file = holdPath(state);
  const token = randomUUID();
  fs.writeFileSync(file, token, { flag: 'wx' });
  return () => {
    if (readHold(file) === token) fs.unlinkSync(file);
  };
}

/** argv carries this state directory: terminal-auth bypasses the acp-bin wrapper and its FAKE_ACP_* environment. */
export async function waitForAcpLoginRelease(state) {
  const file = holdPath(state);
  const token = readHold(file);
  if (token === null) return;
  await new Promise((resolve, reject) => {
    let watcher;
    let deadline;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(undefined);
    };
    const check = () => {
      try {
        const current = readHold(file);
        if (current === null) finish(undefined);
        else if (current !== token) finish(new Error('Fake ACP login hold was replaced before release'));
      } catch (error) {
        finish(error);
      }
    };
    try {
      watcher = fs.watch(state, check);
      watcher.on('error', finish);
      // Only a failure watchdog: successful login requires an explicit release, never elapsed time.
      deadline = setTimeout(() => finish(new Error('Fake ACP login hold was not released')), 120_000);
      check(); // A release between the initial read and watch registration must not be missed.
    } catch (error) {
      finish(error);
    }
  });
}
