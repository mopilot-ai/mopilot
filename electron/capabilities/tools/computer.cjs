// The computer-use tools agents get through the registry: a screenshot, the accessibility element
// list, click, type, key and scroll, all backed by the helper (electron/capabilities/computer.cjs),
// which starts on the first call. Authorization happens here, in the handler: which app the call
// reaches, what the chat may do there (policy.cjs, grants.cjs), and the user's answer on a card.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { LEVELS, LEVEL_LABEL, irreversible, decide, grantFromAnswer, observationKinds } = require('../contract/policy.cjs');
const { sessionAnchorOf } = require('../anchor.cjs');
const { noGoError, helperRefusal } = require('../contract/controlRefusals.cjs');

const { mergeOcr } = require('../vision/ocr.cjs');
const { guarded, mayAct, checkAct, stopped, shuttingDown, pause, tokenLiveness } = require('../contract/actionGuard.cjs');
const { notAllowed } = require('../vision/index.cjs');

const SETTLE_MS = 300;
/** How long a call waits for the desktop while another chat (or profile) controls it. */
const WAIT_MS = 60_000;
const POLL_MS = 1000;
const { IDENTITY, elementList, elementAt, toView, toPoints } = require('./computerElements.cjs');
const { SPECS, VISION_SPECS, TOOL_NAMES } = require('./computerSpecs.cjs');
const { missingPermission, helperError, SCHEDULED_OFF } = require('./computerErrors.cjs');
const { ComputerPermissions } = require('./computerPermissions.cjs');
const { DesktopTakeover, stoppedWaiting } = require('./takeoverWait.cjs');
/** @typedef {import('./computerElements.cjs').AXElement} AXElement */

