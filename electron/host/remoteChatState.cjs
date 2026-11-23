// The chat's title, goal and tasks as a Host tells them on its stream's state lane (host/src/chatState.mjs), in the app: the title in the chat's transcript, the goal and the tasks in the session store the windows draw them from.
const { provisionalTitle } = require('../../shared/title.mjs');
const { isHostPermission } = require('../../shared/host/permissions.mjs');
const { askedQuestions } = require('../../shared/hostAsked.mjs');

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The id a Host's card (a permission or a question) has in this app: the chat's, then the Host's own. Hosts number their requests themselves (a Codex app-server counts from its own start),
 * so two Hosts, or a Host that means harm, can use the same id; in this app every card id is the chat's own, so one chat's card can never be another's, this Mac's included.
 * @param {string} chatId @param {string} requestId
 */
const cardId = (chatId, requestId) => `${chatId}|${requestId}`;

/**
 * @param {object} o
 * @param {{ append: (id: string, ...records: object[]) => void, readAsync: (id: string) => Promise<any[]>, readKindsAsync?: (id: string, kinds: string[]) => Promise<any[]> }} o.items the app's transcript store
 * @param {(event: object) => void} o.emit the ACP host's event bus
 * @param {() => { get: (chatId: string) => any, patch: (chatId: string, partial: object) => unknown } | null | undefined} o.state main's SessionStore (`get`: what the chat's session holds now)
 * @param {() => { openRemote: (o: any) => void, closeRemote: (id: string) => void } | null | undefined} o.questions the app's form cards
 * @param {() => number} o.now
 * @param {(chatId: string, value: unknown) => void} [o.attention] told the chat's `attention` whenever the state lane carries one (attentionLane.cjs)
 * @param {(chatId: string, note: object) => void} o.note told a note the chat keeps beside its turns (the divider of a switch the Host journaled), by an id that tells the same note twice (wiring.cjs `laneOf`); given by remoteChats.cjs, which defaults it to nothing
 * @param {(chatId: string, harness: string) => void} [o.agent] told the agent a chat runs on whenever the lane says it (after a switch settled): kept with the chat, so the picker and the labels follow it
 */
