// MoMo's chats on this Host (M1 H2a, designs/momo-m1-home): which chats are MoMo's (three marks, any one is enough: the form of the id the Host makes for them, the `momo` meta of the chat's own record, and a sealed registry beside the journal; only this module writes them, so none can be set or cleared over the wire, and the registry being lost never loses the other two), making the main chat in a workspace the Host pins, the rules every chat request of a MoMo chat passes, and the refusal to start one on a harness that cannot run isolated.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';
import { Answered } from './chatVeil.mjs';
import { isOwner } from './momoOwner.mjs';
import { parseKind } from '../../shared/harnessKind.mjs';
import { TURN_ID } from '../../shared/host/methods/momo.mjs';
import { SchemaError } from '../../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');
const { isolates: quirksIsolate, momoBlocked } = require('../../electron/harness/quirks/index.cjs');
const { isMomoMeta, isMomoDataMeta, MOMO_META_KEY } = require('../../shared/momoChat.mjs');

/** What a granted client may still not do to a MoMo chat: its settings, its agent and its place are MoMo's own. */
const FIXED = new Set([
  'chat.start',
  'chat.permit',
  'chat.switch',
  'chat.login',
  'chat.prepareContinue',
  'chat.commitContinue',
  'chat.release',
  'chat.remove',
]);
/**
 * The mark on the ids of MoMo's chats: a uuid of version 8 (RFC 9562's "custom" version) whose last group starts with `c0de`. Every
 * generator this product uses makes versions 4 or 7 (`crypto.randomUUID` in the app, the Host and the phone: 4; Swift's `UUID()`: 4;
 * Claude Code's own session ids: 4; Codex's thread ids: 7), so none of them can make one, and the Host refuses a client's id of this
 * form for any chat it does not know (`forged`): only `host.momoChat` makes them. No build has ever shipped another form, so there
 * is nothing to migrate.
 */
export const MOMO_FORM = /[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-c0de[0-9a-f]{8}$/i;
/** How soon a registry that could not be read is read again: at most once a second, so a Host whose key is lost does not decrypt on every message. */
const RETRY_MS = 1000;
/** @param {string} uuid */
const momoUuid = (uuid) =>
  uuid.replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)[0-9a-f]([0-9a-f]{3}-[89ab][0-9a-f]{3}-)[0-9a-f]{4}/i, (_m, head, mid) => `${head}8${mid}c0de`);

/** @param {any} v */
const registryShape = (v) => ({
  chats: v?.chats && typeof v.chats === 'object' && !Array.isArray(v.chats) ? v.chats : {},
});

/**
 * @param {object} o
 * @param {Pick<ReturnType<typeof import('./momoHome.mjs').createMomoHome>, 'granted' | 'hostOnlyStorage' | 'stamp' | 'stores' | 'voided' | 'watch' | 'turnEnded' | 'service'> & { gate?: { taintFor?: (chatId: string) => { tainted: () => boolean, toolResult: (source: 'outside') => Promise<void>, reset: () => Promise<void> } } | null }} o.home
 * @param {{ chats: { records: Map<string, any>, patchMeta: (id: string, patch: object) => unknown }, isolated: (family: string) => boolean, host?: { cancel?: (chatId: string) => Promise<unknown> } }} o.sessions
 * @param {{ current: (chatId: string) => number }} o.epochs
 * @param {Record<string, string | undefined>} [o.env] the environment an ACP agent's isolation is checked against
 * @param {() => number} [o.now]
 * @param {() => string} [o.newId]
 * @param {(message: string) => void} [o.report]
 * @param {(agent: string) => boolean} [o.isolates] whether an agent can be kept apart from the coding side (its quirks say so, by default). Only code can give another (a test entry's own quirks table, handed to the serve entry): nothing reads it from the environment or a file, so a shipped Host always uses its quirks (tests/hostTestBrain.invariant.test.ts)
 */
