// What the user wrote in each chat's current turn (the message that started it and their steers into it), on every
// harness and with no window open: tools that may do only what the user named (another harness for a linked session
// or a scheduled task, a model or effort for one) check it here, never the agent's own preference (#2084). Agent,
// peer, wake-up and other automatic input never counts, nor does text from a file, page or tool result.
const { addGuard } = require('./hookChain.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

/** At most this much of a turn's words is kept. */
const MAX_CHARS = 32768;

/** One per controller: the turn's words, installed once beside the controller's other dispatch hooks. */
const installed = new WeakMap();

/**
 * @param {{ rt: (chatId: string) => { inputToken?: string | null, token?: string | null } }} controller
 * @returns {{ dispatching: (e: { chatId: string, kind: string, item: any }) => void, said: (chatId: string) => string }}
 */
function createUserWords(controller) {
  /** chatId → the turn the words belong to and the words */
  const byChat = new Map();
  const turnOf = (chatId) => {
    const r = controller.rt(chatId);
    return r.inputToken ?? r.token ?? null;
  };
  return {
    dispatching({ chatId, kind, item }) {
      const human = item?.opts?.human === true && !item.peer;
      const text = human && typeof item.text === 'string' ? item.text : '';
      const turn = turnOf(chatId);
      const held = byChat.get(chatId);
      // a new turn starts over (an automatic one with no words); a steer adds to the turn it reached
      const before = kind === 'turn' || held?.turn !== turn ? '' : held.text;
      if (!text && !before) return void byChat.delete(chatId);
      byChat.set(chatId, { turn, text: `${before}${before && text ? '\n' : ''}${text}`.slice(0, MAX_CHARS) });
    },
    said(chatId) {
      const held = byChat.get(chatId);
      return held && held.turn === turnOf(chatId) ? held.text : '';
    },
  };
}

/** The controller's user words, installed on its dispatch hook the first time they are asked for. */
function userWordsOf(controller) {
  let words = installed.get(controller);
  if (!words) {
    words = createUserWords(controller);
    installed.set(controller, words);
    addGuard(controller, 'beforeDispatch', words.dispatching);
  }
  return words;
}

/** `name` as a regular expression: any case, and a dash or dot in it matches a dash, dot or space. */
const patternOf = (name) =>
  name
    .split(/[-.\s]+/)
    .map((part) => part.replace(/[\\^$*+?()[\]{}|/]/g, '\\$&'))
    .join('[-.\\s]?');

/** `name` as a word of `text` (no Latin letter or digit touching it, so Chinese around it, "用codex", still bounds it). */
function mentions(text, name) {
  const n = String(name ?? '').trim();
  if (!n) return false;
  return new RegExp(`(^|[^a-z0-9])${patternOf(n)}($|[^a-z0-9])`, 'i').test(String(text ?? ''));
}

/** Words that pick where work runs, before its name ("use", "run it on", "用", "换成"). */
const BEFORE = [
  '(?:^|[^a-z0-9])(?:use|using|run|running|start|starting|launch|open|switch(?:ed)?\\s+to|move(?:\\s+it)?\\s+to|on|in|with|via)\\s+(?:(?:a|an|the|it\\s+(?:on|in|with))\\s+)?',
  '(?:用|在|换成|换到|切到|切换到|改用|使用|开)\\s*(?:一个|个)?\\s*',
];
/** Words that name it as the place after its name ("Codex session", "Claude Code chat", "codex上"). */
const AFTER = '(?:\\s+code)?\\s*(?:session|chat|thread|harness|instead|会话|对话|上|里|来|跑)';

/**
 * Whether the user picks `name` as where the work runs, not only mentions it: "use Codex", "run it in a Codex
 * session", "用codex", "Claude Code 上跑". "Fix the Codex adapter in its own session" picks nothing.
 */
function picks(text, name) {
  const n = String(name ?? '').trim();
  if (!n) return false;
  const p = patternOf(n);
  const t = String(text ?? '');
  return BEFORE.some((b) => new RegExp(`${b}${p}(?![a-z0-9])`, 'i').test(t)) || new RegExp(`(?<![a-z0-9])${p}${AFTER}`, 'i').test(t);
}

/** Whether the user's words pick harness `kind`: "codex", "claude" (Claude Code), or a basic harness's id. */
function namesHarness(text, kind) {
  const parsed = parseKind(kind);
  if (!parsed) return false;
  return picks(text, parsed.basic ?? parsed.family);
}

/** Claude model families, cheapest first: a user who says "sonnet" names every Sonnet id. */
const CLAUDE_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

/** A Claude model's family ('claude-sonnet-5-5', 'sonnet', 'opus[1m]'), or null. */
const claudeFamily = (model) => CLAUDE_FAMILIES.find((f) => new RegExp(`(^|-)${f}($|[-\\[])`, 'i').test(String(model ?? ''))) ?? null;

/** Whether the user's words name `model`: its id, or for a Claude model its family. */
function namesModel(text, model) {
  if (mentions(text, model)) return true;
  const family = claudeFamily(model);
  return !!family && mentions(text, family);
}

/**
 * A model the agent may pick without the user's word, as Claude Desktop's start_session allows: one of the same
 * Claude family as the chat's own (`own`) or a cheaper one. Anything else needs the user's word.
 */
function cheaperModel(model, own) {
  const mine = claudeFamily(own);
  const theirs = claudeFamily(model);
  return !!mine && !!theirs && CLAUDE_FAMILIES.indexOf(theirs) <= CLAUDE_FAMILIES.indexOf(mine);
}

/** Efforts that never cost more than a harness's default. */
const CHEAP_EFFORTS = ['none', 'minimal', 'low'];

/** Whether the user's words name effort `level` as an effort ("high effort", "effort: max", "xhigh"), or it is cheap. */
function namesEffort(text, level) {
  const e = String(level ?? '').trim();
  if (CHEAP_EFFORTS.includes(e.toLowerCase())) return true;
  if (!e) return false;
  const p = patternOf(e);
  return (
    new RegExp(
      `(?<![a-z0-9])(?:${p}\\s+(?:effort|reasoning|thinking)|(?:effort|reasoning|thinking)\\s*[:=]?\\s*${p})(?![a-z0-9])`,
      'i',
    ).test(String(text ?? '')) ||
    (e.toLowerCase() === 'xhigh' && mentions(text, e))
  );
}

/**
 * A choice the agent made on its own that only the user may make: `chosen` when it is the chat's own (`own`) or the
 * user named it this turn, else null with why it was set aside and what happens instead (`instead`).
 * @param {{ chosen: string | null | undefined, own: string | null, named: (chosen: string) => boolean, what: string, instead: string }} o
 * @returns {{ value: string | null, ignored: string | null }}
 */
function userChoice({ chosen, own, named, what, instead }) {
  if (chosen == null || chosen === own || named(chosen)) return { value: chosen ?? null, ignored: null };
  return { value: null, ignored: `${what} "${chosen}" was set aside: the user didn't name it this turn, so ${instead}` };
}

module.exports = { createUserWords, userWordsOf, mentions, picks, namesHarness, namesModel, cheaperModel, namesEffort, userChoice };
