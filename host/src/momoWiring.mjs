// What the serve entry plugs into the protocol for MoMo's home (M1 H1, H2a): the home over this Host's data dir and its own key file, MoMo's chats over its sessions, the isolation of those chats on every agent the Host runs, and what the Host's audit record and push never say of them, so the serve entry (./cli.mjs) names no MoMo module.
import { createMomoHome } from './momoHome.mjs';
import { createMomoChats } from './momoChats.mjs';
import { createMomoRows, rowsShape } from './momoRows.mjs';
import { createMomoMove } from './momoMove.mjs';
import { loadMomoServices } from './momoServices.mjs';
import path from 'node:path';
import { createFileSafeStorage } from './secretStore.mjs';
import { createEntitlementGate, entitlementModeFrom } from './momoEntitlementGate.mjs';
import { ENTITLEMENT_KEYS, REVOKED_ENTITLEMENT_KEY_IDS } from '../../shared/host/momoEntitlementKeys.mjs';
import { mapStrings } from './chatVeil.mjs';
import { registerMomoTools } from './momoTools.mjs';
import { HostRefusal } from './hostFs.mjs';
import { installMomoContext } from './momoContext.mjs';
import { createIntentRegistry, HOST_LANES } from '../../shared/momoIntents.mjs';
import { bindService, createChatSink, createCheck } from './momoSeams.mjs';
import { createMomoScheduler } from './momoScheduler.mjs';
import { createMomoRuns } from './momoRuns.mjs';
import { createNoticeModel } from './momoNoticeModel.mjs';
import { createMomoDaily, dailySettingsOf } from './momoDaily.mjs';
import { createMomoIntents } from './momoIntents.mjs';
import { scheduleRules } from '../../shared/schedule.mjs';
import rrule from 'rrule';

/** The id an audit line carries in place of a MoMo chat's. */
export const MOMO_AUDIT_ID = 'momo';

/**
 * What the Host's audit record and push notifier must not say of MoMo's chats: made before either, bound to MoMo's chats once the Host's sessions exist.
 * No push of a MoMo chat leaves except through MoMo's own (./momoPush.mjs).
 */
export function createMomoHidden() {
  /** @type {(chatId: string) => boolean} */
  let hidden = () => false;
  /** @type {(chatId: string) => boolean} */
  let momo = () => false;
  return {
    /** `isHidden`: MoMo's chats and the decoys made for callers that may not see them; `isMomo`: MoMo's own. */
    bind: (/** @type {(chatId: string) => boolean} */ isHidden, /** @type {(chatId: string) => boolean} */ isMomo = isHidden) =>
      void ((hidden = isHidden), (momo = isMomo)),
    /** An audit entry with every MoMo chat's id replaced, so the hash-chained record never carries one. @param {any} entry */
    redact: (entry) => mapStrings(entry, (s) => (hidden(s) ? MOMO_AUDIT_ID : s)),
    /**
     * The runtime the line protocol's `send` reaches, with MoMo's chats left to the versioned protocol (`send` names its chat by `key`; the line protocol's
     * `permit` and `turn` name a card and a turn, whose ids no one who may not see MoMo's chats is ever told).
     * @template {{ send: (p: any) => Promise<unknown> }} R @param {R} runtime @returns {R}
     */
    guard: (runtime) =>
      new Proxy(runtime, {
        get: (target, key) =>
          key === 'send'
            ? (/** @type {any} */ p) =>
                hidden(p?.key) ? Promise.reject(new HostRefusal('momo_chat_fixed', "That chat can't be reached this way.")) : target.send(p)
            : Reflect.get(target, key),
      }),
    /** The push port: an ordinary chat's card goes the way it always did, a MoMo chat's only through MoMo's own push (./momoPush.mjs: the fixed title, opaque handles, MoMo's quiet hours), and nothing without one. @param {(event: any) => unknown} notify @param {(event: any) => unknown} [momoNotify] */
    notify: (notify, momoNotify) => (/** @type {any} */ event) =>
      momo(event?.chatId) ? momoNotify?.(event) : hidden(event?.chatId) ? undefined : notify(event),
  };
}

/** The gate that backs a MoMo grant with the account's server-signed entitlement for this Host (#5474); its mode (`MOPILOT_MOMO_ENTITLEMENT`) is `off` until the owner moves Hosts on. @param {string} hostId this Host's own id @param {Record<string, string | undefined>} env @param {(message: string) => void} [report] @param {import('../../shared/host/momoEntitlement.mjs').TrustedKey[]} [keys] the pinned public keys (a test's own) */
export const entitlementGateFor = (hostId, env, report = () => undefined, keys = ENTITLEMENT_KEYS) => {
  const mode = entitlementModeFrom(env);
  if (mode === 'required' && keys.length === 0)
    report('MoMo entitlements are required but this Host trusts no key: MoMo stays off until the app is updated.');
  return createEntitlementGate({ hostId, keys, revoked: REVOKED_ENTITLEMENT_KEY_IDS, mode, now: () => Date.now() });
};

