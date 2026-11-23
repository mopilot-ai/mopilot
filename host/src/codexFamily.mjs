// Codex on a Host: the app's CodexAdapter over a `codex app-server` this Host starts with its own Codex sign-in (nothing of the Mac's ~/.codex is copied). A chat recorded on another credential than the main app-server runs on gets an app-server of its own for it (H3, #4667). The factory host/src/sessions.mjs calls for `families.codex`; it also refuses a chat up front when the binary is missing or signed out, starts the thread of a new chat, and answers its approval cards.
import { steeredEvent } from './steeredEvent.mjs';
import { createRequire } from 'node:module';
import { SchemaError } from '../../shared/remote/schema.mjs';
import { HostRefusal } from './hostFs.mjs';
import { probeHarness } from './harnessState.mjs';
import { which as whichBin } from './acp.mjs';
import { createCodexTools } from './codexTools.mjs';
import { createCodexGoals } from './codexGoals.mjs';
import { isAsk, replyOf, unanswered } from './codexAsk.mjs';
import { approvalAnswer, createCodexStream, isApproval } from './codexStream.mjs';
import { CODEX_PROVIDER, CODEX_TOKEN_ENV } from '../../shared/host/orgAccess.mjs';
import { clampToCeiling } from '../../shared/host/policy.mjs';
import { createCodexChatStart, recordNewCodexThread } from './codexChatStart.mjs';

const require = createRequire(import.meta.url);
const { CodexAdapter, permissionParams } = require('../../electron/harness/codex.cjs');
const { AppServer } = require('../../electron/harness/codexProcess.cjs');
const { IsolatedServer } = require('../../electron/harness/codexIsolatedServer.cjs');
const { CodexLanes } = require('../../electron/harness/codexLanes.cjs');

/** How long a positive `codex login status` is trusted: a send does not spawn the CLI each time. */
const SIGNED_IN_TTL_MS = 60_000;
/** Codex keeps its credentials in memory only, so a key it is told is never written to auth.json. */
const EPHEMERAL_STORE = ['-c', 'cli_auth_credentials_store="ephemeral"'];
/**
 * The arguments a Codex started for an organization lease gets: the customer's gateway as a model provider of its own, whose token Codex reads
 * from CODEX_TOKEN_ENV in its env. Its credential store is in memory, so neither the user's auth.json nor their own login on this machine is touched.
 * @param {string} baseUrl the gateway's OpenAI-style base URL (shared/host/orgAccess.mjs baseUrlOf: no quote can be in it)
 */
export const orgProviderArgs = (baseUrl) => [
  ...EPHEMERAL_STORE,
  '-c',
  `model_providers.${CODEX_PROVIDER}={ name = "Organization gateway", base_url = "${baseUrl}", env_key = "${CODEX_TOKEN_ENV}", wire_api = "responses" }`,
  '-c',
  `model_provider="${CODEX_PROVIDER}"`,
];
/** On a thread/start's params (never sent: a symbol key): the credential whose app-server the thread starts on, when it is not the main one's. */
export const LANE = Symbol('codex credential lane');
/** The credentials Codex runs a chat on, each in an app-server of its own when it is not what the main one runs on. */
const SOURCES = /** @type {const} */ (['own', 'key', 'org']);
/** How long a credential's app-server may sit with no turn and no traffic before it is let go, and how often that is looked at. */
export const LANE_IDLE_MS = 10 * 60_000;
const LANE_CHECK_MS = 60_000;
/** How long Codex may take to take the key. */
const LOGIN_MS = 15_000;
/** The permission modes a Codex turn can run under (electron/harness/codexParams.cjs permissionParams), and `plan`: the collaboration mode it plans in, on the mode it was entered from. */
const PERMISSIONS = new Set(['default', 'read-only', 'auto-review', 'full-access', 'plan']);
/** How long the model list is trusted. */
const MODELS_TTL_MS = 60_000;
/** What a Host says to a request it cannot put to a person (a tool asking for input, an elicitation). */
const NOT_SUPPORTED = 'This host cannot ask you that yet.';

export const NOT_INSTALLED =
  "Codex isn't installed on this Host. Install it (npm install -g @openai/codex), then run `mopilot-host login codex` on it.";
