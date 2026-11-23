// The built-in browser channel: agents drive a BrowserPanel tab through the Chrome DevTools Protocol
// (webContents.debugger). The tab is a main-owned WebContentsView (views.cjs), or with
// shared.browser.viewTabs off a <webview> guest, in its own partition with nodeIntegration off and no
// preload. Its registered native popups may also be driven, preserving OAuth's opener.
// assertCdpTarget refuses app windows, unrelated popups, other sessions and pages with a preload. A tab of
// the user's Chrome over the relay (chromeTab.cjs) is no webContents: only its own contents pass, by their own check.
const { isFailedLoad, becameDownload, DOWNLOAD_NOTE } = require('./downloadNavigations.cjs');
const { withLoadInterruption } = require('./loadInterruption.cjs');
const { settlePage } = require('./pageSettle.cjs');
const { waitEvent } = require('./hostUtil.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { isViewTab, focusForInput } = require('./views.cjs');
const { isBackendTab, keyOf } = require('./backend.cjs');
const { LocalTabContents } = require('./localBackend.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { loadFailureNote, openFailureNote } = require('../../../shared/browserNotice.mjs');
const { untilHung } = require('./pageHang.cjs');
const { refuseCrashed, crashedMidCommand, rendererGone } = require('./browserDispatch.cjs');
const { ELEMENT_INTENT } = require('./chromeIntent.cjs');
const { UNREADABLE_FRAME } = require('./siteRisk.cjs');

const PARTITION = 'persist:browser';
const ATTACH_MS = 15_000;
const LOAD_MS = 20_000;
const SNAPSHOT_MAX = 40_000;

/** Roles that get a ref an agent can click or type into. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
  'treeitem',
]);
/** Roles left out of a snapshot (their children still show). */
const SILENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'ignored']);

/**
 * Throws unless `wc` is a live pane tab (a view main created, or a panel guest) or a guest's
 * registered sandboxed popup, with no preload/Node, in a panel session; a guest must be owned by an
 * app window. App windows themselves are never targets. A view belongs to main, not to a window:
 * `host` only narrows guests.
 * @param {any} contents
 * @param {{ appContents: any[], panelSession: any, host?: any, popupRoot?: any }} o
 *   panelSession: the panel's session, or a list of them (the shared profile and chats' own partitions)
 */
function assertCdpTarget(contents, { appContents, panelSession, host, popupRoot }) {
  const wc = keyOf(contents);
  const fail = (why) => {
    throw new ToolError(`Refusing to drive this page over CDP: ${why}`, 'bad_target');
  };
  // a Chrome tab says itself why it is gone (the user took it, it closed)
  if (isBackendTab(wc)) {
    if (typeof wc.assertDrivable === 'function') return void wc.assertDrivable();
    // a backend with no check of its own is at least gone or not
    return wc.isDestroyed() ? fail('it is gone') : undefined;
  }
  if (!wc || typeof wc.isDestroyed !== 'function' || wc.isDestroyed()) fail('it is gone');
  if (appContents.some((a) => a === wc || (a && a.id === wc.id))) fail("it is MoPilot's own window");
  const view = isViewTab(wc);
  if (view) {
    /* a pane tab main created: no guest type or host window to check */
  } else if (popupRoot) {
    assertCdpTarget(popupRoot, { appContents, panelSession, host });
    if (wc.getType() !== 'window') fail('it is not a registered browser popup');
  } else if (wc.getType() !== 'webview') fail(`it is a ${wc.getType()}, not a browser tab`);
  // the shared profile, or also the chats' own partitions (storage.cjs) when given a list
  const sessions = Array.isArray(panelSession) ? panelSession : [panelSession];
  if (!wc.session || !sessions.includes(wc.session)) fail("it is not in the browser panel's partition");
  const prefs = typeof wc.getLastWebPreferences === 'function' ? wc.getLastWebPreferences() || {} : {};
  if (prefs.preload) fail('it has a preload');
  // preloads in sub-frames (the page dialogs' preload, pagePreload.cjs) give a sandboxed page no Node
  if (prefs.nodeIntegration || (prefs.nodeIntegrationInSubFrames && !prefs.sandbox)) fail('it has Node integration');
  if ((view || popupRoot) && (!prefs.sandbox || !prefs.contextIsolation || prefs.webviewTag)) fail('it is not a sandboxed browser page');
  if (view) return;
  const owner = popupRoot ? keyOf(popupRoot).hostWebContents : wc.hostWebContents;
  if (!owner || !appContents.some((a) => a === owner)) fail('it does not belong to a MoPilot window');
  if (host && owner !== host) fail('it belongs to another window');
}

