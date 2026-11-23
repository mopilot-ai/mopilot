// What MoMo asks the owner and what they answer (#5474, shared/momoView.ts `MomoQuestionView`): the model asks one question with a few answers to tap (`momo_ask`, host/src/momoAskTool.mjs), it is a row in MoMo's chat, and the owner's answer from any paired device is kept once, first answer wins. The answer reaches the turn that asked the way an approval does: the model asks again and is given the answer, once. A question never asks to act (that is an approval card) and a question of a home that is no longer the home is void. Sealed under the home's storage (it moves with a move, Reset deletes it).
import crypto from 'node:crypto';
import { sealedStore } from '../momoCoreHost.mjs';

/** How many questions wait at once, how many are kept, and the bounds of one question. */
export const MAX_PENDING = 10;
const KEEP = 100;
const SWEEP_MS = 60_000;
const LIMITS = { title: 200, body: 1000, label: 60, options: [2, 6] };

/** @typedef {{ id: string, chatId: string, fingerprint: string, title: string, body: string, options: { id: string, label: string }[], status: 'pending' | 'answered' | 'void', fence: string, createdAt: number, answer: { optionId: string, device: string, at: number } | null, consumed: boolean }} Question */

/** The oldest answered or void questions go when there are more than KEEP; one that waits is never trimmed. @param {{ items: Question[] }} all */
const trimmed = (all) => {
  let extra = all.items.length - KEEP;
  all.items = all.items.filter((x) => x.status === 'pending' || extra-- <= 0);
  return all;
};

/** @param {any} v @returns {{ items: Question[] }} */
const shape = (v) =>
  trimmed({
    items: (Array.isArray(v?.items) ? v.items : []).filter(
      (/** @type {any} */ q) =>
        typeof q?.id === 'string' && typeof q.title === 'string' && Array.isArray(q.options) && typeof q.status === 'string',
    ),
  });

