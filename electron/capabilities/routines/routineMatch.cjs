// Whether a new message asks for what a saved routine did (#3571, G4): each part of a routine keeps the user's message it
// came from, and a message close enough to one carries a one-line hint in a hidden block, on every harness (as the linked
// sessions' status does, rosterStatus.cjs). A skill list alone wasn't enough: a model starting a task did not stop to look
// there, however the skill read. No match adds nothing. A hint only says the routine exists: the model decides, and a run
// passes every gate a step does.
const { withoutHiddenBlocks } = require('../../../shared/userText.mjs');
const { hiddenBlockSource } = require('../../../shared/hiddenBlock.mjs');
const { scrub } = require('../../../shared/scrub.cjs');
const { hasSkill } = require('../../../shared/userInput.mjs');

/** How much of two messages' words must be shared (of all the words either has). */
const MIN_OVERLAP = 0.6;
/** A shorter message ("Go ahead") says too little to match anything by its words. */
const MIN_WORDS = 5;
/** The hidden block a hint goes in (shared/userText.mjs hides it). */
const HINT_TAG = 'sage-routine-hint';
const HINT_BLOCK = new RegExp(hiddenBlockSource(HINT_TAG), 'g');

/** A message's words: lowercase letters and digits, each once. */
function wordsOf(/** @type {unknown} */ text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

/** The share of words two sets have in common, of all the words in either. */
function overlap(/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/**
 * The saved routine part a message asks for: the closest above the bar (of two as close, the first listed), or null.
 * @param {{ prompts?: (string | null)[] }[]} routines
 * @param {unknown} text
 * @returns {{ routine: any, part: number, same: boolean } | null}
 */
function matchRoutine(routines, text) {
  // a part keeps its message scrubbed (routineRecorder.cjs turnStarting), so this one is read the same way
  const words = wordsOf(scrub(String(text ?? '')));
  if (words.size < MIN_WORDS) return null;
  /** @type {{ routine: any, part: number, same: boolean } | null} */
  let best = null;
  let bestScore = 0;
  for (const routine of routines)
    (routine.prompts ?? []).forEach((prompt, i) => {
      const other = wordsOf(prompt);
      if (other.size < MIN_WORDS) return;
      const score = overlap(words, other);
      if (score >= MIN_OVERLAP && score > bestScore) {
        best = { routine, part: i + 1, same: score === 1 };
        bestScore = score;
      }
    });
  return best;
}

/**
 * What the model is told: a run changes nothing, what it gets back, and what stays its own to do. Models passed a routine over
 * while they couldn't tell what a run would do (G4 bench pairs on 0c84722ec, 866f88d62). The id names the routine; a name can
 * hold anything.
 */
function hintText(/** @type {{ routine: any, part: number, same?: boolean }} */ { routine, part, same = false }) {
  const parts = routine.prompts.length;
  const name = String(routine.name).replace(/[<>]/g, ' ');
  const what = parts > 1 ? `part ${part} of ${parts} of the saved routine` : 'the saved routine';
  const arg = part > 1 ? `, part: ${part}` : '';
  // the words fit how sure the match is: a close message may be asking about something else
  const advice = same ? 'Run it before reading those pages yourself' : 'Consider it if this request needs the same pages';
  return `This message ${same ? 'is word for word' : 'is close to'} what started ${what} '${name}'. One routine_run call (routine: '${routine.id}'${arg}) reads its pages again and changes nothing. It returns what they say now and the steps recorded after them, as a plan for you to do yourself. ${advice}, loading the tool first if it is deferred.`;
}

/** `text` with this hint, or none, between the hidden blocks ahead of it and the user's words: one only, however often it is sent. */
function withRoutineHint(/** @type {string} */ text, /** @type {string | null} */ hint) {
  const own = withoutHiddenBlocks(text);
  const ahead = text.slice(0, text.length - own.length).replace(HINT_BLOCK, '');
  return `${ahead}${hint ? `<${HINT_TAG}>\n${hint}\n</${HINT_TAG}>\n` : ''}${own}`;
}

/**
 * An input about to reach a chat (ChatController beforeDispatch): the user's message that starts a turn is what a routine
 * saved from that turn answers to, and carries a hint when it matches one. A steer joins the turn running; a chat kept
 * apart has no routine tools; a slash command, skill chip or goal is read from the text's start, so it stays as it is.
 * @param {{ recorder: { turnStarting: (chatId: string, text: string | null) => void }, store: { list: () => any[] }, apart: (chatId: string) => boolean }} o
 * @param {{ chatId: string, kind?: string, item?: any }} delivery
 */
function routineTurnStarting({ recorder, store, apart }, { chatId, kind, item }) {
  if (kind === 'steer') return;
  const human = item?.opts?.human === true && !item.peer && typeof item.text === 'string';
  const own = human ? withoutHiddenBlocks(item.text) : null;
  recorder.turnStarting(chatId, own);
  if (own === null || item.opts.goal || own.trimStart().startsWith('/') || hasSkill(item.attachments)) return;
  const found = apart(chatId) ? null : matchRoutine(store.list(), own);
  item.text = withRoutineHint(item.text, found && hintText(found));
}

module.exports = { matchRoutine, hintText, withRoutineHint, routineTurnStarting, wordsOf, HINT_TAG, MIN_OVERLAP, MIN_WORDS };
