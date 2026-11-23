// What reads every harness's events in main besides the controller, with or without a window: the request ledger (electron/ledger), the context snapshots (electron/context) and Codex's failed hook lines (session/hookNotes.cjs), each on its own so one that throws costs neither the others nor the caller.
const { openRequestLedger } = require('../ledger/index.cjs');
const { openContextService } = require('../context/index.cjs');
const { HookNotes } = require('../session/hookNotes.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** One reader of an event; a throw is noted, never passed on. */
function hear(what, fn) {
  try {
    fn();
  } catch (error) {
    noteIgnored(what, error);
  }
}

/**
 * The taps electron/app/sessions.cjs feeds: Codex's emitted events and raw messages, the ACP host's events; Claude Code's
 * events reach both through claude.observe, and a quit writes what each holds.
 * @param {Parameters<typeof openRequestLedger>[0] & Parameters<typeof openContextService>[0] & { live: { chats: any }, broadcastAll: (channel: string, payload: any) => void }} o
 */
function openHarnessTaps(o) {
  const ledger = openRequestLedger(o);
  const context = openContextService(o);
  // a hook line thread/read can't give back is kept in the chat's own file, and every window shown the change (#2066)
  const hookNotes = new HookNotes({
    chats: { record: (id) => o.live.chats.record(id), patchMeta: (id, patch) => o.live.chats.patchMeta(id, patch) },
    chatOf: o.chatOf,
    changed: (id) => o.broadcastAll('chats:changed', { id, chat: o.live.chats.get(id) }),
  });
  return {
    ledger,
    context,
    /** @param {any} e */
    codexEmitted: (e) => hear('record an emitted event in the request ledger', () => ledger.codex.emitted(e)),
    /** @param {any} msg */
    codexMessage: (msg) => {
      hear('record an app-server message in the request ledger', () => ledger.codex.message(msg));
      hear("update a chat's context snapshot from an app-server message", () => context.service.codexMessage(msg));
      hear("keep a failed hook's line in its chat", () => hookNotes.observe(msg));
    },
    /** @param {any} e */
    acpEvent: (e) => {
      hear('record a basic harness event in the request ledger', () => ledger.acp.event(e));
      hear("update a basic chat's context snapshot", () => context.service.acpEvent(e));
    },
    flush: () => {
      ledger.store.flushSync();
      context.store.flush();
    },
  };
}

module.exports = { openHarnessTaps };
