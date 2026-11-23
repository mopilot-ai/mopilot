// What the Switch host dialog calls: continue a chat on another Host (docs: design/host/index.html, package 3.1 and 3.2). It builds the handoff, runs the continue machine (electron/host/continue.cjs) over the right channel for each Host (this Mac's own, or an authenticated session through the tunnel), and reconciles when a source Host returns.
const { createContinueMachine } = require('./continue.cjs');
const { createContinueHandoff } = require('./continueHandoff.cjs');
const { assertTargetTakes } = require('./continueTargetCheck.cjs');
const { canonicalHarness } = require('../../shared/host/continueFamilies.mjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');
const { CONTINUE_CODES, ContinueRefusal } = require('../../shared/host/continue.mjs');
const schema = require('../../shared/host/schema.mjs');
const stream = require('../../shared/host/stream.mjs');
const { hostChatId } = require('../../shared/host/chatIds.mjs');

/** How long the preparation and the commit may take on the Host: a session is opened there. */
const SLOW_MS = 60_000;

/** An agent whose own login was refused (the Host says `refused`) is its own refusal for the Mac's copy: details do not cross to the window. @param {any} e */
const refusedLogin = (e) => {
  throw e?.code === CONTINUE_CODES.agentSignedOut && e.details?.refused === true ? Object.assign(e, { code: 'agent_login_refused' }) : e;
};

/** The request as the Host knows the chat: every chat.* call leaves the Mac with the Host's id (`<uuid>`), never the app's (`acp:host-codex:<uuid>`), as the Host-id view does for the other chat calls (#5160). @param {any} params */
const onWire = (params) => (typeof params?.chatId === 'string' ? { ...params, chatId: hostChatId(params.chatId) } : params);

