// The pane's window onto a tab on a Host (design/host/index.html, package 2.6): main fetches the tab's frames while a pane shows it and pushes them to that window, and while the user has taken the tab over their clicks and keys reach the page.
//
// IPC: browser:remoteWatch (paneId, chatId, tabKey) starts following a tab, browser:remoteView (paneId, { visible, takeover }) tells how the
// pane shows it, browser:remoteStop (paneId), browser:remoteInput (paneId, input) forwards one input; push: browser:remoteFrame to the watching window.
// A pane key names the Host (hostTabKey.cjs). Nothing is forwarded unless the tab is the user's (takeOver): the agent's page is only watched.
const { decodeTabKey } = require('./hostTabKey.cjs');
const { createFramePoller } = require('./remoteFrames.cjs');
const { userError } = require('../../../shared/userError.mjs');

const MAX_COORD = 100_000;
const MAX_TEXT = 10_000;
const BUTTONS = { left: 1, right: 2, middle: 4 };
const MOUSE = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' };
const KEY = { down: 'keyDown', up: 'keyUp' };

const num = (/** @type {unknown} */ v, lo = -MAX_COORD, hi = MAX_COORD) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (/** @type {unknown} */ v, max = 64) => typeof v === 'string' && v.length <= max;

/**
 * The CDP command for one input of the user's, or null for anything this does not forward.
 * @param {any} input { kind: 'mouse', type: 'down' | 'up' | 'move' | 'wheel', x, y, button?, clickCount?, deltaX?, deltaY?, modifiers? }
 *   | { kind: 'key', type: 'down' | 'up', key, code?, text?, keyCode?, modifiers? } | { kind: 'text', text }
 * @returns {{ method: string, params: object } | null}
 */