/**
 * An accessibility tree (Accessibility.getFullAXTree's nodes) as indented text. Interactive nodes get
 * refs (e1, e2, ...) that map to their backend DOM node ids for click and type.
 * @returns {{ text: string, refs: Map<string, number> }}
 */
function formatAxTree(nodes, { max = SNAPSHOT_MAX } = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  const lines = [];
  const refs = new Map();
  let size = 0;
  let cut = false;
  const clean = (v) =>
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const walk = (node, depth, parentName) => {
    if (!node || cut) return;
    const role = node.role ? String(node.role.value) : '';
    const name = clean(node.name && node.name.value);
    const text = role === 'StaticText';
    const silent = node.ignored || SILENT.has(role) || (text && (!name || name === parentName));
    let d = depth;
    if (!silent) {
      let line = `${'  '.repeat(depth)}- ${text ? 'text' : role}`;
      if (name) line += ` "${prefixUnits(name, 300)}"`;
      const value = clean(node.value && node.value.value);
      if (value && !text) line += ` value="${prefixUnits(value, 200)}"`;
      if (INTERACTIVE.has(role) && node.backendDOMNodeId) {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [ref=${ref}]`;
      }
      size += line.length + 1;
      if (size > max) {
        cut = true;
        lines.push('… (snapshot cut short)');
        return;
      }
      lines.push(line);
      d = depth + 1;
    }
    if (text) return;
    for (const id of node.childIds || []) walk(byId.get(id), d, name || parentName);
  };
  walk(root, 0, '');
  return { text: lines.join('\n'), refs };
}

function trackPage(entry) {
  entry.backend.on('did-start-loading', () => {
    entry.failure = null;
    entry.refs.clear();
  });
  entry.backend.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (isFailedLoad(entry.backend, code, url, mainFrame)) entry.failure = description || String(code);
  });
  entry.backend.on('did-navigate', () => entry.refs.clear());
  entry.backend.on('did-navigate-in-page', () => entry.refs.clear());
}

/**
 * The panel tabs agents drive, one per chat. A tab joins when its window reports it (attach); a chat
 * without one gets a new tab through `open`.
 */
class PanelBrowser {
  /**
   * @param {{ appContents: () => any[], panelSession: () => any, open: (chatId: string) => boolean | void, attachMs?: number,
   *           hang?: InstanceType<typeof import('./pageHang.cjs').PageHang> }} o
   *   hang: which pages stopped responding: a command to one fails at once (pageHang.cjs)
   */
  constructor(o) {
    this.o = o;
    this.attachMs = o.attachMs ?? ATTACH_MS;
    /** chat id -> { backend, refs } */
    this.tabs = new Map();
    // Only native children reported by the browser window policy may become CDP targets.
    this.popups = new Map();
    /** chat id -> resolvers waiting for its tab */
    this.waiting = new Map();
  }

  #check(wc, host) {
    const popupRoot = this.popups.get(keyOf(wc))?.root;
    assertCdpTarget(wc, { appContents: this.o.appContents(), panelSession: this.o.panelSession(), host, popupRoot });
  }

  registerPopup(opener, wc) {
    const root = this.popups.get(keyOf(opener))?.root || keyOf(opener);
    this.#check(opener);
    assertCdpTarget(wc, { appContents: this.o.appContents(), panelSession: this.o.panelSession(), popupRoot: root });
    const entry = { backend: new LocalTabContents(wc), root, refs: new Map() };
    this.popups.set(keyOf(wc), entry);
    this.#clearRefs(root);
    trackPage(entry);
    entry.backend.once('destroyed', () => {
      this.popups.delete(keyOf(wc));
      this.#clearRefs(root);
    });
  }

  #clearRefs(root) {
    for (const entry of this.tabs.values()) if (keyOf(entry.backend) === root) entry.refs.clear();
    for (const entry of this.popups.values()) if (entry.root === root) entry.refs.clear();
  }

  #active(entry) {
    const popups = [...this.popups.values()].filter((p) => p.root === keyOf(entry.backend) && !p.backend.isDestroyed());
    return popups[popups.length - 1] || entry;
  }

  /** A window reports the panel tab it opened for a chat. Throws (and keeps nothing) if it isn't one. */
  attach(chatId, wc, host) {
    if (typeof chatId !== 'string' || !chatId) throw new ToolError('no chat', 'bad_target');
    this.#check(wc, host);
    const prev = this.tabs.get(chatId);
    if (prev && keyOf(prev.backend) === keyOf(wc)) return;
    const entry = { backend: new LocalTabContents(wc), refs: new Map() };
    this.tabs.set(chatId, entry);
    trackPage(entry);
    entry.backend.once('destroyed', () => {
      if (this.tabs.get(chatId) === entry) this.tabs.delete(chatId);
    });
    for (const r of this.waiting.get(chatId) || []) r();
    this.waiting.delete(chatId);
  }

  /** The chat's tab, opening one if it has none. */
  async tab(chatId) {
    const have = this.tabs.get(chatId);
    if (have && !have.backend.isDestroyed()) return this.#active(have);
    const arrived = new Promise((resolve) => {
      const list = this.waiting.get(chatId) || [];
      list.push(resolve);
      this.waiting.set(chatId, list);
      setTimeout(resolve, this.attachMs).unref?.();
    });
    if (this.o.open(chatId) === false) throw new ToolError('There is no MoPilot window to open the browser in.', 'no_browser');
    await arrived;
    const got = this.tabs.get(chatId);
    if (!got || got.backend.isDestroyed()) throw new ToolError("The browser tab didn't open in MoPilot.", 'no_browser');
    return this.#active(got);
  }

  /** The URL the chat's tab shows now (its newest popup's, when one is open), or null when it has none; never opens one. */
  currentUrl(chatId) {
    const have = this.tabs.get(chatId);
    return have && !have.backend.isDestroyed() ? this.#active(have).backend.getURL() : null;
  }

  /** The tab's URL without touching CDP. */
  async url(chatId) {
    return (await this.tab(chatId)).backend.getURL();
  }

  /**
   * A CDP command on the chat's tab; the target is checked again before every attach.
   * @param {{ backend: any, expectedUrl?: string } | null} [entry] a page already looked up, and the URL it must still show
   */
  async send(chatId, method, params = {}, entry = null) {
    const wc = (entry || (await this.tab(chatId))).backend;
    this.#check(wc);
    if (entry?.expectedUrl && wc.getURL() !== entry.expectedUrl)
      throw new ToolError('The page changed. Take a fresh snapshot before continuing.', 'page_changed');
    refuseCrashed(wc, method);
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
    // a view no window shows drops input until its focus is emulated (#1509); nothing here detaches, so it lasts
    // until a browser_* turn or the page lets go of the debugger
    if (method.startsWith('Input.'))
      await focusForInput(wc, (m, p) => wc.debugger.sendCommand(m, p)).catch((error) => {
        // the input is still tried
        noteIgnored('emulate focus on a browser page before input', error);
      });
    return untilHung(
      this.o.hang,
      wc,
      () => wc.debugger.sendCommand(method, params),
      () =>
        new ToolError(
          "This page isn't responding: a script on it is busy. Don't retry it now: tell the user, who can wait, reload or close the tab from the browser pane.",
          'page_unresponsive',
        ),
    ).catch(crashedMidCommand(wc));
  }

  async navigate(chatId, url) {
    const t = await this.tab(chatId);
    return withLoadInterruption(t.backend, async (wait) => {
      t.refs.clear();
      t.failure = null;
      const loaded = waitEvent(t.backend, ['did-stop-loading', 'destroyed'], LOAD_MS);
      const r = await wait(this.send(chatId, 'Page.navigate', { url }, t));
      if (r && r.errorText) {
        // a link answered with a file aborts the navigation: the download is the outcome, not a failure (#1484)
        if (await wait(becameDownload(t.backend, url, r.errorText)))
          return { url: t.backend.getURL(), title: t.backend.getTitle(), note: DOWNLOAD_NOTE };
        throw new ToolError(openFailureNote(url, r.errorText), 'failed');
      }
      if (r && r.loaderId) {
        const finished = await wait(loaded);
        if (finished === 'destroyed')
          throw new ToolError('The browser window closed. Take a fresh snapshot to continue on the original page.', 'page_changed');
        if (finished === 'timeout' && t.backend.isLoading())
          throw new ToolError('The page is still loading. Take a fresh snapshot or ask the user to retry.', 'loading');
      }
      if (t.failure) throw new ToolError(loadFailureNote(t.failure), 'failed');
      return { url: t.backend.getURL(), title: t.backend.getTitle() };
    });
  }

  async snapshot(chatId, mode = 'accessibility', entry = null) {
    const t = entry || (await this.tab(chatId));
    this.#check(t.backend);
    const url = t.backend.getURL();
    const head = `URL: ${url}\nTitle: ${t.backend.getTitle()}\n\n`;
    const unchanged = () => {
      this.#check(t.backend);
      if (t.backend.getURL() !== url) throw new ToolError('The page changed while reading it. Take a fresh snapshot.', 'page_changed');
    };
    if (mode === 'text') {
      const r = await this.send(
        chatId,
        'Runtime.evaluate',
        { expression: 'document.body ? document.body.innerText : ""', returnByValue: true },
        t,
      );
      unchanged();
      const text = String((r && r.result && r.result.value) || '');
      return head + (text.length > SNAPSHOT_MAX ? `${prefixUnits(text, SNAPSHOT_MAX)}\n… (cut short)` : text);
    }
    const { nodes } = await this.send(chatId, 'Accessibility.getFullAXTree', {}, t);
    unchanged();
    const { text, refs } = formatAxTree(nodes || []);
    t.refs.clear();
    for (const [ref, id] of refs) t.refs.set(ref, id);
    return head + text;
  }

  /** The node a ref (from the last snapshot) or a CSS selector names, as CDP node params. */
  async #node(chatId, { ref, selector }, t) {
    if (ref) {
      const id = t.refs.get(ref);
      if (!id) throw new ToolError(`No element ${ref} in the last snapshot; take a new snapshot.`, 'bad_args');
      return { backendNodeId: id };
    }
    if (selector) {
      const { root } = await this.send(chatId, 'DOM.getDocument', { depth: 0 }, t);
      const { nodeId } = await this.send(chatId, 'DOM.querySelector', { nodeId: root.nodeId, selector }, t);
      if (!nodeId) throw new ToolError(`Nothing matches ${selector}.`, 'bad_args');
      return { nodeId };
    }
    throw new ToolError('Name the element with ref or selector.', 'bad_args');
  }

  /**
   * What a click or typing would act on: the element a ref or selector names, read with the page agent's facts
   * (chromeIntent.cjs ELEMENT_INTENT), so the sage_browser_* writes get browser_*'s checks. Null for nothing there;
   * UNREADABLE_FRAME when the page can't be read, which every sensitive check treats as unknown and asks.
   */
  async intent(chatId, target, entry = null) {
    const t = entry || (await this.tab(chatId));
    const node = await this.#node(chatId, target, t);
    try {
      const { object } = await this.send(chatId, 'DOM.resolveNode', node, t);
      const r = await this.send(
        chatId,
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: `function () { return (${ELEMENT_INTENT})(this); }`, returnByValue: true },
        t,
      );
      const v = r?.result?.value;
      if (!v?.mopilot_intent) return UNREADABLE_FRAME;
      return v.none ? null : v;
    } catch (error) {
      noteIgnored('read what a built-in browser action acts on', error);
      return UNREADABLE_FRAME;
    }
  }

  async click(chatId, target, entry = null) {
    const t = entry || (await this.tab(chatId));
    const node = await this.#node(chatId, target, t);
    await this.send(chatId, 'DOM.scrollIntoViewIfNeeded', node, t).catch((error) => {
      // scrolling is best effort; the box model below still locates the node
      noteIgnored('scroll the element into view before a click', error);
    });
    const { model } = await this.send(chatId, 'DOM.getBoxModel', node, t);
    const q = model.content;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    await this.send(chatId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, t);
    await this.send(chatId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, t);
    await this.send(chatId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, t);
    await this.#settle(t);
  }

  async type(chatId, target, text, submit = false, entry = null) {
    const t = entry || (await this.tab(chatId));
    const node = await this.#node(chatId, target, t);
    await this.send(chatId, 'DOM.focus', node, t);
    await this.send(chatId, 'Input.insertText', { text }, t);
    if (submit) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await this.send(chatId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' }, t);
      await this.send(chatId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key }, t);
      await this.#settle(t);
    }
  }

  async screenshot(chatId, entry = null) {
    const t = entry || (await this.tab(chatId));
    const url = t.backend.getURL();
    const { data } = await this.send(chatId, 'Page.captureScreenshot', { format: 'png' }, t);
    this.#check(t.backend);
    if (t.backend.getURL() !== url) throw new ToolError('The page changed while capturing it. Take a fresh snapshot.', 'page_changed');
    return { type: 'image', data, mimeType: 'image/png' };
  }

  /**
   * After an input that may navigate: until the page settled (pageSettle.cjs), a load the input started included (its
   * refs go stale then). These tools have no page agent or network log, so a page that is not loading has settled once
   * the input's navigation grace is over.
   */
  async #settle(t) {
    // OAuth may close its popup immediately after the action: a destroyed page has settled
    return settlePage({ wc: t.backend, ended: () => rendererGone(t.backend), onLoad: () => t.refs.clear() }, { maxMs: LOAD_MS });
  }
}

module.exports = { PARTITION, PanelBrowser, assertCdpTarget, formatAxTree, INTERACTIVE };