/** A failure from before the request was written: it proves nothing was sent. @param {unknown} e */
const unsent = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { notSent: true });

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./ownership.cjs').OwnershipStore>} o.ownership
 * @param {(hostId: string) => 'online' | 'connecting' | 'offline'} o.hostState this Mac is always online; a machine as the registry says
 * @param {(hostId: string, onEvent?: (event: Record<string, any>) => void) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} o.session an authenticated session to a paired machine (MachinesService.session)
 * @param {{ call: (method: string, params: object) => Promise<any> }} o.local this Mac's own channel (localContinue.cjs)
 * @param {(chatId: string) => Promise<{ turns: object[], failed: { kind: string }[], label: string, model: string | null }>} o.localTurns a chat on this Mac as a harness switch reads it
 * @param {(chatId: string) => { harness: string, label: string }} o.harnessOf the harness the chat runs on now
 * @param {{ merge: (t: { chatId: string, hostId: string, items: object[] }) => void }} o.tails where a returning source's tail is kept
 * @param {(problem: string) => void} o.report
 * @param {() => string} o.newKey
 * @param {(chatId: string) => number} o.mirrorRev the last rev the app holds from the chat's Host
 * @param {(chatId: string) => { items: unknown[], complete: boolean } | null} o.mirror the finished items the app holds of a chat that runs on a machine (none yet: nothing consumes a remote chat's stream)
 * @param {(ms: number) => Promise<void>} o.sleep waits between the repeats of a commit
 * @param {(hostId: string) => Promise<null | { code: string, message: string }>} [o.lostCheck] why a source may still run (a cloud machine is lost only when its provider says it is gone)
 * @param {(chatId: string, harness: string) => void} [o.kept] told the agent a chat runs on once it is on a machine, for what is lent and picked with its next message (wiring.cjs `keepAgent`)
 * @param {{ transfer: ReturnType<typeof import('./codeTransfer.cjs').createCodeTransfer>, sourceFolder: (chatId: string, hostId: string) => Promise<string | null> } | null} [o.code] getting the code to the target (3.5): the transfer, and the chat's folder on the Host it runs on now; without it the handoff says nothing about the repository
 */
function createHostContinue({
  ownership,
  hostState,
  session,
  local,
  localTurns,
  harnessOf,
  tails,
  report,
  newKey,
  mirrorRev,
  mirror,
  sleep,
  code = null,
  lostCheck,
  kept,
}) {
  /** The user's yes to continuing without the unreachable source, per chat, for the continue running now. @type {Map<string, { yes: boolean }>} */
  const confirmed = new Map();
  /** @type {ReturnType<typeof createContinueMachine>} */
  let machine;

  /** hello, then the request, on one authenticated session; the session ends with the request. Resolves what the Host answered and the features it agreed to. @param {string} hostId @param {string} method @param {object} params */
  async function exchange(hostId, method, params) {
    let s;
    try {
      s = await session(hostId);
    } catch (e) {
      throw unsent(e);
    }
    // the Host answers a hello with the ids it was asked with: the app's own spelling is put back
    const moved = machine.movedFrom(hostId);
    const asked = new Map(moved.map((/** @type {{ chatId: string }} */ m) => [hostChatId(m.chatId), m.chatId]));
    const named = (/** @type {any} */ list) =>
      Array.isArray(list) ? list.map((m) => ({ ...m, chatId: asked.get(m?.chatId) ?? m?.chatId })) : list;
    try {
      /** @type {any} */
      let reply;
      let negotiated;
      try {
        reply = await s.call('host.hello', { ...schema.helloParams(), moved: moved.map(onWire) });
        negotiated = schema.negotiate(schema.helloParams(), schema.parseParams('host.hello', reply));
        schema.requireFeatures(method, negotiated);
      } catch (e) {
        throw unsent(e);
      }
      if (reply.continued) {
        const { poisoned, conflicts, agreed } = reply.continued;
        await machine.sourceReturned(hostId, { poisoned: named(poisoned), conflicts: named(conflicts), agreed: named(agreed) });
      }
      return {
        result: await s.call(method, schema.parseParams(method, onWire(params)), { timeoutMs: SLOW_MS }),
        features: negotiated.features,
      };
    } finally {
      s.close();
    }
  }

  /** @param {string} hostId @param {string} method @param {object} params */
  const remote = async (hostId, method, params) => (await exchange(hostId, method, params)).result;

  /** The chat as the Host last held it: its snapshot, read from the stream's Hello. @param {string} hostId @param {string} chatId */
  async function snapshot(hostId, chatId) {
    /** @type {any} */
    let hello = null;
    /** @type {any[]} */
    const durables = [];
    // the Host's streams name the chat by its own id
    const wire = hostChatId(chatId);
    const s = await session(hostId, (event) => {
      if (event.event !== 'frame' || event.chatId !== wire) return;
      try {
        const frame = stream.parseFrame(event.frame);
        if (frame.t === 'hello') hello = frame;
        else if (frame.t === 'durable') durables.push(frame);
      } catch (e) {
        report(`A stream frame from host ${hostId} could not be read: ${/** @type {Error} */ (e).message}`);
      }
    });
    try {
      const reply = await s.call('host.hello', { ...schema.helloParams(), moved: [] });
      schema.requireFeatures('chat.subscribe', schema.negotiate(schema.helloParams(), schema.parseParams('host.hello', reply)));
      await s.call('chat.subscribe', { chatId: wire, epoch: ownership.get(chatId).epoch, fromRev: 0 });
    } finally {
      s.close();
    }
    if (!hello) throw new Error('The host sent no snapshot.');
    // from rev 0 the Host replays the finished items as durable frames after its Hello; a Hello with a snapshot already holds them
    const items = hello.snapshot ? (hello.snapshot.items ?? []) : durables.map((f) => f.item);
    return { rev: Math.max(hello.rev, ...durables.map((f) => f.rev)), items };
  }

  const handoff = createContinueHandoff({
    mirror,
    snapshot,
    hostState,
    localTurns,
    labelOf: (chatId) => harnessOf(chatId).label,
    report,
  });

  machine = createContinueMachine({
    ownership,
    hostState,
    channel: (hostId) => (hostId === LOCAL_HOST_ID ? local : { call: (method, params) => remote(hostId, method, params) }),
    confirmLostHost: async ({ chatId }) => confirmed.get(chatId)?.yes === true,
    mirrorRev,
    newKey,
    // the tail a returning Host still held: the items it recorded after the last rev this app holds
    fetchTail: async ({ hostId, chatId, fromRev }) => {
      const snap = await snapshot(hostId, chatId);
      return snap.items.slice(Math.max(0, snap.items.length - Math.max(0, snap.rev - fromRev)));
    },
    mergeTail: (t) => tails.merge(t),
    report,
    sleep,
    ...(lostCheck ? { lostCheck } : {}),
  });

  /**
   * The source folder's repository and how the folder picked on the target compares with it, for the dialog before it asks and for the handoff after; null when there is nothing to read (no code transfer, no folder, a folder that is not readable).
   * @param {string} chatId @param {string} targetHostId @param {string} cwd
   */
  async function repoFacts(chatId, targetHostId, cwd) {
    // a machine that is away is refused as that, not as whatever its folder check would fail with
    if (hostState(targetHostId) !== 'online') throw new ContinueRefusal(CONTINUE_CODES.targetOffline, 'That host is not online.');
    const sourceHostId = ownership.get(chatId).ownerHostId;
    const sourceCwd = await code?.sourceFolder(chatId, sourceHostId);
    if (!code || !sourceCwd) return null;
    const source = await code.transfer.readSource({ sourceHostId, cwd: sourceCwd });
    // the folder on the target is checked even when the source cannot be read: a folder the target refuses is refused now, with its reason
    const { state, target } = await code.transfer.check({ source, targetHostId, targetPath: cwd });
    return { sourceHostId, sourceCwd, source, state, target };
  }

  return {
    /**
     * What the dialog shows before the user confirms: how the folder on the target compares with the source's repository (`ready`, `other_branch`, `other_repository`, `no_repository`, `unverified`), and what carrying the source's uncommitted changes would send.
     * @param {{ chatId: string, targetHostId: string, cwd: string }} req
     */
    async codePlan({ chatId, targetHostId, cwd }) {
      ownership.refresh();
      const facts = await repoFacts(chatId, targetHostId, cwd);
      if (!facts) return null;
      const { sourceHostId, sourceCwd, source, state } = facts;
      return {
        state,
        repository: source?.remote ?? null,
        branch: source?.branch ?? null,
        dirty: source?.dirty ?? 0,
        plan: await code?.transfer.carryPlan({ source, sourceHostId, cwd: sourceCwd }),
      };
    },

    /**
     * The Switch host dialog's request. Resolves `{ hostId, epoch }` once the chat is on its new Host.
     * @param {{ chatId: string, targetHostId: string, cwd: string, lostHostConfirmed: boolean, carry?: { confirmed?: boolean, untracked?: string[], unpushed?: number } | null }} req `carry` asks for the source's uncommitted changes to be carried to the folder; new files go only if listed in `untracked` and `confirmed`; unpushed commits are published with them only as many as `unpushed` says
     */
    async run({ chatId, targetHostId, cwd, lostHostConfirmed, carry = null }) {
      // another window or a continue of the last minute may have moved the chat since this store read the file
      ownership.refresh();
      const source = ownership.get(chatId).ownerHostId;
      const { harness } = harnessOf(chatId);
      const facts = await repoFacts(chatId, targetHostId, cwd);
      let carried = { carried: 0, skipped: /** @type {string[]} */ ([]) };
      // files that reached the target's folder cannot be taken back, so a target that cannot take the chat is found out first (#4910)
      if (facts && carry)
        await assertTargetTakes({ hostId: targetHostId, harness, status: (id) => exchange(id, 'host.status', {}) }).catch(refusedLogin);
      if (facts && carry)
        carried = await /** @type {NonNullable<typeof code>} */ (code).transfer.carryChanges({
          source: facts.source,
          sourceHostId: facts.sourceHostId,
          cwd: facts.sourceCwd,
          targetHostId,
          targetPath: cwd,
          untracked: carry.untracked ?? [],
          unpushed: carry.unpushed ?? 0,
          confirmed: carry.confirmed === true,
        });
      const built = await handoff.build({
        chatId,
        sourceHostId: source,
        cwd,
        code: facts ? { source: facts.source, target: facts.target, carried: carried.carried, skipped: carried.skipped } : null,
      });
      const mine = { yes: lostHostConfirmed };
      confirmed.set(chatId, mine);
      try {
        const done = await machine.continueChat({ chatId, targetHostId, harness, cwd, handoff: built.text }).catch(refusedLogin);
        // the chat's id may spell another agent than the one it was continued on: what the Mac lends and picks with its first message follows this one
        // the chat is on the machine already: a record that cannot be written is reported, never a failed continue
        try {
          if (targetHostId !== LOCAL_HOST_ID) kept?.(chatId, canonicalHarness(harness));
        } catch (e) {
          report(`The agent of chat ${chatId} could not be kept: ${/** @type {Error} */ (e).message}`);
        }
        return { hostId: done.hostId, epoch: done.epoch };
      } finally {
        // a continue that was refused as overlapping must not take the running one's answer with it
        if (confirmed.get(chatId) === mine) confirmed.delete(chatId);
      }
    },

    /** A machine is reachable again: the chats continued without it are told to it, and the releases it missed are sent. @param {string} hostId */
    async hostReturned(hostId) {
      // the lost-host records are read from the file, which another window may have written
      ownership.refresh();
      if (machine.movedFrom(hostId).length > 0) {
        try {
          await remote(hostId, 'host.status', {});
        } catch (e) {
          report(`Host ${hostId} could not be told about the chats continued without it: ${/** @type {Error} */ (e).message}`);
        }
      }
      await machine.flushReleases(hostId);
    },

    machine: () => machine,
  };
}

module.exports = { createHostContinue };
