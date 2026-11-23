// Preparatory, unwired sandbox VM effects for G8: this chat-hash registry is not durable provenance and must never directly back production lifecycle, routing or a picker.
// Production acquire/release/destroy requires operation/principal/identity journal composition, actual-effect CAS, capacity locking and recovery/export authorization. Existing names in cached JSON do not establish authenticated guest ownership. See designs/g8-sandbox/bootstrap.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Guests that may run at the same time on one Mac. */
export const MAX_RUNNING = 2;
/** Guests that may exist at all (running or suspended): each takes disk. */
export const MAX_EXISTING = 4;

export class SandboxError extends Error {
  /** @param {'capacity' | 'no_image' | 'start_failed' | 'state_invalid'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** The guest's name for a chat: stable, and of no chat's words. @param {string} chatId */
export const guestName = (chatId) => `mopilot-sbx-${crypto.createHash('sha256').update(chatId).digest('hex').slice(0, 12)}`;

/**
 * @typedef {{ name: string, chatId: string, state: 'running' | 'suspended', usedAt: number }} Guest
 * @typedef {{
 *   exists: (name: string) => Promise<boolean>,
 *   clone: (from: string, name: string) => Promise<void>,
 *   run: (name: string) => Promise<void>,
 *   suspend: (name: string) => Promise<void>,
 *   remove: (name: string) => Promise<void>,
 *   running: () => Promise<string[]>,
 * }} Tart the `tart` commands the manager uses (host/src/tartDriver.mjs runs the real ones)
 */

/**
 * Unwired test/preparation API. Do not compose into production without the operation/principal/journal/CAS/recovery controller.
 * @param {object} o
 * @param {Tart} o.tart
 * @param {string} o.golden the golden image's name
 * @param {string} o.file where the manager keeps which chat has which guest
 * @param {(chatId: string) => boolean} [o.busy] whether a chat is using its guest now (a lease is held): a busy guest is never suspended for another
 * @param {() => number} [o.now]
 */
export function createSandboxVms({ tart, golden, file, busy = () => false, now = Date.now }) {
  /** @type {Map<string, Guest>} */
  const guests = new Map();
  /** Capacity and registry writes belong to the host, so every chat shares one transaction queue. @type {Promise<unknown>} */
  let transaction = Promise.resolve();
  let loaded = false;

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...guests.values()]), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  /** The record from the last run, checked against what `tart` runs now: a guest that is gone is forgotten, one that runs is running. */
  async function load() {
    if (loaded) return;
    /** @type {Guest[]} */
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw new SandboxError(
          'state_invalid',
          'The sandbox ownership record could not be read. Repair it before starting or removing a sandbox.',
        );
    }
    if (!Array.isArray(saved)) throw new SandboxError('state_invalid', 'The sandbox ownership record is invalid.');
    const owners = new Set();
    for (const g of saved) {
      if (
        !g ||
        typeof g.chatId !== 'string' ||
        !g.chatId ||
        g.name !== guestName(g.chatId) ||
        owners.has(g.chatId) ||
        !['running', 'suspended'].includes(g.state)
      )
        throw new SandboxError('state_invalid', 'The sandbox ownership record is inconsistent. No virtual machine was changed.');
      owners.add(g.chatId);
    }
    const running = new Set(await tart.running());
    const restored = new Map();
    for (const g of saved) {
      if (!(await tart.exists(g.name))) continue;
      restored.set(g.chatId, {
        name: g.name,
        chatId: g.chatId,
        state: running.has(g.name) ? 'running' : 'suspended',
        usedAt: Number(g.usedAt) || 0,
      });
    }
    for (const [chatId, guest] of restored) guests.set(chatId, guest);
    loaded = true;
  }
  /** Runs `fn` after all prior host transactions. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function inTurn(fn) {
    const run = transaction.catch(() => undefined).then(fn);
    transaction = run;
    return run;
  }
  const runningGuests = () => [...guests.values()].filter((g) => g.state === 'running');
  /** Actual Tart inventory wins over persisted or cached state, including a boot whose IP lookup failed. */
  async function refresh() {
    const running = new Set(await tart.running());
    for (const guest of guests.values()) guest.state = running.has(guest.name) ? 'running' : 'suspended';
    return running;
  }

  /** Makes room for one more running guest, or says there is none. Guests this manager did not start count too: the Mac's limit is on every macOS guest that runs. @param {string} chatId */
  async function makeRoom(chatId) {
    for (;;) {
      const actual = await refresh();
      const own = new Set([...guests.values()].map((g) => g.name));
      const foreign = [...actual].filter((name) => !own.has(name)).length;
      if (runningGuests().filter((g) => g.chatId !== chatId).length + foreign < MAX_RUNNING) return;
      const idle = runningGuests()
        .filter((g) => g.chatId !== chatId && !busy(g.chatId))
        .sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!idle)
        throw new SandboxError(
          'capacity',
          foreign > 0
            ? `This Mac already runs ${MAX_RUNNING} virtual machines and none of them is a sandbox that can be paused. Stop one first.`
            : `This Mac already runs ${MAX_RUNNING} sandboxes and both are in use. Finish or stop one of those chats first.`,
        );
      await tart.suspend(idle.name);
      idle.state = 'suspended';
      save();
    }
  }

  return {
    /**
     * Preparatory effect only, not a production lifecycle entry point. The chat's guest, running: cloned from the golden image the first time, resumed when it was suspended. @param {string} chatId
     * @returns {Promise<{ name: string }>}
     */
    acquire: (chatId) =>
      inTurn(async () => {
        await load();
        await refresh();
        let guest = guests.get(chatId);
        if (!guest) {
          if (guests.size >= MAX_EXISTING)
            throw new SandboxError('capacity', `This Mac keeps ${MAX_EXISTING} sandboxes at most. End a chat that uses one first.`);
          if (!(await tart.exists(golden))) throw new SandboxError('no_image', 'This Mac has no sandbox image yet.');
        }
        if (guest?.state === 'running') {
          guest.usedAt = now();
          save();
          return { name: guest.name };
        }
        await makeRoom(chatId);
        const name = guest?.name ?? guestName(chatId);
        try {
          if (!guest) {
            await tart.clone(golden, name);
            guest = { name, chatId, state: 'suspended', usedAt: now() };
            guests.set(chatId, guest);
            save();
          }
          await tart.run(name);
        } catch (error) {
          // a clone that did not start is not kept: the next try makes another
          if (guests.get(chatId) === guest && !(await tart.exists(name).catch(() => false))) guests.delete(chatId);
          save();
          throw new SandboxError('start_failed', `The sandbox did not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        guest.state = 'running';
        guest.usedAt = now();
        save();
        return { name };
      }),
    /** The chat is idle: its guest is suspended and keeps its disk (nothing to do for a chat that has none). @param {string} chatId */
    release: (chatId) =>
      inTurn(async () => {
        await load();
        await refresh();
        const guest = guests.get(chatId);
        if (!guest || guest.state !== 'running') return false;
        await tart.suspend(guest.name);
        guest.state = 'suspended';
        save();
        return true;
      }),
    /** Destructive preparatory effect: not a chat-end hook. Production must authorize exact operation/identity and durable recovery first. @param {string} chatId */
    destroy: (chatId) =>
      inTurn(async () => {
        await load();
        const guest = guests.get(chatId);
        if (!guest) return false;
        await tart.remove(guest.name);
        guests.delete(chatId);
        save();
        return true;
      }),
    /** Preparatory registry inspection only; not authenticated inventory or picker data. @returns {Promise<{ name: string, chatId: string, state: string }[]>} */
    list: () =>
      inTurn(async () => {
        await load();
        await refresh();
        return [...guests.values()].map(({ name, chatId, state }) => ({ name, chatId, state }));
      }),
  };
}