/**
 * MoMo's own push and the answers of a notification, over the relay links the approval push already uses (given once the push is made).
 * @param {ReturnType<typeof createMomoHome> & Record<string, any>} home
 * @param {{ momoPush: (home: any, parts?: any) => any }} approvalPush
 * @param {Parameters<typeof createMomoIntents>[0]['handlers']} [handlers] what the notice lane does with each answer
 */
export function momoDeliveryFor(home, approvalPush, handlers) {
  const push = approvalPush.momoPush(home);
  home.push = push;
  home.intents = createMomoIntents({
    home,
    push,
    handlers,
    zone: () => /** @type {string} */ (dailySettingsOf(home.prefs.forRoutines()).zone),
  });
  return home;
}

/**
 * MoMo's routine runs over the Host's parts, given to its scheduler once the protocol exists.
 * @param {ReturnType<typeof createMomoHome>} home
 * @param {Omit<Parameters<typeof createMomoRuns>[0], 'home'> & { approvalPush?: Parameters<typeof momoDeliveryFor>[1] }} parts the Host's parts, and the approval push whose relay links MoMo's own push goes over
 */
export function momoRunsFor(home, { approvalPush, ...parts }) {
  if (approvalPush) momoDeliveryFor(/** @type {any} */ (home), approvalPush);
  const runs = createMomoRuns({ home, ...parts });
  home.scheduler?.setSource(runs.source);
  // the notice service's tool-less reading turn runs on the same protocol and events (a fresh data-only background chat; it may be absent)
  const notice = /** @type {{ setModel: (model: unknown) => void } | undefined} */ (home.service('notice'));
  const model = createNoticeModel({
    toolsOf: (chatId) => home.toolsOf?.(chatId) ?? [],
    chats: /** @type {any} */ (home.chats),
    protocol: parts.protocol,
    events: parts.events,
    report: parts.report,
  });
  notice?.setModel(model);
  // the same turn is MoMo's brain for the services' read-only checks (./momoSeams.mjs `check.ask`: no tools, the cheapest model, a timeout)
  if (home.seams) home.seams.askModel = (prompt, signal) => model.complete(prompt, signal);
  return runs;
}

/**
 * @param {object} o
 * @param {{ dataDir: string, configDir: string }} o.paths
 * @param {(message: string) => void} o.report
 * @param {Parameters<typeof createMomoChats>[0]['sessions'] & { isolate: (isMomoChat: (chatId: string) => boolean, workspace: string) => void }} o.sessions
 * @param {Parameters<typeof createMomoChats>[0]['epochs']} o.epochs
 * @param {string} o.hostId this Host's own id
 * @param {ReturnType<typeof createMomoHidden>} o.hidden
 * @param {{ registry: Parameters<typeof registerMomoTools>[0]['registry'] | null } | null} [o.tools] the Host's tool channel (./tools.mjs): MoMo's tools join its registry
 * @param {Record<string, string | undefined>} [o.env]
 * @param {() => Promise<{ id: string, detected: boolean, signedIn: boolean }[]>} [o.harnesses] the agents this Host reports (its own sign-ins), for the services
 * @param {import('./momoSeams.mjs').SeamDeps} [o.seams] MoMo's brain and the chat's row writer, once this Host has them
 * @param {Parameters<typeof createMomoScheduler>[0]['rules']} [o.rules] the rule reader MoMo's tasks run on
 */
