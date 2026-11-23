// What the gate keeps of each card's request so the owner can act on the card later (#5474): the exact request a card was raised for, and for a note the owner's words it was checked against. With it, the owner's Allow on a notes card runs that op once in any later turn; "ask again" raises a fresh card for the same request after a deny, an expiry or an uncertain end; and "edit" replaces a waiting card with a NEW card for the edited text (new arguments, new binding), the old one void, never changing a card that is bound. At most BOUND_KEEP are kept (the oldest let go with its card void); an entry whose card can no longer be answered or asked again is forgotten. Sealed under the home's storage with the home's data key, so it moves with a move and Reset deletes it.
import { createRequire } from 'node:module';
import { sealedStore } from './momoCoreHost.mjs';
import { NOTES_TOOL, NO_WORDS, applyNote } from './momoNotesTool.mjs';
import { looksLikeInstruction, looksSecret } from '../../shared/momoCore/text.ts';
import { fieldsOf } from './momoToolEffects.mjs';

const { ToolError } = createRequire(import.meta.url)('../../electron/capabilities/contract/registry.cjs');

/** How many cards may wait for the owner at once, and how many from one chat: more is refused to the model, so injected text cannot fill the owner's phone with cards or push out the genuine ones. */
export const MAX_WAITING = 50;
export const MAX_WAITING_PER_CHAT = 10;
/** How many entries are kept at all (the waiting ones, and the ended ones that can still be asked again). */
export const BOUND_KEEP = 200;
/** What the gate said of a request it turned down, in words for the owner. @type {Record<string, string>} */
const REFUSED_WORDS = {
  rule_deny: 'a rule of yours turns it down.',
  policy_denied: 'a rule of yours turns it down.',
  repeats_denied: 'it was turned down a moment ago.',
  audit_unavailable: 'it could not be recorded.',
  not_home: 'MoMo is not running on this machine.',
  default: 'it was turned down.',
};
/** How long a card that was turned down, ended unattended or ended uncertain keeps its request so the owner can ask again; a void or completed card keeps nothing. */
export const ASK_AGAIN_MS = 60 * 60_000;
const TEXT_MAX = 4000;
/** The reasons a card is void: it cannot be answered, and asking again is not offered. */
const VOID_WHY = ['moved', 'changed', 'dropped', 'superseded', 'taint_changed'];

/** A value shown on a card, cut on whole characters, with the cut said (as the arguments' own fields do). @param {string} text @param {number} max */
export const marked = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')} … (${chars.length - max} more characters not shown)` : text;
};

/** Why the owner is asked again when the chat read outside content after they allowed a card. */
const REISSUED_WHY = 'This chat read outside content after you allowed it, so MoMo needs your OK once more.';

/** @typedef {{ req: any, args: any, said?: { turnId: string, at: string, text: string }, current?: string | null, edited?: boolean }} Entry */

/** @param {any} v @returns {{ cards: Record<string, Entry> }} */
const shape = (v) => ({
  cards: Object.fromEntries(
    Object.entries(v?.cards ?? {})
      .filter(([, b]) => /** @type {any} */ (b)?.req)
      .slice(-BOUND_KEEP),
  ),
});

/**
 * @param {object} o
 * @param {any} o.home
 * @param {() => number} o.now
 * @param {(m: string) => void} o.report
 * @param {() => Promise<{ gate: any, store: import('../../shared/momoCore/approvalGate.ts').CardStore }>} o.ensure the gate and its card store
 * @param {(card: import('../../shared/momoCore/approvalGate.ts').Card) => Promise<unknown>} o.rowed writes a card's row in MoMo's chat
 * @param {() => { run: (req: any, exec: () => unknown) => Promise<any>, resume: (id: string, req: any, exec: () => unknown) => Promise<any> }} o.api the gate's own calls
 */
