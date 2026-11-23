// What MoMo learns from the owner's taps on this Host (#5474, shared/momoCore/learning.ts): reactions are recorded per pattern, two that agree propose a rule, a quieter rule is on at once with Undo, the others wait for a tap, a reaction the other way retires the opposed rule. The state is sealed under the home's storage (it moves with a move, Reset deletes it). The gate reads `gateRules()` on every call, so a rule the owner turned on or off applies at once, and every change of what the gate allows is an audit line.
import crypto from 'node:crypto';
import {
  confirmRule,
  declineRule,
  editRule,
  ownerRule,
  ruleTextOf,
  RULE_TEXT_MAX,
  turnOnRule,
  emptyLearning,
  record,
  suggestRule,
  toGateRules,
  undoRule,
} from '../../../shared/momoCore/learning.ts';
import { ruleViews, signalViews } from '../../../shared/momoCore/view.ts';
import { sealedStore } from '../momoCoreHost.mjs';

/** @typedef {import('../../../shared/momoCore/learning.ts').LearnState} LearnState */
/** @typedef {import('../../../shared/momoCore/gateRules.ts').GateRule} GateRule */

const OWNER_RULES_MAX = 200;
/** How many of the owner's rules in words are given to the judge and the brain. */
export const OWNER_INSTRUCTIONS_MAX = 100;
/** And how many characters of them in all: the rest are left out, oldest first kept. */
export const OWNER_INSTRUCTIONS_CHARS = 6000;
/** The lanes that must read the owner's rules in words before the page may show them as on. */
const APPLIERS = ['notice', 'brain'];
const REACTED_KEEP = 500;

/** @param {any} v @returns {{ state: LearnState, ownerRules: GateRule[], uses: Record<string, number>, reacted: Record<string, number> }} */
const shape = (v) => {
  const fresh = emptyLearning();
  const s = v?.state;
  const str = (/** @type {unknown} */ x) => typeof x === 'string';
  return {
    state: {
      reactions: Array.isArray(s?.reactions) ? s.reactions : fresh.reactions,
      rules: Array.isArray(s?.rules) ? s.rules : fresh.rules,
      since: s?.since && typeof s.since === 'object' ? s.since : fresh.since,
    },
    ownerRules: (Array.isArray(v?.ownerRules) ? v.ownerRules : [])
      .filter(
        (/** @type {any} */ r) =>
          str(r?.id) &&
          (r.behavior === 'allow' || r.behavior === 'ask' || r.behavior === 'deny') &&
          str(r.tool) &&
          str(r.effect) &&
          str(r.scope) &&
          str(r.text),
      )
      .slice(0, OWNER_RULES_MAX),
    uses: Object.fromEntries(Object.entries(v?.uses ?? {}).filter(([, n]) => Number.isFinite(n))),
    /** @type {Record<string, number>} the card reactions already counted, so one tap delivered twice counts once */
    reacted: Object.fromEntries(
      Object.entries(v?.reacted ?? {})
        .filter(([, n]) => Number.isFinite(n))
        .slice(-REACTED_KEEP),
    ),
  };
};

