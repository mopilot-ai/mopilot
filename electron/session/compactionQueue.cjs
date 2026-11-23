// Main-owned compaction holds preserve editable input and release only the current segment's successful compaction once.
const { inputIsGuarded } = require('./contract/inputGuard.cjs');
const { ignoring } = require('../ignored.cjs');
const { guardSend } = require('./contract/inputGuard.cjs');
const { forgetMomoSent } = require('../momo/contract/context.cjs');
const { turnSource } = require('./controllerSwitch.cjs');

/**
 * @typedef {{ source: { kind: string, key: string }, runtime: any, token: any, attempt: any,
 * adapter: any, segments?: any, account?: string | null, id: string, turnId?: string,
 * phase: string, retry?: boolean, releasing?: boolean, again?: boolean, afterTurn?: boolean }} CompactionOwner
 */

const WAITING = 'Waiting for compaction to finish.';
const busy = (s) => s.turn === 'running' || s.turn === 'awaitingUser';

/** The current native owner, including a replacement using the same opaque native ID. */
function sameTurn(c, chatId, owner) {
  const r = c.rts.get(chatId);
  return (
    r === owner.runtime &&
    r.token === owner.token &&
    r.startAttempt === owner.attempt &&
    c.isCurrentSource(chatId, owner.source) &&
    c.adapterOf(chatId) === owner.adapter &&
    (!owner.segments || c.chats.records.get(chatId)?.segments === owner.segments) &&
    !c.state.get(chatId).pendingSwitch &&
    (owner.account === undefined || !owner.adapter.accountOf || owner.adapter.accountOf(chatId) === owner.account)
  );
}

function current(c, chatId, owner) {
  return c.rts.get(chatId)?.compaction === owner && owner.phase !== 'retired' && sameTurn(c, chatId, owner);
}

/** Clear automatic release, leaving held input available for explicit retry (or ordinary next-turn draining). */
function retireCompaction(c, chatId, retry = true, failed = false) {
  const r = c.rts.get(chatId);
  const owner = r?.compaction;
  if (!owner) return;
  owner.retry = retry;
  owner.phase = 'retired';
  r.compaction = null;
  const queue = c.state.get(chatId).queue.map((q) => {
    if (r.compactionInputs?.get(q.id) !== owner) return q;
    r.compactionInputs.delete(q.id);
    const { waitingFor: _waiting, ...item } = q;
    return retry ? { ...item, waitingFor: 'compactionRetry' } : item;
  });
  c.state.patch(chatId, { compaction: failed ? 'failed' : null, queue });
}

/**
 * Stale ownership cannot hold a new segment or release into it. A compaction whose release was refused still holds
 * new input until its turn ends, so nothing sent meanwhile runs ahead of what it holds.
 */
function activeCompaction(c, chatId) {
  const owner = c.rts.get(chatId)?.compaction;
  if (!owner) return null;
  if (!current(c, chatId, owner)) {
    retireCompaction(c, chatId);
    return null;
  }
  return owner.phase === 'active' || owner.afterTurn ? owner : null;
}

/** Add the full input once, or mark the existing row selected by Send now. */
function holdCompaction(c, chatId, item) {
  const owner = activeCompaction(c, chatId);
  if (!owner) return false;
  const r = c.rt(chatId);
  (r.compactionInputs ??= new Map()).set(item.id, owner);
  const queue = c.state.get(chatId).queue;
  const exists = queue.some((q) => q.id === item.id);
  c.state.patch(chatId, {
    queue: exists
      ? queue.map((q) => (q.id === item.id ? { ...q, waitingFor: 'compaction' } : q))
      : [...queue, { ...item, waitingFor: 'compaction' }],
  });
  return true;
}

/** A compaction observed after preflight owns an unsent input even if its completion already arrived. */
function restoreCompaction(c, chatId, item, owner) {
  const r = c.rt(chatId);
  const valid = current(c, chatId, owner);
  const waitingFor = valid ? 'compaction' : 'compactionRetry';
  if (valid) (r.compactionInputs ??= new Map()).set(item.id, owner);
  if (!c.state.get(chatId).queue.some((q) => q.id === item.id)) c.queueFirst(chatId, { ...item, waitingFor });
  if (valid && owner.phase === 'complete') releaseCompaction(c, chatId, owner).catch(ignoring('release input after compaction'));
  return waitingFor;
}

/** Reuse the final transport guard for starts and steers; a rejected preflight records its actual compaction owner. */
function guardCompaction(c, chatId, item) {
  /** @type {CompactionOwner | null} */
  let blocked = null;
  const release = guardSend(item, () => {
    const owner = activeCompaction(c, chatId);
    if (owner) {
      blocked = owner;
      throw new Error(WAITING);
    }
  });
  return {
    get owner() {
      return blocked;
    },
    release,
  };
}

/** An unsent local start may become an idle compaction hold without retiring that native operation or faking a crash. */
function suspendCompactionStart(c, chatId, item, owner, token, attempt) {
  const r = c.rts.get(chatId);
  if (r === owner.runtime && r.token === token && r.startAttempt === attempt && c.state.get(chatId).activeTurn?.id === token) {
    if (current(c, chatId, owner)) {
      // No native prompt was accepted. Keep native approvals and the compaction's queued inputs intact.
      Object.assign(r, { token: null, inputToken: null, outstanding: 0 });
      owner.token = null;
      c.state.patch(chatId, { turn: 'idle', activeTurn: null });
    } else c.end(chatId, { drain: false });
  }
  const retain = !inputIsGuarded(item);
  return { compactionQueued: retain, waitingFor: retain ? restoreCompaction(c, chatId, item, owner) : 'compaction' };
}

