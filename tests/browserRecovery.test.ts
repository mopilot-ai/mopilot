import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { browserUrl, isWebUrl, isIdentityProvider, restartUrl } from '../shared/browser.mjs';

const require = createRequire(import.meta.url);
const { browserWorld } = require('./helpers/browser.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { chromeHandoff, cancelChromeHandoff } = require('../electron/capabilities/browser/handoff.cjs');

test('addresses: domains, local previews, search and rejected protocols/credentials', () => {
  for (const [input, expected] of [
    ['https://EXAMPLE.com/path', 'https://example.com/path'],
    [' example.com/x ', 'https://example.com/x'],
    ['localhost:5199?q=hi', 'http://localhost:5199/?q=hi'],
    ['demo.localhost/a', 'http://demo.localhost/a'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['example.com:8080/', 'https://example.com:8080/'],
    ['about:blank', 'about:blank'],
    ['cats and dogs', 'https://www.google.com/search?q=cats%20and%20dogs'],
  ])
    assert.equal(browserUrl(input), expected);
  for (const input of [
    '',
    '  ',
    'http://',
    'file:///private/a',
    'javascript:alert(1)',
    'https://me:secret@host.test/',
    'example.com:99999/',
  ])
    assert.equal(browserUrl(input), null, input);
  assert.equal(browserUrl(undefined as any), null);
  for (const input of ['https://task.test/x', 'http://localhost:5199/']) assert.equal(isWebUrl(input), true);
  for (const input of ['not a URL', 'about:blank', 'file:///a', 'https://u:p@task.test']) assert.equal(isWebUrl(input), false);
});

test('Chrome restart drops OAuth state and identity providers, keeping the original task site', () => {
  for (const site of [
    'https://accounts.google.com/x',
    'https://login.microsoftonline.com/x',
    'https://login.live.com/x',
    'https://appleid.apple.com/x',
    'https://tenant.auth0.com/x',
    'https://tenant.okta.com/x',
  ]) {
    assert.equal(isIdentityProvider(site), true);
    assert.equal(restartUrl([site]), null);
  }
  assert.equal(isIdentityProvider('https://accounts.google.com.attacker.test/'), false);
  assert.equal(isIdentityProvider('bad'), false);
  assert.equal(
    restartUrl([
      'file:///a',
      'https://accounts.google.com/challenge?state=secret',
      'https://task.test/work?q=x&token=secret#access_token=t',
    ]),
    'https://task.test/work?q=x',
  );
  for (const url of [
    'https://task.test/oauth/callback?code=secret',
    'https://task.test/callback',
    'https://task.test/work?state=secret&code=c',
    'https://task.test/authorize',
    'https://task.test/saml',
    'https://task.test/signin-oidc',
  ])
    assert.equal(restartUrl([url]), 'https://task.test/');
  assert.equal(restartUrl([]), null);
});

function managed() {
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  const manager = new BrowserWindows({ ...w, onPopup: (opener: any, popup: any) => panel.registerPopup(opener, popup) });
  manager.register(w.root);
  return { ...w, panel, manager };
}

test('OAuth popups remain native, share the session, and become the agent target until closed', async () => {
  const w = managed();
  const policy = w.root.windowOpen({ url: 'https://accounts.google.com/oauth?state=private', postBody: 'state' });
  assert.equal(policy.action, 'allow');
  assert.equal(policy.outlivesOpener, false);
  assert.equal(policy.overrideBrowserWindowOptions.parent, w.parent);
  assert.deepEqual(policy.overrideBrowserWindowOptions.webPreferences, {
    session: w.session,
    preload: undefined,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    enableBlinkFeatures: 'WebMCP', // a page's own tools (WebMCP), shipped on
  });
  assert.equal(w.root.windowOpen({ url: 'about:blank' }).action, 'allow');
  for (const url of ['file:///a', 'javascript:alert(1)', 'https://u:p@host.test']) assert.equal(w.root.windowOpen({ url }).action, 'deny');
  const original = await w.panel.tab('chat');
  original.refs.set('e1', 88);
  const win = w.popup({ url: 'https://accounts.google.com/oauth?state=private' });
  w.root.emit('did-create-window', win);
  assert.equal(win.menu, null);
  assert.equal(win.focused, 1);
  assert.equal((await w.panel.tab('chat')).backend.identity, win.webContents);
  assert.equal(original.refs.size, 0);
  const popupPage = await w.panel.tab('chat');
  popupPage.refs.set('e1', 99);
  win.webContents.emit('page-title-updated', { preventDefault: () => {} });
  assert.equal(win.title, 'Built-in browser — accounts.google.com');
  assert.equal(w.manager.state(w.root.id, w.host).at(-1).origin, 'https://accounts.google.com');
  assert.ok(!JSON.stringify(w.host.calls).includes('private'));
  w.manager.closePopup(win.webContents.id, w.host);
  assert.equal((await w.panel.tab('chat')).backend.identity, w.root);
  assert.equal(w.parent.focused, 1);
  assert.equal(w.manager.pages.size, 1);
  assert.throws(() => w.manager.closePopup(w.root.id, w.host), /tab bar/);
  assert.throws(() => w.manager.owned(win.webContents.id, w.host), /no longer/);
  assert.throws(() => w.manager.owned(w.root.id, {}), /another window/);
});

test('nested popups return to the surviving target and are closed with their root', async () => {
  const w = managed();
  const first = w.popup();
  const second = w.popup();
  w.root.emit('did-create-window', first);
  first.webContents.emit('did-create-window', second);
  assert.equal((await w.panel.tab('chat')).backend.identity, second.webContents);
  second.close();
  assert.equal((await w.panel.tab('chat')).backend.identity, first.webContents);
  assert.equal(first.focused, 2);
  const third = w.popup();
  first.webContents.emit('did-create-window', third);
  w.root.destroy();
  assert.equal(first.closed, 1);
  assert.equal(third.closed, 1);
  assert.equal(w.manager.pages.size, 0);
});

test('browser lifecycle exposes slow, failed and crashed states; cancelled/subframe loads stay recoverable', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = managed();
  w.manager.register(w.root);
  w.root.emit('did-start-loading');
  t.mock.timers.tick(30_000);
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'slow');
  w.root.emit('did-stop-loading');
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'ready');
  w.root.emit('did-fail-load', {}, -105, '', '', false);
  w.root.emit('did-fail-load', {}, -3, '', '', true);
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'ready');
  w.root.emit('did-fail-load', {}, -105, '', '', true);
  w.root.emit('did-stop-loading');
  // Chrome's words, the code in the notice's detail
  assert.equal(w.manager.state(w.root.id, w.host)[0].detail, 'ERR_NAME_NOT_RESOLVED');
  w.root.emit('did-start-loading');
  w.root.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', '', true);
  assert.match(w.manager.state(w.root.id, w.host)[0].message, /address wasn't found/);
  w.root.emit('render-process-gone');
  w.root.emit('did-stop-loading');
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'crashed');
  w.root.emit('did-start-loading');
  w.root.emit('did-navigate');
  w.root.emit('did-stop-loading');
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'ready');
});