function inputCommand(input) {
  if (!input || typeof input !== 'object') return null;
  const modifiers = input.modifiers ?? 0;
  if (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) return null;
  if (input.kind === 'mouse') {
    const type = Object.hasOwn(MOUSE, input.type) ? MOUSE[input.type] : null;
    const button = input.button ?? 'left';
    if (!type || !num(input.x) || !num(input.y) || !Object.hasOwn(BUTTONS, button)) return null;
    const clickCount = input.clickCount ?? 1;
    const deltaX = input.deltaX ?? 0;
    const deltaY = input.deltaY ?? 0;
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3 || !num(deltaX) || !num(deltaY)) return null;
    const pressed = input.type === 'down' || input.type === 'move';
    return {
      method: 'Input.dispatchMouseEvent',
      params: { type, x: input.x, y: input.y, button, buttons: pressed ? BUTTONS[button] : 0, clickCount, deltaX, deltaY, modifiers },
    };
  }
  if (input.kind === 'key') {
    const type = Object.hasOwn(KEY, input.type) ? KEY[input.type] : null;
    if (!type || !str(input.key) || !input.key || !str(input.code ?? '') || !str(input.text ?? '', 8)) return null;
    const keyCode = input.keyCode ?? 0;
    if (!Number.isInteger(keyCode) || keyCode < 0 || keyCode > 255) return null;
    // a printable key types its character with the press
    return {
      method: 'Input.dispatchKeyEvent',
      params: {
        type,
        key: input.key,
        code: input.code ?? '',
        windowsVirtualKeyCode: keyCode,
        modifiers,
        ...(type === 'keyDown' && input.text ? { text: input.text } : {}),
      },
    };
  }
  if (input.kind === 'text')
    return str(input.text, MAX_TEXT) && input.text ? { method: 'Input.insertText', params: { text: input.text } } : null;
  return null;
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {() => InstanceType<typeof import('./tabsByHost.cjs').TabsByHost> | null | undefined} o.hosts every Host's tabs
 * @param {typeof createFramePoller} [o.poller]
 * @param {(what: string, error: unknown) => void} [o.report] where a failure that is only noted goes (main passes the app's reporter)
 */
function registerRemoteView({ ipcMain, hosts, poller = createFramePoller, report }) {
  /** `${window}:${pane}` -> what that pane follows. @type {Map<string, { sender: Electron.WebContents, hostId: string, chatId: string, tabKey: string, stop: () => void, view: (v: { visible?: boolean, takeover?: boolean }) => void }>} */
  const watches = new Map();
  const keyOf = (/** @type {Electron.IpcMainInvokeEvent} */ e, /** @type {unknown} */ paneId) => `${e.sender.id}:${String(paneId)}`;
  const stopWatch = (/** @type {string} */ key) => {
    watches.get(key)?.stop();
    watches.delete(key);
  };
  const push = (/** @type {Electron.WebContents} */ sender, /** @type {unknown} */ message) => {
    if (!sender.isDestroyed()) sender.send('browser:remoteFrame', message);
  };

  ipcMain.handle('browser:remoteWatch', (e, paneId, chatId, tabKey) => {
    if (typeof paneId !== 'string' || !paneId || typeof chatId !== 'string' || !chatId) return false;
    const key = keyOf(e, paneId);
    stopWatch(key);
    const target = decodeTabKey(tabKey);
    if (!target.tabKey) return false;
    const tabs = hosts()?.existing(target.hostId);
    if (!tabs || target.hostId === 'local') return false;
    const polling = poller({ fetch: (chat, tab) => /** @type {any} */ (tabs).frame(chat, tab) }).watch({
      chatId,
      tabKey: target.tabKey,
      onFrame: (f) =>
        push(e.sender, {
          paneId,
          data: /** @type {Buffer} */ (f.data).toString('base64'),
          mime: f.mime,
          width: /** @type {any} */ (f).width,
          height: /** @type {any} */ (f).height,
          url: /** @type {any} */ (f).url,
          title: /** @type {any} */ (f).title,
          loading: /** @type {any} */ (f).loading,
        }),
      onError: (error) => push(e.sender, { paneId, error: userError(error) }),
    });
    watches.set(key, {
      sender: e.sender,
      hostId: target.hostId,
      chatId,
      tabKey: target.tabKey,
      stop: polling.stop,
      view: (v) => {
        if (v.visible !== undefined) polling.setVisible(v.visible);
        if (v.takeover !== undefined) polling.setTakeover(v.takeover);
      },
    });
    e.sender.once('destroyed', () => stopWatch(key));
    return true;
  });
  ipcMain.handle('browser:remoteView', (e, paneId, view) => {
    const watch = watches.get(keyOf(e, paneId));
    if (!watch || !view || typeof view !== 'object') return false;
    watch.view({
      visible: typeof view.visible === 'boolean' ? view.visible : undefined,
      takeover: typeof view.takeover === 'boolean' ? view.takeover : undefined,
    });
    return true;
  });
  ipcMain.handle('browser:remoteStop', (e, paneId) => {
    const key = keyOf(e, paneId);
    const had = watches.has(key);
    stopWatch(key);
    return had;
  });
  ipcMain.handle('browser:remoteInput', async (e, paneId, input) => {
    const watch = watches.get(keyOf(e, paneId));
    const command = watch ? inputCommand(input) : null;
    if (!watch || !command) return false;
    const tabs = /** @type {any} */ (hosts()?.existing(watch.hostId));
    const tab = tabs?.byKey(watch.chatId, watch.tabKey);
    // only a tab the user took over takes their input: the agent's page is watched, not driven from the pane
    if (!tab || !tab.takenOver) return false;
    try {
      await tab.send(command.method, command.params);
      return true;
    } catch (error) {
      report?.("forward the user's input to a tab on a Host", error);
      return false;
    }
  });
  return { watching: () => watches.size, stopAll: () => [...watches.keys()].forEach(stopWatch) };
}

module.exports = { registerRemoteView, inputCommand };