export const NOT_SIGNED_IN = "Codex isn't signed in on this Host. Run `mopilot-host login codex` on it.";
/** What a chat is told when its credential changed while its thread is open on the old one: it keeps that one for as long as the chat is open on it. */
const SWITCHED_WORDS = {
  own: "This chat is open on another sign-in, so it can't use this machine's own login yet. Start a new chat to use it.",
  key: "This chat is open on another sign-in, so it can't use the key from your Mac yet. Start a new chat to use it.",
  org: "This chat is open on another sign-in, so it can't use your organization's access yet. Start a new chat to use it.",
};
/** Codex runs one process for every chat: a message for another organization identity waits until the running turn ends, never borrowing its lease. */
export const IDENTITY_BUSY = "This machine's Codex is running another person's organization chat. This message sends when that turn ends.";

/**
 * @param {object} [o]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {(name: string, env: NodeJS.ProcessEnv) => string | null} [o.which] finds a binary on the PATH
 * @param {any} [o.server] the app-server process (tests give a fake); by default `codex app-server` found on the PATH
 * @param {typeof probeHarness} [o.probe] whether the Host's own Codex login is good
 * @param {() => number} [o.now]
 * @param {ReturnType<typeof import('./tools.mjs').createHostTools> | null} [o.tools] the Host's tool channel: each thread is given MoPilot's tools through it (the app's, relayed)
 * @param {{ sourceOf: (chatId: string) => 'own' | 'key' | 'org' | null } | null} [o.credentials] where each chat's credential is kept (./chatCredentials.mjs): a chat on a credential the main app-server is not running on gets an app-server of its own for it
 * @param {(...a: any[]) => any} [o.spawn] starts each app-server's process (tests give a fake)
 * @param {{ loginKey: (harness: string) => string | null, orgLease?: (harness: string) => { identity: string, token: string, gateways: { openai?: string } } | null, onChange?: (fn: (harness: string) => void) => unknown } | null} [o.leases] the key the app lent for Codex (./credentialLease.mjs): with one, the app-server starts with an ephemeral credential store and is told the key after initialize, so it never reaches the disk or the command line
 * @returns {((ctx: import('./sessions.mjs').FamilyContext) => { codex: any, check: (chatId?: string) => Promise<void>, prepare: ReturnType<typeof createCodexChatStart>, revive: (chatId: string) => Promise<void>, setPermission: (chatId: string, value: string) => Promise<void>, goal: (p: { chatId: string, action: string, human?: boolean, tokens?: number | null, objective?: string }) => Promise<unknown>, models: () => Promise<{ id: string, name: string, default: boolean, efforts: string[] }[]>, permit: (p: { requestId: string, optionId?: string, form?: { action: string, content?: object } }) => boolean, close: () => void, signedOut: () => void, reapLanes: (at?: number) => number }) & { models: () => Promise<{ id: string, name: string, default: boolean, efforts: string[] }[]>, running: () => any, signedOut: (harness: string) => void }}
 */