test('restart remembers the task before a provider redirect; local/app redirects are blocked', () => {
  const w = managed();
  assert.equal(w.manager.state(w.root.id, w.host)[0].kind, 'ready');
  w.root.emit('did-start-navigation', { url: 'https://task.test/work?state=private', isMainFrame: false });
  w.root.emit('did-start-navigation', {}, 'https://task.test/work', false, true);
  w.root.emit('did-start-navigation', { url: 'https://accounts.google.com/challenge?state=private', isMainFrame: true });
  w.root.url = 'https://accounts.google.com/challenge?state=private';
  assert.equal(w.manager.restart(w.root.id, w.host), 'https://task.test/work');
  let blocked = 0;
  for (const [event, url] of [
    ['will-navigate', 'https://task.test/'],
    ['will-redirect', 'about:blank'],
    ['will-redirect', 'file:///private/key'],
  ])
    w.root.emit(event, { preventDefault: () => blocked++ }, url);
  assert.equal(blocked, 1);
  // a local file is never opened, and no Retry or "Open in app" goes with it (shared/browserNotice.mjs)
  assert.match(w.manager.state(w.root.id, w.host)[0].message, /non-web address \(file:\)/);
  assert.equal(w.manager.state(w.root.id, w.host)[0].reason, 'address');
  const fresh = managed();
  fresh.root.url = 'https://accounts.google.com/';
  fresh.root.history = [{ url: 'https://task.test/old' }, { url: 'https://task.test/new?token=private' }];
  assert.equal(fresh.manager.restart(fresh.root.id, fresh.host), 'https://task.test/new');
  fresh.root.navigationHistory = undefined;
  assert.equal(fresh.manager.restart(fresh.root.id, fresh.host), null);
});

