// The desktop tools' gate: the screen while a chat holds it (hide-before-action), takeover consent, the one-chat lock, and the grant check before each action.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { helperError } = require('./computer.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { DesktopAccess } = require('./desktopAccess.cjs');
const { checkAct, mayAct, stopped, shuttingDown } = require('../contract/actionGuard.cjs');
const { noGoError, helperRefusal, refuseSelf } = require('../contract/controlRefusals.cjs');

/** What the activity bar calls a hold on the desktop before the app it acts in is known. */
const ANY_APP = 'your Mac';
/** Why the takeover card comes: the access card never asks for screen control up front. */
/** How long after a person's Esc the screen's return still brings MoPilot forward on the stopped chat. */
const FRONT_MS = 15_000;
const TAKEOVER_REASON = "Working in the background isn't enough for this step: it needs the real pointer and keyboard.";
/** @typedef {import('./desktop.cjs').DesktopHost} DesktopHost */

/** @typedef {InstanceType<typeof import('./desktop.cjs').DesktopControl>} DesktopControl the control these methods run on */

class DesktopGate extends DesktopAccess {
  /* -- the screen while a chat holds it ----------------------------- */

  /**
   * Before an input action with hide-before-action on: take the desktop, then (once per hold) hide
   * MoPilot's own windows and every app that isn't granted, remembering what was in front, so the
   * screen matches the screenshot when the gate checks what is under the point. Apps other chats work in
   * in the background are never hidden. An action refused before it runs lets go of the desktop again
   * (input), so a refusal holds nothing until the turn ends.
   * @param {string} chatId
   * @this {DesktopControl}
   */
  async stage(chatId) {
    if (!this.hideBeforeAction()) return;
    await this.acquire(chatId, null);
    let st = this.screen;
    if (st?.chatId !== chatId)
      st = this.screen = /** @type {NonNullable<DesktopControl['screen']>} */ ({
        chatId,
        previous: undefined,
        hidden: st?.hidden ?? [],
        others: false,
        hostHidden: false,
      });
    const screen = st;
    if (screen.previous === undefined) {
      const f = await this.helper.targetInfo().catch((error) => {
        // unknown: no app is brought back to the front when the turn ends
        noteIgnored('remember the frontmost app before desktop control', error);
        return null;
      });
      screen.previous = f?.pid ? { pid: f.pid, host: f.refused === 'MoPilot' } : null;
    }
    const host = this.host;
    if (host && !screen.hostHidden) {
      checkAct("hiding MoPilot's windows");
      const hid = !!(await Promise.resolve()
        .then(() => host.hide(chatId))
        .catch((error) => {
          // MoPilot's windows stay up; a screenshot leaves them out anyway
          noteIgnored("hide MoPilot's windows for desktop control", error);
          return false;
        }));
      // hidden after the turn let go of the screen (restoreScreen dropped it): they come back at once
      if (hid && this.screen !== screen) this.showHost(false);
      else screen.hostHidden = hid;
    }
    if (!screen.others) {
      checkAct('hiding the apps that are not granted');
      screen.others = true;
      const keep = [...[...this.granted(chatId).values()].map((g) => g.bundleId), ...this.lockedElsewhere(chatId)];
      const r = await this.helper.hideOthers(keep).catch((error) => {
        // other apps stay visible; screenshots still show only the granted ones
        noteIgnored('hide the apps that are not granted', error);
        return null;
      });
      const hidden = (Array.isArray(r?.hidden) ? r.hidden : []).filter((h) => h?.pid);
      if (this.screen === screen) screen.hidden.push(...hidden);
      // the turn already let go of the screen: nothing would show these again, so they come back now
      else if (hidden.length)
        await this.helper.restoreApps(hidden.map((h) => h.pid)).catch((error) => {
          // the apps may have quit
          noteIgnored('show the apps hidden after the turn ended', error);
        });
    }
    if (this.screen !== screen) throw stopped('acting on the desktop');
  }

  /**
   * MoPilot's windows come back (`focus`: and to the front).
   * @param {boolean} focus
   * @this {DesktopControl}
   */
  showHost(focus) {
    try {
      // only called with a host (stage(), restoreScreen())
      /** @type {DesktopHost} */ (this.host).show(focus);
    } catch (error) {
      // the host window may already be closed
      noteIgnored("bring MoPilot's windows back", error);
    }
  }

  /**
   * A card is about to ask the user something: the docked panel comes forward with the keyboard, or (nothing docked)
   * MoPilot's windows come back (the next input hides them again).
   * @this {DesktopControl}
   */
  revealHost() {
    const st = this.screen;
    if (!st?.hostHidden) return;
    if (/** @type {DesktopHost} */ (this.host).attend?.()) return;
    st.hostHidden = false;
    try {
      // hostHidden is only ever set when there is a host (stage())
      /** @type {DesktopHost} */ (this.host).show(true);
    } catch (error) {
      // the host window may already be closed
      noteIgnored("bring MoPilot's windows back for a card", error);
    }
  }