export function createBoundCards({ home, now, report, ensure, rowed, api }) {
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof shape>>> | null} */
  let store = null;
  const open = () =>
    (store ??= sealedStore({ dir: home.storage.dir, name: 'bound-notes.json', safeStorage: home.data.safeStorage, shape, now }));
  const read = () => open().read().cards;

  /** A card that cannot be answered any more: void, with its row saying so. @param {string} cardId @param {'changed' | 'dropped' | 'superseded'} why */
  const voidWithRow = async (cardId, why) => {
    const { gate, store: cards } = await ensure();
    await gate.voidCard(cardId, why);
    const voided = await cards.get(cardId);
    if (voided) await rowed(voided);
  };
  /** @param {string[]} ids */
  const drop = async (ids) => {
    const have = read();
    if (ids.some((id) => id in have)) await open().change((v) => void ids.forEach((id) => delete v.cards[id]));
  };
  /** @param {string} cardId @param {Entry} entry */
  const keep = async (cardId, entry) => {
    await open().change((v) => {
      v.cards[cardId] = entry;
    });
  };
  /** Whether a card can be asked again: it was turned down, ended unattended or ended uncertain (a void or completed one cannot). @param {import('../../shared/momoCore/approvalGate.ts').Card} card */
  const askable = (card) =>
    card.status === 'denied' ||
    (card.status === 'expired' && !VOID_WHY.includes(String(card.expiredWhy))) ||
    (card.status === 'used' && card.outcome === 'uncertain');
  /** Whether the owner's request for another card is welcome: at most MAX_WAITING cards wait, and MAX_WAITING_PER_CHAT from one chat. @param {string | undefined} chatId @returns {Promise<'ok' | 'chat' | 'all'>} */
  const room = async (chatId) => {
    // off the home there are no cards: the gate itself says so
    if (!home.stamp()) return 'ok';
    const { store: cards } = await ensure();
    const waiting = await cards.list(['open', 'allowed']);
    if (waiting.length >= MAX_WAITING) return 'all';
    return waiting.filter((c) => c.chatId === chatId).length >= MAX_WAITING_PER_CHAT ? 'chat' : 'ok';
  };
  /** Whether the Edit button is offered on a card: it waits, and the Host itself runs what it was for (a note), so the owner's new text is what runs. @param {string} cardId */
  const editable = (cardId) => {
    const e = read()[cardId];
    return !!e?.said && (e.args.type === 'add' || e.args.type === 'update');
  };
  /** Forgets the entries of cards that cannot be acted on any more: void, completed, gone, or turned down / ended an hour ago (also ones that came with a move after their card was voided). */
  const prune = async () => {
    const { store: cards } = await ensure();
    const all = new Map((await cards.list()).map((c) => [c.id, c]));
    await drop(
      Object.keys(read()).filter((id) => {
        const c = all.get(id);
        if (!c) return true;
        if (c.status === 'open' || c.status === 'allowed' || c.status === 'using') return false;
        return !(askable(c) && now() - /** @type {number} */ (c.usedAt ?? c.decidedAt) < ASK_AGAIN_MS);
      }),
    );
  };

  /** What the line of a note says now, for a card about it. @param {any} args */
  const lineNow = (args) => home.service('notes').lineText(args.noteId, args.lineId);

  /**
   * A call to the notes tool made ready for the gate: the owner's words behind it (none: it is refused, nothing was said to act on), the call without the `sourceId` the model may have sent, whether it needs a card whatever the chat (an update or retire needs the quote to be about the line), and the fields a card shows besides the arguments.
   * @param {{ tool: string, chatId?: string, args: any }} call
   */
  const prepare = (call) => {
    if (call.tool !== NOTES_TOOL)
      return {
        args: call.args,
        said: null,
        unbound: false,
        current: undefined,
        extra: /** @type {{ label: string, value: string }[]} */ ([]),
      };
    const said = home.service('ownerWords')?.current(call.chatId) ?? null;
    if (!said) throw new ToolError(NO_WORDS, 'read_only');
    const { sourceId: _dropped, ...args } = call.args;
    const edits = ['update', 'retire'].includes(args.type);
    const unbound = edits && !home.service('notes')?.binds?.(args);
    // what the line says now: shown on the card and kept, so Allow can tell whether it changed since the owner was asked
    const current = edits ? lineNow(args) : undefined;
    const extra = [
      ...(current === undefined ? [] : [{ label: 'Current line', value: marked(current ?? '(there is no such line)', 300) }]),
      { label: 'You said', value: marked(said.text, 300) },
    ];
    return { args, said, unbound, current, extra };
  };

  /** What runs when the owner allows an entry: a note's op, with the words it was checked against; an op the owner edited is the owner's own write. @param {Entry} entry @param {string} by */
  const execOf = (entry, by) => async () => {
    const { args } = entry;
    if (entry.edited) {
      const notes = home.service('notes');
      const title = args.title ?? notes.view().find((/** @type {any} */ n) => n.id === args.noteId)?.title ?? '';
      const done =
        args.type === 'add' ? await notes.write(title, args.text, by) : await notes.edit(args.noteId, args.lineId, args.text, by);
      if (!done || done.ok === false) throw Object.assign(new Error('The edited note could not be saved.'), { notSent: true });
      return 'Written to MoMo’s notes (the owner can undo it in History).';
    }
    const done = await applyNote({ home, chatId: entry.req.chatId, args, said: /** @type {NonNullable<Entry['said']>} */ (entry.said) });
    if (!done.ok) throw Object.assign(new Error(done.text), { notSent: true });
    return done.text;
  };

  /**
   * The owner answered a card. Allow on a notes card runs its op, once (the card is spent), unless the line changed since they were asked: then the card is void and nothing is applied. Deny keeps the entry: the owner may ask again.
   * @param {string} cardId @param {boolean} allow @param {{ id: string, name?: string }} by
   */
  const settle = async (cardId, allow, by) => {
    const entry = read()[cardId];
    if (!entry?.said || !allow) return;
    if (entry.current !== undefined && lineNow(entry.args) !== entry.current) {
      await voidWithRow(cardId, 'changed');
      report('A note the owner allowed was not changed: the line is not what they were asked about any more.');
      await drop([cardId]);
      return;
    }
    // if the chat read outside content after the owner was asked, the gate voids this card and asks again: the fresh card carries the same op, and says why it was asked
    const again = { ...entry.req, fields: [{ label: 'Asked again', value: REISSUED_WHY }, ...entry.req.fields].slice(0, 10) };
    const out = await api()
      .resume(cardId, again, execOf(entry, by.id))
      .catch((/** @type {Error} */ error) => {
        report(`MoMo could not write the note the owner allowed: ${error.message}`);
        return null;
      });
    if (out && 'pending' in out && out.reissued) await keep(out.card.id, { ...entry, req: again });
  };

  /** What `exec` is for a request the Host does not run itself (a model's tool call): the model's retry spends the card, so if the gate now lets it through, say so. */
  const modelRuns = async () => {
    throw Object.assign(new Error('MoMo may do this now without asking: ask it again in the chat.'), { notSent: true });
  };

  /**
   * "Ask again" on a card that was turned down, ended unattended or ended uncertain: a fresh card for the same request (the gate gives the same card back when one is already waiting for it).
   * @param {string} cardId
   * @returns {Promise<{ ok: true, ran: boolean } | { ok: false, reason: 'gone' | 'not_askable' | 'allowed_now' | 'changed' | 'refused' }>}
   */
  const askAgain = async (cardId) => {
    const entry = read()[cardId];
    const { store: cards } = await ensure();
    const card = await cards.get(cardId);
    if (!entry || !card) return { ok: false, reason: 'gone' };
    if (!askable(card)) return { ok: false, reason: 'not_askable' };
    const current = entry.current === undefined ? undefined : lineNow(entry.args);
    // asked for by the owner's tap, so it is a request of the owner's chat, not an unattended one: the repeat refusal of unattended work and its short expiry do not apply
    const req = {
      ...entry.req,
      origin: 'chat',
      fields: entry.req.fields.map((/** @type {{ label: string, value: string }} */ f) =>
        f.label === 'Current line' && current !== undefined ? { ...f, value: marked(current ?? '(there is no such line)', 300) } : f,
      ),
    };
    const next = { ...entry, req, ...(current === undefined ? {} : { current }) };
    // if an Always allow rule lets it through with no card, it runs now: only on the line the owner was first shown, never on a line changed since
    let changed = false;
    const guarded = async () => {
      if (entry.current !== undefined && lineNow(entry.args) !== entry.current) {
        changed = true;
        throw Object.assign(new Error('The line changed after you were asked.'), { notSent: true });
      }
      return execOf(next, 'owner')();
    };
    const out = await api().run(req, entry.said ? guarded : modelRuns);
    if ('pending' in out) {
      await keep(out.card.id, next);
      return { ok: true, ran: false };
    }
    if ('done' in out) return { ok: true, ran: true };
    if (changed) return { ok: false, reason: 'changed' };
    return { ok: false, reason: 'failed' in out ? 'allowed_now' : 'refused' };
  };

  /**
   * "Edit" on a card that waits: a NEW card for the edited text (new arguments, new binding) and the old one void; a card that is bound is never changed in place. The edited text is the owner's own, so on Allow a note is written as the owner's line.
   * @param {string} cardId @param {string} body
   * @returns {Promise<{ ok: true } | { ok: false, reason: 'gone' | 'not_waiting' | 'not_editable' | 'no_text' | 'invalid' | 'secret' | 'instruction' }  | { ok: false, reason: 'refused', cause: string }>}
   */
  const edit = async (cardId, body) => {
    const entry = read()[cardId];
    const { gate, store: cards } = await ensure();
    const card = await cards.get(cardId);
    if (!entry || !card) return { ok: false, reason: 'gone' };
    if (card.status !== 'open') return { ok: false, reason: 'not_waiting' };
    // only a card the Host itself runs can take the owner's new text: for any other the model runs the call, and it would never learn of the change
    if (!entry.said) return { ok: false, reason: 'not_editable' };
    if (!(entry.args.type === 'add' || entry.args.type === 'update')) return { ok: false, reason: 'no_text' };
    const text = body.trim();
    if (!text || text.length > TEXT_MAX) return { ok: false, reason: 'invalid' };
    // checked before the old card is given up: a text that would never be written must not cost the owner the card
    if (looksSecret(text)) return { ok: false, reason: 'secret' };
    if (entry.args.type === 'add' && looksLikeInstruction(text)) return { ok: false, reason: 'instruction' };
    const args = { ...entry.args, text };
    const shown = fieldsOf(args);
    // the card keeps what it showed besides the arguments (the line as it is, what the owner said), and shows the new text
    const kept = entry.req.fields.filter((/** @type {{ label: string }} */ f) => f.label === 'Current line' || f.label === 'You said');
    const req = { ...entry.req, args, fields: [...kept, ...shown.fields].slice(0, 10) };
    const next = { ...entry, req, args, edited: true };
    // the old card is claimed first: while it is void an Allow on it cannot write the old text, and a second Allow cannot write both
    if (!(await gate.voidCard(cardId, 'superseded'))) return { ok: false, reason: 'not_waiting' };
    const voided = await cards.get(cardId);
    if (voided) await rowed(voided);
    const out = await api().run(req, execOf(next, 'owner'));
    if (!('pending' in out)) {
      // the old card is gone and no new one was made: the chat says why the card ended, and the owner is told the real cause
      const cause = 'refused' in out ? (REFUSED_WORDS[out.reason] ?? REFUSED_WORDS.default) : REFUSED_WORDS.default;
      await cards.transition(cardId, 'expired', {
        failure: { cause: `You changed this card, but MoMo can't ask for the new text: ${cause}` },
      });
      const ended = await cards.get(cardId);
      if (ended) await rowed(ended);
      return { ok: false, reason: 'refused', cause };
    }
    await keep(out.card.id, next);
    return { ok: true };
  };

  return {
    keep,
    drop,
    prune,
    prepare,
    settle,
    askAgain,
    edit,
    room,
    editable,
    read,
    wipe: () => void (store = null),
    seedEntry: (/** @type {string} */ id) =>
      keep(id, { req: { tool: 'momo.seed', fields: [] }, args: {}, said: { turnId: 'seed-0001', at: 'seed', text: 'seed' } }),
  };
}
