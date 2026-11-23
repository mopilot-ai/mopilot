// A Claude Code chat's turns as main's readers take them: a read on the turns worker, or on this thread when the worker is gone,
// and what each reader cuts from it: a page for a window, every turn for main itself, or the replies alone.
const { noteIgnored } = require('../../ignored.cjs');
const { historyPage, releaseHistory, allTurns: turnsOfRead } = require('../../platform/claudeHistory.cjs');

/**
 * @param {{ state: import('./state.cjs').ClaudeState, turnsWorker: any, findTranscript: (sessionId: string) => Promise<string | null>,
 *   readTurnPage: Function }} o
 */
function createTurnReads({ state, turnsWorker, findTranscript, readTurnPage }) {
  /**
   * A page of a session's turns for the window, as JSON it parses (`{ turns, olderCursor, closedTail }`, newest last, with the
   * cursor for the page before it) and those turns' ids. They are built from the whole transcript, so what spans turns (a
   * background agent that settles turns later) reads as one replay has it, and only the page crosses to the window: its turns
   * are a small part of the raw messages. The read is off this thread, and the page comes in one step on it.
   * @param {string} sessionId
   * @param {{ chatId?: unknown, cwd?: unknown, liveTail?: unknown, closedTail?: unknown, open?: unknown, limit?: unknown, before?: unknown } | null} [opts]
   * @param {() => string | null} [liveTurn] the turn the session is running here: a turn left open takes its id
   */
  async function turns(sessionId, opts, liveTurn = () => null) {
    const o = opts ?? {};
    const before = typeof o.before === 'string' && o.before ? o.before : null;
    const limit = Number.isSafeInteger(o.limit) && Number(o.limit) > 0 ? Number(o.limit) : 0;
    const chatId = typeof o.chatId === 'string' && o.chatId ? o.chatId : `claude:${sessionId}`;
    const cwd = typeof o.cwd === 'string' ? o.cwd : '';
    const asked = { liveTail: o.liveTail === true, closedTail: o.closedTail === true, open: o.open === true, limit, before };
    const req = { sessionId, file: await findTranscript(sessionId), chatId, cwd };
    return cutPage(req, (read) => historyPage(read, { ...asked, live: liveTurn() }));
  }

  /**
   * A page of a session's turns as main's claude:turns answers: the JSON, and beside it the saved diffs of this page's turns, as of
   * the step that cut it, which the window lays on the turns it parses.
   * @param {string} sessionId @param {Parameters<typeof turns>[1]} opts
   * @param {{ liveTurn: (key: string) => string | null, diffs: (key: string, ids: string[]) => Record<string, string> }} [pages]
   *   liveTurn: the turn a session is running here; diffs: what each of its turns changed in its folder, by turn id
   */
  async function windowPage(sessionId, opts, pages) {
    const key = `claude:${sessionId}`;
    const { page, ids } = await turns(sessionId, opts, () => pages?.liveTurn(key) ?? null);
    return { page, diffs: pages?.diffs(key, ids) ?? {} };
  }

  /**
   * What `cut` makes of a read of `req`. A read that isn't kept goes when it is done with, on every path. A read can go before
   * it is cut, as a kept one leaves the cache or the worker that holds it dies: it is read again, outside the cache, where nothing
   * else can take it and a kept read that died isn't handed back.
   * @template T
   * @param {any} req @param {(read: number, answer: { read: number, kept: boolean, whole?: boolean, dangling?: boolean, compacted?: boolean }) => T | Promise<T>} cut
   * @returns {Promise<T>}
   */
  async function cutPage(req, cut, tries = 0) {
    const answer = await readOffMain(req);
    const { read, kept } = answer;
    try {
      return await cut(read, answer);
    } catch (error) {
      if (tries >= 2) throw new Error('This Claude Code chat could not be read', { cause: error });
      noteIgnored('cut a page of a Claude Code chat', error);
    } finally {
      if (!kept) releaseHistory(read);
    }
    return cutPage({ ...req, uncached: true }, cut, tries + 1);
  }

  /**
   * Every turn of a session, for main's own readers (a harness switch, a peer's history). `open`: main runs the chat's turn now.
   * A walk takes many steps, so its read is its own: a window's next read would otherwise push it out of the cache part way.
   * @param {string} sessionId @param {{ chatId?: string, cwd?: string, open?: boolean }} [o]
   */
  async function allTurns(sessionId, { chatId = `claude:${sessionId}`, cwd = '', open = false } = {}) {
    const req = { sessionId, file: await findTranscript(sessionId), chatId, cwd, uncached: true };
    return cutPage(req, (read) => turnsOfRead(read, { open }));
  }

  /**
   * The turns of the end of a session's transcript (its last `bytes`): what a reader that wants only the recent end needs, at a
   * cost that does not grow with the chat. `whole` says they are every turn of the chat; otherwise the first of them may have lost
   * its start to the window (a reader leaves it out), and earlier turns exist. `dangling` says a background task's notification is among
   * them with its launch before them: the core names that task by guess, so a reader wanting the whole read's turns reads a larger end.
   * `open`: main runs the chat's turn now.
   * @param {string} sessionId @param {{ chatId?: string, cwd?: string, open?: boolean, bytes: number }} o
   * @returns {Promise<{ turns: any[], whole: boolean, dangling: boolean, compacted: boolean }>}
   */
  async function recentTurns(sessionId, { chatId = `claude:${sessionId}`, cwd = '', open = false, bytes }) {
    const req = { sessionId, file: await findTranscript(sessionId), chatId, cwd, uncached: true, recent: { bytes } };
    return cutPage(req, async (read, answer) => ({
      turns: await turnsOfRead(read, { open }),
      whole: answer.whole !== false,
      dangling: answer.dangling === true,
      compacted: answer.compacted === true,
    }));
  }

  /**
   * A session's finished assistant replies, for readers that keep only prose (the sidebar's PR badge, #2963): parsed in
   * the worker and only the replies cross, so a chat with a huge transcript allocates nothing in the main process and
   * leaves no copy of its messages behind.
   * @param {string} sessionId
   * @param {{ cwd?: unknown } | null} [opts]
   */
  async function replies(sessionId, opts) {
    const cwd = typeof opts?.cwd === 'string' ? opts.cwd : '';
    return readOffMain({ sessionId, file: await findTranscript(sessionId), chatId: `claude:${sessionId}`, cwd, replies: true });
  }

  /** One request to the turns worker, read in this thread when the worker is gone. */
  async function readOffMain(req) {
    const { sessionId } = req;
    const cutoff = () => state.resumeAt.get(`claude:${sessionId}`);
    // a rewind or send during the read moves the cutoff: a page cut at the old one is read again, up to three times
    for (let tries = 0; turnsWorker && tries < 3; tries++) {
      const resumeAt = cutoff();
      try {
        const answer = await turnsWorker.read({ ...req, resumeAt });
        if (cutoff() === resumeAt) return answer;
        if (answer?.kept === false) releaseHistory(answer.read);
      } catch (error) {
        // an answer from the worker (the SDK could not read the session) is final; a worker that is gone is read around
        if (!error?.workerDown) throw error;
        noteIgnored('read a Claude Code chat in the worker', error);
        break;
      }
    }
    // in this thread the cutoff is taken once the reads have settled
    return readTurnPage({ sdk: await state.sdk() }, { ...req, resumeAt: cutoff });
  }

  return { turns, windowPage, allTurns, recentTurns, replies };
}

module.exports = { createTurnReads };
