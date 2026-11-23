// Computer use in main: the helper (started on first use), the grant store, Sage's own approval
// cards and the tools in the registry, all behind the remote switch shared.computerUse.enabled.
const { noteIgnored } = require('../ignored.cjs');
const { recordRefusal } = require('./contract/actionGuard.cjs');
const path = require('node:path');
const { ComputerHelper, helperAppPath, BUILT_IN_DENY, HELPER_NAME, HELPER_BUNDLE_ID } = require('./computer.cjs');
const { GrantStore } = require('./grants.cjs');
const { ApprovalBroker } = require('./contract/approvals.cjs');
const { ComputerUse } = require('./tools/computer.cjs');
const { DesktopControl } = require('./tools/desktop.cjs');
const { AppScopedControl } = require('./tools/appScoped.cjs');
const { ANY_APP } = require('./tools/desktopGate.cjs');
const { indicatorWithPill } = require('./controlPill.cjs');
const { NativeDesktopHolds } = require('./nativeDesktopHold.cjs');
const { setupWatchRecord } = require('./watchRecordService.cjs');
const { ControlRefusals } = require('./contract/controlRefusals.cjs');
const { PhantomCursor } = require('./phantomCursor.cjs');
const { AppVisibility } = require('./appVisibility.cjs');
const { WorkingInViews } = require('./workingInViews.cjs');
const { ControlNotifications } = require('./controlNotifications.cjs');
const { grantFromAnswer, LEVELS, LEVEL_LABEL } = require('./contract/policy.cjs');
const { attendance } = require('./computerAttendance.cjs');
const { helperFactsOf, healthOf } = require('./helperFacts.cjs');
const { hostDesktopFor } = require('./hostDesktop.cjs');
const { chatAnchorOf } = require('./anchor.cjs');
const { VisionFallback, VisionConsent } = require('./vision/index.cjs');
const { PRIVACY_PANES } = require('../../shared/skyComputerUse.mjs');
const { createPermissionWatch } = require('./permissionWatch.cjs');
const { offlineStatus } = require('../platform/helperOffline.cjs');
const { hostWindows, trayTooltip, agentLabel, usingText } = require('./computerPresentation.cjs');
const { quotingBroker } = require('./quotingBroker.cjs');
const FLAG = 'shared.computerUse.enabled';
/** Off: no call runs while nobody is there to answer, grant or not. */
const UNATTENDED_FLAG = 'shared.computerUse.unattended';
/** The desktop_* tools (per-app access, tiers, takeover consent, overlay and Esc to stop) and the background desktop_app_* tools. */
const PARITY_FLAG = 'shared.computerUse.parityTools';
/** While a chat holds the desktop, MoPilot's windows and the apps it may not use are hidden. */
const HIDE_FLAG = 'shared.computerUse.hideBeforeAction';
/** Each permission's System Settings pane, opened without the helper when it can't start. */
const SETTINGS_PANES = Object.freeze({
  ...PRIVACY_PANES,
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
});

/**
 * The model a chat runs (an id or an alias), as far as main knows it: the chat's own pick, its current
 * segment's, then the app's default for the harness. Null when unknown.
 */
