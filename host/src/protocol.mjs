// The Host's side of the wire contract (shared/host/schema.mjs): per connection a hello that fixes the features, then each chat request parsed, gated on those features, checked against the chat's epoch, run once through the ledger, and the session stream served from what the ACP runtime emits (docs: design/host/index.html, package 2.3).
import crypto from 'node:crypto';
import { createChatEffects, pickedOf } from './chatEffects.mjs';
import { createImageProtocol } from './imageProtocol.mjs';
import { approvalsFor } from './approvalWiring.mjs';
import { closeCutOffCards } from './approvalRecovery.mjs';
import { isHostFamily } from '../../shared/host/chatIds.mjs';
import { lentTo as lent } from './chatCredentials.mjs';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';
import { CLIENT_METHODS } from '../../shared/host/clients.mjs';
import { capabilitiesOf, helloParams, negotiate, parseParams, requireFamily, requireFeatures } from '../../shared/host/schema.mjs';
import { StaleEpochError } from './epochs.mjs';
import { loadHandlers } from './methodHandlers.mjs';
import { UnsupportedError } from './errors.mjs';
import { ruleGate } from './ruleGate.mjs';
import { HostRefusal } from './hostFs.mjs';
import { INDETERMINATE } from './ledger.mjs';
import { fitFrame } from './frameFit.mjs';
import { createChatLog, assistantItem, recoverTurn } from './chatLog.mjs';
import { createChatRemoval } from './chatRemoval.mjs';
import { createJournalFaults } from './journalFaults.mjs';
import { createLiveOutput } from './liveOutput.mjs';
import { chatStateOf } from './chatState.mjs';
import { HelloRequiredError } from './helloRequired.mjs';

export { HelloRequiredError };
import { offeredFeatures } from './offeredFeatures.mjs';
import { sideChatStart } from './sideChatStart.mjs';
import { MAX_FRAME } from '../../shared/host/frames.mjs';
import { STREAM2_FEATURE, subAgentOf, withoutStream2 } from '../../shared/host/stream2.mjs';

export { UnsupportedError };

/** The runtime events a client replays to draw the chat as the Host's own app would; the rest (session settings, transcript errors) are the Host's. */
const WIRE_KINDS = new Set(
  'turnStart update turnEnd steered question permission permissionCancelled providerError unattended closed'.split(' '),
);
/** The updates that arrive a token at a time: shown live as deltas, recorded once as a whole message. */
const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk']);

/** The chat methods whose chat's events the client reads: refused for a chat of another family unless both ends declared `family`. */
const FAMILY_GATED = new Set(['chat.start', 'chat.send', 'chat.stop', 'chat.permit', 'chat.answer', 'chat.subscribe', 'chat.remove']);
/** The family a harness id names: `acp:<id>` is ACP's, `codex` and `claude` their own. @param {string} harness */
const harnessFamily = (harness) => (harness.startsWith('acp:') ? 'acp' : harness);

/** What a client is told of a turn the Host stopped under. */
const INTERRUPTED = 'The host stopped while this turn was running.';