export function createMomoChats({
  home,
  sessions,
  epochs,
  env = {},
  now = Date.now,
  newId = () => crypto.randomUUID(),
  report = () => undefined,
  isolates = quirksIsolate,
}) {
  const file = path.join(home.hostOnlyStorage.dir, 'chats.json');
  const registry = new SealedJson({ file, safeStorage: home.hostOnlyStorage.safeStorage, shape: registryShape, now });
  const workspace = path.join(home.hostOnlyStorage.dir, 'workspace');
  /** The chats the registry names, once it has read: never kept from a read that failed. @type {Set<string> | null} */
  let known = null;
  /** The registry's file was damaged and set aside: its chats are not known, and no new file may stand in for it. */
  let damaged = false;
  /** When a read last failed. */
  let failedAt = -Infinity;
  /** The chats the registry names, or null while it cannot be read (the other marks still tell MoMo's chats). */
  const names = () => {
    if (damaged || now() - failedAt < RETRY_MS) return null;
    if (known) return known;
    // nothing is on the disk for a Host with no MoMo chat; this module is the only writer, so start() keeps the set
    if (!fs.existsSync(file)) return (known = new Set());
    try {
      const chats = Object.keys(registry.read().chats);
      if (registry.setAside) throw new Error('its file was damaged and set aside');
      return (known = new Set(chats));
    } catch (error) {
      damaged = !!registry.setAside;
      failedAt = now();
      report(`MoMo's chat registry could not be read: ${/** @type {Error} */ (error).message}`);
      return null;
    }
  };
  /** Whether this Host has ever had a MoMo chat: its workspace is made before the chat is tagged and is never taken away, so no loss of the registry or the records can make this say no. Asked at most once a second until it says yes. */
  let ever = false;
  let askedAt = -Infinity;
  const hasChats = () => {
    if (ever || now() - askedAt < RETRY_MS) return ever;
    askedAt = now();
    return (ever = fs.existsSync(workspace));
  };
  /** Chats the veil made for callers that may not see MoMo's: none is MoMo's (they are not isolated) but none is shown to anyone but the connection that asked. @type {Set<string>} */
  const decoys = new Set();
  /** An id of MoMo's form that no MoMo chat of this Host has: a client made it, and only this Host does. @param {string} chatId */
  const forged = (chatId) => MOMO_FORM.test(chatId) && !names()?.has(chatId) && !isMomoMeta(sessions.chats.records.get(chatId)?.meta);
  /** A chat is MoMo's when its id has the form, its own record is tagged or the registry names it: any one keeps it apart. @param {string} chatId */
  const isMomoChat = (chatId) => MOMO_FORM.test(chatId) || isMomoMeta(sessions.chats.records.get(chatId)?.meta) || !!names()?.has(chatId);

  /** What no connection but the asker's is told of. @param {string} chatId */
  const isHidden = (chatId) => decoys.has(chatId) || isMomoChat(chatId);

  /**
   * The agent a harness names (null for Claude Code), or a refusal when MoMo cannot run on it here: never on Codex yet, never on an
   * agent that cannot be kept apart, never before this machine keeps MoMo's chats apart.
   * @param {string} harness
   */
  const canRun = (harness) => {
    const kind = parseKind(harness);
    if (!kind) throw new HostRefusal('momo_brain_unavailable', 'That is not an agent MoMo can use.');
    const agent = kind.basic;
    /** What a screen shows for an agent MoMo cannot use here: the cause, and the one tap that fixes it. */
    const cannot = (/** @type {string} */ why) =>
      new HostRefusal('momo_brain_unavailable', why, { agent: harness, fix: 'use_another_agent', fixLabel: 'Use another agent' });
    if (agent && !isolates(agent)) throw cannot("That agent can't be kept apart from the coding side, so it can't be MoMo's brain.");
    const blocked = agent && momoBlocked(agent, env);
    if (blocked) throw cannot(String(blocked));
    // every family is held to the same rule: its MoMo chats are kept apart from the coding side on this machine, or none starts
    if (!sessions.isolated(kind.family)) throw cannot("This machine isn't keeping this agent's MoMo chats apart yet, so none was started.");
    return { kind, agent };
  };

  /** The one record of which chats hold outside content is the gate's (./momoServices/gate.mjs): sealed with the data key, never evicting a chat. @param {string} chatId */
  const trackerOf = (chatId) => {
    const t = home.gate?.taintFor?.(chatId);
    if (!t) throw new Error(`MoMo's gate is not available on this machine, so nothing from outside was told to this chat.`);
    return t;
  };

  return {
    isMomoChat,
    /** Whether a turn of this chat carries MoMo's memory: MoMo's own chat, not a data chat (a brief, a reading turn) whose job is to read or write the memory itself. @param {string} chatId */
    carriesMemory: (chatId) => isMomoChat(chatId) && !isMomoDataMeta(sessions.chats.records.get(chatId)?.meta),
    /**
     * Whether this is MoMo's main chat by its own record's tag, where the owner's own words are (a background run's chat is another, and one that lost its tag is not). The runner passes it as the call's origin; whether outside content is in the chat is the gate's to say, and its answer for a write is a card, never a refusal made here.
     * @param {string} chatId
     */
    isMain: (chatId) => sessions.chats.records.get(chatId)?.meta?.[MOMO_META_KEY] === 'main',
    /**
     * Words from outside (a routine's result) are about to enter this chat's context: the gate's own tracker is told, on disk before the words are sent, so a restart cannot forget them. With no gate there is no tracker, so no result is told to the chat. Says whether the chat was already tainted, which `untaint` needs.
     * @param {string} chatId @returns {Promise<boolean>}
     */
    taint: async (chatId) => {
      const t = trackerOf(chatId);
      const already = t.tainted();
      await t.toolResult('outside');
      return already;
    },
    /** They never entered it (the message could not be sent): the context is as it was before this call, so a chat that already held earlier outside words stays tainted. @param {string} chatId @param {boolean} wasTainted what `taint` said */
    untaint: async (chatId, wasTainted) => {
      if (!wasTainted) await trackerOf(chatId).reset();
    },
    isHidden,
    workspace,
    /** What the chat veil (./chatVeil.mjs) asks: which chats are MoMo's, who may see them, and what a caller that may do to one. */
    rules: {
      /** A send the ledger accepted threw before the chat took it: its turn failed. @param {string} chatId */
      sendFailed: (chatId) => home.turnEnded(chatId, { error: true }),
      any: hasChats,
      state: (/** @type {string} */ chatId) => (isHidden(chatId) ? 'hidden' : 'open'),
      forged,
      isDecoy: (/** @type {string} */ chatId) => decoys.has(chatId),
      invalid: () => new SchemaError('That chat id cannot be used.'),
      /** A chat the veil made for a caller that may not see MoMo's, or let go of. @param {string} chatId @param {boolean} on */
      decoy: (chatId, on) => void (on ? decoys.add(chatId) : decoys.delete(chatId)),
      seen: (/** @type {unknown} */ principal) => isOwner(principal) && home.granted(),
      /** Tells a connection that this Host is, or is no longer, MoMo's running home (the veil sends it only to clients that may see MoMo). */
      watch: (/** @type {(e: { running: boolean, state: string }) => void} */ fn) => home.watch(fn),
      /**
       * What a caller that may see a MoMo chat may do to it: not change its settings, agent or place, and every message runs
       * in the workspace the Host pins, with the model and effort MoMo's own settings give it (a message's pick is dropped).
       * A message is accepted into the turn ledger first (design 1): by the id of its send key, so a resend is the same turn, and a
       * second one while the chat's turn is unsettled is `busy`. A home that is not running, or moving, takes none.
       * @param {string} method @param {any} params @param {{ fingerprint?: string } | null} [principal]
       */
      async guard(method, params, principal) {
        if (FIXED.has(method)) throw new HostRefusal('momo_chat_fixed', "MoMo's chat keeps its own settings, agent and place.");
        if (method !== 'chat.send') return params;
        const stamp = home.stamp();
        const turns = home.stores()?.turns;
        if (!stamp || !turns) throw new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
        // a message with no valid id is no turn the home could ever answer for: refused, never run without a record
        if (typeof params.key !== 'string' || !TURN_ID.test(params.key))
          throw new HostRefusal('turn_id_required', 'A message to MoMo needs its own id, so it can be asked about and never sent twice.');
        // an id of a turn a Reset deleted is settled: never run again
        if (home.voided(params.key)) return new Answered({ duplicate: true, turnId: params.key, state: 'cancelled', void: true });
        const { duplicate, turn } = await turns.accept({
          turnId: params.key,
          chatId: params.chatId,
          deviceId: principal?.fingerprint ?? null,
          leaseEpoch: stamp.leaseEpoch,
        });
        // a move's `begin` may have landed while the turn was being written: the home is no longer this machine's to act in, so the turn
        // never runs (it ends as cancelled, so no resend under its id is silently dropped and the chat is not left busy)
        if (!duplicate && !home.stamp()) {
          await turns
            .settle(params.chatId, 'cancelled')
            .catch((error) => report(`MoMo's turn ledger could not end a turn: ${error.message}`));
          throw new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
        }
        // the home already has this turn: the reply is what it kept, and it is not run again
        if (duplicate) return new Answered({ duplicate: true, turnId: turn.turnId, state: turn.state });
        // the owner's own words, as this Host received them, are what a note can cite (host/src/momoServices/ownerWords.mjs); a failure to keep them never stops the message
        await /** @type {any} */ (home.service('ownerWords'))
          ?.heard({ turnId: params.key, chatId: params.chatId, text: params.text, principal })
          .catch((/** @type {Error} */ error) => report(`MoMo could not keep what you said for its notes: ${error.message}`));
        return { ...params, cwd: workspace, pick: undefined };
      },
    },
    /** MoMo's main chat and its harness, or null when there is none (or the registry cannot be read). */
    main() {
      if (!names()) return null;
      const found = Object.entries(registry.read().chats).find(([, c]) => c.kind === 'main');
      return found ? { chatId: found[0], harness: /** @type {string} */ (found[1].harness) } : null;
    },
    /**
     * A fresh chat for a background run (a routine's), on `harness` where MoMo can run, tagged `tag` on its own record: its id has MoMo's form, so it is kept apart
     * and isolated like the main chat whatever happens to the registry, which it is not written to (one entry per run would never end). It is not the main chat.
     * @param {string} harness @param {string} tag what the run is (`routine`)
     */
    startBackground(harness, tag) {
      const { kind, agent } = canRun(harness);
      const chatId = `${agent ? `acp:${agent}` : kind.family}:${momoUuid(newId())}`;
      // the tag is the record's own and is written before anything else names the chat
      sessions.chats.patchMeta(chatId, { [MOMO_META_KEY]: tag });
      if (!isMomoMeta(sessions.chats.records.get(chatId)?.meta))
        throw new HostRefusal('momo_chat_not_started', "A MoMo run's chat could not be set up here.");
      return chatId;
    },
    /** Stops every MoMo chat's running turn, so none goes on acting while the home moves. A chat that cannot be stopped is reported and the move goes on to wait for its end by the ledger. */
    async stopTurns() {
      for (const id of names() ?? []) {
        try {
          await sessions.host?.cancel?.(id);
        } catch (error) {
          report(`A MoMo turn could not be stopped for a move: ${/** @type {Error} */ (error).message}`);
        }
      }
    },
    /** What the registry says, for a granted client's status. */
    state: () => ({ registry: names() ? 'ok' : 'unreadable' }),
    /**
     * MoMo's main chat on `harness`: the one already there, else a new one (the earlier main chat becomes a previous one). It
     * starts only where it can run isolated, never on another agent in its place.
     * @param {{ harness: string }} p
     */
    async start({ harness }) {
      const { kind, agent } = canRun(harness);
      if (!names()) throw new HostRefusal('momo_registry_unreadable', "MoMo's chats can't be read on this machine, so none was started.");
      // the workspace is the Host's mark that MoMo has chats: made before any chat is named, so nothing lost afterwards unmakes it
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      ever = true;
      /** The chat's id and whether it is a new one. */
      let chatId = '';
      let fresh = false;
      await registry
        .change((r) => {
          const current = Object.entries(r.chats).find(([, c]) => c.kind === 'main' && c.harness === harness);
          if (current) {
            chatId = current[0];
            return;
          }
          fresh = true;
          chatId = `${agent ? `acp:${agent}` : kind.family}:${momoUuid(newId())}`;
          // the tag is the record's own and is written before anything names the chat: losing the registry never loses it
          sessions.chats.patchMeta(chatId, { [MOMO_META_KEY]: 'main' });
          if (!isMomoMeta(sessions.chats.records.get(chatId)?.meta)) throw new Error('the chat could not be tagged');
          for (const c of Object.values(r.chats)) if (c.kind === 'main') c.kind = 'previous';
          r.chats[chatId] = { kind: 'main', harness, at: now() };
        })
        .catch((error) => {
          report(`MoMo's chat could not be made: ${error.message}`);
          throw new HostRefusal('momo_chat_not_started', "MoMo's chat could not be set up on this machine, so none was started.");
        });
      const id = chatId;
      if (fresh) /** @type {Set<string>} */ (names()).add(id);
      // an existing chat keeps the tag it has; one that lost it has it again
      sessions.chats.patchMeta(id, { [MOMO_META_KEY]: 'main' });
      return { chatId: id, epoch: epochs.current(id) };
    },
  };
}