test('browser windows tolerate gone owners/URLs and restore minimized windows', () => {
  const w = browserWorld();
  const manager = new BrowserWindows(w);
  manager.register(w.root);
  w.parent.minimized = true;
  manager.focus(w.root.id, w.host);
  assert.equal(w.parent.minimized, false);
  const popup = w.popup({ url: 'about:blank' });
  w.root.emit('did-create-window', popup);
  popup.webContents.emit('did-navigate');
  assert.equal(popup.title, 'Built-in browser — New window');
  popup.webContents.getURL = () => {
    throw new Error('gone');
  };
  popup.webContents.emit('page-title-updated', { preventDefault() {} });
  assert.equal(popup.title, 'Built-in browser — New window');
  popup.dead = true;
  popup.webContents.emit('did-navigate');
  w.wins.delete(popup.webContents);
  popup.webContents.emit('did-navigate');
  w.host.destroyed = true;
  popup.webContents.destroy();
  w.host.destroyed = false;
  w.wins.delete(w.host);
  manager.focus(w.root.id, w.host);
  w.root.destroyed = true;
  assert.throws(() => manager.owned(w.root.id), /no longer/);
});

function handoffWorld() {
  let prefs = { channel: 'builtin', profileDir: 'Profile 2' };
  let enabled = true;
  const calls: any[] = [];
  const inst = {
    needsSnapshot: false,
    call: async (name: string, args: any) => {
      calls.push([name, args]);
      return {};
    },
  };
  const control = {
    seq: 0,
    configure: async (channel: string) => {
      control.seq++;
      calls.push(['configure', channel]);
      return channel;
    },
  };
  const options = {
    browserWindows: {
      owned: (id: number, host: any) => {
        assert.equal(id, 10);
        assert.equal(host, 'ui');
      },
    },
    chromeChannel: {
      has: (_chat: string) => false,
      stop: (chat: string) => calls.push(['stop', chat]),
      instance: async (chat: string) => {
        calls.push(['instance', chat]);
        return inst;
      },
    },
    browserControl: control,
    isEnabled: () => enabled,
    getPrefs: () => prefs,
    commitPrefs: (next: any) => {
      prefs = next;
      calls.push(['commit', next]);
    },
    changed: () => calls.push(['changed']),
  };
  const request = { webContentsId: 10, chatId: 'original-chat', url: 'https://task.test/work?state=secret&code=c' };
  return {
    options,
    request,
    inst,
    control,
    calls,
    getPrefs: () => prefs,
    changePrefs: () => {
      prefs = { channel: 'builtin', profileDir: 'Profile 3' };
    },
    disable: () => {
      enabled = false;
    },
    invoke: (req: any = request) => chromeHandoff(options)(req, 'ui'),
  };
}

