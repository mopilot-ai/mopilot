// The Tasks panel's four tabs (M0a), derived on every read from what MoMo already keeps plus the user's own marks (taskMarks.cjs): Active (cards waiting, loops due soon, routine runs going, runs that did not finish in the last day, finished runs Ready for review until the user marks them done), Up next (open loops awake and not due soon: the suggestion store is a later change, A7), Scheduled (the user's approved routines with their next run) and Resolved (loops the user closed and runs the user marked done or archived, 30 days). Ids are the sources' own, so they survive a restart; nothing here writes anything or completes a task: only the user's mark moves a run out of Active.
const { clip, dayOf, cardTaskId } = require('./tasks.cjs');

/** A loop due within this long (or past due) is on Active; later or undated is Up next. */
const DUE_SOON_MS = 24 * 3600_000;
/** A run that did not finish is shown this long after it ended. */
const FAILED_SHOWN_MS = 24 * 3600_000;
/** A run that finished waits for the user's mark this long, then leaves the list unmarked. */
const REVIEW_SHOWN_MS = 7 * 86_400_000;
/** Resolved shows what was closed or marked this long (the marks and the runs are kept no longer). */
const RESOLVED_SHOWN_MS = 30 * 86_400_000;
/** A run still open after this long is not shown as running (tasks.cjs RUN_SHOWN_MS). */
const RUN_OPEN_SHOWN_MS = 2 * 3600_000;
const MAX_PER_TAB = 100;

/**
 * @typedef {{ id: string, kind: 'card' | 'loop' | 'run' | 'routine' | 'brief', tab: 'active' | 'next' | 'scheduled' | 'resolved',
 *   state: 'needs-you' | 'running' | 'failed' | 'review' | 'queued' | 'scheduled' | 'done' | 'dismissed' | 'archived',
 *   title: string, detail: string | null, at: number | null, dueAt: number | null, dueDay: string | null, ref: string,
 *   outcome: string | null, nextAt: number | null, paused: boolean, channel: { id: string, name: string } | null, chatId: string | null }} PanelTask
 *   `channel`, `chatId`: a card waiting in a channel names it and the chat it waits in (A2); null for main's cards and every other kind
 *   `at`: when it started, ended, was said or closed (a routine's: when its run going started, else null); `outcome`: how a run ended (completed, stopped, failed, interrupted);
 *   `nextAt`, `paused`: a routine's next run and whether it is paused; `ref`: the id the source's own call takes
 */

/** @typedef {{ state: 'scheduled' | 'failed' | 'suspended', nextAt: number | null, reason: string | null }} BriefRow the morning brief's row (brief.cjs) */

/** @param {Partial<PanelTask> & Pick<PanelTask, 'id' | 'kind' | 'tab' | 'state' | 'title' | 'ref'>} t @returns {PanelTask} */
const task = (t) => ({
  detail: null,
  at: null,
  dueAt: null,
  dueDay: null,
  outcome: null,
  nextAt: null,
  paused: false,
  channel: null,
  chatId: null,
  ...t,
});

/**
 * @param {object} o
 * @param {{ chatId: string, taskId: string, startedAt: number, endedAt?: number, outcome?: string }[]} o.runs the routine runs the store keeps (30 days)
 * @param {(taskId: string) => string | null | undefined} o.routineName
 * @param {{ id: string, name: string, status: string, rrule: string }[]} o.routines the routines the user approved
 * @param {(rrule: string, after: number) => Date | null} o.nextRun when a rule runs next (the scheduler's, null for a rule that never does)
 * @param {{ id: string, text: string, quote?: string, state: string, saidAt: number, closedAt?: number, dueAt?: number, dueDay?: string, snoozedUntil?: number }[]} o.loops
 * @param {{ id: string | number, params?: { momo?: { summary?: string, tool?: string, source?: string } }, channel?: { id: string, name: string } | null, chatId?: string }[]} o.cards the momoAction cards waiting in MoMo's main chat and its channels' chats (tasks.cjs waitingCards)
 * @param {Record<string, { mark: 'done' | 'archived' | 'deleted', at: number }>} o.marks the user's marks, by task id
 * @param {BriefRow | null} [o.brief] the morning brief's row (brief.cjs), null while it is off
 * @param {number} o.now
 * @returns {PanelTask[]} the four tabs' rows together, each tab in its own order, at most MAX_PER_TAB each
 */
