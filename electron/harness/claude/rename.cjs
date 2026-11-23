// Naming a Claude Code session so the name outlasts any transcript size: the SDK's title line plus Claude Code's own custom-title.json sidecar (#1932).
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../ignored.cjs');

let seq = 0;

/**
 * The SDK's listSessions/getSessionInfo read a title line only from a transcript's first and last 64 KB, so a name
 * appended once is lost as the chat grows past it. Where the tail has none they read
 * `<project>/<sessionId>/custom-title.json`. A running CLI keeps its session's title and appends it again as the
 * transcript grows, so it is named through its control channel, as Claude Code's own rename does (the line, the
 * sidecar and the title it keeps); otherwise this appends the line and writes the sidecar. A session's renames run
 * one at a time, so the newest one wins everywhere.
 * @param {() => Promise<any>} sdk
 * @param {(sessionId: string) => Promise<string | null>} findTranscript
 * @param {(sessionId: string) => any} live the session's running query, if its CLI runs
 * @returns {(sessionId: string, name: string) => Promise<void>} resolves once the name is kept (rejects if it is not)
 */
function createRename(sdk, findTranscript, live) {
  /** @type {Map<string, Promise<void>>} each session's newest rename */
  const last = new Map();

  async function write(sessionId, name) {
    const q = live(sessionId);
    if (q) {
      try {
        return await q.renameSession(name, sessionId);
      } catch (error) {
        // its CLI exited, or moved on to another session: name the transcript from outside
        noteIgnored('rename a running Claude Code session', error);
      }
    }
    await (await sdk()).renameSession(sessionId, name);
    const file = await findTranscript(sessionId);
    // the transcript was deleted meanwhile: nothing to name
    if (!file) return;
    const dir = path.join(path.dirname(file), sessionId);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // written whole, then moved in place: a reader never sees half a file
    const tmp = path.join(dir, `custom-title.json.tmp.${process.pid}.${++seq}`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify({ customTitle: name.trim() }), { mode: 0o600 });
      await fs.promises.rename(tmp, path.join(dir, 'custom-title.json'));
    } catch (error) {
      await fs.promises.rm(tmp, { force: true });
      throw error;
    }
  }

  return (sessionId, name) => {
    const go = () => write(sessionId, name);
    const prev = last.get(sessionId);
    // after the one before it, whether that one failed or not (its caller heard that)
    const run = prev ? prev.then(go, go) : go();
    last.set(sessionId, run);
    const done = () => {
      if (last.get(sessionId) === run) last.delete(sessionId);
    };
    run.then(done, done);
    return run;
  };
}

module.exports = { createRename };