test('Chrome handoff opens the task site for the original chat, clears stale refs and commits after switching', async () => {
  const w = handoffWorld();
  assert.deepEqual(await w.invoke(), { ok: true, url: 'https://task.test/', route: 'your-chrome', preferredChanged: true });
  assert.deepEqual(w.calls, [
    ['instance', 'original-chat'],
    ['browser_navigate', { url: 'https://task.test/' }],
    ['configure', 'chrome'],
    ['commit', { channel: 'chrome', profileDir: 'Profile 2' }],
    ['changed'],
  ]);
  assert.equal(w.inst.needsSnapshot, true);
});

test('Chrome handoff says whether it changed the saved Preferred browser: not when Chrome was already chosen (#1523)', async () => {
  const w = handoffWorld();
  const chrome = { channel: 'chrome', profileDir: 'Profile 2' };
  w.options.getPrefs = () => chrome;
  assert.deepEqual(await w.invoke(), { ok: true, url: 'https://task.test/', route: 'your-chrome', preferredChanged: false });
});

test('Chrome handoff rejects unsupported URLs, provider URLs, missing chats, disabled control and closed pages', async () => {
  for (const scenario of ['invalid', 'provider', 'chat', 'disabled', 'closed', 'missing']) {
    const w = handoffWorld();
    if (scenario === 'invalid') w.request.url = 'javascript:alert(1)';
    if (scenario === 'provider') w.request.url = 'https://accounts.google.com/';
    if (scenario === 'chat') w.request.chatId = '';
    if (scenario === 'disabled') w.disable();
    if (scenario === 'closed' || scenario === 'missing')
      w.options.browserWindows.owned = () => {
        throw new Error('page closed');
      };
    const result = scenario === 'missing' ? await chromeHandoff(w.options)(undefined, 'ui') : await w.invoke();
    assert.equal(result.ok, false, scenario);
    assert.equal(w.calls.length, 0);
  }
});

test('Chrome handoff reports navigation/connection errors without switching settings', async () => {
  for (const scenario of ['navigate', 'connection', 'unknown-error', 'closed-after-navigation']) {
    const w = handoffWorld();
    if (scenario === 'navigate') w.inst.call = async () => ({ isError: true });
    if (scenario === 'connection')
      w.options.chromeChannel.instance = async () => {
        throw new Error('missing extension');
      };
    if (scenario === 'unknown-error')
      w.options.chromeChannel.instance = async () => {
        throw null;
      };
    if (scenario === 'closed-after-navigation')
      w.inst.call = async () => {
        w.options.browserWindows.owned = () => {
          throw new Error('closed');
        };
        return {};
      };
    const r = await w.invoke();
    assert.equal(r.ok, false);
    assert.equal(w.getPrefs().channel, 'builtin');
    assert.ok(!w.calls.some(([name]) => name === 'configure'));
    if (scenario === 'unknown-error') assert.equal(r.message, 'Could not continue in Chrome.');
  }
});

test('Chrome handoff preserves newer settings/flags during connection and tool configuration', async () => {
  for (const scenario of ['profile', 'flag', 'configure-profile', 'configure-sequence']) {
    const w = handoffWorld();
    if (scenario === 'profile' || scenario === 'flag')
      w.inst.call = async () => {
        scenario === 'profile' ? w.changePrefs() : w.disable();
        return {};
      };
    else
      w.control.configure = async () => {
        w.control.seq++;
        scenario === 'configure-profile' ? w.changePrefs() : w.control.seq++;
        return 'chrome';
      };
    assert.equal((await w.invoke()).ok, false, scenario);
    assert.ok(!w.calls.some(([name]) => name === 'commit'));
  }
});

test('Chrome handoff rolls back failed configuration or persistence, then announces the actual channel', async () => {
  for (const scenario of ['configuration', 'persistence']) {
    const w = handoffWorld();
    if (scenario === 'configuration')
      w.control.configure = async (channel: string) => {
        w.control.seq++;
        w.calls.push(['configure', channel]);
        return 'builtin';
      };
    else
      w.options.commitPrefs = () => {
        throw new Error('disk full');
      };
    const result = await w.invoke();
    assert.equal(result.ok, false);
    assert.deepEqual(w.calls.slice(-2), [['configure', 'builtin'], ['changed']]);
    assert.equal(w.getPrefs().channel, 'builtin');
  }
});

