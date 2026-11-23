// Phone runtime composition: account, pairing, relay, encrypted session, and request ownership.
import { phonePrimitives } from './platform/crypto';
import { requestError } from './remote/requestError';
import { createPhoneVault } from '../../shared/remote/phoneVault.mjs';
import { createPhoneAuth } from '../../shared/remote/phoneAuth.mjs';
import { createPhonePairing } from '../../shared/remote/phonePairing.mjs';
import { createInboxGuard, frameSize } from './inboxGuard';
import { catchUpHandler, createCatchUp, createReturnReopen } from './inboxCatchUp';
import { createRelayLiveness } from './relayLiveness';
import { createPhoneRelay } from '../../shared/remote/phoneRelay.mjs';
import { createPhoneSession } from '../../shared/remote/phoneSession.mjs';
import { cleanupTarget, removePending } from '../../shared/remote/phoneCleanup.mjs';
import { pairView } from './computerName';
import * as accountApi from './platform/auth';
import { openVaultStorage } from './platform/vault';
import { onForeground } from './platform/lifecycle';
import { openPhoneSocket } from './platform/socket';
import { requestId } from './platform/requestId';
import { createUnpairing } from './removeComputer';
import { createRelayRouting, isSealedReply } from './relayRouting';
import { ConnectionCancelled, createReconnector, isTransient, NotJoined, Unreachable, type ReconnectOutcome } from './reconnect';
import { closedBy, errorLine, outcomeOf, refusalIn, refusedWait, type RelayRefusal } from './relayRefused';
import { joinedPeer, presenceAcrossConnect } from './presence';
import { reconnectTiming } from './platform/reconnectTiming';
import { createSendIdLearner } from './remote/sendIdLearner';
import { createComputerHello } from './remote/computerHello';
import { createMessageIdentity, IMAGE_UPDATE } from './remote/messageIdentity';
import { createOutboxStore } from './outboxStore';
import { createOutbox, MAX_QUEUED, sendActions, sendCall, sendExtras, sendLost } from './outbox';
import { phoneSnapshot, type MobileState } from './snapshot';
import type { MobileRuntime } from './contracts';
import type { RemoteMessage } from '../../shared/remote/transport.mjs';
import { PRODUCTION } from './endpoints';
import { createDirectHosts, type DirectHosts } from './remote/directHosts';
import type { HostChatFlag } from './remote/hostChatFlag';
import { relayTokenMethods } from './runtimePush';
export function createMobileRuntime(
  relayUrl: string = PRODUCTION.relayUrl,
  plainRelay = false,
  hostChat?: Omit<HostChatFlag, 'setOverride'>,
): MobileRuntime {
  let state: MobileState = {
    phase: 'loading',
    generation: 0,
    user: null,
    pairs: [],
    selectedPair: null,
    safetyNumber: null,
    pendingPair: false,
    error: null,
    presence: {},
    reconnect: null,
    outbox: [],
  };
  const listeners = new Set<() => void>(),
    events = new Set<(event: RemoteMessage) => void>();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const prim = phonePrimitives();
  const nativeIds = createMessageIdentity(prim.sha256, () => state.selectedPair ?? reconnector.pair());
  let vault: ReturnType<typeof createPhoneVault>,
    auth: ReturnType<typeof createPhoneAuth>,
    pairing: ReturnType<typeof createPhonePairing>,
    session: ReturnType<typeof createPhoneSession> | null = null;
  let generation = 0;
  let direct: DirectHosts | null = null;
  const channels = new Map<string, ReturnType<typeof createPhoneSession>>();
  const guard = createInboxGuard(); // sized to the relay's 5000 frames per pair
  const catchUp = createCatchUp(guard, ensureRelay, connectionLost, () => generation);
  const comeBack = createReturnReopen(
    catchUp,
    () => state.phase === 'online' && !reconnector.pair(),
    () => !inbox.length && !processing,
    () => generation,
  );
  let heardAt = Date.now();
  const liveness = createRelayLiveness({
    probe: async () => relay.authenticate(await auth.relayToken()),
    dead: (owner) => void catchUp(owner),
    generation: () => generation,
    quietFor: () => Date.now() - heardAt,
    heard: () => (heardAt = Date.now()),
  });
  let inbox: Array<{ frame: { pair: string; ctr: number }; owner: number }> = [];
  let processing: object | null = null;
  let routing = false;
  let started: Promise<void> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pairTimer: ReturnType<typeof setTimeout> | null = null;
  let pairTask: Promise<unknown> | null = null;
  let ownPairOwner: string | null = null;
  let cleanupTask: Promise<void> | null = null;
  let stopForeground: (() => void) | null = null;
  const publish = (patch: Partial<MobileState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const fail = (error: unknown) => publish({ phase: 'error', error: errorLine(error), refusal: refusalIn(error) });
  /** Whether each computer answers a repeated send id once (its hello says so); read again on every connection. */
  const sendIds = new Map<string, boolean>();
  const connectPresence = presenceAcrossConnect();
  /** What the last connection to each computer found, kept while it is away: an older one is not offered messages for later. */
  const lastSendIds = new Map<string, boolean>();
  const learnSendIds = createSendIdLearner({
    request: (method, params) => runtime.request(method, params),
    generation: () => generation,
    sendIds,
    lastSendIds,
  });
  const outbox = createOutbox({
    online: (pairId) => state.phase === 'online' && state.selectedPair === pairId && !!session,
    ready: learnSendIds,
    // asked after a connection was lost under a request, so what the connection found, not the current one
    idempotent: (pairId) => lastSendIds.get(pairId) === true,
    send: (item) =>
      item.images && !nativeIds.supports(item.pairId)
        ? Promise.reject(new Error(IMAGE_UPDATE))
        : runtime.request(...sendCall(item, sendIds.get(item.pairId) === true, Date.now() + 30000)),
    // a request cut off by the connection may have reached the computer: it is sent again under the same id
    lost: sendLost,
    newId: () => requestId(prim.randomBytes),
    identity: (item, id) => nativeIds.id('chat.send', item.chatId, id, item.pairId),
    now: Date.now,
    onChange: (items) => {
      publish({ outbox: items });
      outboxStore.persist(items);
    },
  });
  const observeHello = createComputerHello(nativeIds, () => ({ ...state, generation, vault, updatePairs }));
  const outboxStore = createOutboxStore({
    vault: () => vault,
    user: () => state.user?.id,
    pairIds: () => state.pairs.map((pair) => pair.pairId),
    items: () => state.outbox,
    restore: (items) => outbox.restore(items),
    clear: () => outbox.clear(),
  });
  /** Remembers the computer used last (or that the user left it), so the next start can pick up where this one was; a vault that cannot save leaves the app waiting for a tap. */
  function rememberPair(pairId: string | null) {
    void Promise.resolve()
      .then(() => vault.setLastPair(pairId))
      .catch(() => undefined);
  }
  /** At start: connect to the computer used last, by itself and at once, then with the usual backoff if it is away. A tap, a pairing or any other connection made meanwhile wins. */
  async function resumeLastPair(owner: number) {
    let pairId: string | null = null;
    try {
      pairId = await vault.getLastPair();
    } catch {
      return;
    }
    if (!pairId || owner !== generation || state.phase !== 'ready' || state.pendingPair || reconnector.pair()) return;
    if (!state.pairs.some((pair) => pair.pairId === pairId)) return rememberPair(null);
    reconnector.start(pairId, 0);
  }
  const incoming = createRelayRouting({
    channels,
    selectedPair: () => state.selectedPair,
    // an unreadable frame from the computer being connected ends that connection visibly
    connecting: () => reconnector.pair(),
    generation: () => generation,
    refreshPairs: updatePairs,
    reconciliationError: fail,
    pairingSettled: (owner) => void (publish({ phase: 'ready', error: null }), resumeLastPair(owner)),
    removed: (pair) => {
      outbox.drop(pair);
      void unpairing.forget(pair).catch(fail);
    },
    interrupt: (error, phase) => {
      // a computer that went away is waited for; an error (a removed pair) is not
      const pair = phase === 'offline' ? state.selectedPair : null;
      // a computer that went away leaves the relay up, which is where its return is announced
      teardown(phase === 'offline');
      publish({ phase, error });
      if (pair) reconnector.start(pair);
    },
    probe: () => runtime.request('machine.hello', {}),
    presence: (pair, presenceState, at) => {
      publish({ presence: connectPresence.event(state.presence, pair, presenceState, at, Date.now()) });
      // the computer being waited for came back: try now rather than at the end of the backoff
      if (presenceState === 'online' && reconnector.pair() === pair) reconnector.nudge();
    },
  });
  const reconnector = createReconnector({
    attempt: (pairId) => autoConnect(pairId),
    timing: reconnectTiming,
    onChange: (reconnect) => publish({ reconnect }),
  });
  const unpairing = createUnpairing({
    blocked: () => (cleanupTask || pairing.status() !== 'idle' || state.pendingPair ? 'Finish or cancel pairing first' : null),
    hasPair: async (id) => !!(await vault.getPair(id)),
    signedIn: () => !!state.user,
    generation: () => generation,
    // a computer being waited for is the one a removal is about
    selectedPair: () => state.selectedPair ?? reconnector.pair(),
    reaching: () => reconnector.pair(),
    relayConnected: () => relay.connected(),
    connectRelay: (owner) => ensureRelay(owner),
    relayRemove: (id) => relay.remove(id),
    closeChannel: (id) => {
      channels.get(id)?.close();
      channels.delete(id);
    },
    removePair: (id) => vault.removePair(id),
    showPairs: (owner) => updatePairs(owner),
    disconnect: () => disconnect(),
    publishError: (error) => publish({ error }),
  });
  const relay = createPhoneRelay({
    open: openPhoneSocket,
    onFrame: (frame: { pair: string; ctr: number }) => {
      const admission = guard.admit(inbox.length, frame.ctr, () => relay.acker.enabled(), frameSize(frame));
      if (admission === 'lost') {
        disconnect();
        fail(new Error('Relay inbox overflow'));
      }
      if (admission !== 'keep') return;
      heardAt = Date.now();
      inbox.push({ frame, owner: generation });
      void drain();
    },
    onEvent: incoming.event,
    onClose: (refusal?: RelayRefusal | null) => connectionLost(...closedBy(refusal)), // also the computer being brought back, whose socket closed before it was up
  });
  function connectionLost(error: string, delayMs?: number, refusal: RelayRefusal | null = null) {
    const pair = state.selectedPair ?? reconnector.pair();
    teardown();
    publish({ phase: 'offline', error, refusal });
    if (pair) reconnector.start(pair, delayMs);
  }
  /** Ends everything, including a wait to reconnect: the user, a sign-out, an unpair or an error asked for it. */
  function disconnect() {
    reconnector.stop();
    teardown();
    publish({ refusal: null });
  }
  /** Drops the connection to the computer; `keepRelay` leaves the relay socket open so the computer's return (a presence event) reaches a phone waiting for it. */
  function teardown(keepRelay = false) {
    sendIds.clear();
    if (pairing && pairing.status() !== 'idle' && pairing.status() !== 'committing') pairing.cancel();
    generation++;
    liveness.stop();
    incoming.reset();
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    for (const channel of channels.values()) channel.close();
    channels.clear();
    session = null;
    routing = false;
    inbox = [];
    guard.reset();
    processing = null;
    if (!keepRelay) relay.close();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Connection closed'));
    }
    pending.clear();
    publish({ generation, selectedPair: null, catchingUp: false, phase: state.user ? 'offline' : 'signedOut' });
  }
  async function updatePairs(owner = generation) {
    const [pairs, pendingPair] = await Promise.all([vault.pairs(), vault.getPending()]);
    if (owner === generation)
      publish({
        pairs: pairs.map(pairView),
        pendingPair: !!pendingPair,
      });
  }
  function addChannel(pairId: string, owner: number) {
    const channel = createPhoneSession({
      prim,
      vault,
      pairId,
      send: (frame) => relay.send(frame).then(() => undefined),
      acker: relay.acker,
      onCatchUp: catchUpHandler(() => owner === generation && state.selectedPair === pairId, publish, connectionLost),
      onMalformed: ({ inReplyTo }) => {
        const item = inReplyTo ? pending.get(inReplyTo) : undefined;
        if (!item || owner !== generation) return;
        clearTimeout(item.timer);
        pending.delete(inReplyTo!);
        item.reject(requestError({ code: 'reply_unreadable', message: 'The computer sent a reply this phone could not read' }));
      },
      onMessage: (message) => {
        if (owner !== generation || state.selectedPair !== pairId) return;
        if (message.kind === 'reply') {
          const item = pending.get(message.inReplyTo);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.inReplyTo);
            void (message.ok ? item.resolve(message.result) : item.reject(requestError(message.error)));
          }
        } else if (message.kind === 'event') {
          if (message.ev === 'pair.resync') void incoming.resync(pairId);
          else if (message.ev === 'live.missed') connectionLost('Catching up with your computer…', 0); // events skipped while the computer thought this phone away: read again
          for (const fn of events) fn(message);
        }
      },
    });
    channels.set(pairId, channel);
    return channel;
  }
  async function prepareChannels(owner: number) {
    const pairs = await vault.pairs();
    if (owner !== generation) throw new ConnectionCancelled();
    for (const pair of pairs) {
      if (pair.relay === relayUrl) addChannel(pair.pairId, owner);
    }
    routing = true;
    void drain();
  }
  async function drain() {
    if (processing || !routing) return;
    const processOwner = {};
    processing = processOwner;
    const drainOwner = generation;
    let justPaired: string | null = null;
    try {
      while (drainOwner === generation && inbox.length && routing) {
        const { frame, owner } = inbox.shift()!;
        if (frame.ctr === 0) {
          if (pairing.status() === 'idle') continue;
          if (!isSealedReply(frame)) continue;
          let paired;
          try {
            paired = await pairing.finish(frame);
          } catch (error) {
            if (
              error instanceof SyntaxError ||
              (error instanceof Error && ['invalid pairing reply', 'invalid pairing data', 'no pending pairing'].includes(error.message))
            )
              continue;
            if (owner !== generation) {
              await incoming.failed(owner, error);
              continue;
            }
            throw error;
          }
          await incoming.committed(owner);
          if (owner !== generation) continue;
          incoming.reset();
          if (pairTimer) clearTimeout(pairTimer);
          pairTimer = null;
          addChannel(paired.pairId, owner);
          publish({ phase: 'ready', safetyNumber: null, error: null });
          justPaired = paired.pairId;
        } else {
          await incoming.receive(frame);
        }
      }
    } catch (error) {
      if (drainOwner === generation) {
        disconnect();
        fail(error);
      }
    } finally {
      if (processing === processOwner) processing = null;
    }
    const current = drainOwner === generation;
    if (guard.tripped() && current && !inbox.length)
      void catchUp(drainOwner); // the rest comes again, on a fresh socket, unseen
    else if (current && !inbox.length) comeBack.drained(drainOwner);
    if (justPaired && current) reconnector.start(justPaired, 0); // just paired in order to use it: it connects by the path a cold start takes
  }
  async function ensureRelay(owner: number) {
    const token = await auth.relayToken();
    if (owner !== generation) throw new ConnectionCancelled();
    guard.reset(); // a new socket starts with an empty inbox
    const hello = await relay.connect(relayUrl, token);
    heardAt = Date.now();
    if (owner !== generation) throw new ConnectionCancelled();
    scheduleRefresh(owner);
    return hello;
  }
  function scheduleRefresh(owner: number) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      async () => {
        try {
          const token = await auth.relayToken(true);
          if (owner !== generation) return;
          await relay.authenticate(token);
          if (owner === generation) scheduleRefresh(owner);
        } catch (error) {
          if (owner === generation) lose(error);
        }
      },
      Math.max(1000, Math.min(10 * 60 * 1000, auth.relayExpiresAt() - Date.now() - 60_000)),
    );
  }
  /** The connection failed: a computer or network that is away is waited for, anything else ends it visibly. */
  function lose(error: unknown) {
    const pair = state.selectedPair;
    if (pair && isTransient(error)) {
      teardown();
      publish({ phase: 'offline', error: (error as Error).message });
      reconnector.start(pair);
    } else {
      disconnect();
      fail(error);
    }
  }
  /** Opens the pair for a user's tap (a miss starts the wait to reconnect) or for the reconnector (a miss is its outcome). */
  async function open(pairId: string, auto: boolean) {
    teardown();
    const owner = generation;
    try {
      if (!(await vault.getPair(pairId))) throw new Error('Unknown pair');
      await prepareChannels(owner);
      connectPresence.begin();
      const hello = await ensureRelay(owner);
      if (owner !== generation) throw new ConnectionCancelled();
      publish({ presence: connectPresence.hello(state.presence, hello, Date.now()) });
      const peer = joinedPeer(hello, pairId);
      // a pair the relay does not list as joined will not come back by waiting; a listed pair whose computer is away will
      if (!peer) throw new NotJoined('Computer is offline');
      if (!peer.peerOnline || state.presence[pairId]?.state !== 'online') throw new Unreachable('Computer is offline');
      session = channels.get(pairId) ?? null;
      if (!session) throw new Error('Pair relay does not match');
      publish({ selectedPair: pairId, phase: 'online', error: null, refusal: null });
      liveness.start(owner);
      rememberPair(pairId);
      if (!auto) reconnector.stop();
      void outbox.flush(pairId);
      if (outboxStore.dirty()) outboxStore.persist(state.outbox);
    } catch (error) {
      if (owner === generation) {
        // the relay answered and the computer is not there: keep listening on it for the computer's return
        teardown(error instanceof Unreachable);
        if (isTransient(error)) {
          publish({ phase: 'offline', error: (error as Error).message, refusal: refusalIn(error) });
          if (!auto) reconnector.start(pairId, refusedWait(refusalIn(error)));
        } else {
          if (!auto) reconnector.stop();
          // a computer the relay no longer lists will not be there at the next launch either
          else if (error instanceof NotJoined) rememberPair(null);
          fail(error);
        }
      }
      throw error;
    }
  }
  async function autoConnect(pairId: string): Promise<ReconnectOutcome> {
    try {
      await open(pairId, true);
      return 'connected';
    } catch (error) {
      return outcomeOf(error);
    }
  }
  const runtime: MobileRuntime = {
    snapshot: () => phoneSnapshot(state, pairing?.status(), !!processing),
    subscribe(fn) {
      listeners.add(fn);
      if (!stopForeground) stopForeground = onForeground(resumeConnection);
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          stopForeground?.();
          stopForeground = null;
        }
      };
    },
    onEvent(fn) {
      events.add(fn);
      return () => {
        events.delete(fn);
      };
    },
    start() {
      if (started !== null) return started;
      const owner = generation;
      started = (async () => {
        try {
          const storage = await openVaultStorage();
          vault = createPhoneVault({ prim, ...storage });
          auth = createPhoneAuth({ vault, refresh: accountApi.refresh, revoke: accountApi.revoke, relayToken: accountApi.relayToken });
          direct = createDirectHosts({
            prim,
            vault,
            auth,
            relayUrl,
            request: runtime.request,
            open: openPhoneSocket,
            deviceName: accountApi.thisPhoneName,
            hostChat,
          });
          void hostChat?.load().catch(() => undefined);
          pairing = createPhonePairing({
            prim,
            store: {
              ...vault,
              claimPending: (pending: Parameters<typeof vault.claimPending>[0]) => {
                ownPairOwner = pending.owner;
                return vault.claimPending(pending);
              },
            },
            relayUrl,
            plainRelay,
            transport: {
              join: async (_url, pair) => {
                const owner = generation;
                incoming.joining(pair);
                await prepareChannels(owner);
                await ensureRelay(owner);
                if (owner !== generation) throw new ConnectionCancelled();
                await relay.join(pair);
              },
              send: (frame) => relay.send(frame).then(() => undefined),
            },
          });
          if (owner !== generation) return;
          const account = await auth.restore();
          // asked only once the sign-in is restored: a probe that came first would read every machine as away
          if (account) void direct.probe();
          await updatePairs(owner);
          if (owner !== generation) return;
          publish({
            user: account?.user ? { id: account.user.id, name: account.user.name, email: account.user.email } : null,
            phase: account ? 'ready' : 'signedOut',
            error: null,
          });
          // with no account there is nothing to read back, and what is typed from now on is kept
          if (account?.user) {
            await outboxStore.restore(account.user.id);
            await resumeLastPair(owner);
          } else outboxStore.markRestored();
        } catch (error) {
          if (owner === generation) {
            started = null;
            fail(error);
          }
        }
      })();
      return started;
    },
    async signIn() {
      disconnect();
      outboxStore.forget();
      const owner = generation;
      try {
        if (started !== null) await started;
        if (owner !== generation || !auth) throw new Error('Sign-in cancelled');
        // a new sign-in starts with no computer chosen
        rememberPair(null);
        const installId = await vault.getInstallId();
        if (owner !== generation) throw new Error('Sign-in cancelled');
        const account = await accountApi.authorize(installId);
        if (owner !== generation) throw new Error('Sign-in cancelled');
        await auth.install(account);
        if (owner !== generation) throw new Error('Sign-in cancelled');
        await updatePairs();
        if (owner === generation)
          publish({ user: { id: account.user.id, name: account.user.name, email: account.user.email }, phase: 'ready', error: null });
      } catch (error) {
        if (owner === generation) {
          started = null;
          fail(error);
        }
        throw error;
      }
    },
    async signOut() {
      disconnect();
      outboxStore.forget();
      const owner = generation;
      if (started !== null) await started;
      if (owner !== generation) return;
      if (!auth) throw new Error('Secure storage unavailable');
      rememberPair(null);
      await auth.signOut();
      await updatePairs(owner);
      if (owner === generation) publish({ user: null, phase: 'signedOut', error: null });
    },
    features: async () => (auth ? accountApi.accountFeatures(await auth.token()) : null),
    async deleteAccount(confirm) {
      if (!auth) throw new Error('Secure storage unavailable');
      await accountApi.deleteAccount(await auth.token(), confirm);
    },
    async pair(qr, name) {
      if (cleanupTask) throw new Error('Pair cleanup is in progress');
      disconnect();
      ownPairOwner = null;
      const owner = generation;
      let attempt: Promise<{ pairId: string; safetyNumber: string }> | null = null;
      try {
        publish({ phase: 'pairing', error: null });
        attempt = pairing.begin(qr, name);
        pairTask = attempt;
        const result = await attempt;
        if (pairTask === attempt) pairTask = null;
        await updatePairs(owner);
        if (owner === generation && pairing.status() !== 'idle') {
          publish({ safetyNumber: result.safetyNumber });
          const expire = () => {
            if (owner !== generation) return;
            if (pairing.status() === 'committing') {
              pairTimer = setTimeout(expire, 1000);
              return;
            }
            disconnect();
            const retired = generation;
            void updatePairs(retired).then(
              () => {
                if (retired === generation) fail(new Error('Pairing timed out. Clean up before trying again.'));
              },
              (error) => {
                if (retired === generation) fail(error);
              },
            );
          };
          pairTimer = setTimeout(expire, 5 * 60 * 1000);
        }
      } catch (error) {
        if (pairTask === attempt) pairTask = null;
        await incoming.failed(owner, error);
        throw error;
      }
    },
    async cancelPairing() {
      if (cleanupTask) return cleanupTask;
      pairing.cancel();
      disconnect();
      const owner = generation;
      const settling = pairTask;
      const task = (async () => {
        try {
          const target = await cleanupTarget({
            getPending: vault.getPending,
            settling,
            localOwner: () => ownPairOwner,
            current: () => owner === generation,
          });
          const claim = target ? await vault.claimCleanup(target.owner, target.pairId) : null;
          if (owner !== generation) throw new Error('Pair cleanup cancelled');
          let note: string | null = null;
          if (claim) {
            note = await removePending({
              claim,
              relayUrl,
              prepare: () => prepareChannels(owner),
              connect: () => ensureRelay(owner),
              join: relay.join,
              remove: relay.remove,
              current: () => owner === generation,
            });
            if (owner !== generation) throw new Error('Pair cleanup cancelled');
            await vault.finishCleanup(claim.cleanupClaim);
            if (owner !== generation) throw new Error('Pair cleanup cancelled');
          }
          disconnect();
          const completedOwner = generation;
          await updatePairs(completedOwner);
          if (completedOwner === generation) publish({ safetyNumber: null, error: note });
        } catch (error) {
          if (owner === generation) {
            disconnect();
            const retired = generation;
            try {
              await updatePairs(retired);
            } catch (storageError) {
              if (retired === generation) fail(storageError);
              throw storageError;
            }
            if (retired === generation) fail(error);
          }
          throw error;
        }
      })();
      cleanupTask = task;
      try {
        await task;
      } finally {
        if (cleanupTask === task) cleanupTask = null;
      }
    },
    async unpair(pairId) {
      if (started !== null) await started;
      if (!vault) throw new Error('Secure storage unavailable');
      const waited = reconnector.pair();
      await unpairing.unpair(pairId);
      if (!(await vault.getPair(pairId))) outbox.drop(pairId);
      // removing another computer closes the relay it opened for that, which ends the wait; this one is still being waited for
      if (waited && waited !== pairId && state.phase === 'offline' && !reconnector.pair() && (await vault.getPair(waited)))
        reconnector.start(waited);
    },
    async connect(pairId) {
      reconnector.hold(pairId);
      await open(pairId, false);
    },
    disconnect() {
      // leaving on purpose: the next start does not connect by itself
      rememberPair(null);
      disconnect();
    },
    messageIdentity: nativeIds.id,
    send(chatId, text, attachments = [], skills = [], momo, pictures = []) {
      const pairId = state.selectedPair ?? reconnector.pair(); // the computer being brought back counts: the message waits for it
      if (!pairId) throw new Error('Connect to a computer first');
      if (pictures.length && !nativeIds.supports(pairId)) throw new Error(IMAGE_UPDATE);
      if (state.outbox.length >= MAX_QUEUED)
        throw new Error('Too many messages are waiting. Cancel some, or wait until your computer has taken them.');
      if (lastSendIds.get(pairId) === false && state.phase !== 'online')
        throw new Error('This computer is running an older MoPilot that cannot hold messages for later. Update it; your draft is kept.');
      return outbox.add({ pairId, chatId, text, attachments, ...sendExtras(skills, momo) }, pictures);
    },
    ...sendActions(outbox),
    ...relayTokenMethods(relay, () => ensureRelay(generation)),
    get direct() {
      return direct;
    },
    async request(method, params) {
      const channel = session;
      if (!channel) throw new Error('Connect to a computer first');
      const id = requestId(prim.randomBytes);
      if (pending.has(id)) throw new Error('Request identity collision');
      const snapshot = JSON.parse(JSON.stringify(params));
      let requestOwner: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
      const answer = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.get(id) !== requestOwner) return;
          pending.delete(id);
          reject(new Error('Request timed out'));
        }, 30000);
        requestOwner = { resolve, reject, timer };
        pending.set(id, requestOwner);
      });
      void channel.send({ id, t: Date.now(), kind: 'request', method, params: snapshot }).catch((error) => {
        const item = pending.get(id);
        if (item === requestOwner) {
          clearTimeout(item.timer);
          pending.delete(id);
          item.reject(error instanceof Error ? error : new Error('Send failed'));
        }
      });
      if (method === 'machine.hello') observeHello(answer);
      return answer;
    },
  };
  /** The app is in front again: a computer being waited for is tried now rather than at the next backoff, and after a real absence an online socket is replaced. */
  function resumeConnection(awayMs = 0) {
    reconnector.kick();
    comeBack.returned(awayMs);
    void direct?.probe();
  }
  return runtime;
}