function chatModel(kind, record, prefs) {
  const seg = record?.segments?.[record.segments.length - 1] ?? null;
  if (kind === 'claude') return seg?.model ?? prefs?.claudeSelection?.model ?? 'opus';
  if (kind === 'codex') return record?.meta?.config?.model ?? seg?.model ?? prefs?.model ?? null;
  return seg?.model ?? null;
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {InstanceType<typeof import('./contract/registry.cjs').Registry>} o.registry
 * @param {{ isEnabled(key: string): boolean }} o.flags
 * @param {any} o.chats ChatsStore
 * @param {InstanceType<typeof import('../session/controller.cjs').ChatController>} o.controller
 * @param {InstanceType<typeof import('../session/state.cjs').SessionStore>} o.sessions
 * @param {InstanceType<typeof import('../computerAccess/owners.cjs').RemoteOwners> | null} [o.remote] the remote owners of
 *   computer access (#1364): their harness, model and anchor come from the owner, and their grants live with it
 * @param {string} o.userData
 * @param {boolean} o.packaged
 * @param {(channel: string, payload: any) => void} o.broadcast
 * @param {(chatId: string) => Promise<any>} o.stop stops the chat's turn and pauses its goal, as Stop does
 * @param {(chatId: string, app: string) => void} [o.notify] tells the user a chat needs their OK (once per pause)
 * @param {Pick<ConstructorParameters<typeof VisionFallback>[0], 'backendFor' | 'read'>} [o.vision] vision fallback for text-only models (see vision/index.cjs)
 * @param {(chatId: string | null) => void} [o.onControlling] the chat controlling the Mac changed (the tray shows a Stop item)
 * @param {(threadId: string) => boolean} [o.nativeThread] a Codex thread runs the vendor plugin (Codex Computer Use);
 *   none: no native program ever holds the desktop
 * @param {(threadId: string) => string} [o.requestChat] the chat a Codex thread's work is shown in (a sub-agent: its parent's)
 * @param {(threadId: string, turnId: string, chatId: string, holder: string | null, blocked?: string, refusal?: import('./contract/controlRefusals.cjs').Refusal) => void} [o.onNativeBusy]
 *   a native program started while another chat (or, null, another app or profile) holds the desktop, or acts on a no-go app: stop that turn and say why
 * @param {(threadId: string) => boolean} [o.subagentThread] a Codex thread is a sub-agent's, whose turn outlives the chat's own
 * @param {(threadId: string, turnId: string) => void} [o.onNativeStop] Esc or Stop on a chat whose native turn holds
 *   the desktop: stop that turn (a sub-agent's, which the chat's own Stop does not reach)
 * @param {{ BrowserWindow: any, screen: any, globalShortcut: any, clipboard?: any, app?: any, nativeImage?: any, systemPreferences?: any } | null} [o.electron] for the
 *   desktop_* tools: the control overlay, the global Esc shortcut, the clipboard and hiding MoPilot's windows
 *   (none: no overlay or Esc, no clipboard, nothing hidden)
 * @param {() => any} [o.prefs] ui prefs (the default model per harness), for the chat's model
 * @param {(kind: string, chatId: string, opts: object) => any} [o.notifyKind] the app's notifier, for "<Agent> is using <App>" and "Done using <App>"
 * @param {(chatId: string) => string} [o.agentName] the chat's agent as the user knows it ("Claude", "Codex", ...)
 * @param {(chatId: string) => string | null} [o.chatName]
 * @param {(chatId: string) => boolean} [o.shown] a window that is still open shows the chat, focused or not (none: controller.viewing)
 * @param {(url: string) => unknown} [o.openExternal] opens a System Settings pane when the helper can't
 * @param {object} [o.permissionWatch] timing of the wait for a permission the user is turning on (tests; permissionWatch.cjs)
 * @param {() => void} [o.onHealth] the helper's state or permissions changed (the capability health record reads them)
 * @param {() => Promise<boolean>} [o.benchAttended] the VM-only bench switch (electron/platform/virtualMachine.cjs, #1600)
 * @param {(chatId: string) => unknown} [o.showChat] MoPilot to the front on the chat, after a person's Esc stopped it and on a click on the pill's label
 */
function setupComputerUse(o) {
  /** Quitting retires thumbnails as well as input and desktop/app locks. */
  let quitting = false;
  /** The harness a chat (or a remote owner's client chat) runs on, for cards and policy. */
  const kindOf = (chatId) => o.remote?.get(chatId)?.harness ?? o.controller.ref(chatId).kind;
  const chatModelOf = (chatId) => chatModel(o.controller.ref(chatId).kind, o.chats.record?.(chatId), o.prefs?.());
  const grants = new GrantStore({
    file: path.join(o.userData, 'capabilities', 'computer.json'),
    chats: o.chats,
    remote: o.remote ?? null,
    onChange: (chatId) => o.broadcast('computer:changed', { chatId }),
  });
  const broker = new ApprovalBroker({ controller: o.controller });
  const helper = new ComputerHelper({
    appPath: helperAppPath({ packaged: o.packaged }),
    packaged: o.packaged,
    expectedDigest: () => require('./helperStamp.cjs').expectedDigest({ packaged: o.packaged, repoRoot: path.join(__dirname, '../..') }),
    denyBundleIds: grants.deny(),
    connectTo: process.env.SAGE_CU_FAKE_HELPER || null, // e2e tests: a fake helper on a socket, never the real screen
  });
  // chats paused for an answer nobody was there to give; one pause and one notification each, until the user is back
  const paused = new Set();
  // the grant each paused chat was refused for, and the card raised for it once the user opens the chat
  const refused = new Map();
  const refusalCard = new Map();
  const goals = require('./goalStarts.cjs').goalStarts();
  const vision = o.vision
    ? new VisionFallback({
        ...o.vision,
        broker,
        consent: new VisionConsent({ file: path.join(o.userData, 'capabilities', 'vision.json') }),
      })
    : null;
  const parityOn = () => o.flags.isEnabled(FLAG) && o.flags.isEnabled(PARITY_FLAG);
  const shown = (chatId) => (o.shown ? o.shown(chatId) : !!o.controller.viewing(chatId));
  /** @type {InstanceType<typeof DesktopControl> | null} */
  let desktop = null;
  /** @type {InstanceType<typeof AppScopedControl> | null} */
  let apps = null;
  /** @type {InstanceType<typeof NativeDesktopHolds>} */
  let nativeHolds;
  // a no-go app refused, or a native turn stopped: one line in the chat's transcript on every harness (#1724)
  const refusals = new ControlRefusals({
    chats: o.chats,
    turnOf: (chatId) => o.sessions.get(chatId)?.activeTurn?.id ?? null,
    changed: (id, chat) => o.broadcast('chats:changed', { id, chat }),
  });
  o.registry.onNoGo = (chatId, r) => refusals.note(chatId, r);
  // the overlay, its clickable Stop pill (#1579) and the global Esc shortcut while a chat holds the desktop (desktop_* tools on)
  const indicator = indicatorWithPill(helper, {
    electron: o.electron || null,
    onEscape: (chatId) => void stopByPerson(chatId),
    onOpenChat: o.showChat,
    heldNatively: (chatId) => !!nativeHolds?.holding(chatId),
    takenOver: (chatId) => o.sessions.get(chatId).computer?.state === 'takeover',
    who: (chatId) => views.pillWho(o.remote?.get(chatId)?.deviceName ?? o.agentName?.(chatId), indicator.takenOver(chatId)),
    labelFor: (chatId) => o.remote?.indicatorLabel(chatId) ?? `${usingText(o.agentName?.(/** @type {string} */ (chatId)))} · Esc to stop`,
  });
  // Codex Computer Use (Sky) holding the desktop shows it too, whatever MoPilot's own desktop tools are set to
  const syncIndicator = () => indicator.sync(parityOn() || nativeHolds?.holding(cu.controlling) ? cu.controlling : null);
  // background control: the phantom cursor over the target window, the chat's live strip, and the notifications
  const cursor = new PhantomCursor({ electron: o.electron || null });
  const visibility = new AppVisibility({ sessions: o.sessions, cursor, helper });
  // the "working in" stack beside the composer: thumbnails (only with Screen Recording already granted), bring to front; app names and icons
  const views = new WorkingInViews({ helper, enabled: () => !quitting && o.flags.isEnabled(FLAG), images: o.electron?.nativeImage });
  const notes = new ControlNotifications({
    notify: (kind, chatId, opts) => o.notifyKind?.(kind, chatId, opts) ?? null,
    agentName: (chatId) => o.agentName?.(chatId) ?? null,
    chatName: (chatId) => o.chatName?.(chatId) ?? null,
    viewing: (chatId) => !!o.controller.viewing?.(chatId),
    appName: (app) => views.identity.label(app),
  });
  /** @type {{ chatId: string, app: string } | null} the chat holding the whole screen and its app: "Done using <App>" when it lets go */
  let noted = null;
  const syncNote = () => {
    const holder = cu.controlling;
    if (noted && noted.chatId !== holder) {
      notes.finished(noted.chatId, noted.app);
      noted = null;
    }
    // a hold before the app is known ("your Mac": hide-before-action takes the desktop first) waits for the app it acts in
    if (holder && !noted && cu.app && cu.app !== ANY_APP) {
      noted = { chatId: holder, app: cu.app };
      notes.started(holder, cu.app, { background: false });
    }
  };
  const cu = new ComputerUse({
    helper,
    vision,
    grants,
    broker,
    chatOf: (id) => o.controller.chatOf(id),
    session: (chatId) => o.sessions.get(chatId),
    harness: kindOf,
    anchor: (chatId) => chatAnchorOf(chatId, { sessions: o.sessions, controller: o.controller, prefs: o.prefs, remote: o.remote }),
    unattendedAllowed: () => o.flags.isEnabled(UNATTENDED_FLAG),
    unattended: attendance({
      helper,
      sessions: o.sessions,
      controller: o.controller,
      remote: o.remote,
      kindOf,
      benchAttended: o.benchAttended,
    }),
    onUnattended: (chatId, e) => {
      recordRefusal(e.code, e.message);
      if (paused.has(chatId)) return;
      paused.add(chatId);
      // computer_*: the grant it lacked; desktop_*: the card it would have put up, and what its answer grants
      if (e.need) refused.set(chatId, { app: e.app, level: e.need, tool: e.tool });
      else if (e.deferred) refused.set(chatId, { app: e.app, tool: e.tool, deferred: e.deferred });
      // the chat is on screen as it pauses: nothing will "open" it later, so its card goes up once the stopped turn has ended
      if (shown(chatId) && refused.has(chatId)) refused.get(chatId).viewed = true;
      // Codex: goal paused, then interrupt (the adapter in main); Claude: the Sage-held pause
      o.stop(chatId).catch((error) => {
        // the turn may already have ended; the desktop is paused for it either way
        noteIgnored('stop a turn that needed someone at the computer', error);
      });
      o.notify?.(chatId, e.app.name);
    },
    onActivity: (chatId, activity) => {
      o.sessions.patch(chatId, { computer: activity });
      o.onControlling?.(cu.controlling);
      syncNote();
      syncIndicator();
    },
    // Esc or the tray: stop the turn as Stop does (the goal pauses too); a desktop batch stops before its next action
    onStop: (chatId) => {
      desktop?.interrupt(chatId);
      apps?.interrupt(chatId);
      // a Codex Computer Use program of the chat stops too, a sub-agent's included
      nativeHolds.interrupt(chatId);
      o.stop(chatId).catch((error) => {
        // the turn may already have ended; its desktop actions are interrupted above either way
        noteIgnored('stop the turn on Esc or from the tray', error);
      });
    },
    suspendEscape: (fn) => indicator.suspendEscape(fn),
  });
  // Codex Computer Use (Sky) programs on a native thread hold the same lock while their turn runs
  nativeHolds = new NativeDesktopHolds({
    cu,
    isNativeThread: (id) => o.nativeThread?.(id) === true,
    chatOf: (id) => (o.requestChat ? o.requestChat(id) : o.controller.chatOf(id)),
    onBusy: (...busy) => o.onNativeBusy?.(...busy),
    onStop: (threadId, turnId) => o.onNativeStop?.(threadId, turnId),
    isSubagent: (threadId) => o.subagentThread?.(threadId) === true,
    onChange: () => syncIndicator(),
  });
  // a tainted turn's irreversible-action cards quote the text that tried to instruct the agent (G3)
  const cards = quotingBroker(broker, () => o.registry.taint);
  desktop = new DesktopControl({
    helper,
    cu,
    grants,
    broker: cards,
    electron: o.electron || null,
    indicator,
    helperInfo: { name: HELPER_NAME, bundleId: HELPER_BUNDLE_ID, path: helperAppPath({ packaged: o.packaged }) },
    onTurnEnded: () => syncIndicator(),
    // a remote owner's model is its client chat's (it has no chat record here)
    modelOf: (id) => (o.remote ? o.remote.modelOr(id, chatModelOf) : chatModelOf(id)),
    hideBeforeAction: () => o.flags.isEnabled(HIDE_FLAG),
    host: hostWindows(o.electron, () => [
      ...indicator.allWindows(),
      .../** @type {InstanceType<typeof DesktopControl>} */ (desktop).teachOverlay.windows(),
    ]),
    // full-screen input refuses an app another chat is working in in the background
    // `apps` is assigned right below, before any input can run
    appLocked: (bundleId, chatId) => /** @type {InstanceType<typeof AppScopedControl>} */ (apps).lockedBy(bundleId, chatId),
    lockedElsewhere: (chatId) => /** @type {InstanceType<typeof AppScopedControl>} */ (apps).lockedElsewhere(chatId),
  });
  // background (app-scoped) control: the same grants and policy, per-app locks instead of the takeover
  apps = new AppScopedControl({
    desktop,
    helper,
    cu,
    broker: cards,
    visibility,
    // Settings' brief switching, and the rung that worked per app, in computer.json with the grants
    ladder: {
      allowed: () => grants.briefForeground(),
      rung: (bundleId, action) => grants.rung(bundleId, action),
      remember: (app, action, rung) => grants.rememberRung(app, action, rung),
    },
    onLock: (chatId, app, held) => {
      visibility.locked(chatId, app, held);
      if (held) notes.started(chatId, app.name, { background: true });
      else notes.finished(chatId, app.name);
    },
  });
  const hostD = hostDesktopFor(o, { broker: cards, kindOf, cu, desktop, modelOf: chatModelOf });
  const route = hostD?.route ?? ((tools) => tools);
  // Esc, the pill's Stop or the helper's Esc: every chat at work on this Mac stops, and MoPilot comes back on this one
  const stopByPerson = require('./personStop.cjs').personStop({ ...o, cu, apps: () => apps, desktop: () => desktop });
  /** The helper as the capability health record reads it (capabilityHealth.cjs); never launches it. */
  const helperFacts = () => helperFactsOf(helper, o.packaged);
  /** @type {string | null} */
  let lastFacts = null;
  /** Tells open Settings pages and the health record when the helper's state or permissions changed. */
  const syncHealth = () => {
    const next = JSON.stringify(helperFacts());
    if (next === lastFacts) return;
    lastFacts = next;
    o.broadcast('computer:changed', { chatId: null });
    o.onHealth?.();
  };
  lastFacts = JSON.stringify(helperFacts());
  helper.on('state', syncHealth);
  // a chat's turn ended or was stopped: the helper refuses that turn's tokens and lets go of a lock it took
  const offRetire = o.registry.turns?.onRetire((chat, turn, thread) => {
    helper.revokeTurn(chat, turn, thread).catch((error) => noteIgnored("revoke a turn's token in the computer-use helper", error));
  });
  helper.on('paused', (p) => (p?.reason === 'escape' && cu.controlling ? void stopByPerson(cu.controlling) : cu.paused(p?.reason)));
  helper.on('exit', () => {
    views.clear();
    syncHealth();
    const chatId = cu.controlling;
    cu.helperExited();
    if (chatId && !cu.hasPermissionGuide(chatId)) o.sessions.patch(chatId, { computer: null });
    o.onControlling?.(null);
    syncNote();
    syncIndicator();
    // the helper crashed or quit: a relaunched one shows the apps it hid and lets go of held keys and buttons,
    // MoPilot's windows come back, and the user's clipboard comes back from the text kept in main
    desktop.helperExited().catch((error) => {
      // best effort: whatever could not be given back stays as it is
      noteIgnored('give the Mac back after the computer-use helper exited', error);
    });
  });

  let unregister = [];
  /** The helper's grants without a running one (a permission left off after Request or Open Settings is waited for: permissionWatch.cjs); a test's fake helper (connectTo), which has no app to launch, answers itself. */
  const readGrants = (kind) =>
    helper.connectTo ? helper.call(kind === 'eventkit' ? 'eventkit.status' : 'permissions.status') : offlineStatus(helper, kind);
  const permissionWatch = createPermissionWatch({
    read: () => readGrants('permissions'),
    broadcast: o.broadcast,
    onError: noteIgnored,
    options: o.permissionWatch,
  });
  /** Whether nothing is working through the helper now: no chat holds the Mac, no call is in flight. */
  const quiet = () => !cu.controlling && !apps?.busy() && !desktop?.holders().length && helper.pending.size === 0;
  /** Quits the helper before System Settings opens a privacy list, as it asks a running app to Quit & Reopen: 'none' when it was not running, 'busy' (left running, nothing cut off) while it is working. */
  const releaseHelper = () => {
    if (!helper.running) return 'none';
    if (!quiet()) return 'busy';
    helper.stop();
    return 'stopped';
  };
  let offDesktop = [];
  /** Registers the tools while the switch is on; switching it off removes them and stops the helper. */
  const sync = () => {
    const on = o.flags.isEnabled(FLAG);
    if (!on) views.clear();
    const parity = parityOn();
    if (on && !unregister.length) {
      cu.closed = false;
      unregister = cu.tools().map((t) => o.registry.register(t));
    }
    if (parity && !offDesktop.length) offDesktop = route([...desktop.tools(), ...apps.tools()]).map((t) => o.registry.register(t));
    if (!parity && offDesktop.length) {
      for (const off of offDesktop) off();
      offDesktop = [];
      syncIndicator();
    }
    if (!on && unregister.length) {
      for (const off of unregister) off();
      unregister = [];
      // every chat gives the Mac back while the helper still runs, then it stops (unless switched on again meanwhile)
      permissionWatch.cancelAll();
      letGo().then(() => {
        if (o.flags.isEnabled(FLAG)) cu.closed = false;
        else helper.stop();
      });
    }
  };
  /** Every chat lets go of the Mac (held input, hidden apps, the clipboard, the lock), and nothing takes it again. */
  const letGo = () => {
    views.clear();
    // computer_* and background calls still running stop too, and the background app locks go
    for (const chatId of new Set([...desktop.holders(), ...[...apps.locks.values()].map((l) => l.chatId)])) {
      cu.interrupt(chatId);
      apps.turnEnded(chatId);
    }
    return desktop.letGoAll().catch((error) => {
      // best effort and bounded; the helper stops after it either way
      noteIgnored('give the Mac back before computer use stops', error);
    });
  };
  sync();

  /** Settings → Computer use: permissions from the helper (started for it), grants, the deny list, the engine, and the health record's verdict. */
  const status = async () => {
    const enabled = o.flags.isEnabled(FLAG);
    const out = {
      enabled,
      /** @type {{ running: boolean, version: string | null, error: string | null, path: string }} */
      helper: { running: false, version: null, error: null, path: helper.appPath },
      /** @type {unknown} */
      permissions: null,
      /** @type {ReturnType<typeof healthOf> | null} */
      health: null,
      grants: { global: grants.global(), chats: /** @type {{ chatId: string, grants: ReturnType<typeof grants.chat> }[]} */ ([]) },
      machines: hostD?.approvals.settings() ?? [],
      deny: { builtIn: BUILT_IN_DENY, user: grants.deny() },
      ...grants.settings(),
    };
    for (const [chatId, rec] of o.chats.records) {
      const list = grants.chat(chatId);
      if (list.length && rec) out.grants.chats.push({ chatId, grants: list });
    }
    if (enabled && helper.installed) {
      // a helper this read launches already reads the current grants; only one that ran before is relaunched
      const wasRunning = helper.running;
      try {
        const hello = await helper.start();
        // a Screen Recording grant made since this helper started is read by a new one; never while computer use
        // gives the Mac back (switched off or quitting) or a chat still holds anything
        out.permissions = await helper.freshPermissionStatus(
          () => wasRunning && !cu.controlling && !apps.busy() && !cu.closed && desktop.holders().length === 0,
        );
        out.helper = { running: true, version: hello?.version ?? null, error: null, path: helper.appPath };
      } catch (e) {
        out.helper.error = String(e?.message ?? e);
      }
    }
    out.health = health();
    out.helper.error ??= out.health.state === 'unavailable' ? out.health.reason : null;
    return out;
  };
  /** MoPilot's computer use, from the helper as it is now (capabilityHealth.cjs computerHealth). */
  const health = () => healthOf(helper, o.packaged, o.flags.isEnabled(FLAG));
  const PERMISSIONS = new Set(['accessibility', 'screenRecording', 'inputMonitoring']);

  /**
   * The user opened a chat that was paused by an unattended refusal: put the card for the refused grant
   * in the chat now that someone is here. Allowing keeps the grant (once: for the chat's next call into
   * the app); Resume then continues the goal. A desktop_* refusal gets the card that call would have shown
   * (the apps with their tiers, the extras and the takeover offer), and Allow grants what it asked for, so
   * the run's next call goes through.
   */
  const onViewed = (chatId) => {
    const r = refused.get(chatId);
    if (!r || !paused.has(chatId) || refusalCard.has(chatId) || !o.flags.isEnabled(FLAG) || !o.flags.isEnabled(UNATTENDED_FLAG)) return;
    // the desktop tools were switched off since: nothing would use the grant
    if (r.deferred && !parityOn()) return;
    r.viewed = true;
    // Interrupt is asynchronous; the old turn's end clears approvals. Wait for it before raising this card.
    if (o.sessions.get(chatId).activeTurn) return;
    // a scheduled run set to skip doesn't wait for anyone: a card would end it
    const sc = o.sessions.get(chatId).scheduled;
    if (sc?.unattended && sc.onApproval === 'skip') return;
    const harness = kindOf(chatId);
    const card = r.deferred
      ? broker.ask(chatId, r.deferred.kind, { harness, ...r.deferred.params })
      : broker.ask(chatId, 'computerAccess', {
          harness,
          app: r.app,
          level: r.level,
          levels: LEVELS.map((l) => ({ id: l, label: LEVEL_LABEL[l] })),
          tool: r.tool,
        });
    refusalCard.set(chatId, card.id);
    // only this card's answer clears the entry: no second card is raised while it is set
    card
      .then(async (answer) => {
        refusalCard.delete(chatId);
        if (refused.get(chatId) !== r || !paused.has(chatId)) return;
        if (!answer) return;
        if (r.deferred) {
          await r.deferred.apply(answer);
          refused.delete(chatId);
          return;
        }
        const g = grantFromAnswer(answer, r.level);
        if (!g) {
          refused.delete(chatId);
          return;
        }
        if (g.scope === 'once') cu.allowOnce(chatId, r.app, g.level);
        else if (!grants.grant(chatId, r.app, g.level, g.scope)) throw new Error("Couldn't save computer permissions. Please try again.");
        refused.delete(chatId);
      })
      .catch((error) => {
        const body = error instanceof Error ? error.message : String(error);
        o.notifyKind?.('computer', chatId, { title: "Couldn't save computer permission", body });
        console.error('Computer permission save failed:', error);
        // Keep the refusal so reopening the paused chat offers a retry.
      });
  };
  /** The user is back (a turn of theirs, the goal running again): the refusal is stale and its card goes. */
  const back = (chatId) => {
    paused.delete(chatId);
    refused.delete(chatId);
    const id = refusalCard.get(chatId);
    if (id) broker.answer(id, null);
  };

  o.ipcMain.handle('computer:answer', (_e, id, result) => broker.answer(id, result));
  o.ipcMain.handle('computer:status', () => status());
  o.ipcMain.handle('computer:requestPermission', async (_e, kind) => {
    if (!PERMISSIONS.has(kind) || !o.flags.isEnabled(FLAG) || !helper.installed) return false;
    try {
      await helper.start();
      const permissions = await helper.requestPermission(kind);
      o.broadcast('computer:changed', { chatId: null });
      if (permissions?.[kind] !== true) permissionWatch.start(kind);
      return permissions?.[kind] === true;
    } catch (error) {
      // the guide stays as it was; the user can try again
      noteIgnored('ask macOS for a computer-use permission from Settings', error);
      return false;
    }
  });
  // the running helper opens its pane; without one (it can't start, or isn't running) main opens the pane itself
  o.ipcMain.handle('computer:openSettings', async (_e, kind) => {
    if (!PERMISSIONS.has(kind) || !o.flags.isEnabled(FLAG)) return false;
    // an idle helper quits first, so System Settings has no running app to ask to Quit & Reopen; a busy one is left alone
    // (nothing it is doing is cut off) and opens the pane itself
    releaseHelper();
    if (helper.running) {
      try {
        if ((await helper.openSettings(kind))?.opened) {
          permissionWatch.start(kind);
          return true;
        }
      } catch (error) {
        noteIgnored('open the macOS privacy settings through the computer-use helper', error);
      }
    }
    if (!o.openExternal) return false;
    try {
      await o.openExternal(SETTINGS_PANES[kind]);
      permissionWatch.start(kind);
      return true;
    } catch (error) {
      noteIgnored('open the macOS privacy settings for computer use', error);
      return false;
    }
  });
  o.ipcMain.handle(
    'computer:revoke',
    (_e, chatId, bundleId) => typeof bundleId === 'string' && desktop.revoke(typeof chatId === 'string' ? chatId : null, bundleId),
  );
  // Settings' "Remove all" on the always-allowed apps: future requests ask again; chats keep their grants
  o.ipcMain.handle('computer:revokeAll', () => grants.clearGlobal());
  // main's policy applies the change at once; a running helper gets it too, and a stopped or relaunched one at launch
  o.ipcMain.handle('computer:setDeny', async (_e, list) => {
    const deny = grants.setDeny(list);
    await helper.setDeny(deny).catch((error) => {
      // main enforces the list itself; a stopped helper reads it at launch
      noteIgnored('send the deny list to the computer-use helper', error);
    });
    return deny;
  });
  o.ipcMain.handle('computer:setBriefForeground', (_e, on) => grants.setBriefForeground(on === true));
  o.ipcMain.handle('computer:resume', (_e, chatId) => cu.resume(chatId));
  o.ipcMain.handle('computer:recheck', (_e, chatId) => typeof chatId === 'string' && cu.recheck(chatId));
  o.ipcMain.handle('computer:stop', (_e, chatId) => typeof chatId === 'string' && !!chatId && cu.stop(chatId).then(() => true));
  // the chat's control strip: the user takes an app over from the agent (its input there waits; the app is in front)
  o.ipcMain.handle('computer:takeOver', (_e, chatId, bundleId) => {
    if (typeof chatId !== 'string' || typeof bundleId !== 'string' || !apps.takeOver(chatId, bundleId)) return false;
    visibility.takenOver(chatId, bundleId, true);
    helper.openApp(bundleId).catch((error) => {
      // bringing the app forward is a convenience; the takeover already applies
      noteIgnored('bring a taken-over app to the front', error);
    });
    return true;
  });
  o.ipcMain.handle('computer:handBack', (_e, chatId, bundleId) => {
    if (typeof chatId !== 'string' || typeof bundleId !== 'string' || !apps.handBack(chatId, bundleId)) return false;
    visibility.takenOver(chatId, bundleId, false);
    return true;
  });
  views.handle(o.ipcMain);
  // Record a skill: the composer's recording of what a person does, for a chat to turn into a skill
  const watchRecord = setupWatchRecord({
    ipcMain: o.ipcMain,
    electron: o.electron || null,
    helper,
    broadcast: o.broadcast,
    note: noteIgnored,
  });
  // a chat was archived or deleted (any harness): its desktop grants and consent go with it
  o.ipcMain.handle('computer:forget', async (_e, chatId) => {
    if (typeof chatId !== 'string' || !chatId) return false;
    apps.forget(chatId);
    visibility.forget(chatId);
    views.forget(chatId);
    await desktop.forget(chatId);
    return true;
  });

  /**
   * A chat's turn ended (adapters may call this on Stop, interrupt or abort too): releases the desktop
   * lock, held keys and buttons, the overlay and the Esc shortcut. Idempotent and bounded in time.
   */
  const turnEnded = (chatId) => {
    cu.interrupt(chatId);
    // the chat's own Codex Computer Use turn is over with it; a sub-agent's may still run
    nativeHolds.chatTurnEnded(chatId);
    apps.turnEnded(chatId);
    // a refused screen-reading card holds for the turn only
    vision?.turnEnded(chatId);
    return (
      desktop
        .turnEnded(chatId)
        .catch((error) => {
          // turn-end cleanup is bounded and best effort
          noteIgnored('clean up computer use at the end of a turn', error);
        })
        // a sub-agent's Codex Computer Use program still running keeps the desktop
        .then(() => nativeHolds.retake(chatId))
    );
  };

  return {
    cu,
    desktop,
    apps,
    nativeHolds,
    refusals,
    indicator,
    visibility,
    cursor,
    notes,
    helper,
    grants,
    broker,
    hostDesktop: hostD ?? null, // approvals and the pane's tabs of the chats on Hosts (hostDesktop.cjs)
    sync,
    onViewed,
    helperFacts,
    health,
    /** Every SessionState change: unanswered cards that went away (main's turn-end ledger lets go of the desktop, turnEnd.cjs). */
    onSessionPatch({ chatId, patch }) {
      if (patch.approvals) broker.sweep(chatId, patch.approvals);
      if (goals.starts(chatId, patch, paused.has(chatId)) || patch.activeTurn?.human || patch.activeTurn?.userEngaged) back(chatId);
      // A chat opened during interruption gets its card after the old turn has cleared approvals.
      // Still on screen is enough: the window need not have the focus when the turn ends.
      if ((patch.turn === 'idle' || patch.turn === 'crashed') && refused.get(chatId)?.viewed && shown(chatId)) onViewed(chatId);
    },
    turnEnded,
    /**
     * The chat's leases on the Mac (TargetLeases): the desktop lock while it controls the Mac, and each app it holds
     * a background lock on (with whether the user took that app over).
     * @returns {import('./targetLeases.cjs').Lease[]}
     */
    leases(chatId) {
      /** @type {import('./targetLeases.cjs').Lease[]} */
      const out = cu.controlling === chatId ? [{ surface: 'desktop', id: 'desktop', origin: 'agent', mark: null, held: true }] : [];
      for (const l of apps.locks.values())
        if (l.chatId === chatId)
          out.push({
            surface: 'app',
            id: l.bundleId,
            label: l.name,
            origin: 'agent',
            mark: null,
            held: true,
            takenOver: apps.takenOver(chatId, l.bundleId),
          });
      return out;
    },
    /** Whether quitting has to wait for a chat to give the Mac back first (letGo()); false once that has run. */
    /** For MoMo's sources: quits the helper when idle ('stopped', 'none' when it was not running, 'busy' otherwise), and reads the grants without a running one. */
    releaseHelper,
    offlineStatus: readGrants,
    holding: () => !quitting && desktop.holders().length > 0,
    /** Quitting: every chat gives the Mac back while the helper still runs (bounded); stop() follows. */
    letGo() {
      quitting = true;
      return letGo();
    },
    stop() {
      quitting = true;
      permissionWatch.cancelAll();
      views.clear();
      cu.closed = true;
      offRetire?.();
      indicator.dispose();
      cursor.dispose();
      void watchRecord.dispose();
      helper.stop();
    },
  };
}

module.exports = { setupComputerUse, FLAG, PARITY_FLAG, HIDE_FLAG, SETTINGS_PANES, chatModel, hostWindows, trayTooltip, agentLabel };