  /**
   * Apps hidden while the chat holds the desktop that it may now use are shown again.
   * @param {string} chatId
   * @param {string[]} bundleIds
   * @this {DesktopControl}
   */
  async unhide(chatId, bundleIds) {
    const st = this.screen;
    if (st?.chatId !== chatId || !bundleIds.length) return;
    const ids = new Set(bundleIds.map((b) => b.toLowerCase()));
    const back = st.hidden.filter((h) => ids.has(String(h.bundleId).toLowerCase()));
    if (!back.length) return;
    st.hidden = st.hidden.filter((h) => !back.includes(h));
    await this.helper.restoreApps(back.map((h) => h.pid)).catch((error) => {
      // the apps may have quit
      noteIgnored('show the hidden apps that were just granted', error);
    });
  }

  /**
   * A person stopped the chat from the desktop (Esc, the control pill): once the screen is given back, `show` brings
   * MoPilot to the front on the chat instead of the app that was in front before, as Claude Desktop's computer use
   * comes back after Esc. With no screen held for the chat it runs at once.
   * @param {string} chatId
   * @param {() => void} show
   * @this {DesktopControl}
   */
  frontAfterStop(chatId, show) {
    // a stop that did not end the turn soon never pulls MoPilot forward later
    if (this.screen?.chatId === chatId) this.screen.front = { show, until: Date.now() + FRONT_MS };
    else show();
  }

  /**
   * The turn ended: hidden apps and MoPilot's windows come back, and the app that was in front before (MoPilot on the chat, after a person's stop).
   * @param {string} chatId
   * @this {DesktopControl}
   */
  async restoreScreen(chatId) {
    const st = this.screen;
    if (st?.chatId !== chatId) return;
    this.screen = null;
    // a person's Esc not long ago: MoPilot comes forward on the chat instead of the app that was in front
    const front = st.front && Date.now() <= st.front.until ? st.front.show : null;
    const back = st.previous && !st.previous.host && !front ? st.previous.pid : null;
    if ((st.hidden.length || back) && (await this.helperToRestore()))
      await this.helper
        .restoreApps(
          st.hidden.map((h) => h.pid),
          back,
        )
        .catch((error) => {
          // the apps may have quit; restoring is best effort
          noteIgnored('show the hidden apps again at the end of a turn', error);
        });
    if (this.host && (st.hostHidden || st.previous?.host)) this.showHost(!!st.previous?.host || !!front);
    front?.();
  }

  /* -- consent, gate, lock ---------------------------------------- */

  /**
   * What may stop input before it is checked app by app: the chat's mode, attendance, the takeover consent.
   * @this {DesktopControl}
   */
  async preflight(chatId, ctx) {
    return this.takeoverConsent(chatId, ctx);
  }

  /**
   * preflight(), or (`explicit`: desktop_request_full_control) the same consent asked on request, which needs no granted app
   * yet and says in its own words when the user declines.
   * @param {string} chatId
   * @param {any} ctx
   * @param {{ explicit?: boolean }} [o]
   * @this {DesktopControl}
   */
  async takeoverConsent(chatId, ctx, o = {}) {
    if (this.cu.anchor(chatId) === 'readOnly')
      throw new ToolError('This chat is in a read-only mode: desktop control can only look', 'read_only');
    // nothing to take over the screen for yet: no card before the apps are granted
    if (!o.explicit && !this.granted(chatId).size)
      throw new ToolError('No apps are granted in this chat yet: call desktop_request_access first', 'denied');
    const s = this.session(chatId);
    const unattended = await this.cu.unattended(chatId, ctx);
    if (unattended && !this.cu.unattendedAllowed()) {
      const message = `Controlling the desktop with nobody here is switched off (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
      this.cu.onUnattended(chatId, {
        app: { bundleId: 'ai.mopilot.screen', name: 'your screen' },
        code: 'unattended',
        message,
        need: null,
        tool: 'desktop_input',
      });
      throw new ToolError(message, 'unattended');
    }
    if (s.consent) return;
    if (unattended) {
      const message = `Taking over the screen needs the user's OK once per chat, and nobody is here to give it (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
      // the takeover card, put up once the user opens the paused chat; allowing it gives the chat screen control
      const deferred = {
        kind: 'computerTakeover',
        params: {
          apps: [...this.granted(chatId).values()].map((a) => ({ bundleId: a.bundleId, name: a.name, tier: a.tier })),
          reason: TAKEOVER_REASON,
        },
        apply: (answer) => {
          if (answer?.decision === 'allow') this.session(chatId).consent = true;
        },
      };
      this.cu.onUnattended(chatId, {
        app: { bundleId: 'ai.mopilot.screen', name: 'your screen' },
        code: 'unattended',
        message,
        need: null,
        tool: 'desktop_input',
        deferred,
      });
      throw new ToolError(message, 'unattended');
    }
    this.revealHost();
    // asked just in time: the first input that working in the background can't do, with why in one line
    const answer = await this.broker.ask(
      chatId,
      'computerTakeover',
      {
        harness: this.cu.harness(chatId),
        apps: [...this.granted(chatId).values()].map((a) => ({ bundleId: a.bundleId, name: a.name, tier: a.tier })),
        reason: TAKEOVER_REASON,
      },
      { signal: ctx?.signal },
    );
    if (answer?.decision !== 'allow')
      throw new ToolError(
        o.explicit
          ? 'Full-screen control was not approved (declined or not confirmed). Stay with the desktop_app_* tools for the granted background apps, or explain what full-screen access is needed for and let the user decide.'
          : "The user didn't allow MoPilot to control the screen",
        'denied',
      );
    s.consent = true;
    await this.cu.resumeAfterCard(chatId);
  }