/**
 * @param {object} o
 * @param {{ host: import('node:events').EventEmitter & { cancel: (key: string) => unknown }, send: (p: { key: string, text: string, cwd?: string, pick?: { model?: string, effort?: string }, clientId?: string, attachments?: any[] }) => Promise<{ turnId: string }>, setMode?: (p: { chatId: string, value: string }) => Promise<void>, prepare?: (p: Parameters<ReturnType<typeof import('./chatPreparation.mjs').createChatPreparation>>[0]) => Promise<void | boolean>, familyOf?: (chatId: string) => string, discardQueued?: (chatId: string) => void, permit: (p: { requestId: string, optionId?: string, form?: { action: string, content?: object } }) => boolean }} o.runtime what the chats run on (./sessions.mjs chatRuntime): turn events on `host`, a send that goes through the shared controller, Stop as `host.cancel`
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {ReturnType<typeof import('./guard.mjs').createGuard>} o.guard
 * @param {ReturnType<typeof import('./spend.mjs').createSpend>} [o.spend] the spend counter (./spend.mjs): a turn over a limit does not start, each ended turn's usage is added
 * @param {ReturnType<typeof import('./policy.mjs').createPolicy>} [o.policy] the owner's rules (./policy.mjs): a mode above their ceiling is refused, `host.policy` replaces the owner layer
 * @param {(params?: { signIn?: string[] }) => (object & { capabilities?: unknown }) | Promise<object & { capabilities?: unknown }>} o.status the `host.status` answer (`params.signIn`: repository hosts to report git sign-in for)
 * @param {() => unknown} [o.capabilities] the surfaces this Host declares, read without a status: a hello must not wait on the sign-in probes that a status runs (without it the hello asks the status)
 * @param {ReturnType<typeof import('./continue.mjs').createContinueHost>} [o.continueHost] continuing a chat on another Host (3.1); without it those requests are unsupported and nothing is gated
 * @param {{ take: (chatId: string) => { text: string, cwd?: string, harness?: string, id?: string } | null, done: (chatId: string) => void }} [o.handoffs] the handoff a continued chat's first message carries
 * @param {ReturnType<typeof import('./login.mjs').createLogin>} [o.login] the harness sign-ins `host.login*` drive; absent: this Host cannot sign in
 * @param {ReturnType<typeof import('./agentInstall.mjs').createInstaller>} [o.installer] the agent installs `host.install*` drive; absent: this Host cannot install an agent
 * @param {ReturnType<typeof import('./runJournal.mjs').createRunJournal>} [o.journal] the turns running now, so a Host that stops mid-turn can end them as interrupted when it is back (`interrupted`)
 * @param {(message: string) => void} [o.report] storage failures without exposing filesystem paths to clients
 * @param {string} [o.dataDir] durable chat journals, accessed only while this Host holds its data-dir lock
 * @param {ReturnType<typeof import('./browserProtocol.mjs').createBrowserProtocol>} [o.browser] the Host's browser service; without it `browser.*` is unsupported
 * @param {ReturnType<typeof import('./desktopProtocol.mjs').createDesktopProtocol>} [o.desktop] the Host's desktop (G8); without it `desktop.*` is unsupported
 * @param {ReturnType<typeof import('./toolRelay.mjs').createToolRelay> | null} [o.tools] relays the tool calls of Host-resident harnesses to the app; without it `host.toolsSync` and `host.toolResult` are unsupported
 * @param {ReturnType<typeof import('./relayLink.mjs').createRelayLinks>} [o.relay] the relay path (`host.relay*`); without it those requests are unsupported
 * @param {ReturnType<typeof import('./ownCredentials.mjs').createOwnRuns>} [o.ownRuns] the chats started on the Host's own sign-in (scheduled runs)
 * @param {ReturnType<typeof import('./chatImages.mjs').createHostImages>} [o.images] private paired-client/chat image storage @param {ReturnType<typeof import('./hostFs.mjs').createHostFs>} [o.hostFs] the folders the Host may touch: the methods that change a chat's folder (`host.gitCommit`, `host.gitDiscard`) work only inside them; without it those requests are unsupported
 * @param {(event: { kind: 'needsYou' | 'reminder' | 'paused' | 'blocked' | 'cleared', chatId: string, card?: object }) => unknown} [o.notify] the push port of the approval engine (P4 plugs in the relay); default: nothing
 * @param {() => { remindMs: number, pauseMs: number }} [o.approvalTimes] when a waiting card reminds and pauses the run (U2 supplies the owner's values); default 10 and 30 minutes
 * @param {ReturnType<typeof import('./audit.mjs').createAudit>} [o.audit] the audit record (./audit.mjs): cards asked, answered and expired, and the methods `host.auditRead` serves
 * @param {{ now?: () => number, after?: (fn: () => void, ms: number) => () => void }} [o.approvalClock] the engine's time and timers (tests drive them); default: the real ones
 * @param {() => string[]} [o.knownClients] the fingerprints of the clients this Host has paired: a deleted chat's uploads of each go
 * @param {(folder: string) => Promise<string>} [o.existingFolder] a chat's folder is still on this machine (not bound by the browsing roots): `chat.send` refuses a folder that is gone before the agent starts; without it nothing is checked
 * @param {(p: { harness: string, cwd?: string }) => Promise<unknown>} [o.commands] the slash commands and skills an agent offers for a folder (`host.commands`, ./hostCommands.mjs); without it the feature is not offered
 * @param {ReturnType<typeof import('./credentialLease.mjs').createCredentialLeases>} [o.leases] the model keys the app lends (`host.modelKey`); without it that request is unsupported
 * @param {ReturnType<typeof import('./momoHome.mjs').createMomoHome>} [o.momo] MoMo's home on this Host (its grant, record, ledger and chat rules); without it no `host.momo*` request is served and the `momo` feature is never offered @param {ReturnType<typeof import('./homeGate.mjs').createHomeGate>} [o.homeGate] what MoMo's home on another machine may do here (its allow-list, lease and modes); without it a `home` client is served nothing
 * @param {ReturnType<typeof import('./codePairService.mjs').createCodePairService>} [o.codePair] pairing by code (R2b of #5576): without it no `host.codePair.*` request is served and the feature `codePair` is never offered
 */