export function momoHomeFor(
  {
    paths,
    report,
    sessions,
    epochs,
    hidden,
    env,
    hostId,
    harnesses = async () => [],
    seams = {},
    tools = null,
    rules = scheduleRules(rrule.RRule),
  },
  /** @type {{ quirks?: (id: string) => any }} */ { quirks } = {},
) {
  // MoMo's stores are sealed with a key of their own (<config>/momo), so a move carries that key and a wipe deletes it; the grant and the home record stay on the Host's
  const dataKeyDir = path.join(paths.configDir, 'momo');
  const home = createMomoHome({
    hostId,
    dataDir: paths.dataDir,
    safeStorage: createFileSafeStorage(paths.configDir),
    dataSafeStorage: createFileSafeStorage(dataKeyDir),
    dataKeyDir,
    entitlement: entitlementGateFor(hostId, env ?? process.env, report),
    report,
    isMomoChat: (chatId) => !!home.chats?.isMomoChat(chatId),
  });
  home.move = createMomoMove({ home });
  // MoMo's brain and the chat's row writer are read on every call, so what the Host binds later (`home.seams`, see `momoRunsFor`) is found
  home.seams = seams;
  const postedShape = (/** @type {any} */ v) => ({
    keys: Array.isArray(v?.keys) ? v.keys.filter((/** @type {unknown} */ k) => typeof k === 'string') : [],
  });
  // the rows MoMo's chat holds beyond the harness's words (cards, results): the chat sink writes them here, `host.momoRows` reads them
  const rows = createMomoRows({
    store: home.data.sealed('chat-rows.json', rowsShape),
    stamp: () => home.stamp(),
    hasChat: () => !!home.chats?.main(),
  });
  home.rows = rows;
  // its file (chat-rows.json) is sealed with the data key and travels; `seed` writes one settled row so the travel check has it to open
  home.use('rows', { seed: () => rows.seed() });
  seams.writeRow ??= (r) => rows.writeRow(r);
  const check = createCheck(seams);
  const chat = createChatSink(seams, {
    chatId: () => home.chats?.main()?.chatId ?? null,
    stamp: () => home.stamp(),
    posted: home.data.sealed('posted-rows.json', postedShape),
  });
  // services get the home without the Host's own key: a file sealed with it cannot be opened after a move (`home.data.sealed` is the way)
  // and a place for what an agent makes for the user (a spreadsheet, a report), which a move does not carry and a Reset does not delete: `home.workDir(name)`, a path, nothing is made
  const workDir = (/** @type {string} */ name) => path.join(paths.dataDir, 'momo-work', path.basename(String(name)));
  const view = new Proxy(home, {
    get: (target, key) => (key === 'hostOnlyStorage' ? undefined : key === 'workDir' ? workDir : Reflect.get(target, key)),
  });
  const deps = { home: view, sessions, epochs, env, paths, report, harnesses, check, chat };
  home.chats = createMomoChats({
    home,
    sessions,
    epochs,
    env,
    report,
    ...(quirks ? { isolates: (/** @type {string} */ agent) => !!quirks(agent)?.isolation } : {}),
  });
  // routines and the nudge check fire from this Host's clock while the home is active (started by the serve entry once the Host serves)
  home.scheduler = createMomoScheduler({ home, rules, report });
  // the brief, the catch-up and the notes tidy ride the same clock; they do nothing until the notice lane gives what builds and delivers them (`home.daily.setSeams`, `home.push.tell` are called nowhere in host/src yet)
  const daily = createMomoDaily({ home, settings: () => dailySettingsOf(home.prefs.forRoutines()), report });
  home.daily = daily;
  home.scheduler.addTickHook(() => daily.tick());
  // pushes held through quiet hours go out, or are dropped, under the lease as it is at each tick
  home.scheduler.addTickHook(async () => void (await home.push?.release()));
  hidden.bind(home.chats.isHidden, home.chats.isMomoChat);
  home.stopTurns = () => /** @type {NonNullable<typeof home.chats>} */ (home.chats).stopTurns();
  // before any chat starts, so a chat tagged as MoMo's never runs on an agent that has not been told to keep it apart
  sessions.isolate(home.chats.isMomoChat, home.chats.workspace);
  // without the tool channel (no Rust core on this machine) MoMo's chats run with no tools at all
  const registry = tools?.registry;
  if (registry) {
    registerMomoTools({ registry, home, sessions });
    // what a chat is offered, so the reading turn can refuse to run with any tool
    home.toolsOf = (chatId) => registry.list({ chatId }).map((/** @type {{ name: string }} */ t) => t.name);
  }
  // the services other lanes plug in (host/src/momoServices/), after the home's own parts exist
  loadMomoServices({ deps, report });
  // a service that offers `bind` gets the brain and the chat's sink once, after its own module has run
  bindService(view, 'tasks', { check, chat }, report);
  // MoMo's memory and the owner's rules in the turns of its chats, while this Host is the home (a provider only the running home sets)
  /** @type {(() => void) | null} */
  let takeBack = null;
  home.use('momoContext', {
    start: () => void (takeBack ??= installMomoContext({ home })),
    pause: () => void (takeBack?.(), (takeBack = null)),
    wipe: () => void (takeBack?.(), (takeBack = null)),
    // it keeps no file of its own: nothing to seed for the travel check
    seed: () => undefined,
  });
  // the lanes' intents run here, next to their data: a registry made from each service's `intents` map when asked, so a service that fills its map after load is found
  home.intentRegistry = () => {
    const registry = createIntentRegistry({ running: () => !!home.stamp() });
    for (const lane of HOST_LANES) {
      const mine = /** @type {{ intents?: Record<string, (intent: any) => unknown> } | undefined} */ (home.service(lane))?.intents;
      if (!mine || !Object.keys(mine).length) continue;
      try {
        registry.register(lane, mine);
      } catch (error) {
        report(`MoMo service ${lane} has intents the table refuses: ${/** @type {Error} */ (error).message}`);
      }
    }
    return registry;
  };
  return home;
}
