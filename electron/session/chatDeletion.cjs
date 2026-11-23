// Main-owned whole-chat native deletion receipts and monotonic, process-local metadata admission.
const { parseKey } = require('../harness/acp.cjs');
const { toRendererSegment } = require('../platform/chats.cjs');
const { familyOf } = require('./contract/route.cjs');
const { segmentAliases } = require('../../shared/segmentAlias.mjs');
const { noteIgnored } = require('../ignored.cjs');

const storedKey = (s) => toRendererSegment(s).nativeId;

/**
 * What each harness answers a delete of a native chat it doesn't have (#2291): Codex for a thread that never got a
 * rollout (one with no turn), the Claude Agent SDK for a session with no transcript. Such a chat is deleted already.
 * An ACP chat's delete is local and never says so.
 */
const GONE = {
  codex: /\bno rollout found for thread id\b/i,
  claude: /^Session\b.*\bnot found\b/i,
};
/** Whether `error` is the harness saying it has no such native chat. */
const nativeGone = (/** @type {string} */ family, /** @type {unknown} */ error) =>
  GONE[/** @type {keyof typeof GONE} */ (family)]?.test(String(/** @type {any} */ (error)?.message ?? error)) === true;

function nativeKey(segment) {
  const family = familyOf(segment.kind);
  if (typeof segment.nativeId !== 'string' || !segment.nativeId.trim() || segment.nativeId.includes('\0'))
    throw new Error('Invalid native chat identity');
  const key = storedKey(segment);
  const accepts = { codex: () => true, claude: () => true, acp: () => parseKey(key) !== null };
  if (!accepts[family]()) throw new Error('Native chat identity is not supported by its delete adapter');
  return key;
}

/** Capture every target before the first destructive call; later-segment ownership beats stray records. */
function deletionTargets(store, id) {
  if (typeof id !== 'string' || !id) throw new Error('Invalid chat identity');
  if (store.newer.has(id) || store.unreadable.has(id)) throw new Error('Chat metadata is read-only');
  const record = store.record(id);
  if (!record.segments.length || nativeKey(record.segments[0]) !== id) throw new Error('Invalid canonical chat identity');
  const identities = new Map();
  const entries = [...store.records];
  if (!store.records.has(id)) entries.push([id, record]);
  const aliases = segmentAliases(entries.map(([owner, r]) => [owner, r.segments.map(storedKey)]));
  const targetKeys = new Set(record.segments.map(nativeKey));
  for (const [, r] of entries)
    for (const s of r.segments) {
      const key = storedKey(s);
      if (!targetKeys.has(key)) continue;
      const identity = JSON.stringify([s.kind, s.nativeId]);
      const previous = identities.get(key);
      if (previous !== undefined && previous !== identity) throw new Error('Ambiguous native chat identity');
      identities.set(key, identity);
    }
  if (aliases.get(id) !== id) throw new Error('Native session belongs to another chat');
  const unique = new Map();
  for (const s of record.segments) {
    const key = nativeKey(s);
    if (aliases.get(key) !== id) throw new Error('Native session belongs to another chat');
    unique.set(JSON.stringify([s.kind, s.nativeId]), { kind: s.kind, nativeId: s.nativeId, key });
  }
  return [...unique.values()];
}

function aliasIndex(records) {
  const entries = [...records];
  const aliases = segmentAliases(entries.map(([owner, r]) => [owner, r.segments.map(storedKey)]));
  const identities = new Map();
  const owners = new Map();
  for (const [owner, record] of entries)
    for (const [index, segment] of record.segments.entries()) {
      const key = storedKey(segment);
      if (!identities.has(key)) identities.set(key, new Set());
      identities.get(key).add(JSON.stringify([segment.kind, segment.nativeId]));
      if (!owners.has(key)) owners.set(key, [new Set(), new Set()]);
      owners.get(key)[index > 0 ? 1 : 0].add(owner);
    }
  return { aliases, identities, owners };
}