function createChatState({ items, emit, state, questions, now, attention = () => undefined, agent = () => undefined, note }) {
  /** chat -> the Plan the Host last said it holds. @type {Map<string, boolean>} */
  const lanePlan = new Map();
  /**
   * The chat's title, goal and tasks as the Host tells them (host/src/chatState.mjs): the title is kept in the transcript unless the person named the chat themselves, goal and tasks are shown from the session store. Newest wins, so telling it twice changes nothing.
   * @param {{ chatId: string, gone: boolean }} f @param {unknown} patch
   */
  async function apply(f, patch) {
    if (!isObject(patch)) return;
    const p = /** @type {Record<string, any>} */ (patch);
    if (isObject(p.title) && typeof p.title.name === 'string') {
      const records =
        typeof items.readKindsAsync === 'function'
          ? await items.readKindsAsync(f.chatId, ['title', 'user'])
          : await items.readAsync(f.chatId);
      const latest = records.findLast((/** @type {any} */ r) => r?.t === 'title');
      // the window replaces a chat's name only when it is still the first words cut short (or the name the Host named): say which that is
      const first = records.find((/** @type {any} */ r) => r?.t === 'user');
      const words = (Array.isArray(first?.user?.content) ? first.user.content : [])
        .map((/** @type {any} */ b) => (typeof b?.text === 'string' ? b.text : ''))
        .join('');
      // a name the person gave (here, on the phone or on another Mac) is kept as theirs and replaces whatever the window shows; an automatic title only replaces one that is not
      const named = p.title.named === true;
      const provisional =
        named && latest ? latest.name : typeof p.title.provisional === 'string' ? p.title.provisional : provisionalTitle(words);
      const same = latest?.name === p.title.name && (named ? !latest.auto : true);
      if (!f.gone && !same && (named || !(latest && !latest.auto))) {
        items.append(f.chatId, { t: 'title', name: p.title.name, ...(named ? {} : { auto: true }), at: now() });
        emit({ kind: 'threadName', key: f.chatId, chatId: f.chatId, name: p.title.name, provisional });
      }
    }
    if (Object.hasOwn(p, 'attention') && !f.gone) attention(f.chatId, p.attention);
    if (typeof p.harness === 'string' && !f.gone) agent(f.chatId, p.harness);
    /** @type {Record<string, unknown>} */
    const shown = {};
    if (Object.hasOwn(p, 'goal')) shown.goal = p.goal;
    if (Array.isArray(p.tasks)) shown.tasks = p.tasks;
    // the mode the Host holds, as the composer shows it: whether the agent plans (the same flag the composer's Plan switch writes, so another client's Plan shows here and one that left it clears it), and the mode a send without a pick carries
    // only a change of what the Host holds is shown: a replay of the same value (a reconnect's Hello, a resumed thread) must not undo a Plan the person switched on and has not sent yet
    if (typeof p.plan === 'boolean' && lanePlan.get(f.chatId) !== p.plan) {
      lanePlan.set(f.chatId, p.plan);
      shown.plan = p.plan;
    }
    if (isHostPermission(p.permission)) shown.permission = p.permission;
    const store = state();
    // the Host's held choice of another agent, in the session store the chip is drawn from: a choice made here is already there, so only a different one (the phone's, or none after a restart or a settled switch) is written
    if (Object.hasOwn(p, 'pendingSwitch')) {
      const held = store?.get(f.chatId)?.pendingSwitch;
      const next = isObject(p.pendingSwitch) ? p.pendingSwitch : null;
      const same = next === null ? !held : held?.harness === next.harness && (!next.model || held?.model === next.model);
      if (!same) shown.pendingSwitch = next && { harness: next.harness, model: next.model ?? null, modelLabel: '', mode: 'auto' };
    }
    if (Object.keys(shown).length) store?.patch(f.chatId, shown);
  }
  /**
   * The divider of a switch the Host journaled (`{ t: 'switch', turnId, text, at }`), kept beside the turn that settled it, once per turn; a bad item (no turn, no words) leaves nothing.
   * @param {{ chatId: string, gone: boolean }} f @param {any} item
   */
  function switched(f, item) {
    if (f.gone || typeof item.turnId !== 'string' || typeof item.text !== 'string' || !item.text) return;
    const at = Number.isFinite(item.at) ? item.at : now();
    note(f.chatId, {
      id: `switch-${item.turnId}`,
      kind: 'switch',
      text: item.text.slice(0, 300),
      turnId: item.turnId,
      turn: Number.MAX_SAFE_INTEGER,
      at,
      lead: true,
    });
  }
  /**
   * A question the agent on the machine asks: a form card here, answered with the values it takes.
   * @param {{ chatId: string, host: any }} f @param {any} event
   */
  function question(f, event) {
    const q = event.question;
    const id = q?.id;
    if (typeof id !== 'string') return;
    const shown = cardId(f.chatId, id);
    const label = /^acp:host-claude:/.test(f.chatId) ? 'Claude Code' : /^acp:host-codex:/.test(f.chatId) ? 'Codex' : 'The agent';
    questions()?.openRemote({
      chatId: f.chatId,
      label,
      // the questions as asked are read again here, within the same bounds the Host keeps (a Host's own list is not trusted to fit them)
      view: { ...q, id: shown, ...(q.asked === undefined ? {} : { asked: askedQuestions(q.asked) }) },
      send: async (/** @type {object} */ form) => (await f.host.answer({ chatId: f.chatId, requestId: id, form }))?.answered === true,
    });
  }
  /** The machine closed a card: a question with that id is cancelled here. @param {string} id */
  const closeQuestion = (id) => questions()?.closeRemote(id);
  return { apply, question, closeQuestion, switched };
}

module.exports = { createChatState, cardId };
