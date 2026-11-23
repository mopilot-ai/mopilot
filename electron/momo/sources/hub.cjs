// MoMo's local sources (#2139 P2): which sources are connected, since when, at what access level and (Files) which folders, kept in <momo dir>/sources/state.json, encrypted with Electron safeStorage and owner-only (folder 0700, file 0600); without encryption nothing is connected or read. The connect date is each source's backfill floor; disconnecting forgets the source and deletes MoMo's copies of it (<momo dir>/sources/<id>/). Every read goes through read(): within the chat's scope (a routine's run reads only the sources the routine names, setScope), connected, not Blocked, then the injected decide(call) (access level, approvals, the egress taint: every read is private) and the injected audit, failing closed without either.
const { EventEmitter } = require('node:events');
const { fs: nodeFs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { encryptForStore, canEncrypt } = require('../../platform/encryptedStore.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** The sources this PR reads, in the order Settings shows them. */
const SOURCE_IDS = Object.freeze(['calendar', 'reminders', 'files']);
/** Access levels, as Settings names them: Blocked, Read only, Read & ask to change (writes come later; it reads like Read only). */
const LEVELS = Object.freeze(['blocked', 'read', 'ask']);
const LABELS = Object.freeze({ calendar: 'Calendar', reminders: 'Reminders', files: 'Files' });
/** Sources by name, as the user reads them ("Calendar, Files"); empty for none; an id that isn't a source as it is. */
const sourcesText = (/** @type {string[] | undefined} */ ids) =>
  (ids ?? []).map((id) => /** @type {Record<string, string>} */ (LABELS)[id] ?? id).join(', ');
const STATE_FILE = 'state.json';

/** A refusal or failure of a source call; `code` says which (the tools and Settings tell them apart). */
class SourceError extends Error {
  /** @param {string} message @param {'not_allowed'|'unavailable'|'unknown'|'not_connected'|'blocked'|'refused'|'not_granted'|'bad_args'|'outside'|'failed'|'busy'|'changed'|'read_only'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage
 * @typedef {{ connectedAt: number, level: 'blocked'|'read'|'ask', folders?: string[] }} SourceState
 * @typedef {{ kind: 'source.read', source: string, action: string, chatId: string, level: string, private: true, summary: string, args?: unknown }} DecideCall
 * @typedef {(call: DecideCall) => { allow: boolean, reason?: string } | Promise<{ allow: boolean, reason?: string }>} Decide
 * @typedef {{ append(entry: object): unknown }} Audit
 * @typedef {{ sources: string[], name: string | null } | null} Scope the sources a chat may read and its routine's name
 *   (null: the routine was removed); null: any
 */

/** The start of the local day `ms` falls on: a connect date floors history at that day's midnight. */
const dayStart = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The refusal for a source that isn't connected, with where the user connects it. */
const notConnected = (/** @type {string} */ id) =>
  new SourceError(
    `${LABELS[/** @type {keyof typeof LABELS} */ (id)] ?? id} isn't connected; the user connects it in Settings › MoMo › Sources`,
    'not_connected',
  );

/** Emits 'changed' after every change of the stored state (Settings reads it again). */
class SourcesHub extends EventEmitter {
  /**
   * @param {{ dir: string, safeStorage: SafeStorage | null, allowed?: () => boolean, decide?: Decide | null, audit?: Audit | null,
   *           now?: () => number, fs?: typeof nodeFs }} o dir: the MoMo root (<userData>/momo); the hub keeps to its sources/
   *   folder. allowed: whether MoMo is allowed now (the invite gate); without it nothing connects or reads.
   */
  constructor({ dir, safeStorage, allowed = () => false, decide = null, audit = null, now = Date.now, fs = nodeFs }) {
    super();
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error("MoMo's sources need an absolute folder");
    this.dir = path.join(dir, 'sources');
    this.safe = safeStorage ?? null;
    this.allowed = allowed;
    this.decide = decide;
    this.audit = audit;
    this.now = now;
    this.fs = fs;
    /** @type {Record<string, SourceState> | null} the state as last read or written */
    this.cache = null;
    /** @type {Set<string>} connected sources macOS says MoMo may not read (Calendar or Reminders: the grant was reset, or another build asked), not stored: a read or Settings finds it again */
    this.ungranted = new Set();
    /** @type {Map<string, number>} each source's generation: a connect or disconnect bumps it, so work begun before it is void */
    this.epochs = new Map();
    /** @type {(chatId: string) => Scope | Promise<Scope>} the sources a chat may read, read at each check */
    this.scope = () => null;
  }

  /**
   * Who limits a chat's reads (main sets it once the routines exist): a routine's run reads only its routine's sources.
   * @param {(chatId: string) => Scope | Promise<Scope>} scope
   */
  setScope(scope) {
    this.scope = scope;
  }

  /** Whether this Mac can encrypt the state now; without it nothing is connected or read. */
  available() {
    return canEncrypt(this.safe);
  }

  #requireAvailable() {
    if (!this.available()) throw new SourceError("MoMo's sources need encryption, which isn't available on this Mac", 'unavailable');
  }

  #requireAllowed() {
    if (this.allowed() !== true) throw new SourceError('MoMo is not available', 'not_allowed');
  }

  /** Throws unless a source may be connected now (MoMo allowed, encryption on): checked before macOS is asked. */
  assertCanConnect() {
    this.#requireAllowed();
    this.#requireAvailable();
  }

  /** The stored state; a missing or undecryptable file reads as nothing connected (fail closed). */
  #load() {
    if (this.cache) return this.cache;
    let text = '';
    try {
      text = this.fs.readFileSync(path.join(this.dir, STATE_FILE), 'utf8');
    } catch (error) {
      // missing (never connected) is expected; anything else is recorded, and nothing is connected
      noteIgnored("read MoMo's sources state", error, ['ENOENT']);
    }
    /** @type {Record<string, SourceState>} */
    let state = {};
    if (text) {
      try {
        const parsed = JSON.parse(/** @type {SafeStorage} */ (this.safe).decryptString(Buffer.from(text, 'base64')));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
      } catch (error) {
        // another key or a changed byte: nothing is connected until the user connects again, which writes it anew
        noteIgnored("decrypt MoMo's sources state", error);
      }
    }
    this.cache = Object.fromEntries(Object.entries(state).filter(([id, s]) => SOURCE_IDS.includes(id) && isSourceState(s)));
    return this.cache;
  }

  #save(/** @type {Record<string, SourceState>} */ state) {
    const sealed = encryptForStore(this.safe, JSON.stringify(state));
    if (!sealed.ok) throw new SourceError("MoMo's sources need encryption, which isn't available on this Mac", 'unavailable');
    this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivate(path.join(this.dir, STATE_FILE), sealed.value);
    this.cache = state;
    this.emit('changed');
  }

  #known(/** @type {string} */ id) {
    if (!SOURCE_IDS.includes(id)) throw new SourceError(`No source named ${id}`, 'unknown');
  }

  /** The source's state, or null when it isn't connected (or encryption is off). */
  get(/** @type {string} */ id) {
    if (!this.available()) return null;
    return this.#load()[id] ?? null;
  }

  /** Every source as Settings shows it. */
  list() {
    const on = this.available();
    return SOURCE_IDS.map((id) => {
      const s = on ? this.#load()[id] : undefined;
      return {
        id,
        label: LABELS[/** @type {keyof typeof LABELS} */ (id)],
        connected: !!s,
        ...(s && { connectedAt: s.connectedAt, level: s.level }),
        ...(s && this.ungranted.has(id) && { needsGrant: true }),
        ...(id === 'files' && { folders: s?.folders ?? [] }),
      };
    });
  }

  /**
   * `id` is connected but macOS refuses its reads (a read or Settings' names found `not_granted`): it still shows as connected,
   * and says it needs the grant again. The windows read the list again; telling again changes nothing.
   */
  markUngranted(/** @type {string} */ id) {
    if (this.ungranted.has(id) || !this.get(id)) return;
    this.ungranted.add(id);
    this.emit('changed');
  }

  /** macOS answers for `id` again (a read worked, or a grant was seen): the windows read the list again if it had been marked. */
  markGranted(/** @type {string} */ id) {
    if (this.ungranted.delete(id)) this.emit('changed');
  }

  /** Whether `id` can be read now: connected, and not known to be refused by macOS. */
  ready(/** @type {string} */ id) {
    return this.get(id) !== null && !this.ungranted.has(id);
  }

  /** The generation of `id`'s connection, for work that must not outlive a disconnect (see stillConnected). */
  epoch(/** @type {string} */ id) {
    return this.epochs.get(id) ?? 0;
  }

  #bump(/** @type {string} */ id) {
    this.epochs.set(id, this.epoch(id) + 1);
  }

  /**
   * Connects `id` from now on (Read only), its backfill floor the start of today. `epoch`: the generation the caller
   * saw before awaiting the macOS grant; a disconnect or another connect since then voids this one (returns false).
   */
  connect(/** @type {string} */ id, { epoch = this.epoch(id) } = {}) {
    this.#known(id);
    this.assertCanConnect();
    if (epoch !== this.epoch(id)) return false;
    const state = { ...this.#load() };
    if (state[id]) {
      // already connected: the grant a caller saw is what is new
      this.markGranted(id);
      return true;
    }
    state[id] = { connectedAt: this.now(), level: 'read', ...(id === 'files' && { folders: [] }) };
    this.#bump(id);
    this.#save(state);
    return true;
  }

  /**
   * Forgets `id` and deletes MoMo's copies of it; reads still running for it return nothing. It works while MoMo is not
   * allowed, so an account whose invite was revoked can still remove its data. Without encryption the copies still go,
   * but the stored state can't be changed, so it throws (the source would come back once it can be read).
   */
  disconnect(/** @type {string} */ id) {
    this.#known(id);
    this.#bump(id);
    // the copies go even when the state can't be written (no encryption): MoMo keeps nothing of a source the user let go
    this.fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    if (!this.available())
      throw new SourceError(
        `Couldn't record the disconnect without encryption on this Mac; MoMo's copies of ${LABELS[/** @type {keyof typeof LABELS} */ (id)]} were deleted`,
        'unavailable',
      );
    this.ungranted.delete(id);
    const state = { ...this.#load() };
    if (!state[id]) return;
    delete state[id];
    this.#save(state);
  }

  /**
   * Reset MoMo (#2291): every source is let go and its folder deleted; reads still running return nothing, and the next
   * connect starts the folder again, with nothing remembered from before.
   */
  reset() {
    for (const id of SOURCE_IDS) this.#bump(id);
    this.ungranted.clear();
    this.fs.rmSync(this.dir, { recursive: true, force: true });
    this.cache = null;
    this.emit('changed');
  }

  /** Changes a connected source's access level. */
  setLevel(/** @type {string} */ id, /** @type {string} */ level) {
    this.#known(id);
    if (!LEVELS.includes(level)) throw new SourceError(`Access level must be one of ${LEVELS.join(', ')}`, 'bad_args');
    this.#update(id, (s) => ({ ...s, level: /** @type {SourceState['level']} */ (level) }));
  }

  /** Replaces the Files source's folders (files.cjs checks each before it gets here); removing one voids running reads. */
  setFolders(/** @type {string[]} */ folders) {
    const next = [...new Set(folders)];
    const removed = (this.get('files')?.folders ?? []).some((f) => !next.includes(f));
    this.#update('files', (s) => ({ ...s, folders: next }));
    if (removed) this.#bump('files');
  }

  #update(/** @type {string} */ id, /** @type {(s: SourceState) => SourceState} */ fn) {
    this.#requireAvailable();
    const state = { ...this.#load() };
    if (!state[id]) throw notConnected(id);
    state[id] = fn(state[id]);
    this.#save(state);
  }

  /** The earliest time `id`'s history is read from: midnight of the day it was connected. */
  floor(/** @type {string} */ id) {
    const s = this.get(id);
    if (!s) throw notConnected(id);
    return dayStart(s.connectedAt);
  }

  /** Where MoMo keeps its copies of `id` (owner-only); disconnecting deletes it. */
  copyDir(/** @type {string} */ id) {
    this.#known(id);
    const dir = path.join(this.dir, id);
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Runs one read of a source for a chat: the source must be connected and not Blocked, then decide(call) must allow
   * it; the read's outcome is audited (counts and the summary only, never what was read). A source disconnected while
   * the read ran returns nothing. Every read is private data, for the egress rule.
   * @template T
   * @param {{ source: string, action: string, chatId: string, summary: string, args?: unknown }} call args: what the read names (a path, a range), for the audit log's digest
   * @param {() => Promise<{ count: number } & T>} read
   * @returns {Promise<{ count: number } & T>}
   */
  async read(call, read) {
    this.#known(call.source);
    const label = LABELS[/** @type {keyof typeof LABELS} */ (call.source)];
    if (this.allowed() !== true) {
      await this.#record(call, 'refused', 'refused', 'not_allowed');
      throw new SourceError('MoMo is not available', 'not_allowed');
    }
    await this.#inScope(call, 'refused');
    const s = this.get(call.source);
    if (!s) {
      await this.#record(call, 'refused', 'refused', 'not_connected');
      throw notConnected(call.source);
    }
    if (s.level === 'blocked') {
      await this.#record(call, 'refused', 'refused', 'blocked');
      throw new SourceError(`${label} is set to Blocked in Settings › MoMo › Sources`, 'blocked');
    }
    const epoch = this.epoch(call.source);
    /** @type {{ allow: boolean, reason?: string }} */
    let decision;
    try {
      if (!this.decide) throw new SourceError('no access decision is wired', 'refused');
      decision = await this.decide({ kind: 'source.read', ...call, level: s.level, private: true });
    } catch (error) {
      // the check's own failure is recorded, not shown: the agent and the audit are told only that it failed
      noteIgnored(`decide on a ${call.action} read`, error);
      decision = { allow: false, reason: 'the access check failed' };
    }
    if (decision?.allow !== true) {
      await this.#record(call, 'refused', 'refused', decision?.reason);
      throw new SourceError(`Reading ${label} was refused${decision?.reason ? `: ${decision.reason}` : ''}`, 'refused');
    }
    // the decision may have waited (an approval card): the source must still be connected, and not Blocked since
    const after = this.get(call.source);
    if (!after || this.epoch(call.source) !== epoch) {
      await this.#record(call, 'allowed', 'refused', 'disconnected');
      throw notConnected(call.source);
    }
    if (after.level === 'blocked') {
      await this.#record(call, 'allowed', 'refused', 'blocked');
      throw new SourceError(`${label} is set to Blocked in Settings › MoMo › Sources`, 'blocked');
    }
    // and its routine may still read it (an edit or a removal while the card waited)
    await this.#inScope(call, 'allowed');
    let result;
    try {
      result = await read();
    } catch (e) {
      await this.#record(call, 'allowed', 'failed', /** @type {any} */ (e)?.code);
      // macOS refused: connected, but not to be read until the user allows it again
      if (e instanceof SourceError && e.code === 'not_granted' && this.epoch(call.source) === epoch) this.markUngranted(call.source);
      throw e;
    }
    if (this.epoch(call.source) !== epoch) {
      await this.#record(call, 'allowed', 'refused', 'disconnected');
      throw new SourceError(`${label} was disconnected while it was read; nothing was kept`, 'not_connected');
    }
    // a read that worked: macOS answers for this source
    this.markGranted(call.source);
    // what was read goes back only while its routine may still read it
    await this.#inScope(call, 'allowed');
    await this.#record(call, 'allowed', 'done', undefined, result.count);
    return result;
  }

  /** One audit entry; a read whose audit can't be written does not go ahead or return (fail closed). */
  /**
   * Throws, audited as outside_routine, unless the chat's scope (read now) lets it read the call's source. `decision`:
   * what the audit records as decided so far.
   */
  async #inScope(/** @type {{ source: string, action: string, chatId: string, summary: string }} */ call, /** @type {string} */ decision) {
    const scope = await this.scope(call.chatId);
    if (!scope || scope.sources.includes(call.source)) return;
    await this.#record(call, decision, 'refused', 'outside_routine');
    const label = LABELS[/** @type {keyof typeof LABELS} */ (call.source)];
    const reads = sourcesText(scope.sources);
    throw new SourceError(
      scope.name === null
        ? 'This routine was removed, so it reads no sources.'
        : `The routine “${scope.name}” ${reads ? `reads only ${reads}` : 'reads no sources'}: ${label} isn't one of them. The user can add it by editing the routine in Settings › MoMo › Routines.`,
      'refused',
    );
  }

  async #record(
    /** @type {{ source: string, action: string, chatId: string, summary: string, args?: unknown }} */ call,
    /** @type {string} */ decision,
    /** @type {string} */ result,
    /** @type {string | undefined} */ reason = undefined,
    /** @type {number | undefined} */ count = undefined,
  ) {
    if (!this.audit) throw new SourceError('MoMo has no audit log wired, so nothing is read', 'refused');
    await this.audit.append({
      at: this.now(),
      action: call.action,
      source: call.source,
      chatId: call.chatId,
      summary: call.summary,
      ...(call.args !== undefined && { args: call.args }),
      decision,
      result,
      ...(reason !== undefined && { reason }),
      ...(count !== undefined && { count }),
      private: true,
    });
  }
}

/** A stored source as it must look; anything else is dropped on read. */
function isSourceState(/** @type {any} */ s) {
  return (
    !!s &&
    typeof s === 'object' &&
    Number.isFinite(s.connectedAt) &&
    LEVELS.includes(s.level) &&
    (s.folders === undefined || (Array.isArray(s.folders) && s.folders.every((f) => typeof f === 'string')))
  );
}

module.exports = { SourcesHub, SourceError, SOURCE_IDS, LEVELS, LABELS, sourcesText, dayStart };
