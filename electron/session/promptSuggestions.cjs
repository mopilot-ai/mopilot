// Own ephemeral composer suggestions by chat, native segment, and completed turn in main.
const { byFamily, familyOf } = require('./contract/route.cjs');
const { turnSource } = require('./controllerSwitch.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */
/** @typedef {{ kind: ReturnType<typeof familyOf>, key: string }} Source */
/** @type {WeakMap<object, { source: Source, turnId: string, writer: object }>} */
const finished = new WeakMap();
/** @type {WeakMap<object, { turn: object, text: string | null }>} */
const pendingAcp = new WeakMap();

/** @param {ChatController} c @param {Source} source */
function receivePromptSuggestion(c, chatId, source, text, turnId = null) {
  if (!c.state.has(chatId) || !turnSource(c, chatId, source)) return;
  const s = c.state.get(chatId);
  const clean = typeof text === 'string' ? text.trim() || null : null;
  if (s.activeTurn && s.activeTurn.id === turnId) {
    pendingAcp.set(s, { turn: s.activeTurn, text: clean });
    return;
  }
  const owner = finished.get(s);
  if (
    !owner ||
    owner.source.kind !== source.kind ||
    owner.source.key !== source.key ||
    (turnId !== null && owner.turnId !== turnId) ||
    owner.writer !== c.state.localWriterToken(chatId) ||
    s.turn !== 'idle' ||
    s.pendingSwitch ||
    s.runningElsewhere ||
    s.plan ||
    s.queue.length
  )
    return;
  c.state.patch(chatId, { promptSuggestion: clean });
}

/** @param {ChatController} c */
function completePromptSuggestion(c, chatId, turn, completed) {
  const s = c.state.get(chatId);
  const staged = pendingAcp.get(s);
  pendingAcp.delete(s);
  finished.delete(s);
  if (!completed || !turn?.human || turn.compact || s.plan || s.queue.length || s.pendingSwitch) return;
  const ref = c.ref(chatId);
  const source = { kind: familyOf(ref.kind), key: ref.key };
  const writer = c.state.localWriterToken(chatId);
  const turnId = turn.id;
  const owner = { source, turnId, writer };
  finished.set(s, owner);
  const read = byFamily({ codex: c.codex?.promptSuggestion?.bind(c.codex), claude: null, acp: null }, ref.kind);
  if (read && !c.remote?.owns?.(chatId)) {
    void read(ref.id, turnId)
      .then((text) => {
        if (finished.get(s) === owner) receivePromptSuggestion(c, chatId, source, text, turnId);
      })
      .catch((error) => noteIgnored('publish a Codex composer prediction', error));
  } else if (staged && staged.turn === turn) {
    receivePromptSuggestion(c, chatId, source, staged.text, turnId);
  }
}

/** @param {ChatController} c */
function retirePromptSuggestion(c, chatId) {
  const s = c.state.get(chatId);
  finished.delete(s);
  pendingAcp.delete(s);
  if (s.promptSuggestion) c.state.patch(chatId, { promptSuggestion: null });
}

module.exports = { completePromptSuggestion, receivePromptSuggestion, retirePromptSuggestion };
