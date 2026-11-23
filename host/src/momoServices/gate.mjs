// MoMo's approval gate on this Host (#5474, shared/momoCore/approvalGate.ts): where a MoMo tool call is decided once the tool runner calls `home.gate.run` (momoTools.mjs, #4791). `run` checks the call and either runs it, refuses it or returns the card the owner must answer; `resume` spends an answered card on the exact call, once, if the home is still the one that asked; `answer` is the first-answer-wins tap from an owner's device; a timer ends overdue cards, and a card made for an earlier lease of the home is void. Cards, key, taint marks and audit lines live under the home's storage, sealed, so a move carries them and Reset deletes them. Every action carries the home's fence and nothing runs while this Host is not the running home; a call without a chat counts as tainted and one without an origin as unprompted.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createApprovalGate } from '../../../shared/momoCore/approvalGate.ts';
import { approvalView } from '../../../shared/momoCore/view.ts';
import { gateIntents } from '../momoGateIntents.mjs';
import { createAuditSink, createCardStore, createKeyedHash, createTaintStore, sealedStore } from '../momoCoreHost.mjs';
import { MAX_WAITING, MAX_WAITING_PER_CHAT, createBoundCards } from '../momoGateBound.mjs';
import { PENDING_TEXT, REFUSAL_CODES, causeOf, createExtraTools, effectOf, fieldsOf } from '../momoToolEffects.mjs';

const { ToolError } = createRequire(import.meta.url)('../../../electron/capabilities/contract/registry.cjs');

/** The runner's names for who started the turn, and the gate's. A call with no origin, or one nobody knows, is unprompted. @type {Record<string, 'chat' | 'task' | 'unprompted'>} */
const ORIGINS = { owner: 'chat', chat: 'chat', task: 'task', background: 'unprompted', unprompted: 'unprompted' };

const SWEEP_MS = 60_000;

/** @param {any} v */
const cutShortShape = (v) => ({ rows: /** @type {Record<string, any>} */ (v?.rows && typeof v.rows === 'object' ? v.rows : {}) });

/**
 * The row MoMo's chat shows for an action a stop cut short: which tool, and that it may or may not have happened. Nothing of what the action carried.
 * @param {{ id: string, action: string }} entry @param {{ machineId: string, name: string }} machine
 */
const cutShortRow = (entry, machine) => ({
  kind: /** @type {const} */ ('result'),
  id: `cutshort:${entry.id}`,
  result: {
    taskId: entry.id,
    settle: 1,
    title: `${String(entry.action).replace(/^run /, '').slice(0, 80)} was cut short`,
    state: 'failed',
    summary: '1 action was cut short when this machine stopped. It may or may not have happened; MoMo did not try again.',
    files: [],
    evidence: '',
    checked: '',
    machine,
    sessionId: null,
    untrusted: false,
    actions: [],
  },
});
/** The cards a client lists: every open one, and this many settled ones. */
const RECENT = 30;

