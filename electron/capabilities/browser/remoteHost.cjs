// The browser host for a remote Host's headless Chromium (design/host/index.html, package 2.6): the same BrowserTabs the browser_* tools run on, with the chat's tabs on that Host as its pages.
//
// The browser_* implementations (hostTools.cjs and the layers under them) are reused as they are; only the host's options differ.
// One RemoteTabs serves one Host, so a tab is always (hostId, chatId, targetId) and never crosses Hosts or chats (the Host's service
// refuses a command for a tab the chat does not own).
// - spawn opens the chat's tab on the Host; open and select change nothing on screen (the pane shows a tab by screenshot, remoteFrames.cjs).
// - A tab a page opens (window.open, target=_blank) joins the chat's tabs as a tab of its own, as a view tab's popup does in the pane.
// - The chat's tabs live on the Host across turns: a turn end only lets go of CDP, and the Host closes a chat's tabs once it stayed idle
//   (the Mac may be away), or at the chat's end (forget).
// - Stop (abort) tells the Host to drop a drag in progress and let go of the chat's sessions, so a command still waiting fails at once.
// - A download lands in the chat's folder on the Host; the agent's next result says so (the file stays on the Host).
const { BrowserTabs } = require('./host.cjs');
const { RemoteTabContents } = require('./remoteTab.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { tabOf } = require('./hostTabState.cjs');
const { checkScreenshot } = require('./screenshotCheck.cjs');
const { encodeTabKey } = require('./hostTabKey.cjs');
const { downloadOutcome } = require('./agentDownloads.cjs');

/**
 * The transport with its failures as the tool layer reports them: a ToolError that keeps the Host's code (an unreachable Host is
 * `not_connected`), so an agent is told what to do next instead of seeing a bare error.
 * @template {Record<string, any>} T
 * @param {T} transport
 * @returns {T}
 */
function asToolErrors(transport) {
  const wrapped = Object.create(transport);
  for (const name of ['open', 'attach', 'detach', 'command', 'close', 'release', 'abort']) {
    wrapped[name] = (...args) =>
      transport[name](...args).catch((e) => {
        if (e instanceof ToolError) throw e;
        const code = e?.code === 'host_unreachable' ? 'not_connected' : typeof e?.code === 'string' ? e.code : 'failed';
        throw new ToolError(String(e?.message ?? e), code);
      });
  }
  return wrapped;
}

/** The JPEG quality of a pane frame: the page must be readable, and a frame crosses the tunnel about once a second. */
const FRAME_QUALITY = 60;
const MAX_NAME = 200;
const MAX_PATH = 400;

/** A Host's text as one short line: controls, line and paragraph separators and direction marks become spaces, runs of spaces one, and the rest is cut at `max`. @param {unknown} v @param {number} max */
const oneLine = (v, max) =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, max);

/** The Mac-side tabs of one Host's browser service. */
class RemoteTabs extends BrowserTabs {
  /**
   * @param {ConstructorParameters<typeof BrowserTabs>[0]} o
   * @param {string} hostId
   * @param {Pick<import('./remoteTab.cjs').RemoteTransport, 'open'> & { release: (chatId: string) => Promise<unknown> }} transport
   */
  constructor(o, hostId, transport) {
    super(o);
    this.hostId = hostId;
    this.transport = transport;
    /** Stops following the Host and Stop (set by remoteBrowserTabs). @type {() => void} */
    this.dispose = /** @type {() => void} */ (/** @type {unknown} */ (null));
  }

  /** Opens a tab for the chat on the Host; resolves once the Host has made it. */
  async create(chatId, o) {
    const tab = await super.create(chatId, o);
    await /** @type {InstanceType<typeof RemoteTabContents>} */ (tab.backend).created;
    return tab;
  }

  /**
   * The chat's tabs as TargetLeases, with the Host they are on: a tab id means nothing on another Host.
   * @returns {import('../targetLeases.cjs').Lease[]}
   */
  leases(chatId) {
    return super.leases(chatId).map((l) => ({ ...l, hostId: this.hostId }));
  }

