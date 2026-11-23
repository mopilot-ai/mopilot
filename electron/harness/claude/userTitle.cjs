// The name a Claude Code chat was given, as opposed to the title its CLI writes for itself: the SDK's getSessionInfo
// reports both as `customTitle` (it falls back to the CLI's `ai-title`), so a new chat looked "named" within seconds
// and its generated title was never saved (electron/harness/claude/title.cjs).
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How much of the transcript's start and end is searched, as the SDK does: a title line sits near one of them. */
const SPAN = 64 * 1024;

/** The last `custom-title` line's name in `text` (a chunk of a transcript), or ''. */
function lastCustomTitle(text) {
  let found = '';
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim())
        found = entry.customTitle.trim();
    } catch (error) {
      // a line cut by the chunk's edge
      noteIgnored('read a Claude Code title line', error);
    }
  }
  return found;
}

/**
 * @param {(sessionId: string) => Promise<string | null>} findTranscript
 * @returns {(sessionId: string) => Promise<string | null>} the session's own name (its last `custom-title`, or the
 *   sidecar custom-title.json that outlasts the transcript's size), or null when only the CLI has titled it; rejects
 *   when the transcript can't be read, so a caller never takes an unknown name for none
 */
function createUserTitle(findTranscript) {
  return async (sessionId) => {
    const file = await findTranscript(sessionId);
    if (!file) return null;
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const read = async (start, length) => {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, start);
        return buf.toString('utf8', 0, bytesRead);
      };
      const tail = await read(Math.max(0, size - SPAN), Math.min(size, SPAN));
      const head = size > SPAN ? await read(0, SPAN) : '';
      const inline = lastCustomTitle(tail) || lastCustomTitle(head);
      if (inline) return inline;
    } finally {
      await handle.close();
    }
    try {
      const sidecar = JSON.parse(await fs.promises.readFile(path.join(path.dirname(file), sessionId, 'custom-title.json'), 'utf8'));
      return typeof sidecar?.customTitle === 'string' && sidecar.customTitle.trim() ? sidecar.customTitle.trim() : null;
    } catch (error) {
      // no sidecar is the usual answer; an unreadable one is not "no name"
      if (error?.code !== 'ENOENT') throw error;
      return null;
    }
  };
}

module.exports = { createUserTitle };