/** No restart durability or ordering of other native operations is implied by this authority. */
class ChatDeletion {
  constructor({ store, remove, broadcast }) {
    this.store = store;
    this.remove = remove;
    this.broadcast = broadcast;
    this.receipts = new Map();
    this.deletedKeys = new Set();
    this.certifiedIdentities = new Map();
    this.pending = new Map();
    this.protected = new Map();
    /** main's services that forget a deleted chat (the orchestration journal), added with hookChain's addHook */
    this.onDeleted = (_receipt) => {
      /* no service to tell yet */
    };
    store.isDeleted = (id) => this.isDeleted(id);
    store.admitCommit = (record) => this.admitCommit(record);
  }
  isDeleted(id) {
    return this.deletedKeys.has(id);
  }
  /** A completed migration reload is the only post-deletion alias authority; renderer snapshots are not. */
  refreshAliases() {
    const { aliases, identities, owners } = aliasIndex(this.store.records);
    for (const [owner, receipt] of this.receipts) {
      const record = this.store.records.get(owner);
      if (!record?.segments.length || storedKey(record.segments[0]) !== owner) continue;
      const added = [...aliases]
        .filter(([key, id]) => {
          const [, later] = owners.get(key);
          return (
            id === owner &&
            typeof key === 'string' &&
            !!key &&
            !this.deletedKeys.has(key) &&
            identities.get(key).size === 1 &&
            later.size === 1
          );
        })
        .map(([key]) => key);
      if (!added.length) continue;
      const expanded = { ...receipt, retainedAliasKeys: [...(receipt.retainedAliasKeys ?? []), ...added] };
      for (const key of added) {
        this.deletedKeys.add(key);
        this.certifiedIdentities.set(key, [...identities.get(key)][0]);
      }
      this.receipts.set(owner, expanded);
      this.publish(expanded);
    }
  }
  /** A reload may omit retired sessions, but cannot transfer their certified identities to another owner. */
  admitReload(records) {
    const { aliases, identities, owners } = aliasIndex(records);
    for (const [owner, receipt] of this.receipts)
      for (const key of [...receipt.nativeKeys, ...(receipt.retainedAliasKeys ?? [])]) {
        if (!aliases.has(key)) continue;
        const [first, later] = owners.get(key);
        if (
          aliases.get(key) !== owner ||
          identities.get(key).size !== 1 ||
          !identities.get(key).has(this.certifiedIdentities.get(key)) ||
          (later.size ? later : first).size !== 1
        )
          return false;
      }
    return true;
  }
  admitCommit(record) {
    const keys = record.segments.map(storedKey);
    if (this.isDeleted(record.id) || keys.some((key) => this.isDeleted(key))) return false;
    const before = this.store.records.get(record.id);
    if (before && JSON.stringify(before.segments) === JSON.stringify(record.segments)) return true;
    for (const [id, targets] of this.protected) if (id === record.id || targets.some((target) => keys.includes(target.key))) return false;
    return true;
  }
  snapshot() {
    return [...this.receipts.values()];
  }
  publish(receipt) {
    try {
      this.broadcast(receipt);
    } catch (error) {
      noteIgnored('broadcast a completed chat deletion', error);
    }
    return receipt;
  }
  delete(id) {
    // Alias retries return the original canonical owner's certificate, never a new destructive operation.
    const completed =
      this.receipts.get(id) ?? [...this.receipts.values()].find((r) => r.nativeKeys.includes(id) || r.retainedAliasKeys?.includes(id));
    if (completed) return Promise.resolve(this.publish(completed));
    const pending = this.pending.get(id);
    if (pending) return pending;
    const operation = this.run(id);
    this.pending.set(id, operation);
    const forget = () => {
      if (this.pending.get(id) === operation) this.pending.delete(id), this.protected.delete(id);
    };
    operation.then(forget, forget);
    return operation;
  }
  /** Deletes one native chat; one its harness no longer has counts as deleted. */
  async removeNative(target) {
    const family = familyOf(target.kind);
    try {
      return await this.remove[family](target);
    } catch (error) {
      if (!nativeGone(family, error)) throw error;
    }
  }
  async run(id) {
    const targets = deletionTargets(this.store, id);
    this.protected.set(id, targets);
    let remoteDeletionPending = false;
    let remoteDeletionOutdated = false;
    for (const target of targets.slice(1)) {
      try {
        const result = await this.removeNative(target);
        remoteDeletionPending ||= result?.pending === true;
        remoteDeletionOutdated ||= result?.outdated === true;
      } catch (error) {
        noteIgnored("delete an earlier segment's native chat", error);
      }
    }
    const remote = await this.removeNative(targets[0]);
    remoteDeletionPending ||= remote?.pending === true;
    remoteDeletionOutdated ||= remote?.outdated === true;
    // Metadata and aliases remain intact. The terminal admission fence is memory-only and cannot fail a disk write.
    const receipt = {
      chatId: id,
      nativeKeys: targets.map((t) => t.key),
      nativeDeleted: true,
      metadata: 'retained',
      ...(remoteDeletionPending ? { remoteDeletionPending: true } : {}),
      ...(remoteDeletionOutdated ? { remoteDeletionOutdated: true } : {}),
    };
    this.receipts.set(id, receipt);
    for (const target of targets) {
      this.deletedKeys.add(target.key);
      this.certifiedIdentities.set(target.key, JSON.stringify([target.kind, target.nativeId]));
    }
    try {
      this.onDeleted(receipt);
    } catch (error) {
      // the chat is deleted either way: a service that can't forget it now does not fail the deletion
      noteIgnored('tell main a chat was deleted', error);
    }
    return this.publish(receipt);
  }
}
module.exports = { ChatDeletion, deletionTargets, nativeKey, nativeGone };
