// The pane's window onto a Host chat's desktop (G8 #3903, docs: designs/twelve-grid-sota-gap/g8-sandbox-spike.md "Frames for the pane"): main fetches one screenshot of the Host's display at a time while a pane shows it and pushes it to that window, and while the user has taken over their clicks, scrolls and keys reach the Host's desktop.
//
// IPC: desktop:remoteWatch (paneId, chatId, hostId) starts following a chat's desktop, desktop:remoteView (paneId, { visible, takeover }) tells how the pane shows it,
// desktop:remoteStop (paneId), desktop:remoteInput (paneId, input) forwards one input; push: desktop:remoteFrame to the watching window.
// The frames are the same polled stills the remote browser's pane shows (browser/remoteFrames.cjs), never a stream. A frame is taken under the chat's own lease: a chat that holds no lease has nothing to show, and the pane says so. Nothing is forwarded unless main's tab says the user took over (not what a pane claims); a takeover has already stopped the agent's running desktop actions and let go of what it held (hostDesktopTabs.cjs), and the user's input then takes its own lease on the Host, handed back at the hand back. A watch is for one machine: a chat that moves to another stops it.
const { STALE_FRAME } = require('./hostDesktopFrames.cjs');
const { createFramePoller } = require('./browser/remoteFrames.cjs');
const { createDesktopFramePacing, ACTIVE_FRAME_MS } = require('./hostDesktopFrames.cjs');
const { userError } = require('../../shared/userError.mjs');