test("Cancel stops a handoff still waiting for Chrome: an instance it started is stopped, an agent's is left running", async () => {
  for (const scenario of ['fresh', 'agent', 'before-instance']) {
    const w = handoffWorld();
    w.options.chromeChannel.has = () => scenario === 'agent';
    let answer: any;
    let started: any;
    const ready = new Promise((r) => {
      started = r;
    });
    if (scenario === 'before-instance')
      w.options.chromeChannel.instance = () => {
        started();
        return new Promise((r) => {
          answer = () => r(w.inst);
        });
      };
    else
      w.inst.call = (name: string, args: any) => {
        w.calls.push([name, args]);
        started();
        return new Promise((r) => {
          answer = () => r({});
        });
      };
    const run = w.invoke();
    await ready;
    assert.equal(cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'original-chat' }, 'ui'), true, scenario);
    assert.equal(cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'original-chat' }, 'ui'), false, 'already cancelled');
    answer();
    assert.deepEqual(await run, { ok: false, cancelled: true, message: 'Cancelled.' });
    assert.equal(
      w.calls.some(([name]) => name === 'stop'),
      scenario !== 'agent',
      scenario,
    );
    assert.ok(!w.calls.some(([name]) => name === 'configure' || name === 'commit'), scenario);
    assert.equal(cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'original-chat' }, 'ui'), false, 'finished');
  }
});

test('a newer handoff for the same chat keeps its own Cancel when an older one finishes', async () => {
  const w = handoffWorld();
  const answers: any[] = [];
  w.inst.call = (name: string, args: any) => {
    w.calls.push([name, args]);
    return new Promise((r) => answers.push(() => r({})));
  };
  const first = w.invoke();
  await new Promise((r) => setImmediate(r));
  const second = w.invoke();
  await new Promise((r) => setImmediate(r));
  answers[0]();
  assert.equal((await first).ok, true);
  assert.equal(
    cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'original-chat' }, 'ui'),
    true,
    'the second is still cancellable',
  );
  answers[1]();
  assert.equal((await second).cancelled, true);
});

test('Cancel refuses another page, an unknown chat, a closed page and a handoff Chrome has already answered', async () => {
  const w = handoffWorld();
  assert.equal(cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'nobody' }, 'ui'), false);
  assert.equal(cancelChromeHandoff({ ...w.options, browserWindows: { owned: () => {} } }, undefined as any, 'ui'), false);
  let answer: any;
  let started: any;
  const ready = new Promise((r) => {
    started = r;
  });
  w.control.configure = (channel: string) => {
    w.calls.push(['configure', channel]);
    started();
    return new Promise((r) => {
      answer = () => {
        w.control.seq++;
        r(channel);
      };
    });
  };
  const run = w.invoke();
  await ready;
  assert.equal(cancelChromeHandoff(w.options, { webContentsId: 10, chatId: 'original-chat' }, 'ui'), false, 'Chrome answered');
  const other = { ...w.options, browserWindows: { owned: () => {} } };
  assert.equal(cancelChromeHandoff(other, { webContentsId: 11, chatId: 'original-chat' }, 'ui'), false, 'another page');
  const closed = {
    ...w.options,
    browserWindows: {
      owned: () => {
        throw new Error('page closed');
      },
    },
  };
  assert.throws(() => cancelChromeHandoff(closed, { webContentsId: 10, chatId: 'original-chat' }, 'ui'), /page closed/);
  answer();
  assert.deepEqual(await run, { ok: true, url: 'https://task.test/', route: 'your-chrome', preferredChanged: true });
});

test('search text with unpaired UTF-16 units remains navigable', () => {
  assert.equal(
    browserUrl('find \ud800 and \udfff 😺'),
    'https://www.google.com/search?q=find%20%EF%BF%BD%20and%20%EF%BF%BD%20%F0%9F%98%BA',
  );
});