/** @param {{ home: any, report?: (m: string) => void, now?: () => number }} deps */
export default ({ home, now = Date.now }) => {
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof shape>>> | null} */
  let store = null;
  const open = () =>
    (store ??= sealedStore({ dir: home.storage.dir, name: 'learning.json', safeStorage: home.data.safeStorage, shape, now }));
  /** @type {Set<string>} */
  const applied = new Set();
  const deps = () => ({ newId: () => crypto.randomUUID(), now });
  /** The audit line comes first: a change of what the gate may allow that cannot be recorded is not made. @param {string} id @param {'added' | 'edited' | 'removed'} kind @param {string} by */
  const audited = async (id, kind, by) => !!(await home.service('gate')?.policy?.(id, kind, by));
  /** Writes one change of the state while this Host is the running home; null when it is not. @template R @param {(all: ReturnType<typeof shape>) => R | Promise<R>} fn @returns {Promise<R | null>} */
  const change = async (fn) => (home.stamp() ? open().change(fn) : null);
  /** @param {(s: LearnState, at: number) => LearnState} step @param {'added' | 'edited' | 'removed'} kind @param {string} id @param {string} by */
  const act = async (step, kind, id, by) =>
    !!(await change(async (all) => {
      const next = step(all.state, now());
      if (next === all.state || !(await audited(id, kind, by))) return false;
      all.state = next;
      return true;
    }));
  /** Records a reaction; the rules it turns on or retires are audited before it is kept (null when one cannot be). @param {ReturnType<typeof shape>} all @param {any} input */
  const reaction = async (all, input) => {
    const r = record(all.state, input, deps());
    if (r.change.kind === 'activated' && !(await audited(r.change.rule.id, 'added', 'learning'))) return null;
    for (const rule of r.retired) if (!(await audited(rule.id, 'removed', 'learning'))) return null;
    all.state = r.state;
    return { change: r.change, retired: r.retired };
  };

  const api = {
    /** One tap of the owner on something the Host itself raised (a notice, a draft), called in this process by the lane that raised it; never from a client. Never called for silence. @param {{ pattern: string, label: string, kind: any, detail?: string, action?: any }} input */
    react: (input) => change((all) => reaction(all, input)),

    /**
     * A tap on a card, from the device that answered it: what the reaction is about comes from the card, not from the client, and the same tap counts once. Always allow needs an Allow that device gave, Deny a Deny.
     * @param {string} cardId @param {'always_allow' | 'deny'} kind @param {string} device the authenticated device
     */
    async reactToCard(cardId, kind, device) {
      const card = await home.service('gate')?.card?.(cardId);
      const answeredAs = kind === 'deny' ? ['denied'] : ['allowed', 'using', 'used'];
      if (!card || card.decidedBy !== device || !answeredAs.includes(card.status)) return null;
      const key = `${card.id}:${kind}`;
      const action = { tool: card.tool, effect: card.effect, scope: card.scope };
      return change(async (all) => {
        if (key in all.reacted) return { duplicate: true, change: null, retired: [] };
        if (!(await home.service('gate')?.audit?.({ event: 'learning.reacted', reason: kind, cardId: card.id, by: device }))) return null;
        const counted = await reaction(all, {
          pattern: `action:${card.tool}|${card.effect}|${card.scope}`,
          label: card.summary,
          kind,
          action,
        });
        if (!counted) return null;
        all.reacted[key] = now();
        return { duplicate: false, ...counted };
      });
    },

    /** An owner's order that was kept out of the notes, now a rule that waits for a tap. @param {{ text: string, sourceId: string, quote: string }} input */
    suggest: (input) =>
      change(async (all) => {
        const made = suggestRule(all.state, input, deps());
        // a suggestion is a change of what MoMo may later be told to do: its audit line comes first
        if (made.rule && !(await audited(made.rule.id, 'added', 'notes'))) return null;
        all.state = made.state;
        return made.rule ?? null;
      }),
    /** @param {string} ruleId @param {string} by */
    confirm: (ruleId, by) => act((s, at) => confirmRule(s, ruleId, at), 'added', ruleId, by),
    /** @param {string} ruleId @param {string} by */
    decline: (ruleId, by) => act((s, at) => declineRule(s, ruleId, at), 'removed', ruleId, by),
    /** @param {string} ruleId @param {string} by */
    undo: (ruleId, by) => act((s, at) => undoRule(s, ruleId, at), 'removed', ruleId, by),
    /** A rule the owner wrote in words, on at once: audited first. @param {string} text @param {string} effect @param {string} by */
    add: (text, effect, by) =>
      change(async (all) => {
        const made = ownerRule(all.state, { text, effect }, deps());
        if (!made.rule) return { ok: false, reason: made.reason };
        if (!(await audited(made.rule.id, 'added', by))) return null;
        all.state = made.state;
        return { ok: true, id: made.rule.id };
      }),
    /** A rule that was switched off or undone, back on. @param {string} ruleId @param {string} by */
    turnOn: (ruleId, by) => act((s, at) => turnOnRule(s, ruleId, at), 'added', ruleId, by),
    /** @param {string} ruleId @param {string} text @param {string} by */
    edit: (ruleId, text, by) => act((s) => editRule(s, ruleId, text), 'edited', ruleId, by),
    /** The owner's own rule (a plain allow, ask or deny). @param {GateRule} rule @param {string} by */
    async addOwnerRule(rule, by) {
      return !!(await change(async (all) => {
        if (
          all.ownerRules.length >= OWNER_RULES_MAX ||
          all.ownerRules.some((r) => r.id === rule.id) ||
          !(await audited(rule.id, 'added', by))
        )
          return false;
        all.ownerRules.push(rule);
        return true;
      }));
    },
    /** @param {string} ruleId @param {string} by */
    async removeOwnerRule(ruleId, by) {
      return !!(await change(async (all) => {
        if (!all.ownerRules.some((r) => r.id === ruleId) || !(await audited(ruleId, 'removed', by))) return false;
        all.ownerRules = all.ownerRules.filter((r) => r.id !== ruleId);
        return true;
      }));
    },
    /** What the gate reads on every call: the owner's rules and the ones learned that are on. @returns {GateRule[]} */
    gateRules() {
      if (!home.stamp()) return [];
      const all = open().read();
      return [...all.ownerRules, ...toGateRules(all.state)];
    },
    /** The gate applied this learned rule. @param {string} ruleId */
    async used(ruleId) {
      await change((all) => void (all.uses[ruleId] = (all.uses[ruleId] ?? 0) + 1));
    },
    /**
     * The owner's standing instructions in words, for the notice judge's prompt and the brain's turn context: the rules the owner wrote (tell now, stay quiet, ask first) and the orders they accepted, that are on. Owner-authored text from a paired device, so trusted as instructions, but they only ever add (stay quiet, tell, ask first): they never remove a card and never become a gate rule. Framing is the reader's: they are the owner's standing preferences BELOW the gate (they never change what needs approval). At most OWNER_INSTRUCTIONS_MAX rules of RULE_TEXT_MAX characters each and OWNER_INSTRUCTIONS_CHARS characters in all, oldest first; an accepted suggestion's text (model-written, at most RULE_TEXT_MAX) is shown whole on the Rules page before Accept.
     * @returns {{ id: string, text: string, kind: 'tell_now' | 'stay_quiet' | 'ask_first' | 'instruction' }[]}
     */
    ownerRules() {
      if (!home.stamp()) return [];
      return open()
        .read()
        .state.rules.filter((r) => r.stance === 'instruction' && r.status === 'on')
        .slice(0, OWNER_INSTRUCTIONS_MAX)
        .map((r) => ({
          id: r.id,
          text: ruleTextOf(r).slice(0, RULE_TEXT_MAX),
          kind: /** @type {'tell_now' | 'stay_quiet' | 'ask_first' | 'instruction'} */ (r.ownerEffect ?? 'instruction'),
        }))
        .filter((r, i, all) => all.slice(0, i + 1).reduce((n, x) => n + x.text.length, 0) <= OWNER_INSTRUCTIONS_CHARS);
    },
    /**
     * A lane says it now reads `ownerRules()` (`notice`: the judge's prompt, `brain`: the turn's context). Until both have, the owner's rules in words are shown as saved, not as on.
     * @param {'notice' | 'brain'} lane
     */
    appliedBy(lane) {
      if (APPLIERS.includes(lane)) applied.add(lane);
    },

    /** What the Rules page draws. */
    view() {
      if (!home.stamp()) return { rules: [], signals: [] };
      const all = open().read();
      return { rules: ruleViews(all.state, all.uses, applied.size >= APPLIERS.length), signals: signalViews(all.state) };
    },
  };
  /** One owner rule, written as the owner's own is. */
  const seed = async () => {
    await api.addOwnerRule({ id: 'seed-rule', behavior: 'ask', tool: 'momo.seed', effect: '*', scope: '*', text: 'Seed' }, 'seed');
  };
  home.use('learning', { seed, start: () => undefined, pause: () => undefined, wipe: () => void (store = null) });
  home.provide('learning', api);
};
