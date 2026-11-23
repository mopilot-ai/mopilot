// MoMo's background memory pass (#2139 P3): after a MoMo chat has been idle IDLE_MS, and once a day as a reflection over the facts kept, MoMo reads what was said since its last pass and asks its brain (on its cheap model) in a fresh isolated background chat, on any harness, which facts to add, update or supersede; the reply's ops are checked here (each fact's words must come from what was said, nothing that looks like a secret, the shapes the store takes) and applied through MemoryStore.applyPass (memoryLog.cjs: never a fact the user wrote, at most a fifth changed, the old fact kept as past). One pass per chat at a time; nothing runs or lands while MoMo isn't allowed, while its brain is known to be at its limit (the pass is skipped and tried at the next idle), past the memory pass's share of the day's background tokens (backgroundBudget.cjs, shared with the search aliases), or after a reset (its generation moved on).
const { words, estimateTokens } = require('./memoryFacts.cjs');
const { isAuthoredText } = require('../session/authoredInput.cjs');
const { withoutMomoBlock } = require('../../shared/momoContext.mjs');
const { userMessageText } = require('./turnItems.cjs');
const { loopsPrompt, parseLoops, saidOf, saidAtOf } = require('./openLoopsPass.cjs');
const { checkLoops, localLabel } = require('./openLoopsShape.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a MoMo chat stays quiet before its pass runs. */
const IDLE_MS = 10 * 60_000;
/** How often the reflection over the kept facts runs. */
const REFLECT_MS = 24 * 3600_000;
/** The most recent characters of a chat a pass reads; earlier turns were read by earlier passes. */
const MAX_SOURCE = 12_000;
/** The facts a pass is shown to match against (the most related). */
const MAX_SHOWN = 30;
/** Hard cap on one pass's prompt (estimated tokens): the oldest of what was said, then the least related facts, go first. */
const MAX_PASS_TOKENS = 6_000;
/** A pass's reply, estimated before it comes (its tokens are counted when it lands). */
const PASS_REPLY_TOKENS = 400;
/** Words a fact may use that a chat need not say: how a fact names its subject, and glue. */
const GLUE = new Set(
  'user users user’s s the a an is are was were be been has have had of to in on at for and or with by from as that this it its their they he she his her them not no who which when where than then also likes like lives works'.split(
    ' ',
  ),
);
/** CJK pairs a fact may use for the same reasons: the user, likes, lives in, works (data matched against, never shown). */
const CJK_GLUE = new Set(['\u7528\u6237', '\u559c\u6b22', '\u4f4f\u5728', '\u5de5\u4f5c']);

/** The prompt of a pass: what was said, the related facts kept, and the reply's exact shape. */
function passPrompt(
  /** @type {{ sourceText: string, facts: { id: string, text: string }[], reflect: boolean, loops?: { open: { id: string, text: string }[], now: string } | null }} */ o,
) {
  const kept = o.facts.length ? o.facts.map((f) => `- [${f.id}] ${f.text}`).join('\n') : '(none)';
  return [
    o.reflect
      ? "Review MoMo's memory of the user below. Merge facts that say the same thing and replace ones a newer fact contradicts."
      : 'Read what the user and MoMo said below and keep lasting facts about the user in MoMo’s memory.',
    'Rules: one short sentence per fact, only what was said (never guess), never passwords, keys, ID numbers or account numbers.',
    'Use "supersede" when a kept fact is no longer true, "update" to correct one, "add" for a new one. Say nothing else.',
    'Reply with JSON only: {"ops":[{"op":"add","text":"…","confidence":"sure"|"likely"},{"op":"update","id":"…","text":"…"},{"op":"supersede","id":"…","text":"…"}]}',
    '',
    'Facts kept:',
    kept,
    '',
    ...(o.loops ? ['', loopsPrompt(o.loops)] : []),
    '',
    o.reflect ? '' : 'What was said:',
    o.reflect ? '' : o.sourceText,
  ].join('\n');
}

/** The ops of a pass's reply: its first JSON object with an `ops` array (fenced or not), else null. */
function parseOps(/** @type {unknown} */ text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(v?.ops) ? v.ops : null;
  } catch {
    return null;
  }
}

