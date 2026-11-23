// Browser Use request handlers over a thread backend’s tab and permission services.
const { ownTable } = require('../../../../shared/ownTable.mjs');
const { withTimeout } = require('../hostUtil.cjs');
const { checkAct } = require('../../contract/actionGuard.cjs');
const { noteInput } = require('../heldInput.cjs');
const { NO_PASSWORDS, fail } = require('./protocol.cjs');
const { isEarlyScript } = require('../documentScripts.cjs');
const { formReloadNote } = require('../../../../shared/browserNotice.mjs');
const { FOCUS_EMULATION, emulatesFocus } = require('../views.cjs');
const { forgetViewport } = require('./viewport.cjs');
const { screenRead } = require('./readTaint.cjs');
const { withLoadInterruption } = require('../loadInterruption.cjs');
const {
  awaitsCursor,
  cdpClass,
  cdpPolicy,
  writes,
  typingInput,
  siteOf,
  actsOnPage,
  urlAllowed,
  autoAttachParams,
  childUrl,
} = require('./policy.cjs');

/** What a command on a crashed tab gets back: the page is gone until it is reloaded. */
const crashedNote = (/** @type {string} */ id) =>
  `The page in tab ${id} crashed (its renderer is gone). Reload it with Page.reload (or navigate it), then read the page again before acting.`;