function deriveTaskPanel({ runs, routineName, routines, nextRun, loops, cards, marks, now, brief = null }) {
  const soon = now + DUE_SOON_MS;
  const dueSoon = (/** @type {(typeof loops)[number]} */ l) =>
    l.dueAt !== undefined ? l.dueAt <= soon : l.dueDay !== undefined && l.dueDay <= dayOf(soon);
  const awake = loops
    .filter((l) => l.state === 'open' && !(typeof l.snoozedUntil === 'number' && l.snoozedUntil > now))
    // the soonest due first, then the ones with no date, newest said first
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.saidAt - a.saidAt || a.id.localeCompare(b.id));
  const loopRow = (/** @type {(typeof loops)[number]} */ l, /** @type {'active' | 'next'} */ tab) =>
    task({
      id: `loop:${l.id}`,
      kind: 'loop',
      tab,
      state: tab === 'active' ? 'needs-you' : 'queued',
      title: clip(l.text, 'A reminder'),
      detail: l.quote ? clip(l.quote, '') : null,
      at: l.saidAt,
      dueAt: l.dueAt ?? null,
      dueDay: l.dueDay ?? (l.dueAt === undefined ? null : dayOf(l.dueAt)),
      ref: l.id,
    });
  const name = (/** @type {string} */ taskId) => clip(routineName(taskId), 'A routine');
  const runRow = (/** @type {(typeof runs)[number]} */ r, /** @type {Partial<PanelTask> & Pick<PanelTask, 'tab' | 'state'>} */ o) =>
    task({ id: `run:${r.chatId}`, kind: 'run', title: name(r.taskId), ref: r.chatId, at: r.startedAt, outcome: r.outcome ?? null, ...o });

  /** @type {PanelTask[]} */
  const active = cards.map((c) =>
    task({
      id: cardTaskId(c),
      kind: 'card',
      tab: 'active',
      state: 'needs-you',
      title: clip(c.params?.momo?.summary || c.params?.momo?.tool, 'MoMo needs your OK'),
      detail: c.params?.momo?.source ? clip(c.params.momo.source, '') : null,
      ref: String(c.id),
      channel: c.channel ?? null,
      chatId: c.chatId ?? null,
    }),
  );
  active.push(...awake.filter(dueSoon).map((l) => loopRow(l, 'active')));
  /** @type {PanelTask[]} */
  const resolved = [];
  const byNewest = (/** @type {PanelTask} */ a, /** @type {PanelTask} */ b) =>
    /** @type {number} */ (b.at) - /** @type {number} */ (a.at) || a.id.localeCompare(b.id);
  /** @type {PanelTask[]} */
  const running = [];
  /** @type {PanelTask[]} */
  const failed = [];
  /** @type {PanelTask[]} */
  const review = [];
  for (const r of [...runs].sort((a, b) => b.startedAt - a.startedAt || a.chatId.localeCompare(b.chatId))) {
    const mark = marks[`run:${r.chatId}`];
    if (r.endedAt === undefined) {
      if (now - r.startedAt < RUN_OPEN_SHOWN_MS) running.push(runRow(r, { tab: 'active', state: 'running' }));
    } else if (mark?.mark === 'deleted') continue;
    else if (mark) {
      if (now - mark.at < RESOLVED_SHOWN_MS)
        resolved.push(runRow(r, { tab: 'resolved', state: mark.mark === 'done' ? 'done' : 'archived', at: mark.at }));
    } else if (r.outcome !== 'completed') {
      if (now - r.endedAt < FAILED_SHOWN_MS) failed.push(runRow(r, { tab: 'active', state: 'failed', at: r.endedAt }));
    } else if (now - r.endedAt < REVIEW_SHOWN_MS) review.push(runRow(r, { tab: 'active', state: 'review', at: r.endedAt }));
  }
  active.push(...running, ...failed, ...review);
  for (const l of loops)
    if (l.state !== 'open' && now - (l.closedAt ?? l.saidAt) < RESOLVED_SHOWN_MS)
      resolved.push(
        task({
          id: `loop:${l.id}`,
          kind: 'loop',
          tab: 'resolved',
          state: l.state === 'done' ? 'done' : 'dismissed',
          title: clip(l.text, 'A reminder'),
          detail: l.quote ? clip(l.quote, '') : null,
          at: l.closedAt ?? l.saidAt,
          ref: l.id,
        }),
      );
  const next = awake.filter((l) => !dueSoon(l)).map((l) => loopRow(l, 'next'));
  const scheduled = routines
    .map((r) => {
      // a run of it going (the schedule's or the user's Run now): its row says Working, and since when
      const going = runs.find((x) => x.taskId === r.id && x.endedAt === undefined && now - x.startedAt < RUN_OPEN_SHOWN_MS);
      return task({
        id: `routine:${r.id}`,
        kind: 'routine',
        tab: 'scheduled',
        state: 'scheduled',
        // a routine's `at`: when its run going started (the schedule's or the user's Run now), null while none; its state stays
        // scheduled so a reader that knows only that keeps the row as it was (the phone's)
        at: going ? going.startedAt : null,
        title: clip(r.name, 'A routine'),
        ref: r.id,
        paused: r.status === 'PAUSED',
        nextAt: r.status === 'PAUSED' ? null : (nextRun(r.rrule, now)?.getTime() ?? null),
      });
    })
    // running ones by their next time, paused ones after, by name
    .sort(
      (a, b) => Number(a.paused) - Number(b.paused) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || a.title.localeCompare(b.title),
    );
  // the morning brief: its next time, why it is suspended, or why it could not start (with Try again where it is shown)
  if (brief)
    scheduled.unshift(
      task({
        id: 'brief:morning',
        kind: 'brief',
        tab: 'scheduled',
        // a brief that could not start says so; one suspended is a paused row
        state: brief.state === 'failed' ? 'failed' : 'scheduled',
        title: 'Morning brief',
        detail: brief.reason,
        ref: 'momo.brief',
        paused: brief.state === 'suspended',
        nextAt: brief.nextAt,
      }),
    );
  return [active, next, scheduled, resolved.sort(byNewest)].flatMap((tab) => tab.slice(0, MAX_PER_TAB));
}

module.exports = { deriveTaskPanel, DUE_SOON_MS, FAILED_SHOWN_MS, REVIEW_SHOWN_MS, RESOLVED_SHOWN_MS, MAX_PER_TAB };
