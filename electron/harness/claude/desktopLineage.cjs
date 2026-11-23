// Which Claude Code chats a Claude desktop chat started (its side sessions), read only from Claude desktop's session files.
// The links nest the sidebar; they grant no family authority, which stays with chats MoPilot itself started.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How many session files are read at once. */
const BATCH = 16;
const SESSION_FILE = /^local_[\w-]+\.json$/;

/** @typedef {{ local: string, cli: string | null, parent: string | null, createdAt: number }} DesktopSession */

/** What a session file says of its place, or null when it says nothing usable. @returns {DesktopSession | null} */
function sessionOf(data) {
  if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string') return null;
  const cli = [data.cliSessionId, data.lastAssistantCliSessionId].find((v) => typeof v === 'string' && v) ?? null;
  const from = data.spawnedFrom;
  // Claude desktop keeps the provenance of a detached session: it no longer nests there either
  const parent = !data.lineageDetached && from && typeof from.sessionId === 'string' ? from.sessionId : null;
  return { local: data.sessionId, cli, parent, createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0 };
}

/**
 * Child transcript id → its parent's transcript id and when it started. A session without a transcript, a parent that
 * is not on file, or a link to itself is left out.
 * @param {DesktopSession[]} sessions
 * @returns {Record<string, { parentId: string, createdAt: number }>}
 */
function lineageOf(sessions) {
  const cliOf = new Map(sessions.map((s) => [s.local, s.cli]));
  /** @type {Record<string, { parentId: string, createdAt: number }>} */
  const out = {};
  for (const s of sessions) {
    const parentId = s.parent ? cliOf.get(s.parent) : null;
    if (s.cli && parentId && parentId !== s.cli) out[s.cli] = { parentId, createdAt: s.createdAt };
  }
  return out;
}

/**
 * Reads claude-code-sessions/<account>/<org>/local_*.json under Claude desktop's data folder; a file is parsed again
 * only when its size or modification time changed, and reads asked while one runs share it.
 * @param {{ appData: () => string, fsp?: typeof fs.promises }} o `appData`: Claude desktop's data folder
 */
function createDesktopLineage(o) {
  const appData = o.appData;
  const fsp = o.fsp ?? fs.promises;
  /** @type {Map<string, { stamp: string, session: DesktopSession | null }>} */
  const parsed = new Map();
  /** @type {Promise<Record<string, { parentId: string, createdAt: number }>> | null} */
  let running = null;

  const dirs = async (dir) => {
    try {
      return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch (error) {
      noteIgnored("list Claude desktop's sessions", error, ['ENOENT', 'ENOTDIR']);
      return [];
    }
  };

  async function sessionFiles() {
    const files = [];
    for (const account of await dirs(path.join(appData(), 'claude-code-sessions')))
      for (const org of await dirs(account)) {
        const names = await fsp.readdir(org).catch((error) => (noteIgnored("list Claude desktop's sessions", error, ['ENOENT']), []));
        for (const name of names) if (SESSION_FILE.test(name)) files.push(path.join(org, name));
      }
    return files;
  }

  async function readOne(file) {
    try {
      const st = await fsp.stat(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = parsed.get(file);
      if (hit && hit.stamp === stamp) return hit.session;
      const session = sessionOf(JSON.parse(await fsp.readFile(file, 'utf8')));
      parsed.set(file, { stamp, session });
      return session;
    } catch (error) {
      // a file Claude desktop is writing or just removed: read again next time
      parsed.delete(file);
      noteIgnored("read a Claude desktop session's file", error, ['ENOENT']);
      return null;
    }
  }

  async function readAll() {
    const files = await sessionFiles();
    const known = new Set(files);
    for (const file of parsed.keys()) if (!known.has(file)) parsed.delete(file);
    /** @type {DesktopSession[]} */
    const sessions = [];
    for (let i = 0; i < files.length; i += BATCH)
      for (const s of await Promise.all(files.slice(i, i + BATCH).map(readOne))) if (s) sessions.push(s);
    return lineageOf(sessions);
  }

  return {
    read() {
      running ??= readAll().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

module.exports = { createDesktopLineage, lineageOf, sessionOf };
