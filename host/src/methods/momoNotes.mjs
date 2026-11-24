// The Host's handlers for MoMo's notes, cards and rules (#5474, shared/host/methods/momoNotes.mjs): thin calls into the gate, notes and learning services, read with `momo.service(id)` inside each call (never at load). Like every MoMo method they are veiled: a client that is not paired, or while no live grant is held, gets an unknown request. Answering a card, changing a note or a rule and recording a reaction are the owner's: only a paired desktop or phone may, never the local command line, which any process on this machine can reach. A tap names the device that made it from the connection's own standing, never from the request.
import { deviceOf } from '../momoDevice.mjs';
import { isOwner } from '../momoOwner.mjs';
import { onlyAtHome } from '../momoHomeGuard.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  /** @param {unknown} principal */
  const seen = (principal) => !!momo && !!principal && !!momo.granted();
  /** @param {unknown} principal */
  const owner = (principal) => seen(principal) && isOwner(principal);
  const home = /** @type {NonNullable<typeof momo>} */ (momo);
  /** @param {string} id */
  const service = (id) => /** @type {any} */ (home.service(id));
  return {
    guard: onlyAtHome(momo),
    veils: {
      'host.momoCards': owner,
      'host.momoCardAnswer': owner,
      'host.momoNotes': owner,
      'host.momoNoteAct': owner,
      'host.momoRules': owner,
      'host.momoRuleAct': owner,
      'host.momoReact': owner,
    },
    handlers: {
      'host.momoCards': async (/** @type {unknown} */ _p, /** @type {string} */ _kind, /** @type {unknown} */ who) => ({
        cards: await service('gate').cards(deviceOf(who).id),
      }),
      'host.momoCardAnswer': (/** @type {any} */ p, /** @type {string} */ _kind, /** @type {unknown} */ who) => {
        const device = deviceOf(who);
        return service('gate').answer(p.cardId, p.decision, device.id, device.name);
      },
      'host.momoNotes': () => ({ notes: service('notes').view() }),
      'host.momoNoteAct': async (/** @type {any} */ p, /** @type {string} */ _kind, /** @type {unknown} */ who) => {
        const notes = service('notes');
        const by = deviceOf(who).id;
        if (p.op === 'undo') return { result: await notes.undo(p.journalId, by) };
        if (p.op === 'restore') return { result: await notes.restore(p.snapshotId, by) };
        if (p.op === 'bring-back') return { ok: !!(await notes.bringBack(p.lineId, by)) };
        if (p.op === 'edit') return { ok: !!(await notes.edit(p.noteId, p.lineId, p.text, by)) };
        return { result: await notes.tidyIfDue(by) };
      },
      'host.momoRules': () => service('learning').view(),
      'host.momoRuleAct': async (/** @type {any} */ p, /** @type {string} */ _kind, /** @type {unknown} */ who) => {
        const learning = service('learning');
        const by = deviceOf(who).id;
        if (p.op === 'confirm') return { ok: await learning.confirm(p.ruleId, by) };
        if (p.op === 'decline') return { ok: await learning.decline(p.ruleId, by) };
        if (p.op === 'undo') return { ok: await learning.undo(p.ruleId, by) };
        return { ok: await learning.edit(p.ruleId, p.text, by) };
      },
      // a reaction is derived from a card this device answered, once: the client names the card and the tap, never what it is about
      'host.momoReact': async (/** @type {any} */ p, /** @type {string} */ _kind, /** @type {unknown} */ who) => {
        const out = await service('learning').reactToCard(p.cardId, p.kind, deviceOf(who).id);
        return {
          counted: !!out && !out.duplicate,
          change: out?.change ?? null,
          retired: (out?.retired ?? []).map((/** @type {any} */ r) => r.id),
        };
      },
    },
  };
};
