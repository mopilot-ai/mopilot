// What the clients' card, note and rule buttons do on the home's Host (shared/momoIntents.mjs, lane `gate`): the owner's tap on an approval card, on a line of the notes, on a rule. Each goes through the same service call the wire methods use (host/src/methods/momoNotes.mjs), so the single-use, expiry and void rules of the gate, the audit line first and the owner-only veil are the same on both paths. The device that tapped (`by`) is set by the Host from the connection (host/src/methods/momoLaneIntent.mjs), never taken from the client. A kind that is not here is answered by the registry as "MoMo can't do that yet": changing the body of a card, asking again, a question card, restoring, forgetting or writing a note, adding a rule or turning one back on have no Host operation yet.
import { IntentError } from '../../shared/momoHomeApi.mjs';

/** A card's row names it `approval:<id>`; the card is the id. @param {string} id */
const cardOf = (id) => id.replace(/^approval:/, '');

/** What the gate said of a tap that did not win, in words for the owner. @param {string} status */
const WHY = (status) =>
  ({
    missing: 'That card is gone.',
    expired: 'That card expired, or MoMo moved, so it can no longer be answered.',
    not_home: 'MoMo isn’t running on this machine right now.',
    audit_unavailable: 'MoMo couldn’t record that, so nothing was done.',
  })[status] ?? 'That card was already answered.';

/** What the questions service said of an answer that did not win, in words for the owner. @param {string} status */
const QUESTION_WHY = (status) =>
  ({
    missing: 'That question is gone.',
    void: 'That question can no longer be answered, because MoMo moved.',
    invalid: 'That is not one of the answers.',
    not_home: 'MoMo isn’t running on this machine right now.',
    audit_unavailable: 'MoMo couldn’t record that, so nothing was done.',
  })[status] ?? 'That question was already answered.';

/** What asking a card again, or editing one, was told. @type {Record<string, string>} */
const AGAIN_WHY = {
  gone: 'MoMo no longer has what that card was for.',
  not_askable: 'That card can’t be asked again: it is still waiting, or it can no longer be answered.',
  allowed_now: 'MoMo may do that now without asking: ask for it in the chat.',
  changed: 'The line changed after you were asked, so nothing was applied.',
  refused: 'MoMo can’t ask for that any more.',
};
/** @type {Record<string, string>} */
const EDIT_WHY = {
  gone: 'MoMo no longer has what that card was for.',
  not_waiting: 'That card is no longer waiting, so it can’t be edited.',
  not_editable:
    'That card can’t be edited here: the chat runs that action, so it would never see your change. Turn it down and say what you want in the chat.',
  no_text: 'That card has no text to edit.',
  invalid: 'Write the text in up to 4000 characters.',
  secret: 'That looks like a password or key, so it was not used.',
  instruction: 'That reads as a rule, not a note: add it in Rules.',
};

/** What a note the owner wrote or forgot was told, in words for them. @type {Record<string, string>} */
const NOTE_WHY = {
  invalid: 'Write a title and a line (the line up to 4000 characters).',
  secret: 'That looks like a password or key, so it was not saved.',
  instruction: 'That reads as a rule, not a note: add it in Rules.',
  full: 'Your notes are full: forget something first.',
  same: 'That is already in your notes.',
};
/** What a rule the owner wrote was told. @type {Record<string, string>} */
const RULE_WHY = {
  effect:
    'MoMo can only add a rule in words that keeps it quieter, tells you, or asks first. To stop it asking about an action, tap Always allow on that action’s card.',
  invalid: 'Write the rule in a few words.',
  same: 'You already have that rule.',
  full: 'You have as many rules of your own as MoMo can keep: remove one first.',
};

