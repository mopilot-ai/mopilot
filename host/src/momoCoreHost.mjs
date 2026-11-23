// What MoMo's notes, gate and learning services keep on a Host (#5474, shared/momoCore): the card store over one sealed file with atomic transitions, the audit sink over MoMo's hash-chained log, the keyed hash that keeps arguments out of cards and audit lines, and the sealed stores of the notes and the learning state. Everything lives under the home's storage folder, so a move carries it and Reset deletes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** Settled cards are kept this long, so a repeat of a denied action is still recognised. */
export const KEEP_CARDS_MS = 7 * 86_400_000;
const TERMINAL = ['denied', 'expired', 'used'];

/**
 * One sealed file as a store. `shape` turns what was read into the store's value; reading a file that is not there is the empty value and makes nothing on disk.
 * @template T
 * @param {{ dir: string, name: string, safeStorage: any, shape: (v: any, now?: number) => T, now: () => number }} o
 */
export function sealedStore({ dir, name, safeStorage, shape, now }) {
  const file = new SealedJson({ file: path.join(dir, name), safeStorage, shape, now });
  return {
    /** @returns {T} */
    read: () => (fs.existsSync(path.join(dir, name)) ? file.read() : shape(null, now())),
    /** @template R @param {(value: T) => R | Promise<R>} fn @returns {Promise<R>} */
    change: (fn) => file.change(fn),
  };
}

/** @param {any} v @param {number} [at] @returns {{ cards: Record<string, import('../../shared/momoCore/approvalGate.ts').Card> }} */
const cardsShape = (v, at = Date.now()) => {
  /** @type {Record<string, any>} */
  const cards = {};
  for (const [id, c] of Object.entries(v?.cards ?? {})) {
    const card = /** @type {any} */ (c);
    if (typeof card?.id !== 'string' || typeof card.status !== 'string' || typeof card.fingerprint !== 'string') continue;
    const ended = card.usedAt ?? card.decidedAt ?? card.createdAt;
    if (TERMINAL.includes(card.status) && at - ended > KEEP_CARDS_MS) continue;
    cards[id] = card;
  }
  return { cards };
};

/**
 * The gate's card store (shared/momoCore/approvalGate.ts `CardStore`): one sealed file, every change taken under its lock, so a transition is compare-and-set across processes.
 * @param {{ dir: string, safeStorage: any, now: () => number }} o
 * @returns {import('../../shared/momoCore/approvalGate.ts').CardStore}
 */
export function createCardStore({ dir, safeStorage, now }) {
  const store = sealedStore({ dir, name: 'cards.json', safeStorage, shape: cardsShape, now });
  /** @param {any} patch */
  const clean = (patch) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return {
    get: async (id) => store.read().cards[id],
    put: async (card) => void (await store.change((all) => void (all.cards[card.id] = card))),
    list: async (statuses) => Object.values(store.read().cards).filter((c) => !statuses || statuses.includes(c.status)),
    byFingerprint: async (fingerprint) =>
      Object.values(store.read().cards)
        .filter((c) => c.fingerprint === fingerprint)
        .sort((a, b) => b.createdAt - a.createdAt),
    transition: (id, expected, patch) =>
      store.change((all) => {
        const card = all.cards[id];
        if (!card || card.status !== expected) return undefined;
        const next = { ...card, ...clean(patch) };
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (/** @type {any} */ (next)[k]);
        all.cards[id] = next;
        return next;
      }),
  };
}

const label = (/** @type {unknown} */ v, /** @type {string} */ fallback) => (typeof v === 'string' && v ? v.slice(0, 190) : fallback);

/**
 * The gate's audit sink over MoMo's hash-chained log: a refusal is a refusal entry, every other event an intent that is on the disk before this resolves and its outcome. Arguments never reach it, only the card's keyed digest.
 * @param {() => any} audit MoMo's audit log (`home.stores().audit`), or null when this Host is not the running home
 * @returns {import('../../shared/momoCore/approvalGate.ts').AuditSink}
 */
export function createAuditSink(audit) {
  return {
    async append(event) {
      const log = audit();
      if (!log) throw new Error('MoMo’s audit log is not available');
      const fields = {
        action: label(event.tool ? `${event.event} ${event.tool}` : event.event, 'gate'),
        chatId: label(event.chatId, 'none'),
        decision: label(event.verdict ?? event.reason, event.event),
        args: {
          fingerprint: event.fingerprint ?? null,
          cardId: event.cardId ?? null,
          reason: event.reason ?? null,
          ruleId: event.ruleId ?? null,
        },
        ...(event.by ? { device: label(event.by, 'device') } : {}),
      };
      if (event.event === 'action.refused') {
        await log.refusal(fields);
        return;
      }
      const { id } = await log.intent(fields);
      await log.outcome(id, { result: 'done' });
    },
  };
}

/**
 * The key that keys the gate's digests: random, made once, kept sealed beside the cards so a move carries it.
 * @param {{ dir: string, safeStorage: any, now: () => number }} o
 * @returns {Promise<import('../../shared/momoCore/approvalGate.ts').KeyedHash>}
 */
export async function createKeyedHash({ dir, safeStorage, now }) {
  const store = sealedStore({
    dir,
    name: 'gate-key.json',
    safeStorage,
    now,
    shape: (/** @type {any} */ v) => ({ key: typeof v?.key === 'string' && v.key.length >= 40 ? v.key : '' }),
  });
  let key = store.read().key;
  if (!key) {
    key = crypto.randomBytes(32).toString('base64');
    await store.change((s) => void (s.key = key));
  }
  const secret = Buffer.from(key, 'base64');
  return Object.assign((/** @type {string} */ text) => crypto.createHmac('sha256', secret).update(text).digest('hex'), {
    keyed: /** @type {const} */ (true),
  });
}

/**
 * Which chats the gate has seen outside content in, kept sealed under the home's storage with the home's data key (so a move carries it): it survives a restart, and a chat the Host knows nothing about is not clean. Its own file (`gate-taint.json`): the scheduler keeps a record of its own (`taint.json`) in another shape, and the two must not read each other's. No chat is ever forgotten while its session could be resumed: nothing here is evicted.
 * @param {{ dir: string, safeStorage: any, now: () => number }} o
 */
export function createTaintStore({ dir, safeStorage, now }) {
  const shape = (/** @type {any} */ v) => ({
    chats: /** @type {Record<string, number>} */ (
      Object.fromEntries(Object.entries(v?.chats ?? {}).filter(([, at]) => Number.isFinite(at)))
    ),
  });
  const store = sealedStore({ dir, name: 'gate-taint.json', safeStorage, shape, now });
  return {
    has: (/** @type {string} */ chatId) => chatId in store.read().chats,
    /** Marks the chat; true when it was already marked, so a caller that undoes its own mark later knows not to undo an earlier one. @param {string} chatId */
    mark: async (chatId) => {
      let was = false;
      await store.change((all) => {
        was = chatId in all.chats;
        all.chats[chatId] = now();
      });
      return was;
    },
    /** Clears the chat's mark, unless the caller says it was marked before the caller's own mark (`wasTainted`): then nothing is cleared. @param {string} chatId @param {boolean} [wasTainted] */
    clear: async (chatId, wasTainted = false) => {
      if (wasTainted) return false;
      await store.change((all) => void delete all.chats[chatId]);
      return true;
    },
  };
}