  /**
   * Takes the desktop for the chat: one chat at a time, refused at once (not queued) while another holds
   * it. `appName` (null: not known yet) is what the activity bar names; `bundleId` the app it acts in.
   * @param {string} chatId
   * @param {string | null} appName
   * @param {string} [bundleId]
   * @this {DesktopControl}
   */
  async acquire(chatId, appName, bundleId) {
    const cu = this.cu;
    // a stopped call never takes the desktop (back), nor acts while the chat still holds it
    checkAct('taking the desktop');
    // another chat works in this app in the background (desktop_app_*): full-screen input would collide with it
    if (this.appLocked(bundleId, chatId))
      throw new ToolError(
        `Another chat is working in ${appName} in the background. Wait for it to finish, or work in another app.`,
        'busy',
      );
    // a lock is granted per (chat, turn) token: one a turn kept after it ended or was stopped is free again
    const holder = cu.liveHolder();
    if (holder === chatId) {
      // the chat moved on to another granted app: the activity bar names the app it controls now
      // (a take-over or a reading note stays until it ends)
      if (appName && cu.app !== appName) {
        cu.app = appName;
        const shown = cu.session?.(chatId)?.computer;
        if (!shown || (shown.state === 'active' && !shown.read)) cu.onActivity(chatId, { app: appName, state: 'active' });
      }
      return;
    }
    if (holder)
      throw new ToolError(
        'Another chat is controlling this Mac. Only one chat can control the desktop at a time: wait for it to finish (the user can stop it with Esc), then try again.',
        'busy',
      );
    if (cu.closed) throw shuttingDown();
    cu.controlling = chatId;
    try {
      await this.helper.acquireControl(cu.holder(chatId));
    } catch (e) {
      if (cu.controlling === chatId) cu.controlling = null;
      if (e?.reason === 'lock_busy')
        throw new ToolError(
          `The desktop is in use by ${String(e.message).replace(/^the desktop is in use by /, '')}. Only one controller at a time: wait and try again.`,
          'busy',
        );
      throw helperError(e);
    }
    // stopped while the helper took it: let go at once, so the next turn (or another chat) gets it
    if (!mayAct()) {
      await cu.release(chatId);
      throw stopped('taking the desktop');
    }
    cu.app = appName || ANY_APP;
    cu.onActivity(chatId, { app: cu.app, state: 'active' });
  }