/** Claim one row at a time; edits/removals of later rows and Stop remain effective while a native ACK is pending. */
async function releaseCompaction(c, chatId, owner) {
  if (owner.releasing) {
    owner.again = true;
    return;
  }
  owner.releasing = true;
  try {
    while (current(c, chatId, owner) && owner.phase === 'complete' && !owner.afterTurn) {
      const s = c.state.get(chatId);
      if (!busy(s)) {
        retireCompaction(c, chatId, false);
        await c.drain(chatId);
        return;
      }
      const next = s.queue.find((q) => c.rt(chatId).compactionInputs?.get(q.id) === owner);
      if (!next) return;
      const q = c.removeQueued(chatId, next.id);
      const result = await c.steer(chatId, q, q.origin, owner);
      if (result?.started) continue;
      if (!c.state.get(chatId).queue.some((item) => item.id === q.id && !item.waitingFor)) return;
      // Refused: the turn takes no steer (Codex's /compact is a turn of its own) or ended before the steer reached it.
      // While the compaction still owns the turn, its input stays held and runs as the next turn once that turn completes
      // (end() lets go of it, then drains), as any refused steer does; Stop, a failed end or a replacement keep it for retry.
      const afterTurn = current(c, chatId, owner);
      if (afterTurn) {
        owner.afterTurn = true;
        c.rt(chatId).compactionInputs.set(q.id, owner);
      }
      const waitingFor = afterTurn ? 'compaction' : 'compactionRetry';
      c.state.patch(chatId, {
        queue: c.state.get(chatId).queue.map((item) => (item.id === q.id ? { ...item, waitingFor } : item)),
      });
      return;
    }
  } finally {
    owner.releasing = false;
    if (owner.again) {
      owner.again = false;
      releaseCompaction(c, chatId, owner).catch(ignoring('release input after its compaction guard settled'));
    }
  }
}

/** A validated adapter signal is admitted only for an existing current chat/session and matching native turn/item. */
function observeCompaction(c, signal) {
  if (!signal) return;
  const chatId = c.chatOf(signal.source.key);
  // a session a switch is leaving cannot compact the switching start's turn
  if ((!c.state.has(chatId) && !c.chats.records.has(chatId)) || !turnSource(c, chatId, signal.source)) return;
  // a compacted context may no longer hold MoMo's memory: its next turn carries it again (electron/momo/contract/context.cjs)
  forgetMomoSent(chatId);
  const adapter = c.adapterOf(chatId);
  if (signal.account !== undefined && adapter.accountOf && adapter.accountOf(chatId) !== signal.account) return;
  if (!c.state.has(chatId)) {
    // Completion/reset cannot create an owner. Unopened Codex chats need proof from the current adapter's turn.
    if (signal.phase !== 'active') return;
    if (signal.turnId !== undefined) {
      if (!adapter.running?.has(signal.source.key) || adapter.turnOf?.get(signal.source.key) !== signal.turnId) return;
      c.rt(chatId).token = signal.turnId;
      c.state.patch(chatId, { turn: 'running', activeTurn: { id: signal.turnId, human: false } });
    }
  }
  const s = c.state.get(chatId);
  if (signal.turnId !== undefined && s.activeTurn?.id !== signal.turnId) return;
  const r = c.rt(chatId);
  const owner = r.compaction;
  if (signal.phase === 'reset') return void retireCompaction(c, chatId);
  if (signal.phase === 'active') {
    if (owner && current(c, chatId, owner) && owner.phase === 'active' && owner.id === signal.id && owner.turnId === signal.turnId) return;
    retireCompaction(c, chatId);
    r.compaction = {
      ...signal,
      runtime: r,
      token: r.token,
      attempt: r.startAttempt,
      segments: c.chats.records.get(chatId)?.segments,
      adapter,
    };
    c.state.patch(chatId, { compaction: 'active' });
    return;
  }
  if (
    !owner ||
    (owner.phase !== 'active' && owner.phase !== 'ended') ||
    owner.id !== signal.id ||
    owner.turnId !== signal.turnId ||
    owner.account !== signal.account
  )
    return;
  if (!current(c, chatId, owner)) return void retireCompaction(c, chatId);
  if (signal.phase === 'failed') return void retireCompaction(c, chatId, true, true);
  if (signal.phase === 'ended') {
    owner.phase = 'ended';
    c.state.patch(chatId, {
      compaction: null,
      queue: s.queue.map((q) => (r.compactionInputs?.get(q.id) === owner ? { ...q, waitingFor: 'compactionRetry' } : q)),
    });
    return;
  }
  owner.phase = 'complete';
  c.state.patch(chatId, { compaction: null });
  releaseCompaction(c, chatId, owner).catch(ignoring('release queued input after compaction'));
}

module.exports = {
  WAITING,
  sameTurn,
  activeCompaction,
  holdCompaction,
  restoreCompaction,
  guardCompaction,
  suspendCompactionStart,
  retireCompaction,
  observeCompaction,
};