/**
 * The ops a pass may apply, and why each other one was dropped: an op's text must be made of words from `sourceText`
 * (or the fact it changes, or GLUE), so the model can't add what nobody said; text that looks like a secret is
 * dropped; anything that isn't an add, update or supersede with a string text is left for the store to skip.
 * @param {unknown[]} ops
 * @param {{ sourceText: string, facts: { id: string, text: string }[], looksSecret: (text: string) => boolean }} o
 */
function checkOps(ops, { sourceText, facts, looksSecret }) {
  const said = new Set(words(sourceText));
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  /** @type {unknown[]} */
  const kept = [];
  /** @type {{ op: string, reason: string }[]} */
  const dropped = [];
  for (const op of ops) {
    const o = /** @type {any} */ (op);
    const text = typeof o?.text === 'string' ? o.text : null;
    if (text === null) {
      kept.push(op);
      continue;
    }
    if (looksSecret(text)) {
      dropped.push({ op: String(o.op), reason: 'looks like a secret' });
      continue;
    }
    const own = new Set(words(byId.get(String(o.id)) ?? ''));
    const unsaid = words(text).filter((w) => !said.has(w) && !own.has(w) && !GLUE.has(w) && !CJK_GLUE.has(w));
    if (unsaid.length) dropped.push({ op: String(o.op), reason: `not said: ${unsaid.slice(0, 3).join(', ')}` });
    else kept.push(op);
  }
  return { kept, dropped };
}

/**
 * Whether a turn's item is a message main sent that no human wrote (a routine's result, a nudge): by its id or client id
 * in the chat's `authored` record, or by the mark such a message starts with.
 */
const authoredItem = (/** @type {any} */ it, /** @type {Set<string>} */ authored) =>
  authored.has(String(it?.clientId ?? '')) || authored.has(String(it?.id ?? '')) || isAuthoredText(userMessageText(it));

/**
 * A turn's words as plain text: what the user wrote (each line with when they said it, given `label`) and what MoMo
 * replied, in order; a message no human wrote is MoMo's, never the user's.
 * @param {any} turn @param {Set<string>} [authored] @param {((it: any, turn: any) => string) | null} [label]
 */
function turnText(turn, authored = new Set(), label = null) {
  const lines = [];
  for (const it of Array.isArray(turn?.items) ? turn.items : []) {
    if (it?.type === 'userMessage') {
      // a user message's words are its content's text (turnItems.cjs); MoMo's block ahead of them is MoMo's memory
      const words = userMessageText(it);
      const own = withoutMomoBlock(words);
      if (authoredItem(it, authored)) lines.push(`MoMo: ${words}`);
      else if (own) lines.push(`User${label ? ` [${label(it, turn)}]` : ''}: ${own}`);
    } else if (it?.type === 'agentMessage' && typeof it.text === 'string') lines.push(`MoMo: ${it.text}`);
  }
  return lines.join('\n');
}

/**
 * A pass's prompt within MAX_PASS_TOKENS: the oldest half of what was said goes while that is long, then the last half
 * of the shown facts (the instructions alone are far under the cap).
 * @param {{ sourceText: string, facts: { id: string, text: string }[], reflect: boolean, loops?: { open: { id: string, text: string }[], now: string } | null }} o
 */
function cappedPrompt(o) {
  let { sourceText, facts } = o;
  const loops = o.loops ?? null;
  let prompt = passPrompt({ sourceText, facts, reflect: o.reflect, loops });
  while (estimateTokens(prompt) > MAX_PASS_TOKENS && (sourceText.length > 200 || facts.length)) {
    if (sourceText.length > 200) sourceText = sourceText.slice(Math.floor(sourceText.length / 2));
    else facts = facts.slice(0, Math.floor(facts.length / 2));
    prompt = passPrompt({ sourceText, facts, reflect: o.reflect, loops });
  }
  return { prompt, sourceText, facts };
}

