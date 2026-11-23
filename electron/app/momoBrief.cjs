// The morning brief in main (A7), over the services app/momo.cjs made: the brief (momo/brief.cjs) on a sealed state file in MoMo's folder (erased by Reset MoMo), its inputs read from what MoMo already keeps (open loops, the cards and failed runs of Tasks, the suggestions), its words written in a data-only background chat on MoMo's brain, and its stack put into MoMo's main chat as notes (a greeting, an attention item, a lead-in and one card per suggestion). A human message in a MoMo chat marks the day the user was active. The lock screen gets the fixed notice and nothing of the brief (notices.cjs). Try again is `momoBrief:runNow` (momo/briefIpc.cjs).
const path = require('node:path');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { createBrief, briefShape } = require('../momo/brief.cjs');
const { registerBriefIpc } = require('../momo/briefIpc.cjs');
const { cheapBrain } = require('../momo/cheapBrain.cjs');
const { UNATTENDED, ISOLATION } = require('../momo/routines.cjs');
const { roleBrain, readMomoPrefs, isMomoPaused } = require('../../shared/momoPrefs.mjs');
const { routineSettings } = require('../../shared/momoRoutine.mjs');
const { addGuard } = require('../session/hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { waitingCards } = require('../momo/tasks.cjs');

const MAX_TURN = Number.MAX_SAFE_INTEGER;

/**
 * The notes one brief is in MoMo's main chat: each text a MoMo line, each suggestion a card (the suggestion's id, title and source line).
 * @param {{ texts: string[], cards: { id: string, title: string, source: string }[] }} b @param {number} at
 */
function briefNotes(b, at) {
  const note = (/** @type {string} */ id, /** @type {string} */ text, /** @type {object} */ extra = {}) => ({
    id: `brief-${at}-${id}`,
    kind: 'brief',
    text,
    // after the chat's latest turn (shared/chatNotes.mjs)
    turnId: null,
    turn: MAX_TURN,
    at,
    ...extra,
  });
  return [
    ...b.texts.map((t, i) => note(`t${i}`, t)),
    ...b.cards.map((c) => note(`c${c.id}`, c.title, { suggestion: { id: c.id, title: c.title, source: c.source } })),
  ];
}

/**
 * @param {object} d
 * @param {any} d.core @param {any} d.live @param {() => boolean} d.allowed @param {any} d.safeStorage
 * @param {(brain: any, tag: object) => Promise<string>} d.startChat @param {(chatId: string, item: object) => Promise<unknown>} d.send
 * @param {(chatId: string, text: string, show: object) => object} d.authored @param {(chatId: string) => unknown} d.discardChat
 * @param {(brain: any) => object} d.limitOf @param {() => any} d.momoPrefs @param {() => any} d.prefs
 * @param {{ needsYou: (t: { kind: 'chat', chatId: string }) => boolean }} d.notices
 * @param {(channel: string, payload?: unknown) => void} d.broadcastAll @param {any} d.mainChat @param {any} d.routineStore
 * @param {{ list: () => Record<string, unknown> }} d.marks @param {{ list: () => { suggestions: any[] } }} d.suggestions
 * @param {{ ipcMain: any, nextRun: (rrule: string, after: number) => Date | null, broadcast: (channel: string) => void }} d.ipc
 * @param {() => number} [d.now]
 */
function openMomoBrief(d) {
  const { core, live, allowed, now = Date.now } = d;
  const state = new SealedJson({ file: path.join(core.dir, 'brief.json'), safeStorage: d.safeStorage, shape: briefShape, now });
  const on = () => allowed() === true && !isMomoPaused(d.momoPrefs());
  const brief = createBrief({
    state,
    now,
    enabled: () => readMomoPrefs(d.momoPrefs()).brief === true,
    allowed,
    paused: () => isMomoPaused(d.momoPrefs()),
    quietHours: () => routineSettings(d.prefs()).quietHours,
    name: () => readMomoPrefs(d.momoPrefs()).persona.name,
    inputs: async () => ({
      loops: core.loops.list(),
      needs: [
        ...waitingCards(live.controller, d.mainChat).map((/** @type {any} */ c) => ({
          kind: 'card',
          id: `card:${c.id}`,
          title: String(c.params?.momo?.summary || c.params?.momo?.tool || 'MoMo needs your OK'),
          source: String(c.params?.momo?.source || 'Waiting for you in MoMo’s chat'),
        })),
        // a routine that did not finish in the last day and that the user has not marked
        ...d.routineStore
          .routineRunsSince(now() - 86_400_000)
          .filter((/** @type {any} */ r) => r.endedAt !== undefined && r.outcome !== 'completed' && !d.marks.list()[`run:${r.chatId}`])
          .map((/** @type {any} */ r) => ({
            kind: 'run',
            id: `run:${r.chatId}`,
            title: String(d.routineStore.get(r.taskId)?.name ?? 'A routine'),
            source: 'A routine that did not finish',
          })),
      ],
      // the brief's lead-in and cards need the suggestions flag as well as its own: with it off the brief has no suggestions to offer
      suggestions: readMomoPrefs(d.momoPrefs()).suggestions === true ? d.suggestions.list().suggestions : [],
    }),
    brain: async () => cheapBrain(roleBrain(d.momoPrefs()), async () => live.codex?.modelList()),
    atLimit: (brain) => 'held' in d.limitOf(brain),
    startChat: async (brain, tag) => {
      const chatId = await d.startChat(brain, { ...tag, isolation: ISOLATION });
      live.sessions?.patch(chatId, { scheduled: UNATTENDED });
      return chatId;
    },
    send: (chatId, text) => d.send(chatId, d.authored(chatId, text, { by: 'momo', title: 'Morning brief' })),
    discardChat: d.discardChat,
    deliver: async (b) => {
      if (!on()) return false;
      const main = (await core.mainChat.ensureMainChat()).chatId;
      const rec = live.chats.record(main);
      // patchMeta-changes: the brief's notes are new, so the notes always change
      if (!rec || !live.chats.patchMeta(main, { notes: [...(rec.meta?.notes ?? []), ...briefNotes(b, now())] })) return false;
      d.broadcastAll('chats:changed', { id: main, chat: live.chats.get(main) });
      // the lock screen: the fixed title alone, never the brief
      d.notices.needsYou({ kind: 'chat', chatId: main });
      return true;
    },
  });
  // the days the user was active: a message of theirs in a MoMo chat (Start's send counts)
  let noted = '';
  if (live.controller)
    addGuard(live.controller, 'beforeDispatch', (/** @type {{ chatId: string, item?: any }} */ e) => {
      if (e.item?.opts?.human !== true || !core.isMomoChat(e.chatId)) return;
      const day = new Date(now()).toDateString();
      if (day === noted) return;
      noted = day;
      brief.noteActive().catch((error) => noteIgnored('note the day MoMo was used', error));
    });
  const ipc = registerBriefIpc(d.ipc.ipcMain, {
    allowed,
    enabled: () => readMomoPrefs(d.momoPrefs()).brief === true,
    run: () => brief.run({ manual: true }),
    failed: (error) => brief.failed(error),
    broadcast: d.ipc.broadcast,
  });
  return {
    brief,
    /** Reset MoMo erases the state file (with the routines'). */
    erase: () => state.erase(),
    /** The Scheduled row's data, or null while the flag is off. */
    row: () => (readMomoPrefs(d.momoPrefs()).brief === true && allowed() === true ? brief.row(d.ipc.nextRun) : null),
    ipc,
  };
}

module.exports = { openMomoBrief, briefNotes };