  /**
   * One frame of the chat's tab for the pane: the page as the Host's Chromium paints it, JPEG, with the page's size in CSS pixels (what a
   * click on the frame maps to) and where it is. It is the user's own view of their agent's page, so it is not masked as a screenshot
   * for the model is.
   * @param {string} chatId @param {string | null} tabKey the tab's browser_* id, or null for the chat's current tab
   * @returns {Promise<{ data: Buffer, mime: 'image/jpeg', width: number, height: number, url: string, title: string, loading: boolean }>}
   */
  async frame(chatId, tabKey) {
    const tab = tabKey ? this.byKey(chatId, tabKey) : this.current(chatId);
    if (!tab) throw new ToolError('This tab is closed.', 'tab_closed');
    const [shot, metrics] = await Promise.all([
      tab.send('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY }),
      tab.send('Page.getLayoutMetrics'),
    ]);
    const view = metrics.cssVisualViewport;
    return {
      data: Buffer.from(String(shot.data), 'base64'),
      mime: 'image/jpeg',
      width: Math.round(view.clientWidth),
      height: Math.round(view.clientHeight),
      url: tab.url,
      title: tab.title,
      loading: tab.backend.isLoading(),
    };
  }

  /** The chat ended (deleted, archived, cleared): its tabs on the Host go with it. */
  forget(chatId) {
    super.forget(chatId);
    this.transport.release(chatId).catch((error) => noteIgnored("close a finished chat's tabs on a Host", error));
  }
}

/**
 * The browser host whose tabs are the chats' tabs on one Host.
 * @param {{ hostId: string,
 *           transport: import('./remoteTab.cjs').RemoteTransport & {
 *             release: (chatId: string) => Promise<unknown>, abort: (chatId: string) => Promise<unknown>,
 *             subscribe: (chatId: string, fn: (event: any) => void) => () => void },
 *           images: { fromBuffer: (buf: Buffer) => any },
 *           modelOf?: (chatId: string) => string | null | Promise<string | null>,
 *           onChange?: (chatId: string) => void,
 *           onAbort: (fn: (chatId: string) => void) => () => void,
 *           pane?: { open: (req: { chatId: string, tabKey: string, focus?: boolean, after?: string | null }) => unknown,
 *                    select: (req: { chatId: string, tabKey: string, auto?: boolean }) => unknown,
 *                    close: (req: { chatId: string, tabKey: string }) => unknown },
 *           hang?: InstanceType<typeof import('./pageHang.cjs').PageHang> }} o
 *   pane: how a window is told to open, show and close the pane tab of a tab on this Host (the pane key names the Host: hostTabKey.cjs); without it the tabs work with no pane tab.
 *   hang: which pages stopped responding (the 3 s rule of pageHang.cjs); onAbort: hears a chat's calls being stopped (Registry.onAbort)
 */
function remoteBrowserTabs({ hostId, transport: raw, images, modelOf, onChange, onAbort, hang, pane }) {
  /** A tab's pane key, which names this Host. */
  const keyOf = (/** @type {string} */ tabKey) => /** @type {string} */ (encodeTabKey(hostId, tabKey));
  const transport = asToolErrors(raw);
  /** chat id -> target id -> its contents */
  const byChat = new Map();
  /** chat id -> stops following the Host's events for it */
  const following = new Map();
  /** chat id -> guid -> the download's name and entry, from the Host's start report to its end */
  const downloads = new Map();
  const contentsOf = (chatId) => {
    let m = byChat.get(chatId);
    if (!m) byChat.set(chatId, (m = new Map()));
    return m;
  };
  const track = (chatId, wc) => {
    wc.created.then(
      () => {
        if (!wc.isDestroyed()) contentsOf(chatId).set(wc.targetId, wc);
      },
      () => undefined,
    );
    wc.once('destroyed', () => {
      const m = byChat.get(chatId);
      if (m && m.get(wc.targetId) === wc) m.delete(wc.targetId);
    });
    return wc;
  };

  /** The Host's report of what happened to the chat's tabs. */
  const heard = (chatId, event) => {
    const mine = contentsOf(chatId);
    const all = () => [...mine.values()];
    switch (event.type) {
      case 'cdp':
        // a tab the chat closed meanwhile has no one to tell
        mine.get(event.targetId)?.event(event.sessionId, event.method, event.params);
        break;
      case 'closed':
        // a closed tab; with no target id the chat's context itself went
        if (event.targetId) mine.get(event.targetId)?.gone('closed');
        else {
          for (const t of all()) t.gone('closed');
          // the Host dropped the chat's listeners with its context: the next tab subscribes anew
          stopFollowing(chatId);
        }
        break;
      case 'exit':
        for (const t of all()) t.gone("The Host's browser stopped");
        stopFollowing(chatId);
        break;
      case 'opened': {
        const opener = mine.get(event.openerId);
        if (!opener) break;
        const popup = track(
          chatId,
          new RemoteTabContents({ transport, hostId, chatId, tab: { targetId: event.targetId, url: event.url } }),
        );
        mine.set(event.targetId, popup);
        if (tabs.adoptPopup(opener, popup, { asTab: true })) tabs.emit(chatId);
        else popup.gone();
        break;
      }
      case 'download':
        reportDownload(chatId, event);
        break;
      default:
    }
  };

  const reportDownload = (chatId, d) => {
    // the Host's words reach the agent's next result: one short line, with no control, line-break or direction-changing character, so a file name cannot pose as a result line
    d = { ...d, filename: oneLine(d.filename, MAX_NAME) || 'download', path: oneLine(d.path, MAX_PATH) };
    let mine = downloads.get(chatId);
    if (!mine) downloads.set(chatId, (mine = new Map()));
    if (d.state === 'inProgress') {
      // a download of a frame that is not one of the chat's tabs is not the agent's
      const wc = contentsOf(chatId).get(d.targetId);
      const tab = wc && tabOf(tabs, wc);
      if (!tab) return;
      const entry = { name: d.filename, path: '', state: 'progressing' };
      mine.set(d.guid, { name: d.filename, entry });
      tab.downloads.push(entry);
      if (tab.downloads.length > 20) tab.downloads.shift();
      tabs.change(chatId, `download_started ${d.filename} in ${tab.id}`);
      return;
    }
    const started = mine.get(d.guid);
    if (!started) return;
    mine.delete(d.guid);
    const state = d.state === 'completed' ? 'completed' : d.state === 'canceled' ? 'cancelled' : 'interrupted';
    Object.assign(started.entry, { state, path: d.path });
    tabs.change(chatId, downloadOutcome(state, started.name, `${d.path} (on the Host)`));
  };

  const follow = (chatId) => {
    if (following.has(chatId)) return;
    following.set(
      chatId,
      transport.subscribe(chatId, (event) => heard(chatId, event)),
    );
  };
  const stopFollowing = (chatId) => {
    following.get(chatId)?.();
    following.delete(chatId);
    downloads.delete(chatId);
  };

  const tabs = new RemoteTabs(
    {
      // no MoPilot window or partition is a remote tab: assertCdpTarget lets backend tabs through on their own check
      appContents: () => [],
      panelSession: () => null,
      spawn: (chatId) =>
        track(
          chatId,
          new RemoteTabContents({
            transport,
            hostId,
            chatId,
            open: transport.open(chatId).then((t) => {
              follow(chatId);
              return t;
            }),
          }),
        ),
      // the agent opened a tab: the window shows it (the tab itself needs no window, it is on the Host)
      open: (chatId, { tabKey, focus, after }) => {
        pane?.open({
          chatId,
          tabKey: keyOf(tabKey),
          focus,
          ...(after === undefined ? {} : { after: typeof after === 'string' ? keyOf(after) : after }),
        });
        return true;
      },
      close: (tab) => {
        const wc = /** @type {InstanceType<typeof RemoteTabContents>} */ (tab.backend);
        const gone = () => wc.gone('closed');
        pane?.close({ chatId: tab.chatId, tabKey: keyOf(tab.id) });
        // still opening: it goes now, and the Host's tab once it exists, so none is left without an owner
        if (wc.targetId == null) {
          gone();
          wc.created.then(
            () =>
              transport
                .close(tab.chatId, /** @type {string} */ (wc.targetId))
                .catch((error) => noteIgnored('close a tab on a Host', error)),
            () => undefined,
          );
          return;
        }
        transport.close(tab.chatId, wc.targetId).then(gone, (error) => noteIgnored('close a tab on a Host', error));
      },
      select: (tab, { auto = false } = {}) => pane?.select({ chatId: tab.chatId, tabKey: keyOf(tab.id), ...(auto ? { auto: true } : {}) }),
      // a Host's bytes are looked at before the decoder sees them
      images: { fromBuffer: (buf) => images.fromBuffer(checkScreenshot(buf)) },
      modelOf,
      onChange,
      keepTabsOnTurnEnd: true,
      ...(hang ? { hang } : {}),
    },
    hostId,
    transport,
  );

  /** Stop: the Host lets go of the chat's sessions; the debuggers here are let go at once, so nothing that was waiting continues. */
  const stop = (chatId) => {
    const stopping = transport.abort(chatId);
    for (const t of tabs.list(chatId)) {
      t.backend.hold(stopping);
      t.backend.debugger.lost('stopped');
    }
    stopping.catch((error) => noteIgnored("stop a chat's tabs on a Host", error));
  };
  const offAbort = onAbort(stop);
  const forget = tabs.forget.bind(tabs);
  tabs.forget = (chatId) => {
    stopFollowing(chatId);
    byChat.delete(chatId);
    forget(chatId);
  };
  tabs.dispose = () => {
    offAbort();
    for (const chatId of [...following.keys()]) stopFollowing(chatId);
  };
  return tabs;
}

module.exports = { remoteBrowserTabs, RemoteTabs };
