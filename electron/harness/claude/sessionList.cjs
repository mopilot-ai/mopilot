// The Claude Code session list in pages cut from one listing: the SDK's listSessions reads transcripts' heads and tails
// up to the end of the page asked for on every call, so paging a long history read the first pages' transcripts again
// for each later page, and every caller listing at launch (the sidebar, the auto-archive sweep) read them all again.
const { clock } = require('../../platform/ports/clock.cjs');

/** How long a listing serves the later pages of a read that started with it (and is kept in memory). */
const SNAPSHOT_MS = 10_000;
/** How long reads join a listing that has not answered: one that hangs is let go, and the reads after it list again. */
const RUNNING_MS = 60_000;
/** Every session in one call: with a limit the SDK keeps its newest-first scan of a few transcripts at a time. */
const EVERY = Number.MAX_SAFE_INTEGER;

/**
 * @typedef {{ sessionId: string, cwd?: string } & Record<string, unknown>} SessionSummary
 * @typedef {{ list: Promise<SessionSummary[]>, running: boolean, timer?: ReturnType<typeof setTimeout> }} Listing
 * @param {() => Promise<{ listSessions: (o: { limit: number, offset: number }) => Promise<SessionSummary[]> }>} sdk
 * @param {(page: SessionSummary[]) => Promise<void>} backfill fills in what a page's sessions lack (their cwd)
 */
function createSessionList(sdk, backfill) {
  /** The latest listing: running until it answers, then kept SNAPSHOT_MS. */
  /** @type {Listing | null} */
  let snapshot = null;

  /** @param {Listing} entry @param {number} ms */
  function letGoAfter(entry, ms) {
    clock.clearTimeout(entry.timer);
    entry.timer = clock.setTimeout(() => snapshot === entry && (snapshot = null), ms);
    entry.timer.unref?.();
  }

  function listAll() {
    /** @type {Listing} */
    const entry = { list: sdk().then((s) => s.listSessions({ limit: EVERY, offset: 0 })), running: true };
    snapshot = entry;
    letGoAfter(entry, RUNNING_MS);
    entry.list.then(
      () => {
        entry.running = false;
        // the sessions are let go once no read can still be paging through them
        letGoAfter(entry, SNAPSHOT_MS);
      },
      () => {
        // a failed listing serves no page after it: the next read lists again
        clock.clearTimeout(entry.timer);
        if (snapshot === entry) snapshot = null;
      },
    );
    return entry.list;
  }

  /**
   * A first page lists afresh, or joins a listing still running (it started no earlier than the read asking). A later
   * page is cut from the listing its read's first page took, so the pages also agree with one another; a page asked for
   * once that listing was let go lists afresh.
   */
  function listing(offset) {
    if (snapshot && (snapshot.running || offset > 0)) return snapshot.list;
    return listAll();
  }

  /**
   * Sessions newest first, from `offset`; a limit of 0 or less takes the rest, as the SDK does.
   * @param {number} limit
   * @param {number} [offset]
   */
  async function page(limit, offset = 0) {
    const all = await listing(offset);
    const rows = all.slice(offset, limit > 0 ? offset + limit : undefined);
    await backfill(rows);
    return rows;
  }

  return page;
}

module.exports = { createSessionList, SNAPSHOT_MS, RUNNING_MS, EVERY };