/**
 * @typedef {{ chatId: string, harness: string }} Source
 * @param {object} o
 * @param {InstanceType<typeof import('./memory.cjs').MemoryStore>} o.store
 * @param {() => boolean} o.allowed MoMo is on for the account and not paused
 * @param {(chatId: string) => 'main' | 'routine' | 'pass' | null} o.kindOf what a chat is to MoMo (null: not MoMo's)
 * @param {(chatId: string) => Promise<any[]>} o.readTurns a chat's turns, oldest first (peerRuntime.readReference)
 * @param {() => Promise<any>} o.brain the brain a pass runs on, its cheap model chosen
 * @param {(brain: any) => boolean} o.atLimit whether that brain is known to be at its limit now
 * @param {(brain: any, tag: object) => Promise<string>} o.startChat a fresh isolated MoMo background chat
 * @param {(chatId: string, text: string) => Promise<unknown>} o.send
 * @param {(chatId: string) => Promise<unknown> | unknown} o.discardChat
 * @param {{ get: (chatId: string) => string | null, set: (chatId: string, turnId: string) => Promise<unknown> | void }} o.seen the last turn a
 *   pass read, per chat (by id: a long chat's reference holds only its newest turns, so a count would drift)
 * @param {(text: string) => boolean} o.looksSecret
 * @param {{ spend: (kind: 'memory', tokens: number) => Promise<void>, left: (kind: 'memory') => number }} o.budget the day's
 *   background tokens (backgroundBudget.cjs): a pass starts only when its prompt and reply fit the memory share left
 * @param {(chatId: string | null) => string | null} [o.mainChat] MoMo's main chat, the source of a reflection
 * @param {(chatId: string) => Set<string>} [o.authoredIds] the ids of the chat's messages no human wrote (its meta `authored`)
 * @param {{ store: InstanceType<typeof import('./openLoops.cjs').OpenLoopStore>, tz: () => string }} [o.loops] open loops: a
 *   pass over MoMo's main chat also reads promises, dates and to-dos from the user's own words (P4), in the user's zone
 * @param {() => number} [o.now] the clock open loops' times are read by
 * @param {number} [o.idleMs] how long a MoMo chat stays quiet before its pass (IDLE_MS; shorter only in a development build's E2E run)
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
 */