  /**
   * Checks an action against the chat's grants, right before it runs: the frontmost app (and, for a
   * pointer action, the app under the point) must be granted at a tier that allows it. When another app
   * is in front, the app the action is for comes forward first: the granted app under the point, the
   * `app` named for keys, or the app of the latest screenshot. Only a granted app is ever brought
   * forward, and everything is checked again after. Throws a refusal that tells the model what to do.
   * Returns the apps to restrict the helper to.
   * @this {DesktopControl}
   */
  async gate(chatId, action, args, point) {
    const need = P.needOf(action, args);
    const granted = this.granted(chatId);
    if (!granted.size) throw new ToolError('No apps are granted in this chat yet: call desktop_request_access first', 'denied');
    const allowed = [...granted.values()].filter((g) => !need || P.tierRank(g.tier) >= P.tierRank(need));
    // looking (screenshot, zoom, the pointer's position) works at any tier, whatever is in front
    if (!P.INPUT.has(action)) return { granted, allowed: allowed.map((g) => g.bundleId), front: null };
    // an app's tier is fixed by its kind (desktopPolicy.cjs tierOf: browsers read, terminals and IDEs click), whatever
    // the user grants: asking for more access can't help, so the model is told so (#1483)
    const tierError = (g, where) =>
      new ToolError(
        `${g.name} is granted at tier "${g.tier}" (${P.TIER_LABEL[g.tier]}), which doesn't allow ${action.replace(/_/g, ' ')}${where}. ${g.name} is never granted more than this, so don't ask the user for more access.${g.tier === 'read' ? ' For a web page use the browser tools.' : g.tier === 'click' ? ' For commands use the shell tool; only left clicks and scrolling work here.' : ''}`,
        'tier',
      );
    const lookup = async (p) => {
      try {
        return await this.helper.targetInfo(p);
      } catch (e) {
        throw helperError(e);
      }
    };
    const grantOf = (t) => (t?.bundleId ? granted.get(t.bundleId.toLowerCase()) : null);
    let front = await lookup(null);
    /** @type {ReturnType<typeof grantOf>} */
    let atGrant = null;
    if (point) {
      const at = await lookup(point);
      if (at?.refused)
        throw noGoError(`That point is on ${at.name || at.refused}, which MoPilot never controls`, 'refused', helperRefusal(at));
      atGrant = grantOf(at);
      if (!atGrant)
        throw new ToolError(
          `That point is on ${at?.name || 'an app'}${at?.bundleId ? ` (${at.bundleId})` : ''}, which isn't granted in this chat. Call desktop_request_access for it, or aim at a granted app's window.`,
          'denied',
        );
      if (P.tierRank(atGrant.tier) < P.tierRank(need)) throw tierError(atGrant, '');
    }
    // the app the action is for comes forward when something else is in front (or, for keys, when another app was named)
    const named = !point && P.KEYBOARD.has(action) ? this.namedApp(chatId, args) : null;
    const want = point ? atGrant : named || this.lastApp(chatId, granted, need);
    const before = grantOf(front);
    if (want && (named ? before?.bundleId !== want.bundleId : !before)) {
      await this.acquire(chatId, want.name, want.bundleId);
      await this.helper.openApp(want.bundleId, { bundleIds: [want.bundleId] }).catch((error) => {
        // the lookup below sees what is in front now and refuses if it is not the app
        noteIgnored('bring a granted app forward for an action', error);
      });
      front = await lookup(null);
    }
    const frontIsMoPilot = front?.refused === 'MoPilot';
    if (front?.refused && !frontIsMoPilot)
      throw new ToolError(
        `${front.name || front.refused} is in front, and MoPilot never controls ${front.refused}. Bring a granted app forward with desktop_open_application.`,
        'refused',
      );
    const frontGrant = grantOf(front);
    if (point) {
      // the frontmost app must be granted too, unless MoPilot itself is in front (a click brings the app forward)
      if (!frontIsMoPilot && !frontGrant)
        throw new ToolError(
          `${front?.name || 'The frontmost app'} is in front and isn't granted in this chat. Bring a granted app forward with desktop_open_application first.`,
          'denied',
        );
      return { granted, allowed: allowed.map((g) => g.bundleId), front: atGrant };
    }
    if (frontIsMoPilot)
      throw new ToolError(
        'MoPilot is in front, so keys and text would go to it. Bring the app to work in forward with desktop_open_application first.',
        'refused',
      );
    if (!frontGrant)
      throw new ToolError(
        `${front?.name || 'The frontmost app'} is in front and isn't granted in this chat. Call desktop_request_access for it, or bring a granted app forward with desktop_open_application.`,
        'denied',
      );
    if (named && frontGrant.bundleId !== named.bundleId)
      throw new ToolError(
        `${named.name} didn't come to the front (${frontGrant.name} is in front); bring it forward with desktop_open_application and try again.`,
        'denied',
      );
    if (P.tierRank(frontGrant.tier) < P.tierRank(need)) throw tierError(frontGrant, ' (it is the frontmost app)');
    return { granted, allowed: allowed.map((g) => g.bundleId), front: frontGrant };
  }

  /**
   * The granted app `args.app` names, or null when none is named; an app that isn't granted is refused.
   * @this {DesktopControl}
   */
  namedApp(chatId, args) {
    if (args.app === undefined || args.app === null || args.app === '') return null;
    refuseSelf(args.app);
    const app = this.findGranted(chatId, args.app);
    if (!app) throw new ToolError(`${args.app} isn't granted in this chat; call desktop_request_access first`, 'denied');
    return app;
  }

  /**
   * The app the chat last saw or acted in, while it is still granted at a tier the action needs.
   * @this {DesktopControl}
   */
  lastApp(chatId, granted, need) {
    const id = this.session(chatId).lastApp;
    const g = id ? granted.get(id.toLowerCase()) : null;
    return g && P.tierRank(g.tier) >= P.tierRank(need) ? g : null;
  }
}

module.exports = { DesktopGate, TAKEOVER_REASON, ANY_APP };