/** @type {Record<string, (this: InstanceType<typeof import('./backend.cjs').IabBackend>, p: any, previewWait?: ((promise: Promise<any>) => Promise<any>) | null) => any>} */
const HANDLERS = ownTable({
  getInfo() {
    return this.info();
  },
  getTabs() {
    const host = this.host();
    const { chatId } = this.ctx;
    const current = host.current(chatId);
    return host.list(chatId).map((t) => this.serialize(t, current));
  },
  async createTab() {
    const host = this.host();
    const tab = await host.create(this.ctx.chatId, { focus: this.showNext });
    this.showNext = false;
    this.controlled.add(tab);
    return this.serialize(tab, tab);
  },
  focusTab(p) {
    const tab = this.tabOf(p.tabId);
    this.host().select(this.ctx.chatId, tab.id);
    return true;
  },
  nameSession() {
    return null;
  },
  async attach(p) {
    const tab = this.tabOf(p.tabId);
    await this.gatePage(tab, 'read', '');
    await this.hold(tab);
    return null;
  },
  async attachTarget(p) {
    return HANDLERS.attach.call(this, p);
  },
  detach(p) {
    const tab = this.ids.get(p.tabId);
    if (tab) this.drop(tab);
    return null;
  },
  detachTarget(p) {
    const tab = this.ids.get(p.tabId);
    if (tab && (p.targetId == null || p.targetId === this.targetId(tab))) this.drop(tab);
    return null;
  },
  getCommittedTabUrl(p) {
    return this.tabOf(p.tabId).url || null;
  },
  async executeCdp(p, previewWait = null) {
    const target = p.target && typeof p.target === 'object' ? p.target : {};
    const tab = this.tabOf(target.tabId);
    const method = p.method;
    const raw = p.commandParams && typeof p.commandParams === 'object' ? p.commandParams : {};
    cdpPolicy(method);
    const kind = cdpClass(method);
    if (kind === 'emulated') return this.emulated(tab, method, raw, target);
    if (method === 'Page.navigate' && !previewWait) {
      this.notTakenOver(tab);
      const preview = this.host().o.prepare?.(this.ctx.chatId, raw.url);
      if (preview)
        return withLoadInterruption(tab.backend, async (wait) => {
          const url = await wait(preview);
          checkAct('restore a preview in the built-in browser');
          this.notTakenOver(tab);
          return wait(HANDLERS.executeCdp.call(this, { ...p, commandParams: { ...raw, url } }, wait));
        });
    }
    // a view's focus emulation is the host tab's for the turn (focusForInput): the plugin can't turn it off
    if (method === FOCUS_EMULATION && raw.enabled === false && emulatesFocus(tab.backend)) return {};
    const params = method === 'Target.setAutoAttach' ? autoAttachParams(raw) : raw;
    const write = writes(kind, params);
    const need = write ? 'write' : 'read';
    // the session a command goes to: the one it names, or a child frame's it names by target id (its page is gated below)
    let sessionId = typeof target.sessionId === 'string' ? target.sessionId : '';
    if (!sessionId && target.targetId != null && target.targetId !== this.targetId(tab))
      sessionId = [...(this.held.get(tab)?.children ?? [])].find(([, id]) => id === target.targetId)?.[0] ?? '';
    // MoPilot's own Page domain and early scripts (documentScripts.cjs) stay: the plugin can't switch them off
    if (
      method === 'Page.disable' ||
      (method === 'Page.removeScriptToEvaluateOnNewDocument' && isEarlyScript(tab.backend, sessionId, params.identifier))
    )
      return {};
    const gatedUrl = tab.url;
    /** @type {Set<string>} the pages the user said yes to on this command's own card */
    let allowed = new Set();
    // a dialog answer goes only to the dialog its approval was about (the user may answer one in the pane meanwhile)
    const dialogAsked = tab.dialog?.own ?? null;
    // the gates first, outside the tab's queue: an approval card can take longer than an action's turn
    if (kind === 'navigate') {
      this.notTakenOver(tab);
      let url = tab.url;
      if (method === 'Page.navigate') url = params.url;
      else if (method === 'Page.navigateToHistoryEntry') {
        const { entries = [] } = (await tab.send('Page.getNavigationHistory')) || {};
        url = entries.find((e) => e.id === params.entryId)?.url;
      }
      if (!urlAllowed(url)) {
        const errorText = `Blocked browser navigation by Browser Use URL policy: ${String(url)}`;
        this.notify('onCDPEvent', { source: { tabId: this.idOf(tab) }, method: 'Page.navigationBlocked', params: { errorText, url } });
        throw this.refuse('bad_url', `${errorText}. Only http and https pages can be opened.`);
      }
      await this.gateUrl(url, 'read');
      // a reload of a form result sends the form again (CDP's reload doesn't ask): only the user resubmits
      if (method === 'Page.reload' && (await this.host().reloadResubmits(tab)))
        throw this.refuse('form_resubmit', formReloadNote(`tab ${this.idOf(tab)}`));
    } else {
      // the page the command is about, on every command: a redirect may have taken the tab somewhere the user refused
      allowed = await this.gatePage(tab, need, sessionId);
      if (write) await this.gateWrite(tab, method, params, sessionId);
    }
    const deliver = async () => {
      // a command that acts, begun before the chat's calls were stopped, reaches the page no more (reads and
      // request interception still go, so a page the plugin paused isn't left waiting)
      // input lands under the agent cursor: after the glide the plugin's moveMouse (or this press) started, not during
      // it; a drag's moves with a button down follow at once
      if (awaitsCursor(kind, params)) await this.host().o.cursor?.arrival(tab);
      if (actsOnPage(kind, params) || write) checkAct(`${method} in the built-in browser`);
      // the page's own dialog (pageDialogs.cjs) is answered where MoPilot holds it, as the pane's would be
      if (method === 'Page.handleJavaScriptDialog' && dialogAsked != null) {
        await this.host().handleDialog(
          tab,
          params.accept === true,
          typeof params.promptText === 'string' ? params.promptText : null,
          dialogAsked,
        );
        return {};
      }
      // a tab whose renderer is gone answers the debugger only "Target crashed" (#1319 G25): a reload or a navigation
      // loads it anew (the browser runs them), the viewport waits for it (backend.cjs), and anything else says what
      // happened and what to do
      if (kind !== 'navigate' && kind !== 'viewport' && tab.rendererGone()) throw fail(crashedNote(this.idOf(tab)));
      await this.hold(tab);
      const session = sessionId;
      // a child frame named by target id was resolved above; one the tab doesn't have can't be reached
      if (!session && target.targetId != null && target.targetId !== this.targetId(tab))
        throw fail(`No debugger session is attached for target ${String(target.targetId)}`);
      const h = this.held.get(tab);
      if (method === 'Page.startScreencast' && !h.screencast) {
        h.screencast = true;
        await this.conceal(tab, true);
      }
      const ms = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? Math.min(p.timeoutMs, this.cdpMs) : this.cdpMs;
      const send = async () => {
        if (previewWait) await previewWait(Promise.resolve());
        return withTimeout(tab.send(method, params, session), ms, () => {
          throw fail(`Timed out running CDP command "${method}" for tab ${this.idOf(tab)}`);
        }).catch((error) => {
          // the renderer went while the command ran (a navigation still loading): the same way back as a tab that had
          // already crashed, not the debugger's bare "Target crashed" (#1617). An error with its own reason (the tab
          // closed, the credential document changed) is passed on as it was
          const crash = error?.code === 'page_crashed' || !error?.code;
          if (crash && tab.rendererGone()) throw fail(crashedNote(this.idOf(tab)));
          throw error;
        });
      };
      // a key or button the plugin presses is let go when it lets go of the tab (drop) or the turn ends (hostTabs.cjs)
      noteInput(tab, method, params, session);
      try {
        if (method !== 'Page.captureScreenshot') return await send();
        await this.conceal(tab, true);
        try {
          return await send();
        } finally {
          await this.conceal(tab, false);
        }
      } finally {
        if (method === 'Page.stopScreencast' && h.screencast) {
          h.screencast = false;
          await this.conceal(tab, false);
        }
      }
    };
    // a read's text taints the turn when it tries to instruct the agent (G3: ./readTaint.cjs; the result itself is unchanged)
    const screened = async () => {
      const out = await deliver();
      screenRead(this.grants().taint?.(), this.ctx.chatId, childUrl(this.held.get(tab), sessionId) || tab.url, method, out);
      return out;
    };
    if (!actsOnPage(kind, params)) return screened();
    // an action then waits for its turn in the tab's queue, so it never interleaves with a browser_* action, and
    // the tab is checked again when the turn comes: a browser_* action may have changed it meanwhile
    return this.host().run(tab, async () => {
      this.tabOf(target.tabId);
      this.notTakenOver(tab);
      // input and history moves were meant for the site that was gated; a navigation and the viewport name their own.
      // By origin: a page that moves its own URL (pushState, a hash) mid-drag must still get the rest of its events
      if (method !== 'Page.navigate' && kind !== 'viewport' && siteOf(tab.url) !== siteOf(gatedUrl))
        throw this.refuse(
          'tab_changed',
          `Tab ${this.idOf(tab)} changed while this action waited for its turn: it is at ${tab.url} now. Look at it again before acting.`,
        );
      // the site may have been refused, or lowered to read only, meanwhile (no card here: the gates above asked)
      if (kind !== 'navigate') {
        // a yes on this command's own card covers its re-check (an "Allow once" isn't stored)
        this.checkUrl(tab.url, need, allowed.has(tab.url));
        const child = childUrl(this.held.get(tab), sessionId);
        if (child) this.checkUrl(child, need, allowed.has(child));
      }
      // the focus may have moved to a password field while this waited (typing, or an accessibility action)
      if ((typingInput(method, params) || kind === 'gesture') && (await this.host().intent(tab, {}))?.secret)
        throw this.refuse('password_field', NO_PASSWORDS);
      // the plugin acted on this tab: the turn's result tab is the one acted on last (hostTabs.cjs turnEnded)
      if (kind !== 'viewport') this.host().acted(tab);
      return screened();
    });
  },
  async executeCdpWithCachedExpression(p) {
    const { expressionCacheKey, ...rest } = p;
    const cp = rest.commandParams && typeof rest.commandParams === 'object' ? rest.commandParams : {};
    if (typeof cp.expression === 'string') this.cached.set(expressionCacheKey, cp.expression);
    const expression = this.cached.get(expressionCacheKey);
    if (expression == null) return { kind: 'cache-miss' };
    return { kind: 'executed', result: await HANDLERS.executeCdp.call(this, { ...rest, commandParams: { ...cp, expression } }) };
  },
  markTab(p) {
    if (p.status !== 'handoff' && p.status !== 'deliverable') throw fail(`markTab received invalid status ${String(p.status)}`);
    this.host().mark(this.ctx.chatId, this.tabOf(p.tabId).id, p.status);
    return null;
  },
  /**
   * The host closes the turn's unmarked tabs itself when the chat's turn ends; this lets go of the rest. A
   * turnEnded naming another turn than the one the plugin's requests last came from is stale: nothing changes.
   */
  turnEnded(p) {
    if (typeof p.turn_id === 'string' && this.turn !== null && p.turn_id !== this.turn) return null;
    for (const tab of [...this.held.keys()]) this.drop(tab);
    this.controlled.clear();
    forgetViewport(this);
    this.showNext = false;
    return null;
  },
  allowDownload(p) {
    this.tabOf(p.tabId);
    return null;
  },
  setBlobDownloadOrigin() {
    return null;
  },
  async executeUnhandledCommand(p) {
    const host = this.host();
    const { chatId } = this.ctx;
    const current = host.current(chatId);
    switch (p.type) {
      case 'browser_visibility_get':
        return { visible: host.list(chatId).some((t) => t.layer === 'front') };
      case 'browser_visibility_set':
        // cua.createBrowserTab(..., { visible }) sets this before it opens the tab, so in a chat with no tab yet it
        // applies to the tab opened next. Hidden: nothing of the chat's is in front (new tabs open in the background)
        if (p.visible !== true) {
          // MoPilot's pane is the user's: the plugin can bring its tab forward, not hide the pane
          if (host.list(chatId).some((t) => t.layer === 'front'))
            throw fail("MoPilot's built-in browser can't be hidden by an agent: the user shows or hides the browser pane.");
          this.showNext = false;
          return {};
        }
        const shown = current ?? host.list(chatId).at(-1);
        if (!shown) {
          this.showNext = true;
          return {};
        }
        host.select(chatId, shown.id);
        return {};
      // the plugin's viewport is on the tabs it holds (in each tab's action queue), and on the ones it attaches later
      case 'browser_viewport_set': {
        const width = Number(p.width);
        const height = Number(p.height);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
          throw fail('browser_viewport_set needs a positive integer width and height.');
        const tabs = [...this.held.keys()].filter((t) => !t.closed);
        if (!tabs.length) throw fail('No tab is attached yet: attach a tab first, then set its viewport.');
        this.viewport = { width, height };
        await Promise.all(tabs.map((t) => host.run(t, () => this.size(t))));
        return {};
      }
      case 'browser_viewport_reset':
        this.viewport = null;
        await Promise.all([...this.sized].map((t) => host.run(t, () => this.unsize(t))));
        return {};
    }
    throw fail(`Unsupported command for MoPilot's built-in browser: ${String(p.type)}`);
  },
});

module.exports = { HANDLERS };