function createMemoryPass(o) {
  const timers = o.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const now = o.now ?? Date.now;
  /** @type {Map<string, any>} chat → its idle timer */
  const idle = new Map();
  /**
   * @typedef {{ gen: number }} Owner one start of a pass, in the generation it began in (cancelAll moves on)
   * @type {Map<string, Owner>} chat → the start that holds it: only that start (or its pass landing) frees it
   */
  const running = new Map();
  /** @type {Map<string, { source: Source, sourceText: string, facts: any[], upto: string | null, owner: Owner, from: string, loops: { said: import('./openLoopsShape.cjs').Said, tz: string, open: Set<string> } | null }>} pass chat → its pass */
  const pending = new Map();
  /** @type {Set<string>} chats whose idle came while their pass ran: each gets one more pass once it lands */
  const again = new Set();
  let gen = 0;
  /** Whether `owner` began in this generation: after a reset, nothing it started is published or written. */
  const current = (/** @type {Owner} */ owner) => owner.gen === gen;
  /** Frees `chatId` only for the start that holds it, never for one a reset retired and a newer start replaced. */
  const release = (/** @type {string} */ chatId, /** @type {Owner} */ owner) => {
    if (running.get(chatId) === owner) running.delete(chatId);
  };
  /** @type {any} */
  let daily = null;

  /** Starts a pass over `chatId` (or, with `reflect`, over the kept facts as told from it); false when none was started. */
  async function start(/** @type {string} */ chatId, reflect = false) {
    if (!o.allowed()) return false;
    if (running.has(chatId)) {
      // a pass over this chat is under way: once it lands, one more reads what was said meanwhile
      if (!reflect) again.add(chatId);
      return false;
    }
    const owner = { gen };
    running.set(chatId, owner);
    let started = false;
    try {
      const turns = reflect ? [] : await o.readTurns(chatId);
      // reset while the turns were read
      if (!current(owner)) return false;
      const last = reflect ? null : o.seen.get(chatId);
      // the turns after the last one read; all the reference holds when that one is no longer in it
      const after = turns.findIndex((t) => last !== null && t?.id === last) + 1;
      const authored = o.authoredIds?.(chatId) ?? new Set();
      // open loops come only from what the user said in MoMo's main chat (never a routine's run or a coding chat)
      const loopsOn = !reflect && !!o.loops && o.kindOf(chatId) === 'main';
      const tz = loopsOn ? /** @type {NonNullable<typeof o.loops>} */ (o.loops).tz() : '';
      const label = loopsOn ? (/** @type {any} */ it, /** @type {any} */ t) => localLabel(saidAtOf(it, t, now()), tz) : null;
      const fresh = turns
        .slice(after)
        .map((t) => turnText(t, authored, label))
        .filter(Boolean)
        .join('\n\n');
      if (!reflect && !fresh) return false;
      const sourceText = reflect ? '' : fresh.slice(-MAX_SOURCE);
      const facts = reflect ? o.store.list().facts : o.store.search(sourceText, { limit: MAX_SHOWN });
      const all = facts.slice(0, reflect ? 200 : MAX_SHOWN).map((f) => ({ id: f.id, text: f.text }));
      if (reflect && !all.length) return false;
      const openLoops = loopsOn ? /** @type {NonNullable<typeof o.loops>} */ (o.loops).store.open().slice(0, MAX_SHOWN) : [];
      const loops = loopsOn ? { open: openLoops.map((l) => ({ id: l.id, text: l.text })), now: localLabel(now(), tz) } : null;
      const capped = cappedPrompt({ sourceText, facts: all, reflect, loops });
      const { prompt, facts: shown } = capped;
      if (o.budget.left('memory') < estimateTokens(prompt) + PASS_REPLY_TOKENS) return false;
      const brain = await o.brain();
      if (!current(owner) || !brain || o.atLimit(brain)) return false;
      const passChat = await o.startChat(brain, { momo: 'memory', forChat: chatId });
      // turned off or reset while the chat started: nothing is sent
      if (!current(owner) || !o.allowed()) {
        await o.discardChat(passChat);
        return false;
      }
      const entry = {
        source: { chatId, harness: String(brain.harness ?? '') },
        sourceText: reflect ? shown.map((f) => f.text).join('\n') : capped.sourceText,
        facts: shown,
        upto: reflect ? null : String(turns.at(-1)?.id ?? ''),
        owner,
        from: chatId,
        loops: loopsOn ? { said: saidOf(turns.slice(after), authored, now()), tz, open: new Set(openLoops.map((l) => l.id)) } : null,
      };
      pending.set(passChat, entry);
      await o.budget.spend('memory', estimateTokens(prompt));
      // reset or turned off while the prompt was counted: this pass is no longer the one to send (a reset already
      // discarded its chat with the passes under way)
      if (!current(owner) || pending.get(passChat) !== entry || !o.allowed()) {
        if (pending.get(passChat) === entry) {
          pending.delete(passChat);
          await o.discardChat(passChat);
        }
        return false;
      }
      started = true;
      try {
        await o.send(passChat, prompt);
      } catch (error) {
        // never sent: no turn of it will end, so its slot and its chat go now
        pending.delete(passChat);
        release(chatId, owner);
        await o.discardChat(passChat);
        throw error;
      }
      return true;
    } finally {
      if (!started) release(chatId, owner);
    }
  }

  /** A pass chat's turn ended: its ops are checked and applied (unless MoMo went off or was reset), and the chat goes. */
  async function landed(/** @type {string} */ passChat, /** @type {string | null | undefined} */ text) {
    const p = /** @type {NonNullable<ReturnType<typeof pending.get>>} */ (pending.get(passChat));
    pending.delete(passChat);
    release(p.from, p.owner);
    // the turns said while this pass ran get their own pass, after this one's progress is saved
    const more = again.delete(p.from) && current(p.owner);
    try {
      await o.budget.spend('memory', estimateTokens(String(text ?? '')));
      if (!current(p.owner) || !o.allowed()) return null;
      const ops = parseOps(text);
      /** @type {any} */
      let result = null;
      if (ops) {
        const { kept, dropped } = checkOps(ops, { sourceText: p.sourceText, facts: p.facts, looksSecret: o.looksSecret });
        const applied = await o.store.applyPass(/** @type {any} */ (kept), {
          source: p.source,
          reason: p.upto === null ? 'reflection' : 'chat idle',
        });
        result = { ...applied, dropped };
      }
      // reset while the facts were written: no loop lands either
      const loops = p.loops && current(p.owner) ? await landLoops(p, text) : null;
      if (!result && !loops) return null;
      // reset while the ops were written: how far it read belongs to no generation now
      // awaited: a pass that follows reads from here, not from before it
      if (p.upto && current(p.owner)) await o.seen.set(p.from, p.upto);
      return { ...result, ...(loops ? { loops } : {}) };
    } finally {
      await o.discardChat(passChat);
      if (more) start(p.from).catch((error) => noteIgnored("run MoMo's memory pass", error));
    }
  }

  /** A pass's loop ops, checked against the user's own words and applied to the loop store. */
  async function landLoops(/** @type {any} */ p, /** @type {unknown} */ text) {
    const raw = parseLoops(text);
    if (!raw?.length) return null;
    const checked = checkLoops(raw, { ...p.loops, looksSecret: o.looksSecret });
    const applied = await /** @type {NonNullable<typeof o.loops>} */ (o.loops).store.applyPass(checked, p.source);
    return { ...applied, dropped: checked.dropped };
  }

  return {
    /** A chat's turn ended (the controller's onFinished): a pass chat lands; a MoMo chat's idle clock starts again. */
    async finished(/** @type {{ chatId: string, text?: string | null }} */ e) {
      if (pending.has(e.chatId)) return landed(e.chatId, e.text);
      const kind = o.kindOf(e.chatId);
      if (kind !== 'main' && kind !== 'routine') return null;
      timers.clearTimeout(idle.get(e.chatId));
      const timer = timers.setTimeout(() => {
        idle.delete(e.chatId);
        start(e.chatId).catch((error) => noteIgnored("run MoMo's memory pass", error));
      }, o.idleMs ?? IDLE_MS);
      // a pending pass never keeps MoPilot from quitting
      timer?.unref?.();
      idle.set(e.chatId, timer);
      return null;
    },
    /** Starts the daily reflection over the kept facts, told as from MoMo's main chat. */
    startDaily() {
      if (daily !== null) return;
      daily = timers.setInterval(() => {
        const main = o.mainChat?.(null);
        if (main) start(main, true).catch((error) => noteIgnored("run MoMo's memory reflection", error));
      }, REFLECT_MS);
      daily?.unref?.();
    },
    /** MoMo went off or was reset: no idle clock runs, no pass under way lands, and its chat is discarded. */
    cancelAll() {
      gen++;
      for (const t of idle.values()) timers.clearTimeout(t);
      idle.clear();
      running.clear();
      again.clear();
      // a pass under way never lands now: its chat goes without waiting for its turn to end
      for (const passChat of pending.keys())
        Promise.resolve(o.discardChat(passChat)).catch((error) => noteIgnored("discard a memory pass's chat", error));
      pending.clear();
      if (daily !== null) timers.clearInterval(daily);
      daily = null;
    },
    start,
    pending: () => pending.size,
  };
}

module.exports = {
  createMemoryPass,
  passPrompt,
  cappedPrompt,
  parseOps,
  checkOps,
  turnText,
  IDLE_MS,
  REFLECT_MS,
  MAX_SOURCE,
  MAX_SHOWN,
  MAX_PASS_TOKENS,
  PASS_REPLY_TOKENS,
};
