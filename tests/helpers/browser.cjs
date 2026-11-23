const { EventEmitter } = require('node:events');

let nextId = 1;

/**
 * A webContents' CDP debugger that records its commands (method, params, session id) and answers them with `answer`.
 * Detaching emits 'detach', as Electron's does.
 */
function fakeDebugger(answer = () => ({})) {
  const dbg = Object.assign(new EventEmitter(), {
    attached: false,
    /** @type {any[][]} */
    commands: [],
    isAttached: () => dbg.attached,
    attach() {
      dbg.attached = true;
    },
    detach() {
      dbg.attached = false;
      dbg.emit('detach', {}, 'target closed');
    },
    sendCommand: async (method, params, sessionId) => {
      dbg.commands.push(sessionId === undefined ? [method, params] : [method, params, sessionId]);
      return answer(method, params, sessionId);
    },
  });
  return dbg;
}
function contents(options = {}) {
  const wc = Object.assign(
    new EventEmitter(),
    {
      id: nextId++,
      destroyed: false,
      type: 'webview',
      prefs: {},
      url: 'https://task.test/work',
      title: 'Task',
      loading: false,
      history: [],
      calls: [],
      attached: false,
      focusCount: 0,
    },
    options,
  );
  wc.isDestroyed = () => wc.destroyed;
  wc.getType = () => wc.type;
  wc.getLastWebPreferences = () => wc.prefs;
  wc.getURL = () => wc.url;
  wc.getTitle = () => wc.title;
  wc.isLoading = () => wc.loading;
  // as Electron's: a page that says it stopped loading is no longer loading, for every listener (and none is added)
  const emit = wc.emit.bind(wc);
  wc.emit = (name, ...args) => {
    if (name === 'did-stop-loading') wc.loading = false;
    return emit(name, ...args);
  };
  wc.focus = () => wc.focusCount++;
  wc.send = (channel, value) => wc.calls.push([channel, value]);
  wc.setIgnoreMenuShortcuts = (on) => {
    wc.ignoreMenuShortcuts = on;
  };
  wc.setWindowOpenHandler = (fn) => {
    wc.windowOpen = fn;
  };
  wc.navigationHistory = { getAllEntries: () => wc.history };
  wc.destroy = () => {
    wc.destroyed = true;
    wc.emit('destroyed');
  };
  wc.debugger = Object.assign(new EventEmitter(), {
    isAttached: () => wc.attached,
    attach: () => {
      wc.attached = true;
    },
    sendCommand: async (method, args) => {
      wc.calls.push([method, args]);
      if (wc.command) return wc.command(method, args);
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [
            { nodeId: 'r', role: { value: 'RootWebArea' }, childIds: ['b', 't'] },
            { nodeId: 'b', parentId: 'r', role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 10 },
            { nodeId: 't', parentId: 'r', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 11 },
          ],
        };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'Page.captureScreenshot') return { data: 'AA==' };
      if (method === 'Runtime.evaluate') return { result: { value: 'Page text' } };
      // what an action acts on (PanelBrowser.intent): nothing sensitive
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { mopilot_intent: true, none: true } } };
      if (method === 'Page.navigate') {
        wc.url = args.url;
        return {};
      }
      return {};
    },
  });
  return wc;
}

function browserWorld() {
  const session = {};
  const host = contents({ type: 'window', session: {}, url: 'app://index' });
  const root = contents({ session, hostWebContents: host });
  const wins = new Map();
  const windowFor = (wc) => {
    const win = {
      webContents: wc,
      dead: false,
      minimized: false,
      focused: 0,
      shown: 0,
      closed: 0,
      setMenu(menu) {
        this.menu = menu;
      },
      setTitle(title) {
        this.title = title;
      },
      isDestroyed() {
        return this.dead;
      },
      isMinimized() {
        return this.minimized;
      },
      restore() {
        this.minimized = false;
      },
      show() {
        this.shown++;
      },
      focus() {
        this.focused++;
      },
      close() {
        this.closed++;
        this.dead = true;
        wc.destroy();
      },
    };
    wins.set(wc, win);
    return win;
  };
  const parent = windowFor(host);
  const popup = (options = {}) => {
    const wc = contents({ type: 'window', session, prefs: { sandbox: true, contextIsolation: true }, ...options });
    return windowFor(wc);
  };
  return {
    session,
    host,
    root,
    parent,
    popup,
    wins,
    BrowserWindow: { fromWebContents: (wc) => wins.get(wc) },
    appContents: () => [host],
    panelSession: () => session,
  };
}

module.exports = { contents, browserWorld, fakeDebugger };