export function createProtocol(options) {
  const {
    runtime,
    epochs,
    guard,
    status,
    login,
    installer,
    continueHost,
    handoffs,
    browser,
    desktop,
    tools = null,
    journal,
    dataDir,
    report = console.error,
    leases,
    ownRuns,
    images,
    spend,
  } = options;
  const media = createImageProtocol({ images, epochs, continueHost, clients: options.knownClients, guard });
  const lentTo = (harness) => !!leases && lent(leases, harness); // a shared harness process (Codex's app-server, an ACP agent) runs on something the app lent
  /** The scheduled tasks this Host fires (`host.schedule*`), given after the protocol is made (they start runs through it, `keepSchedules`); until then those requests are unsupported. @type {ReturnType<typeof import('./schedules.mjs').createHostSchedules> | null} */
  let schedules = null;
  /** The chat a turn belongs to, and the text its reply has so far. @type {Map<string, { key: string, text: string, retired?: boolean }>} */
  const turns = new Map();
  /** The turns that ended, newest last, as `chatId\nturnId`: a Stop that names one of them is late and must not reach the turn that runs now. @type {Set<string>} */
  const endedTurns = new Set(); // the newest 500 are kept
  /** @param {string} chatId @param {string} turnId */
  const noteEnded = (chatId, turnId) => {
    endedTurns.add(`${chatId}\n${turnId}`);
    if (endedTurns.size > 500) endedTurns.delete(/** @type {string} */ (endedTurns.values().next().value));
  };
  /** The family a chat's events are tagged with: its harness's (`acp`, `codex`, `claude`); a runtime that does not tell runs ACP chats only. */
  const familyOf = (/** @type {string} */ chatId) => runtime.familyOf?.(chatId) ?? 'acp';
  const log = createChatLog({ dataDir, epoch: (chatId) => epochs.current(chatId), live: runtime.liveChoice, report });
  const { hub, finish, check } = log;
  // a chat's owner moved (another client's continue): the list row carries its epoch
  epochs.onAdvance((chatId) => log.index.observe(chatId, { t: 'epoch' }));
  const faults = createJournalFaults({ hub, cancel: (chatId) => runtime.host.cancel(chatId), report });
  const output = createLiveOutput(hub);
  const approvals = approvalsFor({ record, hub, runtime, epochs, familyOf, report, skipped: (c) => schedules?.needsApproval(c) }, options);
  /** The text a chat is streaming now: the chunks of one message, sent live as they come and recorded as one update when the message ends. @type {Map<string, { key: string, turnId: string, update: object, text: string }>} */
  const groups = new Map();
  /** The group ends: its whole text becomes one durable update, which replaces what was streamed under its key. @param {string} chatId */
  function flushGroup(chatId) {
    const g = groups.get(chatId);
    if (!g) return;
    groups.delete(chatId);
    finish(
      chatId,
      {
        t: 'event',
        family: familyOf(chatId),
        event: { kind: 'update', turnId: g.turnId, update: { ...g.update, content: { type: 'text', text: g.text } } },
      },
      g.key,
    );
  }
  /** One runtime event on the wire: a text chunk joins its message's group, anything else first ends the group before it. @param {string} chatId @param {any} e */
  function record(chatId, e) {
    if (!e || log.deleted(chatId)) return;
    const { key: _key, ...raw } = e;
    const event = raw.user ? { ...raw, user: media.project(raw.user) } : raw;
    const content = e.update?.content;
    if (
      e.kind === 'update' &&
      CHUNKS.has(e.update?.sessionUpdate) &&
      typeof content?.text === 'string' &&
      (content.type ?? 'text') === 'text'
    ) {
      const { sessionUpdate, messageId, _meta } = e.update;
      // a sub-agent's words are their own message, told with the call they belong to
      const sub = subAgentOf(e.update);
      const key = `${e.turnId}:${sessionUpdate}:${messageId ?? ''}${sub ? `:${sub}` : ''}`;
      if (groups.get(chatId)?.key !== key) flushGroup(chatId);
      const g = groups.get(chatId) ?? {
        key,
        turnId: e.turnId,
        update: { sessionUpdate, ...(messageId === undefined ? {} : { messageId }), ...(_meta === undefined ? {} : { _meta }) },
        text: '',
      };
      g.text += content.text;
      groups.set(chatId, g);
      return void hub.delta(chatId, key, {
        turnId: e.turnId,
        sessionUpdate,
        ...(messageId === undefined ? {} : { messageId }),
        ...(_meta === undefined ? {} : { _meta }),
        text: content.text,
      });
    }
    // what a running command prints is live on its card only (the finished call has the whole output)
    if (output.delta(chatId, e)) return;
    flushGroup(chatId);
    finish(chatId, { t: 'event', family: familyOf(chatId), event }, output.ended(chatId, e));
  }
  faults.listen(
    runtime.host,
    (e) => e.key ?? e.chatId ?? turns.get(e.turnId)?.key,
    (/** @type {any} */ e) => {
      const owner = e.key ?? e.chatId ?? turns.get(e.turnId)?.key;
      if ((owner && log.deleted(owner)) || log.repeats(owner, e, turns)) return;
      const changed = chatStateOf(e);
      if (changed) hub.state(changed.chatId, changed.patch);
      if (e.kind === 'turnStart') {
        turns.set(e.turnId, { key: e.key, text: '' });
        journal?.begin(e.turnId, e.key);
      }
      const turn = turns.get(e.turnId);
      const chatId = typeof e.key === 'string' ? e.key : turn?.key;
      if (e.kind === 'turnEnd' && chatId) options.momo?.turnEnded(chatId, e);
      if (turn?.retired && e.kind !== 'turnEnd') return;
      // a card opens or closes in the approval engine first: it adds the time and reason, and leaves out a close it recorded itself (null)
      if (chatId && WIRE_KINDS.has(e.kind)) record(chatId, approvals.seen(chatId, e));
      if (!turn) return;
      // the reply the turn is summed up by is the chat's own words, not a sub-agent's
      if (e.kind === 'update' && e.update?.sessionUpdate === 'agent_message_chunk' && !subAgentOf(e.update)) {
        turn.text += String(e.update.content?.text ?? '');
      } else if (e.kind === 'turnEnd') {
        noteEnded(turn.key, e.turnId);
        finish(turn.key, assistantItem(turn, log.terminal(turn.key, e.turnId).end));
        journal?.end(e.turnId);
        spend?.record(turn.key, e.usage);
        turns.delete(e.turnId);
      }
    },
    (e) => {
      const turn = turns.get(e.turnId);
      if (turn) Object.assign(turn, { retired: true });
    },
  );
  const assertAlive = (chatId) => {
    if (log.deleted(chatId)) throw new HostRefusal('session_journal_deleted', 'This chat was deleted from this machine.');
  };
  const effects = createChatEffects({
    runtime,
    handoffs,
    finish,
    record,
    endedTurns,
    images,
    tools,
    check,
    faults,
    approvals,
    credentials: ownRuns?.chatCredentials,
    report,
    state: hub.state,
    existingFolder: options.existingFolder,
    ...(dataDir ? { assertAlive } : {}),
  });
  const startOnParent = sideChatStart({ epochs, continueHost, log, runtime, policy: options.policy, report });
  const { handlers, effects: moreEffects, veil, visible, chatVeil } = loadHandlers({ ...options, log, epochs });
  Object.assign(effects, moreEffects);
  const forgetting = { log, runtime, ownRuns, approvals, spend, groups, output, turns, journal, tools, images, handoffs, guard };
  effects['chat.remove'] = createChatRemoval({ ...forgetting, clients: options.knownClients, report });

  /** The continue methods go to the continue Host directly: the epoch guard would refuse the retry of a commit whose reply was lost. @type {Record<string, (p: any) => unknown>} */
  const continues = {
    'chat.prepareContinue': (p) => continueHost?.prepare(p),
    'chat.commitContinue': (p) => continueHost?.commit(p),
    'chat.release': (p) => continueHost?.release(p),
  };

  return {
    awaiting: (chatId) => approvals.awaiting(chatId),
    /** The scheduled tasks this Host keeps (./schedules.mjs hostSchedulesFor), once they exist. @param {ReturnType<typeof import('./schedules.mjs').createHostSchedules>} kept */
    keepSchedules(kept) {
      schedules = kept;
    },
    /**
     * A scheduled run this Host fires itself (./schedules.mjs): its chat starts as one an app starts, at epoch 0, so the app that adopts it later follows it at that epoch.
     * @param {{ chatId: string, task: import('../../shared/host/hostSchedules.mjs').WireTask }} p
     */
    startScheduled({ chatId, task }) {
      spend?.check(chatId);
      options.policy?.checkScheduled({ harness: task.harness });
      approvals.scheduled(chatId, task.onApproval);
      if (task.harness === 'claude') ownRuns?.add(chatId);
      else if (lentTo(task.harness))
        return Promise.reject(
          new Error(`${agentLabel(task.harness)} is running on a sign-in the app lent; a scheduled run uses this machine's own sign-in.`),
        );
      return effects['chat.start']({
        chatId,
        epoch: 0,
        key: crypto.randomUUID(),
        harness: isHostFamily(task.harness) ? task.harness : `acp:${task.harness}`,
        text: task.prompt,
        cwd: task.cwd,
        projectId: task.projectId ?? null,
        ...pickedOf(task),
      });
    },
    chatState: (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ patch) => hub.state(chatId, patch),
    /** A chat request the Host makes itself (MoMo's routine runs, their reports, a stop): at the chat's own epoch, under a key of its own. @param {string} method @param {{ chatId: string, [k: string]: unknown }} p */
    asHost: (method, p) => effects[method]({ epoch: epochs.current(p.chatId), key: crypto.randomUUID(), ...p }),
    /** The Host's status: the `host.status` answer, and the line `status` the CLI and the app's heartbeat ask. There is one producer of it. */
    status,
    /**
     * Turns a Host that stopped without ending them left running: each ends for the chat's clients as cancelled, with the reason, in the log a client reads when it subscribes.
     * @param {[turnId: string, chatId: string][]} left
     */
    interrupted(left) {
      return faults.recover(left, (turnId, chatId) => {
        if (!log.deleted(chatId)) {
          closeCutOffCards({ log, approvals, chatId, turnId, record });
          recoverTurn(log, chatId, turnId, record, INTERRUPTED);
        }
        noteEnded(chatId, turnId);
        journal?.end(turnId);
      });
    },
    /** One connection; identity is trusted server authentication state, never request data. @param {(message: object) => void} rawEmit @param {() => string | null} [identity] @param {{ principal?: () => import('./hostClients.mjs').Principal | null, clients?: ReturnType<typeof import('./hostClients.mjs').createHostClients> }} [who] the trusted standing of this connection's client (set by the server at `host.pair` or `host.auth`, never by a request) and the client table */
    connection(rawEmit, identity = () => null, who = {}) {
      const { emit, wrap } = chatVeil(rawEmit, who);
      const rules = ruleGate(options, who);
      const imageClient = media.connection(identity);
      /** @type {{ minor: number, features: string[] } | null} */
      let agreed = null;
      /** @type {Map<string, { silent: boolean, unsubscribe: (() => void) | null }>} */
      const subs = new Map();
      const tabs = browser?.connection(emit);
      const seat = desktop?.connection();
      /** What the connection's handlers keep going (a watch of the chat list), ended with it. @type {Set<() => void>} */
      const ends = new Set();
      const app = tools?.attach(emit, (chatId) => epochs.current(chatId), identity);
      return wrap({
        /** @param {string} method @param {unknown} raw @returns {Promise<any>} */
        async call(method, raw) {
          const veiled = veil(method, who.principal?.(), raw);
          let params = parseParams(method, veiled instanceof Promise ? await veiled : veiled);
          if (method === 'host.hello') {
            const offered = helloParams({ switching: !!runtime.switching, continueFamilies: !!continueHost?.takesFamilies });
            offered.features = offeredFeatures(offered.features, options);
            offered.features = visible(offered.features, who.principal?.());
            agreed = negotiate(offered, params);
            // the chats the app moved away while this Host was gone: this Host poisons its copies and says which
            const continued = continueHost && params.moved.length > 0 ? await continueHost.acceptHello(params.moved) : null;
            // the surfaces this Host declares ride on its hello, so the app knows them from the first answer
            return {
              ...offered,
              capabilities: capabilitiesOf(options.capabilities ? options.capabilities() : (await status()).capabilities),
              agreed,
              ...(continued ? { continued } : {}),
            };
          }
          if (!agreed) throw new HelloRequiredError();
          requireFeatures(method, agreed, params);
          if (params.chatId && method !== 'chat.remove' && log.deleted(params.chatId))
            throw new HostRefusal('session_journal_deleted', 'This chat was deleted from this machine.');
          params = imageClient.prepare(method, params);
          if (method === 'chat.image') return imageClient.read(params);
          if (method === 'chat.attach') return imageClient.upload(params);
          // a chat that is not ACP's is served only to an end that tells its events from ACP's
          if (FAMILY_GATED.has(method))
            requireFamily(method === 'chat.start' ? harnessFamily(params.harness) : familyOf(params.chatId), agreed);
          if (method === 'host.status') return status(params);
          if (method === 'host.pending') return approvals.pending();
          if (Object.hasOwn(continues, method)) {
            if (!continueHost) throw new UnsupportedError('This host cannot continue a chat from another host.');
            return continues[method](params);
          }
          if (CLIENT_METHODS.includes(method)) {
            const caller = who.principal?.();
            if (!who.clients || !caller) throw new UnsupportedError('This host does not keep a client table.');
            return who.clients.call(method, params, caller);
          }
          if (method === 'host.modelKey') {
            if (!leases) throw new UnsupportedError('This host cannot hold a key.');
            return leases.set(params.harness, params.key);
          }
          if (method === 'host.scheduleSync' || method === 'host.scheduleRuns') {
            const kept = schedules;
            if (!kept) throw new UnsupportedError('This host cannot keep scheduled tasks.');
            return method === 'host.scheduleSync' ? kept.sync(params.tasks) : kept.runs(params.after);
          }
          if (method === 'host.orgLease') {
            if (!leases) throw new UnsupportedError('This host cannot hold organization access.');
            return leases.setOrg(params, Date.now());
          }
          if (
            method === 'host.login' ||
            method === 'host.loginStatus' ||
            method === 'host.loginCancel' ||
            method === 'host.loginInput' ||
            method === 'host.logout'
          ) {
            if (!login) throw new UnsupportedError('This host cannot sign in to a harness.');
            if (method === 'host.login') return login.start(params);
            if (method === 'host.logout') return login.logout(params.harness);
            if (method === 'host.loginInput') return { accepted: login.input(params.harness, params.text) };
            return method === 'host.loginStatus' ? login.status(params.harness) : login.cancel(params.harness);
          }
          if (Object.hasOwn(handlers, method))
            return /** @type {any} */ (handlers)[method](params, who.principal?.()?.kind ?? 'desktop', who, emit, ends);
          if (method === 'host.install' || method === 'host.installStatus' || method === 'host.installCancel') {
            if (!installer) throw new UnsupportedError('This host cannot install an agent.');
            if (method === 'host.install') return installer.start(params);
            return method === 'host.installStatus' ? installer.status(params.harness) : installer.cancel(params.harness);
          }
          if (method === 'host.toolsSync' || method === 'host.toolResult') {
            if (!app) throw new UnsupportedError('This host cannot relay tool calls.');
            if (method === 'host.toolsSync') return app.sync(params.tools);
            // an answer for a chat that moved on is refused; unlike a chat write it never advances the epoch
            if (params.epoch !== epochs.current(params.chatId))
              throw new StaleEpochError(params.chatId, params.epoch, epochs.current(params.chatId));
            return app.result(params);
          }
          if (method.startsWith('desktop.')) {
            if (!seat) throw new UnsupportedError('This host has no desktop.');
            return seat.call(method, params);
          }
          if (method.startsWith('browser.')) {
            if (!tabs) throw new UnsupportedError('This host has no browser.');
            return tabs.call(method, params);
          }
          if (method === 'chat.history') {
            epochs.admit(params.chatId, params.epoch);
            requireFamily(familyOf(params.chatId), agreed);
            return log.history(params);
          }
          if (method === 'chat.subscribe') {
            epochs.admit(params.chatId, params.epoch);
            // this app can run the chat's tool calls only if it has none (a watcher never takes them from the app that drives the chat)
            app?.watch(params.chatId);
            // a request at the epoch a prepared chat waits for makes this Host its owner; reading a chat that moved is still allowed
            continueHost?.touch(params.chatId, params.epoch);
            // a second subscribe to the chat replaces the first without telling the client it closed
            const prev = subs.get(params.chatId);
            if (prev) {
              prev.silent = true;
              prev.unsubscribe?.();
            }
            /** @type {{ silent: boolean, unsubscribe: (() => void) | null }} */
            const rec = { silent: false, unsubscribe: null };
            subs.set(params.chatId, rec);
            const modern = agreed.features.includes(STREAM2_FEATURE);
            const handle = hub.subscribe(params.chatId, {
              fromRev: params.fromRev,
              generation: params.generation,
              send: (sent) => {
                // an end that has not agreed on `stream2` is not told what it would misread
                const frame = modern ? sent : withoutStream2(sent);
                if (!frame) return true;
                // a frame over what one message may carry is cut to fit (every revision is still told); one that cannot be cut ends the stream with a reason the app reads, never a silent hole
                const fitted = fitFrame(frame, MAX_FRAME - 4096);
                if (fitted) return emit({ event: 'frame', chatId: params.chatId, frame: fitted }), true;
                queueMicrotask(() => {
                  if (rec.silent) return;
                  rec.silent = true;
                  rec.unsubscribe?.();
                  if (subs.get(params.chatId) === rec) subs.delete(params.chatId);
                  emit({ event: 'closed', chatId: params.chatId, reason: 'too_large' });
                });
                return true;
              },
              close: (reason) => {
                if (rec.silent) return;
                if (subs.get(params.chatId) === rec) subs.delete(params.chatId);
                emit({ event: 'closed', chatId: params.chatId, reason });
              },
            });
            rec.unsubscribe = handle.unsubscribe;
            return { subscribed: true };
          }
          const ruled = rules(method, params);
          if (ruled) return ruled.value;
          // a chat that moved, was poisoned, or is mid-commit takes no write (before the guard, so a refusal is not remembered as the key's answer)
          continueHost?.gate(params.chatId, params.epoch);
          const by = who.principal?.() ? { by: who.principal() } : {};
          const { replayed, result } = await guard({ chatId: params.chatId, epoch: params.epoch, key: params.key, method, ...by }, () =>
            startOnParent({ ...params, ...by }, effects[method]),
          );
          // started in an earlier life of this Host and never settled: not run again, and not an answer the app may take for a delivery
          if (result === INDETERMINATE)
            throw new HostRefusal(
              'request_interrupted',
              'The host restarted while this was being sent. Check the chat, then send it again.',
            );
          // a send makes this app the chat's tool owner, if it announced tools
          if (method === 'chat.send' || method === 'chat.start') app?.send(params.chatId);
          return { replayed, result };
        },
        /** The client went away: its streams end, the chats go on. */
        close() {
          imageClient.close();
          for (const s of subs.values()) s.unsubscribe?.();
          subs.clear();
          tabs?.close();
          seat?.close();
          app?.detach();
          for (const end of ends) end();
        },
      });
    },
  };
}

/** The error a failed call becomes on the wire: a message safe to show and the codes the client acts on. @param {unknown} e */
export function wireError(e) {
  const x = /** @type {any} */ (e);
  return {
    error: String(e instanceof Error ? e.message : e),
    ...(typeof x?.code === 'string' ? { code: x.code } : {}),
    ...(typeof x?.current === 'number' ? { current: x.current } : {}),
    ...(x?.details && typeof x.details === 'object' ? { details: x.details } : {}),
    ...(Array.isArray(x?.missing) && x.missing.length > 0 ? { missing: x.missing } : {}),
  };
}