export function createCodexFamily({
  env = process.env,
  which = whichBin,
  server,
  probe = probeHarness,
  now = Date.now,
  tools = null,
  leases = null,
  credentials = null,
  spawn,
} = {}) {
  /** The family built for the Host's sessions, once it is: `host.status` asks it for the models, a sign-out tells it. @type {{ models: () => Promise<{ id: string, name: string, default: boolean, efforts: string[] }[]>, signedOut: () => void } | null} */
  let current = null;
  const make = (/** @type {import('./sessions.mjs').FamilyContext} */ ctx) => {
    const controller = () => ctx.controller();
    /** Whether the running app-server was started for a lent key (an ephemeral credential store). */
    let startedKeyed = false;
    /** The organization lease the running app-server was started with: its token is in that process's env, so a new one needs a new process. @type {{ identity: string, token: string, gateways: { openai?: string } } | null} */
    let startedOrg = null;
    const findBin = () => {
      const bin = which('codex', env);
      if (!bin) throw new HostRefusal('harness_not_configured', NOT_INSTALLED);
      return bin;
    };
    const appServer =
      server ??
      new AppServer({
        spawn,
        findBin,
        // args() runs first (codexProcess.cjs start): the env carries the token of the lease the args were made for
        env: () => (startedOrg ? { ...env, [CODEX_TOKEN_ENV]: startedOrg.token } : env),
        args: () => {
          const org = leases?.orgLease?.('codex') ?? null;
          startedOrg = org?.gateways.openai ? org : null;
          if (startedOrg) return (startedKeyed = false), orgProviderArgs(/** @type {string} */ (startedOrg.gateways.openai));
          // the mode is the process's for its whole life: one started without a key is never told one (it would write it to auth.json)
          startedKeyed = !!leases?.loginKey('codex');
          return startedKeyed ? EPHEMERAL_STORE : [];
        },
      });
    /** The credential the main app-server runs on: what it was started for, or while it is stopped, what its next start will use. */
    const mainSource = () => {
      if (appServer.proc || appServer.pending) return startedOrg ? 'org' : startedKeyed ? 'key' : 'own';
      return leases?.orgLease?.('codex')?.gateways.openai ? 'org' : leases?.loginKey('codex') ? 'key' : 'own';
    };
    /** The credential whose own app-server runs a chat, or null for the main one: a chat on what the main one runs on needs none. @param {string} chatId */
    const laneOf = (chatId) => {
      const source = credentials?.sourceOf(chatId) ?? null;
      return source && source !== mainSource() ? source : null;
    };
    /** The credential each chat's thread was last sent to in this process: while that app-server runs, the thread is loaded in it and cannot be moved under a chat. @type {Map<string, 'own' | 'key' | 'org'>} */
    const ranOn = new Map();
    /** Whether the app-server a credential runs in is up now: the main one runs on `mainSource()`, the others each in their lane. @param {string} source */
    const runsNow = (source) => (source === mainSource() ? !!(appServer.proc || appServer.pending) : !!lanes?.lanes.get(source)?.running());
    // an app-server for each credential, started with its first thread: a chat on the machine's own login runs beside one on a key the app lent, neither using the other's
    /** @type {InstanceType<typeof CodexLanes> | null} */
    let lanes = null;
    if (!server && credentials) {
      lanes = new CodexLanes(appServer);
      for (const source of SOURCES) {
        /** @type {{ identity: string, token: string, gateways: { openai?: string } } | null} */
        let org = null;
        const lane = new IsolatedServer({
          main: appServer,
          server: new AppServer({
            spawn,
            findBin,
            // args() runs first: the env carries the token of the lease the args were made for
            env: () => (source === 'org' && org ? { ...env, [CODEX_TOKEN_ENV]: org.token } : env),
            // a credential that is gone leaves its process with an empty store, never the machine's own login
            args: () => {
              if (source === 'own') return [];
              org = source === 'org' ? (leases?.orgLease?.('codex') ?? null) : null;
              const gateway = org?.gateways.openai;
              return gateway ? orgProviderArgs(gateway) : EPHEMERAL_STORE;
            },
          }),
          owns: (threadId) => laneOf(controller().chatOf(threadId)) === source,
          prepare: () => undefined,
          // a key is told to its process after initialize, as the main one is, never on its command line
          login: async () => {
            const apiKey = source === 'key' ? leases?.loginKey('codex') : null;
            return apiKey ? { type: 'apiKey', apiKey } : null;
          },
          prefix: `lane-${source}:`,
          now,
          follows: false,
          attach: false,
          mine: (obj) => obj.params?.[LANE] === source || lane.holds(obj.params?.threadId),
        });
        lanes.add(source, lane);
      }
    }
    /** Ends the lanes that have run nothing for LANE_IDLE_MS: a credential nobody is using keeps no process, and its threads load again with the next message. @param {number} [at] */
    const reapLanes = (at = now()) => lanes?.reapIdle(LANE_IDLE_MS, at) ?? 0;
    const reaper = lanes ? setInterval(reapLanes, LANE_CHECK_MS) : null;
    reaper?.unref();
    const stream = createCodexStream({
      chatOf: (threadId) => {
        const chatId = controller().chatOf(threadId);
        // only a chat this Host holds and whose current segment this thread is: a helper thread or a sub-agent has no stream of its own
        return ctx.state.has(chatId) && controller().isCurrentSource(chatId, { kind: 'codex', key: threadId }) ? chatId : null;
      },
      emit: ctx.emit,
    });
    /** Answer a request the Host cannot put to a person, so the turn is not left waiting on it. @param {{ id: number | string }} msg */
    const refuse = (msg) => appServer.send({ id: msg.id, error: { code: -32601, message: NOT_SUPPORTED } });

    // where sage-mcp connects, known once the Host's tool socket is listening (check() opens it before any chat's first request)
    /** @type {string | null} */
    let toolSocket = null;
    const codexTools = tools?.available
      ? createCodexTools({
          sessions: tools.sessions,
          socketPath: () => toolSocket,
          pidOf: (params) => appServer.pidFor(params),
          // a sub-agent thread's calls are its parent chat's, so Stop there reaches them
          chatOf: (threadId) => controller().requestChat(threadId),
        })
      : null;

    const adapter = new CodexAdapter({
      server: appServer,
      tools: codexTools,
      nativeOf: (/** @type {string} */ chatId) => controller().ref(chatId),
      chatOf: (/** @type {string} */ id) => controller().chatOf(id),
      state: ctx.state,
      // the model, effort and permission a chat was given (a mode set by `chat.permit` or chat.start); the message's own pick wins over them
      chatConfig: (/** @type {string} */ chatId) => clampToCeiling(ctx.chats.get(chatId)?.meta?.config ?? null, ctx.ceiling?.()),
      probe: null,
      clientInfo: { name: 'mopilot_host', title: 'MoPilot Host', version: '' },
      log: () => undefined,
      // timestamped, so a line can be laid beside a client's trace
      stopLog: (/** @type {string} */ line) => ctx.log(`${new Date().toISOString()} ${line}`),
      emit: (/** @type {any} */ e) => {
        // the adapter's own start of a turn: the notification usually names it first, and the stream takes it once
        // it carries the text of the message that started the turn: the user message of the turn's start (#3599)
        if (e.kind === 'turnStarted')
          stream.started(
            e.chatId,
            e.turnId,
            typeof e.text === 'string' ? e.text : undefined,
            e.human === true,
            ctx.userOf?.(e.chatId, e.clientId),
          );
        // a message the app-server took into the running turn: told in that turn, as the message it is
        else if (e.kind === 'steered')
          ctx.emit(
            steeredEvent({
              chatId: e.chatId,
              turnId: e.turnId,
              clientId: e.clientId,
              text: e.text,
              user: ctx.userOf?.(e.chatId, e.clientId),
            }),
          );
        // the chat was titled: told on the stream's state lane
        else if (e.kind === 'threadName') ctx.emit(e);
        // a goal the adapter set (its objective sent as a message): the chat shows it from the store
        else if (e.kind === 'goal' && ctx.state.has(e.chatId)) ctx.state.patch(e.chatId, { goal: e.goal ?? null });
      },
      observe: (/** @type {any} */ msg) => {
        if (msg.id != null && msg.method) {
          const thread = msg.params?.threadId ?? msg.params?.conversationId;
          // a sub-agent's thread asks in the chat of the thread that spawned it (the controller's own rule for the app's cards)
          const chatId = thread ? controller().requestChat(thread) : null;
          const ask = isAsk(msg.method);
          if (!(isApproval(msg.method) || ask) || !chatId || !ctx.state.has(chatId)) return refuse(msg);
          controller().onCodexMessage(msg);
          const sub = thread !== controller().ref(chatId).key;
          // the controller shows the card on the chat's state; the stream shows it to the clients (a question this Host cannot ask is answered as declined, so the turn goes on)
          if (!ctx.state.get(chatId).approvals.some((/** @type {any} */ a) => a.id === msg.id)) return refuse(msg);
          if (!ask) return void stream.request(msg, chatId, sub);
          if (!stream.ask(msg, chatId, sub)) {
            controller().onCodexOutgoing({ id: msg.id });
            appServer.send({ id: msg.id, result: unanswered(msg.method) });
          }
          return;
        }
        controller().onCodexMessage(msg);
        stream.notification(msg);
        // the goal's own changes (the agent met it, a budget ran out, a client changed it) reach the state lane as the app tells them to its windows
        if (msg.method === 'thread/goal/updated' || msg.method === 'thread/goal/cleared') {
          const chatId = controller().chatOf(msg.params?.threadId);
          if (ctx.state.has(chatId))
            ctx.state.patch(chatId, { goal: msg.method === 'thread/goal/updated' ? (msg.params.goal ?? null) : null });
        }
      },
      onExit: () => {
        const paused = controller().onCodexExit();
        stream.exited('Codex quit while working.');
        // the goals the exit paused stay paused until Codex is back (the adapter resumes the pause then)
        return paused;
      },
      onStopped: (/** @type {string} */ chatId, /** @type {string} */ turnId) => controller().codexStopped(chatId, turnId),
    });

    // after initialize, a process started for a key is told it (over its stdin, never argv) before anything else is asked of it
    const initialize = adapter.initialize.bind(adapter);
    /** @type {Promise<any> | null} */
    let initOf = null;
    /** @type {Promise<any> | null} */
    let loggedIn = null;
    adapter.initialize = () => {
      const p = initialize();
      if (p !== initOf) {
        initOf = p;
        loggedIn = p.then(async (r) => {
          const key = startedKeyed ? leases?.loginKey('codex') : null;
          if (key) await adapter.call('account/login/start', { type: 'apiKey', apiKey: key }, LOGIN_MS);
          return r;
        });
      }
      return /** @type {Promise<any>} */ (loggedIn);
    };
    /** A key or lease lent, changed, renewed or taken back reaches Codex with its next process: the running one is stopped once no Codex turn runs, never mid-turn. */
    let restartWanted = false;
    const busyNow = () => ctx.state.all().some((/** @type {string} */ id) => ['running', 'awaitingUser'].includes(ctx.state.get(id).turn));
    /** @param {{ refuse?: boolean }} [o] refuse: a message about to go out (check), which another identity's running turn refuses; a lease change only notes it */
    const restartIfIdle = ({ refuse = false } = {}) => {
      if (!restartWanted) return;
      const busy = busyNow();
      if (busy) {
        // a turn of the identity the process runs for goes on; another identity's message is refused rather than sent with its lease
        const now = leases?.orgLease?.('codex')?.identity;
        if (refuse && startedOrg && now && now !== startedOrg.identity) throw new HostRefusal('org_identity_busy', IDENTITY_BUSY);
        return;
      }
      restartWanted = false;
      signedAt = -Infinity;
      models = null;
      appServer.stop();
    };
    leases?.onChange?.((harness) => {
      if (harness !== 'codex') return;
      restartWanted = true;
      restartIfIdle();
    });

    let signedAt = -Infinity;
    /** @type {{ at: number, list: { id: string, name: string, default: boolean, efforts: string[] }[] } | null} */
    let models = null;
    const api = {
      codex: adapter,
      /** What the goal bar does to the chat's goal (`chat.goal`), as the app does on this Mac: the goal now. */
      goal: createCodexGoals({ adapter, state: ctx.state }),
      /** Refuse a chat before anything is queued: Codex is not installed here, or its login is not good. */
      async check(chatId) {
        if (!which('codex', env)) throw new HostRefusal('harness_not_configured', NOT_INSTALLED);
        if (tools?.available && !toolSocket) toolSocket = await tools.mcp.socket.listen();
        restartIfIdle({ refuse: true });
        // that restart forgets a thread no message recorded: a chat on one gets another before its message goes (#5160)
        if (chatId !== undefined && ctx.chats.records.has(chatId)) await api.revive(chatId);
        // a chat whose credential was changed while its thread is loaded in the app-server of the old one is refused, never run on a process that does not hold it (or on the old one while the app says the new)
        const want = chatId === undefined ? null : (credentials?.sourceOf(chatId) ?? null);
        if (chatId !== undefined && want) {
          const ran = ranOn.get(chatId);
          if (ran && ran !== want && runsNow(ran))
            throw new HostRefusal('credential_unavailable', SWITCHED_WORDS[want], { cause: 'other_signin' });
          ranOn.set(chatId, want);
        }
        // a lent key or an organization lease needs no sign-in here, unless the chat runs on the machine's own login
        const own = chatId !== undefined && credentials?.sourceOf(chatId) === 'own';
        if (!own && (leases?.loginKey('codex') || leases?.orgLease?.('codex')?.gateways.openai)) return;
        if (now() - signedAt < SIGNED_IN_TTL_MS) return;
        // refused as signed out only when the CLI said so; one that could not answer (null) lets the send go on and is asked again next time
        const answer = await probe('codex', { env, which });
        if (answer === false) throw new HostRefusal('harness_not_configured', NOT_SIGNED_IN);
        if (answer === true) signedAt = now();
      },
      prepare: createCodexChatStart(adapter, ctx, (chatId) => {
        const lane = laneOf(chatId);
        return lane ? { [LANE]: lane } : {};
      }),
      /**
       * A chat whose thread no message had recorded when Codex quit (an update, a lent key renewed, a crash) has no thread any more, and a resume of it is "no rollout found" (#5160): it gets a new one, recorded as the chat's, before its message goes.
       * Nothing was said on the lost thread, so nothing is lost with it; a continue's handoff goes in front of the message as it would have.
       * @param {string} chatId
       */
      async revive(chatId) {
        const ref = controller().ref(chatId);
        if (ref.kind !== 'codex' || !adapter.lostUnrecorded.has(ref.id)) return;
        const rec = ctx.chats.record(chatId);
        const params = {
          cwd: adapter.lostUnrecorded.get(ref.id) ?? ctx.paths.dataDir,
          ...permissionParams('default'),
          ephemeral: false,
          ...(laneOf(chatId) ? { [LANE]: laneOf(chatId) } : {}),
        };
        /** @type {string[]} */
        const claimed = [];
        try {
          const started = await adapter.startThread(params, {
            onThread: (/** @type {string} */ id) => (claimed.push(id), controller().claim(id, chatId)),
          });
          await recordNewCodexThread(adapter, started, (nativeId) => {
            const segments = rec.segments.map((/** @type {any} */ s, /** @type {number} */ i) =>
              i === rec.segments.length - 1 ? { ...s, nativeId } : s,
            );
            if (!ctx.chats.commit({ ...rec, segments })) throw new Error("Couldn't record the chat's new thread.");
          });
          adapter.lostUnrecorded.delete(ref.id);
          controller().invalidate();
        } finally {
          for (const id of claimed) controller().unclaim(id, chatId);
        }
      },
      /**
       * The permission mode the chat's later turns run under. A message's own pick still wins. `plan` is the plan collaboration mode: the chat keeps the mode it was in as the one its tools run under
       * (`planBasePermission`, as the app's own Codex chats do), and any other mode leaves Plan.
       * @param {string} chatId @param {string} value
       */
      async setPermission(chatId, value) {
        if (!PERMISSIONS.has(value)) throw new SchemaError("That permission mode isn't one Codex has.");
        const config = ctx.chats.get(chatId)?.meta?.config ?? {};
        const base = config.permission && config.permission !== 'plan' ? config.permission : (config.planBasePermission ?? 'default');
        ctx.chats.patchMeta(chatId, {
          config: { ...config, permission: value, ...(value === 'plan' ? { planBasePermission: base } : {}) },
        });
      },
      /**
       * The models this Host's Codex offers, for `host.status`: the app-server's own list, kept for a minute. Empty when Codex is not installed or signed in,
       * or does not answer: a status that lists none is not one that fails.
       * @returns {Promise<{ id: string, name: string, default: boolean, efforts: string[] }[]>}
       */
      async models() {
        if (models && now() - models.at < MODELS_TTL_MS) return models.list;
        try {
          await api.check();
          const found = await adapter.request('model/list', { includeHidden: false });
          const list = (found?.data ?? []).map((/** @type {any} */ m) => ({
            id: String(m.model),
            name: String(m.displayName ?? m.model),
            // the app-server's display name is the model's name with its version; absent when it names none (the validator drops one equal to the id)
            ...(typeof m.displayName === 'string' && m.displayName ? { resolvedModel: m.displayName } : {}),
            default: m.isDefault === true,
            ...(typeof m.defaultReasoningEffort === 'string' ? { defaultEffort: m.defaultReasoningEffort } : {}),
            efforts: (m.supportedReasoningEfforts ?? []).map((/** @type {any} */ e) => String(e.reasoningEffort ?? e)),
          }));
          models = { at: now(), list };
          return list;
        } catch {
          return [];
        }
      },
      /**
       * A person's answer to an approval card: the command runs, or does not. False when the card is gone (answered elsewhere, or the app-server restarted).
       * @param {{ requestId: string, optionId?: string, form?: { action: string, content?: object } }} p
       */
      permit({ requestId, optionId, form }) {
        const card = stream.card(requestId);
        if (!card) return false;
        // the controller holds the card for the current app-server only, and gives it up once; one it no longer holds is closed for every client
        if (!controller().onCodexOutgoing({ id: card.id })) {
          stream.settle(requestId);
          return false;
        }
        stream.take(requestId);
        appServer.send({
          id: card.id,
          result: card.ask
            ? replyOf({ method: card.method, ask: card.ask }, { optionId, form })
            : approvalAnswer(card.method, optionId, card.permissions),
        });
        return true;
      },
      reapLanes,
      close: () => {
        if (reaper) clearInterval(reaper);
        appServer.stop();
      },
      /** Codex was signed out here: its app-server holds the old login in memory, so it goes (the next chat starts a new one), and the login is asked again. */
      signedOut() {
        signedAt = -Infinity;
        models = null;
        appServer.stop();
      },
    };
    current = api;
    return api;
  };
  /** The models the family's Codex offers (none until the Host's sessions have built it), and the family itself, null before: the skills of a folder are read through it (./codexSkills.mjs). */
  make.models = () => (current ? current.models() : Promise.resolve([]));
  make.running = () => current;
  /** A harness was signed out on this Host: Codex's app-server lets the old login go (nothing to do before the sessions have built it, or for another harness). @param {string} harness */
  make.signedOut = (harness) => {
    if (harness === 'codex') current?.signedOut();
  };
  return make;
}
