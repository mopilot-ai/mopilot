// The wire methods of MoMo's notes, cards and rules on a Host (#5474): list and answer the approval cards, read and change the notes (undo, edit, bring back, restore last night), read and change the learned rules, and record a tap. Every one needs the `momo` feature, so an older Host or an ungranted client sees an unknown request.
import { MOMO_FEATURE } from './momo.mjs';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const NOTE_OPS = ['undo', 'edit', 'bring-back', 'restore', 'tidy'];
const RULE_OPS = ['confirm', 'decline', 'undo', 'edit'];
const MAX_TEXT = 4000;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  /** @param {unknown} v @param {string} what @param {number} [max] */
  const text = (v, what, max = 300) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`That is not ${what}.`);
    return v;
  };
  /** @param {unknown} v @param {string} what */
  const id = (v, what) => matchOf(v, ID, `That is not ${what}.`);
  return {
    features: [MOMO_FEATURE],
    methods: {
      // the approval cards a device draws: the open ones, and the latest settled
      'host.momoCards': { access: 'open', requires: [MOMO_FEATURE], parse: () => ({}) },
      // one tap on a card; the first answer from any device wins
      'host.momoCardAnswer': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (p.decision !== 'allow' && p.decision !== 'deny') throw bad('That is not an answer.');
          return { cardId: id(p.cardId, 'a card id'), decision: p.decision };
        },
      },
      'host.momoNotes': { access: 'open', requires: [MOMO_FEATURE], parse: () => ({}) },
      // undo one change, edit a line, bring a line back, restore last night, or tidy now
      'host.momoNoteAct': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const op = NOTE_OPS.find((o) => o === p.op);
          if (!op) throw bad('That is not something to do with a note.');
          if (op === 'undo') return { op, journalId: id(p.journalId, 'a change id') };
          if (op === 'restore') return { op, snapshotId: id(p.snapshotId, 'a snapshot id') };
          if (op === 'bring-back') return { op, lineId: id(p.lineId, 'a line id') };
          if (op === 'edit')
            return { op, noteId: id(p.noteId, 'a note id'), lineId: id(p.lineId, 'a line id'), text: text(p.text, 'a line', MAX_TEXT) };
          return { op };
        },
      },
      'host.momoRules': { access: 'open', requires: [MOMO_FEATURE], parse: () => ({}) },
      // turn a suggested rule on, turn it down, undo it, or rewrite it
      'host.momoRuleAct': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const op = RULE_OPS.find((o) => o === p.op);
          if (!op) throw bad('That is not something to do with a rule.');
          const ruleId = id(p.ruleId, 'a rule id');
          return op === 'edit' ? { op, ruleId, text: text(p.text, 'a rule') } : { op, ruleId };
        },
      },
      // the owner's tap on a card that device answered, as a reaction (Always allow after an Allow, Deny after a Deny): what it is about comes from the card, and one tap counts once
      'host.momoReact': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (p.kind !== 'always_allow' && p.kind !== 'deny') throw bad('That is not a reaction.');
          return { cardId: id(p.cardId, 'a card id'), kind: p.kind };
        },
      },
    },
  };
};