/** @param {{ home: { service: (id: string) => any } }} deps @returns {Record<string, (intent: any) => Promise<unknown>>} */
export function gateIntents({ home }) {
  /** @param {any} intent */
  const device = (intent) => /** @type {{ id: string, name?: string }} */ (intent.by ?? { id: 'unknown' });
  /** @param {string} id @param {'allow' | 'deny'} decision @param {any} intent */
  const answer = async (id, decision, intent) => {
    const by = device(intent);
    const out = await home.service('gate').answer(cardOf(id), decision, by.id, by.name);
    if (!out.won) throw new IntentError(WHY(out.status));
    return null;
  };
  /** @param {unknown} done @param {string} cause */
  const must = (done, cause) => {
    if (!done) throw new IntentError(cause);
    return null;
  };
  const RULE_GONE = 'That rule is gone or has already been changed.';
  return {
    'question.answer': async (i) => {
      const by = device(i);
      const out = await home.service('questions').answer(i.id, i.optionId, by);
      if (!out.won) throw new IntentError(QUESTION_WHY(out.status));
      return null;
    },
    'note.write': async (i) => {
      const r = await home.service('notes').write(i.title, i.text, device(i).id);
      if (!r) throw new IntentError('MoMo couldn’t record that, so nothing was done.');
      if (!r.ok) throw new IntentError(NOTE_WHY[r.reason]);
      return null;
    },
    'note.restore': async (i) => {
      const r = await home.service('notes').restoreNote(i.noteId, device(i).id);
      if (!r) throw new IntentError('MoMo couldn’t record that, so nothing was done.');
      if (!r.ok) throw new IntentError('The nightly tidy let nothing go in that note, or it has already been brought back.');
      return null;
    },
    'note.forget': async (i) => {
      const r = await home.service('notes').forget(i.noteId, i.lineId, device(i).id);
      if (!r) throw new IntentError('MoMo couldn’t record that, so nothing was done.');
      if (!r.ok) throw new IntentError('That note or line is already gone.');
      return null;
    },
    'rule.add': async (i) => {
      const r = await home.service('learning').add(i.text, i.effect, device(i).id);
      if (!r) throw new IntentError('MoMo couldn’t record that, so nothing was done.');
      if (!r.ok) throw new IntentError(RULE_WHY[r.reason]);
      return null;
    },
    'rule.turnOn': async (i) => must(await home.service('learning').turnOn(i.id, device(i).id), 'That rule is gone, or it is already on.'),
    'approval.askAgain': async (i) => {
      const r = await home.service('gate').askAgain(cardOf(i.id));
      if (!r.ok) throw new IntentError(AGAIN_WHY[r.reason]);
      // an Always allow rule of the owner's let it through with no card: it was done, and they are told
      return r.ran ? { ran: 'Done: your Always allow rule lets this through, so MoMo did it without a new card.' } : null;
    },
    'approval.edit': async (i) => {
      const r = await home.service('gate').editApproval(cardOf(i.id), i.body);
      if (!r.ok)
        throw new IntentError(
          r.reason === 'refused' ? `The old card is gone and MoMo couldn’t make a new one: ${r.cause}` : EDIT_WHY[r.reason],
        );
      return null;
    },
    'approval.send': (i) => answer(i.id, 'allow', i),
    'approval.deny': (i) => answer(i.id, 'deny', i),
    'note.edit': async (i) =>
      must(await home.service('notes').edit(i.noteId, i.lineId, i.text, device(i).id), 'That line is gone, so it was not changed.'),
    'note.undo': async (i) => {
      const r = await home.service('notes').undo(i.changeId, device(i).id);
      if (!r?.found) throw new IntentError('That change can’t be undone any more.');
      return null;
    },
    'rule.accept': async (i) => must(await home.service('learning').confirm(i.id, device(i).id), RULE_GONE),
    'rule.undo': async (i) => must(await home.service('learning').undo(i.id, device(i).id), RULE_GONE),
    // a rule that is turned off stops applying: it is the same change as undoing it
    'rule.turnOff': async (i) => must(await home.service('learning').undo(i.id, device(i).id), RULE_GONE),
    'rule.edit': async (i) => {
      const learning = home.service('learning');
      const rule = learning.view().rules.find((/** @type {any} */ r) => r.id === i.id);
      if (!rule) throw new IntentError(RULE_GONE);
      // only the words of a rule can change here; when it applies and whether the brief lists it are the rule's own
      if (i.effect !== rule.effect || (i.inBrief !== undefined && i.inBrief !== rule.inBrief))
        throw new IntentError('MoMo can only change the words of a rule here, not when it applies.');
      return must(await learning.edit(i.id, i.text, device(i).id), RULE_GONE);
    },
  };
}