/** @param {{ home: any, report?: (m: string) => void, now?: () => number }} deps */
export default ({ home, report = () => undefined, now = Date.now }) => {
  /** @type {Promise<{ gate: ReturnType<typeof createApprovalGate>, store: import('../../../shared/momoCore/approvalGate.ts').CardStore }> | null} */
  let building = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {ReturnType<typeof createTaintStore> | null} */
  let taintStore = null;
  /** @type {Set<(change: import('../../../shared/momoCore/approvalGate.ts').CardChange) => void>} */
  const listeners = new Set();
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof cutShortShape>>> | null} */
  let cutStore = null;
  /** The rows still to post for actions a stop cut short: written before the intents are settled, taken out once MoMo's chat has them, so a second restart never repeats one and a chat that is not there yet is not missed. */
  const cut = () =>
    (cutStore ??= sealedStore({
      dir: home.storage.dir,
      name: 'cut-short.json',
      safeStorage: home.data.safeStorage,
      shape: cutShortShape,
      now,
    }));
  const postCutShort = async () => {
    const rows = home.rows;
    if (!rows || !home.stamp()) return;
    for (const [id, row] of Object.entries(cut().read().rows)) {
      const posted = await rows.put({ ...row, at: now() }).then(
        () => true,
        () => false,
      );
      if (posted) await cut().change((v) => void delete v.rows[id]);
    }
  };
  const taints = () => (taintStore ??= createTaintStore({ dir: home.storage.dir, safeStorage: home.data.safeStorage, now }));

  /**
   * The card as a row of MoMo's chat, one per card id, updated in place at every change (answered, used, expired, void). The row is the same for every client, so it names no viewing device: who answered is `decidedName` of host.momoCards, per device. A card raised while MoMo has no main chat has no row yet; `syncRows` writes it once there is one.
   * @param {import('../../../shared/momoCore/approvalGate.ts').Card} card
   */
  const putRow = async (card) => {
    await home.rows?.put({
      kind: 'approval',
      id: `approval:${card.id}`,
      at: card.createdAt,
      approval: approvalView(card, { device: card.decidedBy ?? '', editable: bound.editable(card.id) }),
    });
  };
  /** The row of a card, written where a failure of the row must not stop what the card is for: it is reported. @param {import('../../../shared/momoCore/approvalGate.ts').Card} card */
  const rowed = (card) => putRow(card).catch((/** @type {Error} */ error) => report(`MoMo could not write a card's row: ${error.message}`));
  /** Writes the row of every card that has one to write (a card from before MoMo had a chat, a failed write); a row already kept as it is is not written again. */
  const syncRows = async () => {
    if (!home.stamp() || !home.rows || !home.chats?.main()) return;
    const { store } = await ensure();
    for (const card of await store.list()) await rowed(card);
    await home.service('questions')?.syncRows?.();
  };

  /** The tools other lanes added (`home.gate.tools.register`): what each does, so a send is a card and a read of outside content taints the chat. */
  const extraTools = createExtraTools();
  const bound = createBoundCards({ home, now, report, ensure: () => ensure(), rowed, api: () => api });

  const build = async () => {
    const dir = home.storage.dir;
    const safeStorage = home.data.safeStorage;
    const hash = await createKeyedHash({ dir, safeStorage, now });
    const store = createCardStore({ dir, safeStorage, now });
    // before any action of this process: an intent an earlier run of the Host left open (it quit while the action ran) is recorded as uncertain, never as done and never tried again
    const log = home.stores()?.audit;
    if (!log) throw new Error('MoMo’s audit log is not available, so nothing runs.');
    // a log that cannot be read is no reason for the gate not to build: every action fails closed at its own intent line, and the intents left open are settled at the next start
    const open = await Promise.resolve()
      .then(() => log.unfinished())
      .catch((/** @type {Error} */ error) => {
        report(`MoMo's audit log could not be read for actions a stop cut short: ${error.message}`);
        return [];
      });
    if (open.length) {
      const machine = { machineId: home.stamp()?.homeId ?? 'this-machine', name: home.machine() };
      // the rows are queued before the intents are settled, so a crash between the two loses neither
      await cut().change((v) => void open.forEach((e) => (v.rows[`cutshort:${e.id}`] = cutShortRow(e, machine))));
      await log.settleUnfinished();
      report(
        `${open.length} MoMo action${open.length === 1 ? ' was' : 's were'} cut short when this Host last stopped: it may or may not have happened, so it was not tried again.`,
      );
    }
    const gate = createApprovalGate({
      now,
      newId: () => crypto.randomUUID(),
      hash,
      store,
      audit: createAuditSink(() => home.stores()?.audit),
    });
    gate.subscribe((change) => {
      listeners.forEach((fn) => fn(change));
      // the phones: an open card pushes the approval, an answered or ended one clears it everywhere (momoPush.cardChanged)
      void (
        /** @type {Promise<import('../../../shared/momoCore/approvalGate.ts').Card>} */ (store.get(change.cardId))
          .then((card) => {
            home.push?.cardChanged?.({ cardId: change.cardId, status: change.status, ...(card.chatId ? { chatId: card.chatId } : {}) });
            return rowed(card);
          })
          .catch((error) => report(`MoMo could not tell the phones about a card: ${error.message}`))
      );
    });
    return { gate, store };
  };
  const ensure = () =>
    (building ??= build().catch((error) => {
      building = null;
      throw error;
    }));
  /** @param {{ homeId: string, leaseEpoch: number }} stamp */
  const fenceOf = (stamp) => `${stamp.homeId}:${stamp.leaseEpoch}`;
  /** The rules in force: the owner's own and the ones learned. Read at call time, never at load (services load in file-name order). */
  const rules = async () => (await home.service('learning')?.gateRules?.()) ?? [];
  /** A rule that allowed a call is used once more; one that refused it is not. @param {{ verdict: string, ruleId?: string }} result */
  const used = async (result) => {
    if (result.verdict === 'allow' && result.ruleId?.startsWith('learned:'))
      await home.service('learning')?.used?.(result.ruleId.slice('learned:'.length));
  };

  /** A card made for an earlier lease of the home can never be used: it ends here, whoever answers it later. @param {{ homeId: string, leaseEpoch: number }} stamp */
  const voidStale = async (stamp) => {
    const { gate, store } = await ensure();
    const fence = fenceOf(stamp);
    for (const card of await store.list(['open', 'allowed'])) {
      if (card.fence === fence) continue;
      await gate.voidCard(card.id, 'moved');
      const voided = await store.get(card.id);
      if (voided) await rowed(voided);
    }
    // an op whose card is void, completed or gone (also one that came with a move after its card was voided) is forgotten
    await bound.prune();
  };

  /** What a call may have changed outside this Host: a send, a spend or a delete, or any call that sends model-chosen text out. */
  const mayHaveLeft = (/** @type {{ effect: string, egress?: string }} */ call) =>
    ['send', 'spend', 'delete'].includes(call.effect) || call.egress === 'network';

  /**
   * The action's own intent line, on the disk before the action runs. A plain read has none (the gate's decision line is its record, so a loop of reads cannot push the evidence of a send out of the log). Null when the line cannot be written: the action does not run.
   * @param {{ tool: string, chatId?: string, args: any, effect: string, egress?: string }} call @param {string} [cardId]
   */
  const begin = async (call, cardId) => {
    if (call.effect === 'read' && call.egress !== 'network') return { end: async () => undefined };
    const log = home.stores().audit;
    const began = await log
      .intent({
        action: `run ${call.tool}`.slice(0, 190),
        chatId: call.chatId ?? 'none',
        decision: cardId ? `card ${cardId}` : 'allowed',
        // the log keeps only the keyed digest of these, so a run line matches its decision line and two sends are told apart
        args: call.args,
      })
      .catch(() => null);
    if (!began) return null;
    return {
      // an outcome that cannot be written leaves the intent open: `settleUnfinished` (at the gate's build) records it as uncertain
      end: (/** @type {'done' | 'not sent' | 'uncertain'} */ result) => log.outcome(began.id, { result }).catch(() => undefined),
    };
  };

  /**
   * Runs the action if this Host is still the home that asked. Its outcome line follows when it ends. A failure of a call that may have left this Host is `uncertain` unless the error says it positively did not leave (`notSent`), so a timeout after the request went out is never read as "not sent" and retried.
   * @param {{ homeId: string, leaseEpoch: number }} stamp @param {() => unknown} exec @param {Parameters<typeof begin>[0]} call @param {string} [cardId] @param {NonNullable<Awaited<ReturnType<typeof begin>>>} [pre] the intent, when it was written before the card was spent
   */
  const execute = async (stamp, exec, call, cardId, pre) => {
    if (!home.current(stamp)) {
      await pre?.end('not sent');
      return { refused: true, reason: 'moved' };
    }
    const began = pre ?? (await begin(call, cardId));
    if (!began) return { refused: true, reason: 'audit_unavailable' };
    try {
      const result = await exec();
      await began.end('done');
      return { done: true, result };
    } catch (error) {
      const e = /** @type {any} */ (error);
      const uncertain = e?.uncertain === true || (mayHaveLeft(call) && e?.notSent !== true);
      await began.end(uncertain ? 'uncertain' : 'not sent');
      const said = causeOf(error);
      return {
        failed: true,
        error: uncertain ? `${said} It may already have happened, so it was not tried again.` : said,
        code: e?.code,
        uncertain,
      };
    }
  };

  const api = {
    /**
     * What is known of the outside content one chat holds, kept on disk: the tool-result path calls `toolResult(source)` for every tool that ran (whatever it returned), `reset()` only when outside content is provably gone. A call without a chat is never clean, and nothing is while this Host is not the home.
     * @param {string | undefined} chatId
     */
    taintFor(chatId) {
      return {
        // a chat this Host does not know as MoMo's own (an id from before a move, one never registered) is not clean; a Host with no chat registry cannot tell, and then only the record counts
        tainted: () => !chatId || !home.stamp() || (!!home.chats && !home.chats.isMomoChat(chatId)) || taints().has(chatId),
        /** @param {'owner_state' | 'outside' | 'unknown'} source */
        toolResult: async (source) => {
          if (chatId && source !== 'owner_state' && home.stamp()) await taints().mark(chatId);
        },
        reset: async () => {
          if (chatId && home.stamp()) await taints().clear(chatId);
        },
      };
    },

    /**
     * The gate in front of one MoMo action. `exec` runs only when the call is allowed (or, in `resume`, answered), on a Host that is still the running home.
     * @param {Omit<import('../../../shared/momoCore/approvalGate.ts').ActionRequest, 'tainted' | 'fence'> & { tainted?: boolean }} input
     * @param {() => unknown} exec
     */
    async run(input, exec) {
      const stamp = home.stamp();
      if (!stamp) return { refused: true, reason: 'not_home' };
      const { gate } = await ensure();
      await voidStale(stamp);
      const req = { ...input, tainted: input.tainted ?? api.taintFor(input.chatId).tainted(), fence: fenceOf(stamp) };
      const result = await gate.check(req, await rules());
      await used(result);
      if (result.verdict === 'deny') return { refused: true, reason: result.reason };
      if (result.verdict === 'ask') return { pending: true, card: result.card };
      return execute(stamp, exec, input);
    },

    /**
     * After the owner answered: spend the card on the very same call. The home must be the one that asked (a move voids pending cards), and a chat that read outside content since gets a fresh card to tap again.
     * @param {string} cardId @param {Omit<import('../../../shared/momoCore/approvalGate.ts').ActionRequest, 'tainted' | 'fence'> & { tainted?: boolean }} input @param {() => unknown} exec
     */
    async resume(cardId, input, exec) {
      const stamp = home.stamp();
      if (!stamp) return { refused: true, reason: 'not_home' };
      const { gate, store } = await ensure();
      const card = await store.get(cardId);
      if (!card) return { refused: true, reason: 'missing' };
      if (card.fence !== fenceOf(stamp)) {
        await gate.voidCard(cardId, 'moved');
        return { refused: true, reason: 'moved' };
      }
      const req = { ...input, tainted: input.tainted ?? api.taintFor(input.chatId).tainted(), fence: card.fence };
      // the action's intent line is written before the card is spent: with no writable log the card is not burned
      const pre = await begin(input, cardId);
      if (!pre) return { refused: true, reason: 'audit_unavailable' };
      const spent = await gate.authorize(cardId, req, await rules());
      if (!spent.ok) await pre.end('not sent');
      if (!spent.ok)
        return spent.reason === 'reissue' ? { pending: true, card: spent.card, reissued: true } : { refused: true, reason: spent.reason };
      const result = await execute(stamp, exec, input, cardId, pre);
      /** @type {Partial<import('../../../shared/momoCore/approvalGate.ts').Card>} */
      let patch = { outcome: 'completed' };
      if ('failed' in result) patch = { outcome: result.uncertain ? 'uncertain' : 'failed', failure: { cause: String(result.error) } };
      else if ('refused' in result) patch = { outcome: 'failed', failure: { cause: 'MoMo moved to another machine before this ran.' } };
      await store.transition(cardId, 'used', patch);
      // how it ended is not a change the gate announces, so the row and the phones are told here
      const ended = await store.get(cardId);
      if (ended) await rowed(ended);
      return result;
    },

    /** One tap on a card by an owner's device: `by` is its identifier, `name` what it is called. A card of an earlier lease is void. @param {string} cardId @param {'allow' | 'deny'} decision @param {string} by @param {string} [name] */
    async answer(cardId, decision, by, name) {
      const stamp = home.stamp();
      if (!stamp) return { won: false, status: 'not_home' };
      const { gate } = await ensure();
      await voidStale(stamp);
      const won = await gate.answer(cardId, decision, by, name);
      if (won.won) await bound.settle(cardId, decision === 'allow', { id: by, ...(name ? { name } : {}) });
      return won;
    },

    /** The cards a device draws: open ones first, then the latest settled. @param {string} device */
    async cards(device) {
      const stamp = home.stamp();
      if (!stamp) return [];
      const { store } = await ensure();
      await voidStale(stamp);
      const all = (await store.list()).sort((a, b) => b.createdAt - a.createdAt);
      const open = all.filter((c) => c.status === 'open' || c.status === 'deciding');
      return [...open, ...all.filter((c) => !open.includes(c)).slice(0, RECENT)].map((c) =>
        approvalView(c, { device, editable: bound.editable(c.id) }),
      );
    },

    /** One card as kept (for the learning service, which derives a reaction from it). @param {string} cardId */
    async card(cardId) {
      return home.stamp() ? (await ensure()).store.get(cardId) : undefined;
    },

    /** Ends overdue cards as a deny. The tool call that made a card has already told the model to wait, so nothing is blocked on it. */
    async sweep() {
      const stamp = home.stamp();
      if (!stamp) return [];
      await voidStale(stamp);
      const ended = await (await ensure()).gate.sweep();
      await bound.prune();
      // an overdue card ended as a deny: its row says so
      for (const card of ended) await rowed(card);
      await postCutShort();
      return ended;
    },

    /** The owner changed a rule: an audit line, false when it could not be written. @param {string} ruleId @param {'added' | 'edited' | 'removed'} change @param {string} by */
    async policy(ruleId, change, by) {
      if (!home.stamp()) return false;
      return (await ensure()).gate.policyChanged(ruleId, change, by);
    },

    /** Another change of the owner for the audit log (notes, a reaction), false when it could not be written. @param {Omit<import('../../../shared/momoCore/approvalGate.ts').AuditEvent, 'at'>} event */
    async audit(event) {
      if (!home.stamp()) return false;
      return (await ensure()).gate.audit(event);
    },

    /** "Ask again" on a card that was turned down, ended unattended or ended uncertain: a fresh card for the same request. @param {string} cardId */
    askAgain: (cardId) => bound.askAgain(cardId),

    /** "Edit" on a card that waits: a new card for the edited text, the old one void. @param {string} cardId @param {string} body */
    editApproval: (cardId, body) => bound.edit(cardId, body),

    /** Every change of a card, for each connected device. @param {(change: import('../../../shared/momoCore/approvalGate.ts').CardChange) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };

  /**
   * The chokepoint of the tool registry (host/src/momoTools.mjs `setChatGate`, #4791): every tool call of a MoMo chat passes here after the allow-list. The call is classified by what the tool does (in a chat holding outside content, saving or forgetting what MoMo remembers needs a card), decided by the gate, and run only if it is allowed; a refusal or a card to tap reaches the model as a refusal it can read. The chat's taint follows every tool that ran, whatever it answered. A call without an origin is unprompted.
   * @param {{ chatId: string, tool: string, args: any, origin?: 'owner' | 'background' | 'chat' | 'task' | 'unprompted' }} call @param {() => unknown} run
   */
  home.gate = {
    /** How another lane puts its tool behind the gate: `register({ tool, effect, egress?, scope?, summary? })` (host/src/momoToolEffects.mjs), `has(tool)`. The tool's own runner is that lane's. */
    tools: extraTools,
    /** The one record of which chats hold outside content, for the runner and the scheduler: `has` at once, `mark` and `clear` as in createTaintStore. A call without a chat, or on a Host that is not the home, is tainted. */
    taint: {
      has: (/** @type {string | undefined} */ chatId) => api.taintFor(chatId).tainted(),
      mark: async (/** @type {string} */ chatId) => (home.stamp() ? taints().mark(chatId) : true),
      clear: async (/** @type {string} */ chatId, /** @type {boolean} */ wasTainted = false) =>
        home.stamp() ? taints().clear(chatId, wasTainted) : false,
    },
    /** The chat's taint, read at once: the runner asks it before a write it decides itself (`mayRemember`). @param {string | undefined} chatId */
    taintFor: (chatId) => api.taintFor(chatId),

    async run(call, run) {
      const taint = api.taintFor(call.chatId);
      // a call to the notes tool is checked against the owner's words first; any call may be asked about again, so what each card was for is kept
      const prep = bound.prepare(call);
      const { args, said, current } = prep;
      const what = effectOf(call.tool, taint.tainted() || prep.unbound, args, extraTools);
      // too many cards waiting: refused to the model, so a chat that read injected text cannot fill the owner's phone with cards or push out the genuine ones
      if (what.effect !== 'read') {
        const room = await bound.room(call.chatId);
        if (room !== 'ok')
          throw new ToolError(
            room === 'all'
              ? `${MAX_WAITING} things are already waiting for the owner: do not try more until they have answered some.`
              : `${MAX_WAITING_PER_CHAT} things from this chat are already waiting for the owner: do not try more until they have answered some.`,
            'invalid',
          );
      }
      const shown = fieldsOf(args);
      if (prep.extra.length) shown.fields = [...prep.extra, ...shown.fields].slice(0, 10);
      // a call the owner could not see whole must not be put to a tap
      if (shown.tooLong && what.effect !== 'read' && what.effect !== 'notes')
        throw new ToolError('This call has a value too long to show the owner in full, so it did not run.', 'invalid');
      const req = {
        tool: call.tool,
        effect: what.effect,
        egress: what.egress,
        scope: what.scope,
        args,
        origin: ORIGINS[call.origin ?? ''] ?? 'unprompted',
        chatId: call.chatId,
        summary: what.summary,
        fields: shown.fields,
      };
      let out = await api.run(req, run);
      // the owner already tapped Allow on this very call: the model's retry spends that card, once
      if ('pending' in out && out.card.status === 'allowed') out = await api.resume(out.card.id, req, run);
      if ('done' in out || 'failed' in out) await taint.toolResult(what.source);
      if ('done' in out) return out.result;
      if ('pending' in out) {
        // the card is for this op and these words: the owner's Allow runs exactly that, whenever it comes
        await bound.keep(out.card.id, { req, args, ...(said ? { said } : {}), ...(current === undefined ? {} : { current }) });
        throw new ToolError(PENDING_TEXT, 'approval_pending');
      }
      if ('failed' in out) throw new ToolError(out.error, out.code ?? 'failed');
      throw new ToolError(`MoMo did not run ${call.tool}.`, REFUSAL_CODES[out.reason]);
    },
  };

  const disarm = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  /** One record of everything the gate keeps, written through its normal path: a chat that holds outside content (the taint file), and a card for a send that waits (the card store, the gate's key and the audit lines). */
  const seed = async () => {
    await api.taintFor('momo-seed').toolResult('outside');
    await bound.seedEntry('seed-card');
    await cut().change(
      (v) => void (v.rows['cutshort:seed'] = cutShortRow({ id: 'seed', action: 'run momo.seed' }, { machineId: 'seed', name: 'Seed' })),
    );
    await api.run(
      { chatId: 'momo-seed', origin: 'chat', tool: 'momo.seed', effect: 'send', scope: 'seed', args: { seed: true }, summary: 'Seed' },
      // never run: the card waits for a tap, so what runs is whatever is given
      home.stamp,
    );
  };
  home.use('gate', {
    seed,
    start: () => {
      disarm();
      ensure()
        .then(() => api.sweep())
        .then(() => syncRows())
        .catch((error) => report(`MoMo's gate could not start: ${error.message}`));
      timer = setInterval(
        () =>
          void api
            .sweep()
            .then(syncRows)
            .catch((error) => report(`MoMo's gate sweep failed: ${error.message}`)),
        SWEEP_MS,
      );
      timer.unref?.();
    },
    pause: disarm,
    wipe: () => {
      disarm();
      building = null;
      taintStore = null;
      cutStore = null;
      bound.wipe();
    },
  });
  // the clients' buttons on cards, notes and rules (lane `gate`, shared/momoIntents.mjs): read by the Host's registry when asked
  home.provide('gate', Object.assign(api, { intents: gateIntents({ home }) }));
};