/** @param {unknown} v @param {number} max */
const clean = (v, max) =>
  typeof v === 'string'
    ? Array.from(
        v
          .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
        .slice(0, max)
        .join('')
    : '';

/** @param {{ home: any, report?: (m: string) => void, now?: () => number }} deps */
export default ({ home, report = () => undefined, now = Date.now }) => {
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof shape>>> | null} */
  let store = null;
  const open = () =>
    (store ??= sealedStore({ dir: home.storage.dir, name: 'questions.json', safeStorage: home.data.safeStorage, shape, now }));
  const fenceOf = (/** @type {{ homeId: string, leaseEpoch: number }} */ s) => `${s.homeId}:${s.leaseEpoch}`;
  /** The view the row and the clients draw. @param {Question} q */
  const viewOf = (q) => ({
    id: q.id,
    title: q.title,
    body: q.body,
    options: q.options,
    expiresAt: null,
    status: q.status,
    // the row is the same for every client and names no device: who answered is in the audit line
    answer: q.answer ? { optionId: q.answer.optionId, device: '', at: q.answer.at } : null,
  });
  /** MoMo's chat shows the question and then its answer: the row is written again at each change, and a chat that is not there yet is told at the next look. @param {Question} q */
  const rowOf = async (q) => {
    try {
      await home.rows?.put({ kind: 'question', id: `question:${q.id}`, at: q.createdAt, question: viewOf(q) });
    } catch (error) {
      report(`MoMo could not write a question's row: ${/** @type {Error} */ (error).message}`);
    }
  };
  /** Questions of a lease this home no longer holds are void: they cannot be answered. @param {{ homeId: string, leaseEpoch: number }} stamp */
  const voidStale = async (stamp) => {
    /** @type {Question[]} */
    const gone = [];
    await open().change((all) => {
      for (const q of all.items)
        if (q.status === 'pending' && q.fence !== fenceOf(stamp)) {
          q.status = 'void';
          gone.push({ ...q });
        }
    });
    for (const q of gone) await rowOf(q);
  };

  const api = {
    /**
     * The model asks. The same question (the same words and answers, in the same chat) while it waits is the one that waits; once answered it is given back, once; then it is a new question.
     * @param {{ chatId: string, title: unknown, body?: unknown, options: unknown }} input
     * @returns {Promise<{ state: 'pending' | 'answered' | 'full' | 'invalid' | 'away', question?: Question, label?: string }>}
     */
    async ask({ chatId, title, body, options }) {
      const stamp = home.stamp();
      if (!stamp) return { state: 'away' };
      const t = clean(title, LIMITS.title);
      const labels = Array.isArray(options) ? options.map((o) => clean(o, LIMITS.label)) : [];
      if (
        !t ||
        labels.length < LIMITS.options[0] ||
        labels.length > LIMITS.options[1] ||
        labels.some((l) => !l) ||
        new Set(labels).size !== labels.length
      )
        return { state: 'invalid' };
      await voidStale(stamp);
      const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify([chatId, t, labels]))
        .digest('hex');
      /** @type {{ state: 'pending' | 'answered' | 'full', question: Question | null, fresh: boolean }} */
      const out = await open().change((all) => {
        const same = all.items.find((q) => q.fingerprint === fingerprint && q.status !== 'void' && !q.consumed);
        if (same?.status === 'answered') {
          same.consumed = true;
          return { state: /** @type {const} */ ('answered'), question: { ...same }, fresh: false };
        }
        if (same) return { state: /** @type {const} */ ('pending'), question: { ...same }, fresh: false };
        if (all.items.filter((q) => q.status === 'pending').length >= MAX_PENDING)
          return { state: /** @type {const} */ ('full'), question: null, fresh: false };
        /** @type {Question} */
        const q = {
          id: crypto.randomUUID(),
          chatId,
          fingerprint,
          title: t,
          body: clean(body, LIMITS.body),
          options: labels.map((label, i) => ({ id: `o${i + 1}`, label })),
          status: 'pending',
          fence: fenceOf(stamp),
          createdAt: now(),
          answer: null,
          consumed: false,
        };
        all.items.push(q);
        trimmed(all);
        return { state: /** @type {const} */ ('pending'), question: { ...q }, fresh: true };
      });
      if (out.fresh && out.question) {
        await home.service('gate')?.audit?.({ event: 'question.asked', cardId: out.question.id, chatId });
        await rowOf(out.question);
      }
      if (out.state === 'answered' && out.question) {
        const picked = out.question.options.find((o) => o.id === out.question?.answer?.optionId);
        return { state: 'answered', question: out.question, label: picked?.label };
      }
      return { state: out.state, ...(out.question ? { question: out.question } : {}) };
    },

    /**
     * One answer to one question; the first from any device wins. The audit line is written before the answer is kept, and with none it is not.
     * @param {string} id @param {string} optionId @param {{ id: string, name?: string }} by
     * @returns {Promise<{ won: boolean, status: string }>}
     */
    async answer(id, optionId, by) {
      const stamp = home.stamp();
      if (!stamp) return { won: false, status: 'not_home' };
      await voidStale(stamp);
      /** @type {{ won: boolean, status: string, question?: Question }} */
      const out = await open().change(async (all) => {
        const q = all.items.find((x) => x.id === id);
        if (!q) return { won: false, status: 'missing' };
        if (q.status !== 'pending') return { won: false, status: q.status };
        if (!q.options.some((o) => o.id === optionId)) return { won: false, status: 'invalid' };
        if (!(await home.service('gate')?.audit?.({ event: 'question.answered', cardId: q.id, chatId: q.chatId, by: by.id })))
          return { won: false, status: 'audit_unavailable' };
        q.status = 'answered';
        q.answer = { optionId, device: '', at: now() };
        return { won: true, status: 'answered', question: { ...q } };
      });
      if (out.question) await rowOf(out.question);
      return { won: out.won, status: out.status };
    },

    /** Writes the row of every question that has none yet (MoMo had no chat when it was asked): an identical row is not written twice. */
    async syncRows() {
      if (!home.stamp()) return;
      for (const q of open().read().items) await rowOf(q);
    },

    /** Voids the questions of a lease this home no longer holds. */
    async sweep() {
      const stamp = home.stamp();
      if (stamp) await voidStale(stamp);
    },

    /** Every question, newest last: the Questions of the chat, for a client that opens it. */
    view() {
      return home.stamp() ? open().read().items.map(viewOf) : [];
    },
  };

  /** One pending question, asked as a model would. */
  const seed = async () => {
    await api.ask({ chatId: 'momo-seed', title: 'Which calendar should I use?', body: 'You have two.', options: ['Work', 'Home'] });
  };
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const disarm = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  home.use('questions', {
    seed,
    // a question of a lease this home no longer holds is void as soon as it looks, not only when somebody asks or answers: after a move the new home must not show answerable stale ones
    start: () => {
      disarm();
      void api.sweep().catch((error) => report(`MoMo's questions could not be looked at: ${error.message}`));
      timer = setInterval(
        () => void api.sweep().catch((error) => report(`MoMo's questions could not be looked at: ${error.message}`)),
        SWEEP_MS,
      );
      timer.unref?.();
    },
    pause: disarm,
    wipe: () => {
      disarm();
      store = null;
    },
  });
  home.provide('questions', api);
};