const NO_VISION = 'No vision model can read the screen in this chat; use computer_elements, which lists the text on screen';
/** What a screenshot asks to see when no ordinary app is in front. */
const SCREEN = { bundleId: 'ai.mopilot.screen', name: 'your screen', pid: null };
class ComputerUse extends ComputerPermissions {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('../computer.cjs').ComputerHelper>} o.helper
   * @param {InstanceType<typeof import('../grants.cjs').GrantStore>} o.grants
   * @param {InstanceType<typeof import('../contract/approvals.cjs').ApprovalBroker>} o.broker
   * @param {(chatId: string) => { permission?: string | null, modality?: string | null, scheduled?: { computer?: boolean } | null, acp?: any, computer?: any }} o.session the chat's SessionState
   * @param {(id: string) => string} [o.chatOf] the chat a tool session's id belongs to (a Codex thread id is a segment's)
   * @param {(chatId: string) => string} [o.harness] the harness running the chat (its kind)
   * @param {(chatId: string) => 'readOnly' | 'ask' | 'auto' | 'full'} [o.anchor] the chat's permission anchor (../anchor.cjs)
   * @param {(chatId: string) => string} [o.holder] who holds the desktop lock, as shown to other profiles
   * @param {(chatId: string, ctx: { callId?: string | null }) => string | null | Promise<string | null>} [o.unattended] why nobody can answer a card in the chat now, or null
   * @param {() => boolean} [o.unattendedAllowed] the remote switch shared.computerUse.unattended; false refuses every unattended call
   * @param {(chatId: string, e: { app: {bundleId: string, name: string}, code: string, message: string, need: string | null, tool: string, deferred?: { kind: string, params: object, apply(answer: any): any } }) => void} [o.onUnattended]
   *   a call was refused for that: pause the chat and tell the user. `need` is the computer_* grant it lacked;
   *   `deferred` (desktop_*), the card to put up once the user is back and what its answer grants
   * @param {(chatId: string, activity: { app: string, state: 'active' | 'reading' | 'takeover' | 'waiting' | 'permission', holder?: string | null, permission?: string, read?: object } | null) => void} [o.onActivity]
   *   what the chat's activity bar shows
   * @param {(chatId: string) => void} [o.onStop] the user stopped the agent (Esc, the tray): stop the chat's turn
   * @param {<T>(fn: () => Promise<T>) => Promise<T>} [o.suspendEscape] runs fn with the global Esc shortcut lifted
   * @param {InstanceType<typeof import('../vision/index.cjs').VisionFallback> | null} [o.vision] vision fallback for text-only models: locate and describe, OCR elements, consent
   * @param {number} [o.settleMs]
   * @param {number} [o.waitMs]
   * @param {number} [o.pollMs]
   * @param {number} [o.takeoverWaitMs] how long input waits for the user to hand the desktop back
   */
  constructor(o) {
    super(o.onActivity);
    this.helper = o.helper;
    this.grants = o.grants;
    this.broker = o.broker;
    this.session = o.session;
    this.chatOf = o.chatOf || ((id) => id);
    this.harness = o.harness || (() => 'The agent');
    this.anchor = o.anchor || ((chatId) => sessionAnchorOf(this.harness(chatId), this.session(chatId)));
    this.holder = o.holder || (() => 'MoPilot');
    this.unattended = o.unattended || (() => null);
    this.unattendedAllowed = o.unattendedAllowed || (() => true);
    this.onUnattended =
      o.onUnattended ||
      (() => {
        /* no unattended listener */
      });
    this.onStop =
      o.onStop ||
      (() => {
        /* no stop listener */
      });
    /** runs a key press with the global Esc-to-stop shortcut lifted (see controlIndicator.cjs) */
    this.suspendEscape = o.suspendEscape || ((fn) => fn());
    this.vision = o.vision || null;
    this.settleMs = o.settleMs ?? SETTLE_MS;
    this.waitMs = o.waitMs ?? WAIT_MS;
    this.pollMs = o.pollMs ?? POLL_MS;
    this.takeover = new DesktopTakeover({ ms: o.takeoverWaitMs });
    /** the app the controlling chat works in, for the activity bar */
    this.app = null;
    /** per chat: the last screenshot's geometry and element list */
    /** @type {Map<string, { geom: { x: number, y: number, ppp: number }, byId: Map<string, AXElement> }>} */
    this.views = new Map();
    /** per chat: "Allow once" answers to a card raised after an unattended refusal, spent by the next call into that app */
    this.once = new Map();
    /** @type {string | null} the chat holding the desktop lock (controlling) */
    this.holder_ = null;
    /** @type {(() => boolean) | null} whether the token the lock was granted to is still current; null: not turn-scoped */
    this.holderLive = null;
    /** per chat: the control epoch, moved by Esc, Stop and the turn's end; a call acts only within the epoch it began in */
    /** @type {Map<string, number>} */
    this.epochs = new Map();
  }

  /** The chat holding the desktop lock, if any. */
  get controlling() {
    return this.holder_;
  }

  /**
   * Taken (or let go): the lock is granted to the running call's `(chat, turn)` token (../contract/turnTokens.cjs), so a lock
   * its turn kept after it ended or was stopped is free again (liveHolder). A lock taken outside a call (a native
   * Codex hold) has no token and stays until it is let go.
   */
  set controlling(chatId) {
    this.holder_ = chatId;
    this.holderLive = chatId ? tokenLiveness() : null;
  }

  /**
   * The chat holding the desktop lock under a current token, or null. A lock held by a turn that ended or was
   * stopped is let go now, so the chat's next turn (or another chat) takes it afresh under its own token.
   * @returns {string | null}
   */
  liveHolder() {
    const chatId = this.holder_;
    if (chatId && this.holderLive && !this.holderLive()) {
      void this.release(chatId);
      return null;
    }
    return chatId;
  }

  /** The chat's control epoch (./actionGuard.cjs). */
  epoch(chatId) {
    return this.epochs.get(chatId) ?? 0;
  }

  /** Esc, Stop or the turn's end: the chat's computer_* calls running now may no longer act. */
  interrupt(chatId) {
    this.epochs.set(chatId, this.epoch(chatId) + 1);
    this.takeover.end(chatId, stoppedWaiting());
  }

  /**
   * Registry tool definitions; each handler authorizes its own call.
   * @returns {import('../contract/registry.cjs').ToolDef[]}
   */
  tools() {
    return [...SPECS, ...(this.vision ? VISION_SPECS : [])].map((s) => ({
      ...s,
      authorizesItself: true,
      handler: (args, ctx) => this.run(s.name, args || {}, ctx),
    }));
  }

  /** What a result carries for the chat: by its model's input, and the vision backend if there is one. */
  async plan(chatId) {
    const modality = this.session(chatId)?.modality;
    if (this.vision) return this.vision.plan(chatId, modality);
    return { kinds: observationKinds(modality), ocr: false, locate: false, backend: null };
  }

  view(chatId) {
    let v = this.views.get(chatId);
    if (!v) {
      v = { geom: IDENTITY, byId: new Map() };
      this.views.set(chatId, v);
    }
    return v;
  }

  async ready() {
    try {
      await this.helper.start();
    } catch (e) {
      throw new ToolError(`Computer use isn't available: ${e?.message ?? e}`, 'unavailable');
    }
    return this.helper;
  }

  /** The point a click or scroll goes to, in screen points, and the element there if known. */
  point(chatId, args) {
    const v = this.view(chatId);
    if (typeof args.element === 'string' && args.element) {
      const n = v.byId.get(args.element);
      if (!n) throw new ToolError(`No element ${args.element} in the latest element list; list the elements again`, 'bad_args');
      return { p: { x: n.frame.x + n.frame.w / 2, y: n.frame.y + n.frame.h / 2 }, element: n };
    }
    if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new ToolError('Pass x and y, or element', 'bad_args');
    const p = toPoints(v.geom, { x: args.x, y: args.y });
    return { p, element: elementAt(v.byId, p) };
  }

  /** A call that fails for a missing permission shows the guide card in its chat; a call that works takes it down. */
  run(tool, args, ctx, retried = false) {
    const chatId = this.chatOf(ctx.chatId);
    // the call acts only while it isn't stopped and the chat's turn hasn't ended or been interrupted since it began
    return guarded({ signal: ctx.signal ?? null, epoch: () => this.epoch(chatId) }, () =>
      this.runGuarded(chatId, tool, args, ctx, retried),
    );
  }

  /** run(), inside the call's guard. */
  async runGuarded(chatId, tool, args, ctx, retried, owner = this.permissionOwner(chatId)) {
    try {
      const out = await this.runCall(tool, args, ctx, chatId);
      await this.recoverPermissionGuide(chatId, owner, tool, this.helper);
      return out;
    } catch (e) {
      const permission =
        e instanceof ToolError && e.code === 'permission'
          ? /** @type {InstanceType<typeof ToolError> & { permission?: string }} */ (e).permission
          : null;
      if (permission) {
        const refusal = this.showPermissionGuide(chatId, permission, owner);
        if (refusal && !retried && !(await this.unattended(chatId, ctx)) && this.permissionMayAct(chatId, refusal)) {
          const status = await this.askPermission(permission);
          // Input may already have succeeded before its follow-up screenshot failed.
          // Retry observations only; replaying a click, key or typed text would duplicate input.
          if (
            status?.[permission] === true &&
            this.permissionMayAct(chatId, refusal) &&
            (tool === 'computer_screenshot' || tool === 'computer_elements')
          )
            return this.runGuarded(chatId, tool, args, ctx, true, refusal);
        }
      }
      throw e;
    }
  }

  async runCall(tool, args, ctx, chatId) {
    // a scheduled task runs with computer control only when its settings allow it
    if (this.session(chatId)?.scheduled?.computer === false) throw new ToolError(SCHEDULED_OFF, 'refused');
    const seeing = tool === 'computer_locate' || tool === 'computer_describe';
    if (seeing && !(await this.plan(chatId)).locate) throw new ToolError(NO_VISION, 'unavailable');
    const helper = await this.ready();
    /** @type {{ x: number, y: number } | null} */
    let p = null;
    /** @type {ReturnType<typeof this.point>['element'] | null} */
    let element = null;
    if (tool === 'computer_click' || tool === 'computer_scroll') ({ p, element } = this.point(chatId, args));
    let app;
    try {
      app = await helper.targetInfo(p);
    } catch (e) {
      throw helperError(e);
    }
    // MoPilot (or another app on the deny list) in front: a screenshot still shows the rest of the
    // screen, without it, so it asks for the screen as a whole
    if (app?.refused && tool === 'computer_screenshot') app = SCREEN;
    if (app?.refused) throw noGoError(`MoPilot never controls ${app.refused}`, 'refused', helperRefusal(app));
    app = { bundleId: app?.bundleId || '', name: app?.name || app?.bundleId || 'this app', pid: app?.pid ?? null };
    await this.authorize(chatId, tool, args, app, element, ctx);
    // input while the user has taken over waits for "Done, continue" (#1905), then the glow shows while the call runs
    if (!seeing && tool !== 'computer_screenshot' && tool !== 'computer_elements') await this.takeover.wait(chatId, ctx.signal);
    this.glow(true, app);
    try {
      return await this.execute(chatId, tool, args, ctx, { helper, p, element, app });
    } finally {
      this.glow(false, app);
    }
  }

  /** Starts or stops the helper's glow around an app's window. Best effort: a helper without it, or a stopped one, is fine. */
  glow(on, app) {
    if (!this.helper.running) return;
    if (on && !app.pid) return;
    (on ? this.helper.glowStart(app.pid) : this.helper.glowStop())?.catch?.(() => {
      /* the glow is cosmetic; a helper without it is fine */
    });
  }

  /** The call itself, once it is allowed. */
  async execute(chatId, tool, args, ctx, { helper, p, element, app }) {
    const seeing = tool === 'computer_locate' || tool === 'computer_describe';
    const only = { bundleIds: [app.bundleId] };
    if (seeing) return this.see(chatId, tool, args, app, ctx);
    if (tool === 'computer_screenshot') return this.observe(chatId, app, await this.plan(chatId));
    if (tool === 'computer_elements') return this.observe(chatId, app, { ...(await this.plan(chatId)), kinds: ['elements'] });
    await this.control(chatId, app);
    try {
      if (tool === 'computer_click') await helper.click(p.x, p.y, { button: args.button || 'left', count: args.count || 1, ...only });
      else if (tool === 'computer_scroll') await helper.scroll(p.x, p.y, args.dx || 0, args.dy || 0, only);
      else if (tool === 'computer_type') await helper.type(args.text, only);
      else if (tool === 'computer_key') {
        // an Escape the agent sends itself must not hit the global Esc-to-stop shortcut
        const press = () => helper.key(args.key, only);
        await (/(^|\+)\s*esc(ape)?\s*$/i.test(String(args.key)) ? this.suspendEscape(press) : press());
      }
    } catch (e) {
      throw await this.cutShort(chatId, e, ctx.signal).catch((x) => (x instanceof ToolError ? x : helperError(x)));
    }
    if (this.settleMs) await new Promise((r) => setTimeout(r, this.settleMs));
    return this.observe(chatId, app, await this.plan(chatId), `Done: ${tool.replace('computer_', '')} in ${app.name}.`);
  }

  /** An "Allow once" given with no call waiting (the card for an unattended refusal): the chat's next call into the app may run. */
  allowOnce(chatId, app, level) {
    this.once.set(chatId, [
      ...(this.once.get(chatId) || []).filter((g) => g.bundleId.toLowerCase() !== app.bundleId.toLowerCase()),
      { bundleId: app.bundleId, level },
    ]);
  }

  #spendOnce(chatId, app) {
    const list = this.once.get(chatId);
    if (!list) return;
    const rest = list.filter((g) => g.bundleId.toLowerCase() !== app.bundleId.toLowerCase());
    if (rest.length) this.once.set(chatId, rest);
    else this.once.delete(chatId);
  }

  /** Runs the policy for one call; asks on a card when it needs the user. Throws when it may not run. */
  async authorize(chatId, tool, args, app, element, ctx = {}) {
    const irr = irreversible(tool, args, { app, element });
    const unattended = await this.unattended(chatId, ctx);
    const anchor = this.anchor(chatId);
    const d = decide({
      tool,
      args,
      app,
      grants: [...this.grants.forChat(chatId), ...(this.once.get(chatId) || [])],
      deny: this.grants.deny(),
      unattended,
      unattendedAllowed: this.unattendedAllowed(),
      anchor,
      irreversible: irr,
    });
    if (d.action === 'refuse') {
      // no card nobody would see: refuse, pause the chat, tell the user once
      if (d.pause)
        this.onUnattended(chatId, {
          app: { bundleId: app.bundleId, name: app.name },
          code: d.code,
          message: d.message,
          need: d.grant ?? null,
          tool,
        });
      if (d.code !== 'blocked') throw new ToolError(d.message, d.code);
      throw noGoError(d.message, d.code, { reason: 'blocked', app: app.name, name: app.name });
    }
    this.#spendOnce(chatId, app);
    const harness = this.harness(chatId);
    if (d.action === 'ask') {
      const levels = LEVELS.map((l) => ({ id: l, label: LEVEL_LABEL[l] }));
      const card = { harness, app: { bundleId: app.bundleId, name: app.name }, level: d.level, levels, tool };
      const answer = await this.broker.ask(chatId, 'computerAccess', card, { signal: ctx.signal });
      const g = grantFromAnswer(answer, d.level);
      if (!g) throw new ToolError(`The user didn't allow controlling ${app.name}`, 'denied');
      if (this.grants.grant(chatId, app, g.level, g.scope) === false && g.scope !== 'once')
        throw new ToolError("Couldn't save computer permissions. Please try again.", 'save_failed');
      await this.resumeAfterCard(chatId);
    }
    // an action that can't be undone is confirmed every time, whatever the grant
    if (irr) {
      const card = { harness, app: { bundleId: app.bundleId, name: app.name }, verb: irr.verb, summary: irr.summary, tool };
      const answer = await this.broker.ask(chatId, 'computerConfirm', card, { signal: ctx.signal });
      if (answer?.decision !== 'allow') throw new ToolError(`The user didn't confirm: ${irr.verb} in ${app.name}`, 'denied');
      await this.resumeAfterCard(chatId);
    }
  }

  /**
   * Takes the desktop for this chat: one controller per user, across chats and profiles. While someone
   * else has it the chat shows "Waiting" and tries again, for up to a minute.
   */
  async control(chatId, app) {
    const deadline = Date.now() + this.waitMs;
    let waiting = false;
    try {
      // a lock its turn kept after it ended or was stopped is free again (liveHolder)
      while (this.liveHolder() !== chatId) {
        if (this.closed) throw shuttingDown();
        // Stop, Esc or the turn's end while waiting: the wait ends, and the desktop is never taken
        checkAct('taking the desktop');
        if (!this.controlling) {
          // claimed before the helper answers, so another chat (or the desktop_* tools) can't take it meanwhile
          this.controlling = chatId;
          try {
            await this.helper.acquireControl(this.holder(chatId));
            break;
          } catch (e) {
            if (this.controlling === chatId) this.controlling = null;
            if (e?.reason !== 'lock_busy') throw helperError(e);
          }
        }
        if (Date.now() >= deadline) {
          this.onActivity(chatId, null);
          waiting = false;
          throw new ToolError('Another chat is controlling the Mac; try again later', 'busy');
        }
        // another chat here, or (holder null) another profile or app
        if (!waiting) this.onActivity(chatId, { app: app.name, state: 'waiting', holder: this.controlling });
        waiting = true;
        await pause(this.pollMs);
      }
    } catch (e) {
      // the "Waiting" strip goes with the wait, however it ended
      if (waiting) this.onActivity(chatId, null);
      throw e;
    }
    // stopped while the helper took it: let go at once, so the next turn (or another chat) gets it
    if (!mayAct()) {
      await this.release(chatId);
      throw stopped('taking the desktop');
    }
    if ((this.app !== app.name || waiting) && !this.takeover.is(chatId)) this.onActivity(chatId, { app: app.name, state: 'active' });
    this.app = app.name;
  }

  /** Shows what reads the screen while `fn` runs: a vision model, or the text on this Mac. */
  async reading(chatId, app, read, fn) {
    // while the user has taken over, the strip keeps their "Done, continue" (#1896)
    if (!read || this.takeover.is(chatId)) return fn();
    const was = this.controlling === chatId;
    this.onActivity(chatId, { app: app.name, state: was ? 'active' : 'reading', read });
    try {
      return await fn();
    } finally {
      this.onActivity(chatId, was ? { app: app.name, state: 'active' } : null);
    }
  }

  /** computer_locate and computer_describe: a screenshot that goes only to the vision backend. */
  async see(chatId, tool, args, app, ctx) {
    const plan = await this.plan(chatId);
    const vision = this.vision;
    // the plan is read again here: the chat's model or sign-in may have changed since runCall checked it
    if (!vision || !plan.backend) throw new ToolError(NO_VISION, 'unavailable');
    // only the app's own windows go to the vision model: the consent card names the app, not the screen
    if (!app.pid) throw new ToolError('No app is in front to look at; bring the app forward first', 'unavailable');
    const r = await vision.allowing(chatId, plan.backend, {
      harness: this.harness(chatId),
      app: { bundleId: app.bundleId, name: app.name },
      // a scheduled run or nobody at the Mac: no card that nobody would answer
      unattended: () => this.unattended(chatId, ctx),
      signal: ctx?.signal,
    });
    const backend = r.backend;
    if (!backend)
      throw new ToolError(`${notAllowed(plan.backend.vendor, r)}; use computer_elements, which lists the text on screen`, 'denied');
    const v = this.view(chatId);
    return this.reading(chatId, app, { model: backend.model, vendor: backend.vendor }, async () => {
      let shot;
      try {
        shot = await this.helper.screenshot({ pid: app.pid, bundleIds: [app.bundleId] });
      } catch (e) {
        throw helperError(e);
      }
      const d = shot.display || { x: 0, y: 0 };
      v.geom = { x: d.x || 0, y: d.y || 0, ppp: shot.pixelsPerPoint || 1 };
      try {
        if (tool === 'computer_describe') return [{ type: 'text', text: await vision.describe(backend, shot, args.region, ctx.signal) }];
        const { point } = await vision.locate(backend, shot, String(args.query || ''), ctx.signal);
        if (!point) return [{ type: 'text', text: `Not found on the screen: ${args.query}` }];
        const el = elementAt(v.byId, toPoints(v.geom, point));
        return [
          {
            type: 'text',
            text: `Found at (${point.x}, ${point.y}) in pixels of the latest ${shot.width}×${shot.height} screenshot${el ? `; element ${el.id}` : ''}.`,
          },
        ];
      } catch (e) {
        throw new ToolError(`The vision model couldn't read the screen: ${e?.message ?? e}`, 'failed');
      }
    });
  }

  /** A screenshot, the element list (with OCR text when the plan says so), or both, as tool content. */
  async observe(chatId, app, plan, lead = '') {
    const kinds = plan.kinds;
    const v = this.view(chatId);
    /** @type {import('../contract/registry.cjs').ToolContent[]} */
    const out = lead ? [{ type: 'text', text: lead }] : [];
    const read = kinds.includes('elements') && plan.ocr ? { text: true } : null;
    return this.reading(chatId, app, read, async () => {
      try {
        if (kinds.includes('screenshot')) {
          // the app's own windows only; the screen as a whole (minus MoPilot) when no app is in front
          const shot = await this.helper.screenshot(app.pid ? { pid: app.pid, bundleIds: [app.bundleId] } : {});
          const d = shot.display || { x: 0, y: 0 };
          v.geom = { x: d.x || 0, y: d.y || 0, ppp: shot.pixelsPerPoint || 1 };
          out.push({ type: 'image', data: shot.png, mimeType: 'image/png' });
          out.push({ type: 'text', text: `Screenshot ${shot.width}×${shot.height}; x and y for computer_click are pixels of this image.` });
        }
        if (kinds.includes('elements')) {
          const snap = await this.helper.axSnapshot({ bundleIds: [app.bundleId] });
          const list = elementList(snap, v.geom);
          v.byId = list.byId;
          let text = list.text;
          if (plan.ocr) {
            // the helper may not have ocr.elements yet, and OCR never blocks the list
            const res = await this.helper.ocrElements({ bundleIds: [app.bundleId] }).catch((error) => {
              noteIgnored('read the screen text with OCR for the element list', error);
              return null;
            });
            const lines = res ? mergeOcr(v.byId, res, (p) => toView(v.geom, p)) : [];
            if (lines.length) text += `\nText read from the screen (OCR):\n${lines.join('\n')}`;
          }
          out.push({ type: 'text', text });
        }
      } catch (e) {
        throw helperError(e);
      }
      return out;
    });
  }
}

module.exports = { ComputerUse, TOOL_NAMES, SPECS, VISION_SPECS, elementList, elementAt, toView, toPoints, helperError, missingPermission };