const MAX_COORD = 100_000;
const MAX_TEXT = 10_000;
const BUTTONS = new Set(['left', 'right', 'middle']);
const num = (/** @type {unknown} */ v, lo = -MAX_COORD, hi = MAX_COORD) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The helper request for one input of the user's, in the Host display's points, or null for anything this does not forward. `frame` is the last frame shown: a point in it is in pixels of the image.
 * @param {any} input { kind: 'click', x, y, button?, count? } | { kind: 'scroll', x, y, dx, dy } | { kind: 'key', key } | { kind: 'text', text } (x, y in the frame's pixels)
 * @param {{ pixelsPerPoint: number, display: { x: number, y: number } } | null} frame
 * @returns {{ method: string, params: object } | null}
 */
function inputCall(input, frame) {
  if (!input || typeof input !== 'object') return null;
  const point = () => {
    if (!frame || !num(input.x) || !num(input.y) || !(frame.pixelsPerPoint > 0)) return null;
    return { x: frame.display.x + input.x / frame.pixelsPerPoint, y: frame.display.y + input.y / frame.pixelsPerPoint };
  };
  if (input.kind === 'click') {
    const p = point();
    const button = input.button ?? 'left';
    const count = input.count ?? 1;
    if (!p || !BUTTONS.has(button) || !Number.isInteger(count) || count < 1 || count > 3) return null;
    return { method: 'input.click', params: { ...p, button, count } };
  }
  if (input.kind === 'scroll') {
    const p = point();
    if (!p || !num(input.dx) || !num(input.dy)) return null;
    return { method: 'input.scroll', params: { ...p, dx: input.dx, dy: input.dy } };
  }
  if (input.kind === 'key')
    return typeof input.key === 'string' && input.key && input.key.length <= 64
      ? { method: 'input.key', params: { key: input.key } }
      : null;
  if (input.kind === 'text')
    return typeof input.text === 'string' && input.text && input.text.length <= MAX_TEXT
      ? { method: 'input.type', params: { text: input.text } }
      : null;
  return null;
}

/**
 * @param {object} o
 * @param {{ handle: (channel: string, fn: (e: any, ...args: any[]) => unknown) => void }} o.ipcMain
 * @param {(hostId: string) => { command: (chatId: string, method: string, params?: object) => Promise<any>, generation?: () => unknown, lease: (chatId: string, apps: string[] | '*') => Promise<any>, release: (chatId: string) => Promise<any> } | null} o.remoteOf a Host's desktop (RemoteDesktop), null while that Host is not connected
 * @param {(chatId: string) => string | null} o.hostOf the Host the chat's desktop is on now, null for this Mac or unknown
 * @param {(chatId: string) => boolean} o.takenOver the user took the chat's desktop over (main's tab, the only authority for input)
 * @param {(hostId: string, chatId: string, shot: any) => number} o.frameVersion the display layout version a frame's screenshot has (the agent's cursor is drawn only on a frame of the version it was placed by)
 * @param {(chatId: string) => boolean} o.agentHolds the agent holds the chat's desktop on the Host again (the user's lease is gone with it: a late release must not end it)
 * @param {(chatId: string) => Promise<void> | undefined} o.settled the takeover's stop of the agent's side (undefined: none under way)
 * @param {(hostId: string) => void} o.hostLost a watched machine is not connected: a takeover on it ends
 * @param {typeof createFramePoller} [o.poller]
 * @param {(what: string, error: unknown) => void} o.report
 */
function registerRemoteDesktopView({
  ipcMain,
  remoteOf,
  hostOf,
  takenOver,
  agentHolds,
  frameVersion,
  settled,
  hostLost,
  report,
  poller = createFramePoller,
}) {
  /** `${window}:${pane}` -> what that pane follows. @type {Map<string, { sender: any, paneId: string, chatId: string, hostId: string, turn?: number, userLease?: boolean, acting?: boolean, release: () => Promise<void>, takeover: boolean, frame: any, stop: () => void, unsubscribe: () => void, view: (v: { visible?: boolean, takeover?: boolean }) => void }>} */
  const watches = new Map();
  const pacing = createDesktopFramePacing({ remoteOf, hostOf });
  const keyOf = (/** @type {any} */ e, /** @type {unknown} */ paneId) => `${e.sender.id}:${String(paneId)}`;
  const stopWatch = (/** @type {string} */ key) => {
    const watch = watches.get(key);
    // a pane that closes while the user drives gives the desktop back to the Host
    watch?.release().catch((/** @type {unknown} */ error) => report("let go of the user's lease on a Host's desktop", error));
    watch?.stop();
    watch?.unsubscribe();
    watches.delete(key);
  };
  const push = (/** @type {any} */ sender, /** @type {unknown} */ message) => {
    if (!sender.isDestroyed()) sender.send('desktop:remoteFrame', message);
  };

  ipcMain.handle('desktop:remoteWatch', (e, paneId, chatId, hostId) => {
    if (typeof paneId !== 'string' || !paneId || typeof chatId !== 'string' || !chatId || typeof hostId !== 'string' || !hostId)
      return false;
    const key = keyOf(e, paneId);
    stopWatch(key);
    // a chat that is on another machine (or this Mac) than the pane's is not this pane's to show
    if (hostOf(chatId) !== hostId) return false;
    /** @type {any} */
    const watch = { sender: e.sender, paneId, chatId, hostId, takeover: false, visible: false, frame: null };
    const polling = poller({
      activeMs: ACTIVE_FRAME_MS,
      fetch: async (chat) => {
        if (hostOf(chat) !== hostId) {
          // the chat moved: this pane's machine is not where it runs now
          watch.frame = null;
          stopWatch(key);
          throw Object.assign(new Error('This chat now runs on another machine.'), { code: 'moved' });
        }
        const remote = remoteOf(hostId);
        if (!remote) {
          // the machine is not connected (yet): the pane says so and keeps trying; a takeover on it ends
          watch.frame = null;
          hostLost(hostId);
          throw Object.assign(new Error('The machine is not connected.'), { code: 'not_connected' });
        }
        const generation = remote.generation?.();
        const shot = await pacing.fetch(hostId, chat, () => watches.get(key) === watch && watch.visible);
        return {
          data: Buffer.from(String(shot.png ?? shot.jpeg ?? ''), 'base64'),
          mime: shot.mimeType ?? (shot.jpeg ? 'image/jpeg' : 'image/png'),
          shot,
          connection: { remote, generation },
        };
      },
    }).watch({
      chatId,
      tabKey: null,
      onFrame: (f) => {
        const connection = /** @type {any} */ (f).connection;
        if (
          watches.get(key) !== watch ||
          !watch.visible ||
          hostOf(chatId) !== hostId ||
          remoteOf(hostId) !== connection.remote ||
          connection.remote.generation?.() !== connection.generation
        )
          return;
        const shot = /** @type {any} */ (f).shot;
        const version = frameVersion(hostId, chatId, shot);
        watch.frame = { pixelsPerPoint: shot.pixelsPerPoint, display: shot.display };
        push(e.sender, {
          paneId,
          data: f.data.toString('base64'),
          mime: f.mime,
          width: shot.width,
          height: shot.height,
          pixelsPerPoint: shot.pixelsPerPoint,
          display: shot.display,
          version,
        });
      },
      onError: (error) => {
        if (watches.get(key) !== watch || !watch.visible || hostOf(chatId) !== hostId) return;
        // an overtaken capture is not shown and keeps the frame the user's input is mapped by
        if (/** @type {any} */ (error)?.code === STALE_FRAME) return;
        // the chat's own action is running, so no capture was sent for it: a quiet pane is not a broken one
        if (/** @type {any} */ (error)?.code === 'fetch_timeout' && watch.acting) return;
        watch.frame = null;
        push(e.sender, /** @type {any} */ (error)?.code === 'no_lease' ? { paneId, idle: true } : { paneId, error: userError(error) });
      },
    });
    watch.stop = polling.stop;
    watch.unsubscribe = pacing.subscribe(hostId, chatId, (active, refresh) => {
      watch.acting = active;
      polling.setActive(active);
      if (refresh) polling.refresh();
    });
    /** Gives the user's lease back, once, and only while it is still the Host's holder: the agent's next lease replaced it. */
    watch.release = async () => {
      if (!watch.userLease) return;
      watch.userLease = false;
      if (!agentHolds(chatId)) await remoteOf(hostId)?.release(chatId);
    };
    watch.view = (/** @type {{ visible?: boolean, takeover?: boolean }} */ v) => {
      if (v.visible !== undefined) {
        watch.visible = v.visible;
        polling.setVisible(v.visible);
      }
      // a pane's claim counts only while main's tab agrees
      const on = v.takeover === undefined ? undefined : v.takeover && takenOver(chatId);
      if (on !== undefined && on !== watch.takeover) {
        watch.takeover = on;
        // the agent's side is let go first (settled); then the user's input holds the desktop under the chat's lease, and gives it back at the hand back
        const turn = (watch.turn = (watch.turn ?? 0) + 1);
        (async () => {
          const remote = remoteOf(hostId);
          if (on) {
            await settled(chatId);
            await remote?.lease(chatId, '*');
            watch.userLease = true;
            // handed back or closed while the lease was being taken
            if (!watch.takeover) await watch.release();
          } else await watch.release();
          if (watch.turn === turn) polling.setTakeover(on);
        })().catch((error) => {
          report('hand a Host desktop between the agent and the user', error);
          push(e.sender, { paneId, error: userError(error) });
        });
      }
    };
    watches.set(key, watch);
    e.sender.once('destroyed', () => stopWatch(key));
    return true;
  });
  ipcMain.handle('desktop:remoteView', (e, paneId, view) => {
    const watch = watches.get(keyOf(e, paneId));
    if (!watch || !view || typeof view !== 'object') return false;
    watch.view({
      visible: typeof view.visible === 'boolean' ? view.visible : undefined,
      takeover: typeof view.takeover === 'boolean' ? view.takeover : undefined,
    });
    return true;
  });
  ipcMain.handle('desktop:remoteStop', (e, paneId) => {
    const key = keyOf(e, paneId);
    const had = watches.has(key);
    stopWatch(key);
    return had;
  });
  ipcMain.handle('desktop:remoteInput', async (e, paneId, input) => {
    const watch = watches.get(keyOf(e, paneId));
    // only a desktop main's tab says the user took over takes their input (never a pane's claim): the agent's desktop is watched, not driven from the pane
    if (!watch || !watch.takeover || !takenOver(watch.chatId) || hostOf(watch.chatId) !== watch.hostId) return false;
    const call = inputCall(input, watch.frame);
    const remote = call ? remoteOf(watch.hostId) : null;
    if (!call || !remote) return false;
    try {
      await pacing.around(watch.hostId, watch.chatId, call.method, () => remote.command(watch.chatId, call.method, call.params));
      return true;
    } catch (error) {
      report("forward the user's input to a Host's desktop", error);
      // the pane says it: a lost lease is not a silent dead click
      push(watch.sender, { paneId, error: userError(error) });
      return false;
    }
  });
  return {
    aroundAction: pacing.around,
    retireChat: pacing.retireChat,
    retireHost: pacing.retireHost,
    /** The agent's cursor for a chat: every pane that watches the chat gets it. @param {string} chatId @param {{ hostId: string }} cursor */
    cursorTo: (chatId, cursor) => {
      // only a pane of the machine the cursor is on, and only while the chat is still there
      for (const [, w] of watches)
        if (w.chatId === chatId && w.hostId === cursor.hostId && hostOf(chatId) === w.hostId) push(w.sender, { paneId: w.paneId, cursor });
    },
    watching: () => watches.size,
    stopAll: () => {
      pacing.dispose();
      [...watches.keys()].forEach(stopWatch);
    },
  };
}

module.exports = { registerRemoteDesktopView, inputCall };
