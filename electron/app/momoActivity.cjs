// MoMo's activity in main (momo/activity.cjs over main's services): routine runs from MoMo's routine store, errands from its own chats' saved history, steps worded as Chrome's side panel words them, and each change told to paired phones as momo.changed {area:'activity', id}. The same on every harness, with no window open.
const { createMomoActivity } = require('../momo/activity.cjs');
const { createHistoryReader } = require('./chromePanelHistory.cjs');
const { stepOf } = require('../capabilities/browser/chromePanelLive.cjs');
const { stateOfCall } = require('../capabilities/browser/chromePanelToolLines.cjs');
const { isMomoMeta, isMomoDataMeta } = require('../../shared/momoChat.mjs');
const { notAllowed } = require('../momo/mainChat.cjs');

/** Told to the windows showing MoMo's activity when an item changed (the id of what changed). */
const ACTIVITY_CHANGED = 'momoChat:activityChanged';

/**
 * @param {object} o
 * @param {any} o.live main's services: chats, controller (its session state), peerRuntime (history) and chromePanel (phones)
 * @param {{ routineRunsSince: (at: number) => any[], get: (id: string) => { name?: string } | null | undefined }} o.routineStore
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule]
 * @param {(channel: string, payload?: unknown) => void} [o.broadcastAll] to every window
 */
function openMomoActivity({ live, routineStore, allowed, schedule, broadcastAll }) {
  /** Windows showing MoMo's activity (its right panel), by sender id: a window that is not showing it is not told. */
  const watchers = new Set();
  const historyOf = createHistoryReader(live);
  const stateOf = (/** @type {string} */ chatId) => (live.controller?.state?.has(chatId) ? live.controller.state.get(chatId) : null);
  /** MoMo's own chats that may hold errands: its chats, not its data-only background ones. */
  const own = (/** @type {any} */ record) => isMomoMeta(record?.meta) && !isMomoDataMeta(record.meta);
  const activity = createMomoActivity({
    runs: (since) => routineStore.routineRunsSince(since),
    routineName: (taskId) => routineStore.get(taskId)?.name ?? null,
    chats: (since) =>
      [...(live.chats?.records ?? new Map()).entries()]
        .filter(([, r]) => own(r))
        .map(([chatId, r]) => ({ chatId, updatedAt: r.updatedAt ?? 0 }))
        .filter((c) => c.updatedAt >= since),
    turns: async (chatId, running) => {
      const record = live.chats?.records.get(chatId);
      return record ? ((await historyOf(chatId, record, running))?.turns ?? []) : [];
    },
    chatState: stateOf,
    version: (chatId) => `${stateOf(chatId)?.rev ?? ''}:${live.chats?.records.get(chatId)?.updatedAt ?? ''}`,
    stepOf,
    stateOfCall,
    changed: (id) => {
      live.chromePanel?.service.onMomoActivity(id);
      if (watchers.size > 0 && allowed() === true) broadcastAll?.(ACTIVITY_CHANGED, { id });
    },
    ...(schedule && { schedule }),
  });
  /** A chat MoMo works in: one of its own, or a routine run's (tagged MoMo too). */
  const tracked = (/** @type {string} */ chatId) => own(live.chats?.records.get(chatId));
  return {
    /** The list a phone reads; only while MoMo is allowed (the remote service refused first), paused or not. */
    async list() {
      if (allowed() !== true) throw notAllowed();
      return activity.list();
    },
    /** A chat's session changed (SessionStore's publish): MoMo's are compared shortly, while a phone is connected to hear it. */
    onSessionPatch(/** @type {{ chatId: string }} */ p) {
      const heard = (live.chromePanel?.service.phones.size ?? 0) > 0 || watchers.size > 0;
      if (allowed() === true && heard && tracked(p?.chatId)) activity.touched(p.chatId);
    },
    /** A window shows the activity (or stops): it is told of changes while any does; `key` is the window's. */
    watch(/** @type {number} */ key, /** @type {boolean} */ on) {
      if (on) watchers.add(key);
      else watchers.delete(key);
    },
    /** A MoMo chat's turn finished (its run's outcome is written then). */
    touched: (/** @type {string} */ chatId) => activity.touched(chatId),
  };
}

module.exports = { openMomoActivity, ACTIVITY_CHANGED };
