// Other extensions' frames in agent tabs (frameGuard.mjs, debuggers.mjs): the guard empties and hides them in the page and its open shadow roots, every attach puts it on the tab, and an attach such a frame blocks reloads the tab (at most twice, once a minute) and attaches as the new page commits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  guardFrames,
  guardSource,
  guardTab,
  reloadToCommit,
  BLOCKED,
  GUARD_WORLD,
  RELOAD_AGAIN_MS,
} from '../electron/chrome-extension/src/frameGuard.mjs';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';

const OWN = 'ownextensionid';
const tick = () => new Promise((r) => setTimeout(r, 0));

test('guardFrames: frames of other extensions are emptied and hidden, now and later, in open shadow roots too; the page and this extension keep theirs', async () => {
  const win: any = new Window({ url: 'https://site.test/' });
  const doc = win.document;
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { document: doc, MutationObserver: win.MutationObserver });
  try {
    const frame = (tag: string, attr: string, url: string) => {
      const el = doc.createElement(tag);
      el.setAttribute(attr, url);
      return el;
    };
    const there = frame('iframe', 'src', 'chrome-extension://othe/menu.html');
    const mine = frame('iframe', 'src', `chrome-extension://${OWN}/x.html`);
    const page = frame('iframe', 'src', 'https://site.test/embed');
    const broken = frame('iframe', 'src', 'chrome-extension://');
    const odd = frame('iframe', 'src', 'chrome-extension://a b/x');
    doc.body.append(there, mine, page, broken, odd);
    delete (globalThis as any).__mopilotFrameGuard;
    guardFrames(OWN);
    // a second run in the same world does nothing more
    guardFrames(OWN);
    assert.equal(there.getAttribute('srcdoc'), '');
    assert.equal(there.style.getPropertyValue('display'), 'none');
    for (const el of [mine, page, broken, odd]) assert.equal(el.getAttribute('srcdoc'), null);
    // later: a frame added in an open shadow root, a <frame>, an <object>, an <embed>, and a src changed to another extension's
    const host = doc.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const inShadow = frame('iframe', 'src', 'chrome-extension://othe/a.html');
    root.append(inShadow);
    const old = frame('frame', 'src', 'chrome-extension://othe/b.html');
    const obj = frame('object', 'data', 'chrome-extension://othe/c.html');
    const wrap = doc.createElement('section');
    wrap.append(frame('embed', 'src', 'chrome-extension://othe/d.html'));
    doc.body.append(host, old, obj, wrap, doc.createTextNode('text'));
    await tick();
    page.setAttribute('src', 'chrome-extension://othe/late.html');
    // the shadow host checked again: its root is watched once
    host.setAttribute('src', 'x');
    await tick();
    assert.equal(inShadow.getAttribute('srcdoc'), '');
    assert.equal(old.getAttribute('src'), 'about:blank');
    assert.equal(obj.getAttribute('data'), 'about:blank');
    assert.equal(wrap.firstElementChild.getAttribute('src'), 'about:blank');
    assert.equal(page.getAttribute('srcdoc'), '');
    // an emptied frame stays as it is when it changes again
    there.setAttribute('src', 'chrome-extension://othe/again.html');
    old.setAttribute('src', 'chrome-extension://othe/again.html');
    await tick();
    assert.equal(old.getAttribute('src'), 'about:blank');
    // the source runs the same function with this extension's id
    assert.match(guardSource(OWN), /^\(function guardFrames\(own\)[\s\S]*\)\("ownextensionid"\)$/);
  } finally {
    Object.assign(globalThis, saved);
    delete (globalThis as any).__mopilotFrameGuard;
    await win.happyDOM.close();
  }
});

test('guardTab puts the guard on the page now and on each new page; false when the debugger refuses', async () => {
  const chrome = fakeChromeApi({ id: OWN });
  const logged: string[] = [];
  assert.equal(await guardTab(chrome, 5, (w: string) => logged.push(w)), true);
  const [, target, method, params] = chrome.log.at(-1);
  assert.deepEqual(
    [target, method, params.worldName, params.runImmediately],
    [{ tabId: 5 }, 'Page.addScriptToEvaluateOnNewDocument', GUARD_WORLD, true],
  );
  assert.equal(params.source, guardSource(OWN));
  chrome.cdp['Page.addScriptToEvaluateOnNewDocument'] = new Error('Debugger is not attached');
  assert.equal(await guardTab({ ...chrome, runtime: undefined }, 5, (w: string) => logged.push(w)), false);
  assert.deepEqual(logged, ["guard a tab against other extensions' frames"]);
});

/** The fake chrome with webNavigation.onCommitted and tabs.reload, which commits unless `commit` says otherwise. */
function navChrome() {
  const chrome: any = fakeChromeApi({ id: OWN });
  const listeners: Function[] = [];
  chrome.webNavigation.onCommitted = {
    addListener: (f: Function) => listeners.push(f),
    removeListener: (f: Function) => listeners.splice(listeners.indexOf(f), 1),
    listeners,
  };
  chrome.commit = (tabId: number) => [...listeners].forEach((f) => f({ tabId, frameId: 0 }));
  chrome.tabs.reload = async (tabId: number) => {
    chrome.log.push(['tabs.reload', tabId]);
    if (chrome.reloadFails) throw new Error('No tab');
    if (chrome.noCommit) return;
    // another tab's commit and a subframe's don't count
    for (const f of [...listeners]) f({ tabId: tabId + 1, frameId: 0 });
    for (const f of [...listeners]) f({ tabId, frameId: 3 });
    chrome.commit(tabId);
  };
  return chrome;
}

test('reloadToCommit: true when the main frame commits, false after the wait or when the reload fails; the listener goes either way', async () => {
  const chrome = navChrome();
  const logged: string[] = [];
  const log = (w: string) => logged.push(w);
  assert.equal(await reloadToCommit(chrome, 9, log), true);
  chrome.noCommit = true;
  assert.equal(await reloadToCommit(chrome, 9, log, 5), false);
  chrome.reloadFails = true;
  assert.equal(await reloadToCommit(chrome, 9, log), false);
  assert.deepEqual(logged, ['reload a tab to clear another extension’s frame']);
  assert.equal(chrome.webNavigation.onCommitted.listeners.length, 0);
});

async function attached() {
  const chrome = navChrome();
  const sent: any[] = [];
  const logged: string[] = [];
  const sessions = new Sessions({
    chrome,
    storage: chrome.storage.session,
    send: (m: any) => sent.push(m),
    log: (w: string) => logged.push(w),
  });
  await sessions.open('chat-a', {});
  const tab = await sessions.command('chat-a', 'chrome.tabs.create', [{}], 0);
  let now = 1_000_000;
  sessions.debuggers.now = () => now;
  const attach = () => sessions.command('chat-a', 'chrome.debugger.attach', [{ tabId: tab.id }], 0);
  const steps = () =>
    chrome.log
      .filter((c: any[]) => /^(debugger\.(attach|sendCommand)|tabs\.reload)$/.test(c[0]))
      .map((c: any[]) => (c[0] === 'debugger.sendCommand' ? c[2] : c[0]));
  const foreign = () => Object.assign(new Error('Cannot access a chrome-extension:// URL of different extension'));
  return { chrome, sessions, sent, logged, tab, attach, steps, foreign, later: (ms: number) => (now += ms) };
}

test('attach: every attach puts the guard on the tab', async () => {
  const w = await attached();
  await w.attach();
  assert.deepEqual(w.steps(), ['debugger.attach', 'Page.addScriptToEvaluateOnNewDocument']);
});

test('attach blocked by another extension frame: the tab reloads and attaches as its page commits, with the guard; again within a minute it refuses at once', async () => {
  const w = await attached();
  const real = w.chrome.debugger.attach;
  let blocks = 1;
  w.chrome.debugger.attach = async (target: any, version: string) => {
    if (blocks-- > 0) throw (w.chrome.log.push(['debugger.attach', target, version]), w.foreign());
    return real.call(w.chrome.debugger, target, version);
  };
  assert.deepEqual(await w.attach(), {});
  assert.deepEqual(w.steps(), ['debugger.attach', 'tabs.reload', 'debugger.attach', 'Page.addScriptToEvaluateOnNewDocument']);
  assert.equal(w.sessions.chats.get('chat-a')!.attached.has(w.tab.id), true);
  // blocked again within a minute: no second reload
  await w.sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: w.tab.id }], 0);
  blocks = 1;
  w.later(RELOAD_AGAIN_MS - 1);
  // the side panel hears which tab another extension blocks (tabNotices.mjs)
  const told: number[] = [];
  w.sessions.debuggers.onBlocked = (tabId: number) => told.push(tabId);
  await assert.rejects(w.attach(), { message: BLOCKED });
  assert.deepEqual(told, [w.tab.id]);
  assert.equal(w.steps().filter((s: string) => s === 'tabs.reload').length, 1);
  // a minute on, it may reload again
  blocks = 1;
  w.later(1);
  assert.deepEqual(await w.attach(), {});
  assert.equal(w.steps().filter((s: string) => s === 'tabs.reload').length, 2);
});

test('attach recovery: a frame that comes back before the guard lands costs a second reload; a third block, no commit or another error fail', async () => {
  const w = await attached();
  const real = w.chrome.debugger.attach;
  /** what each native attach does, in order: 'block', 'ok' or an Error */
  let script: any[] = [];
  w.chrome.debugger.attach = async (target: any, version: string) => {
    const next = script.shift() ?? 'ok';
    if (next === 'ok') return real.call(w.chrome.debugger, target, version);
    w.chrome.log.push(['debugger.attach', target, version]);
    throw next === 'block' ? w.foreign() : next;
  };
  // the reload's attach succeeds but the guard can't land (the debugger was detached again): reload once more
  let guards = 0;
  w.chrome.cdp['Page.addScriptToEvaluateOnNewDocument'] = () => {
    if (guards++ === 0) {
      // the detach that came with it is the recovery's own: not reported, ownership kept
      w.sessions.onDebuggerDetach({ tabId: w.tab.id }, 'target_closed');
      throw new Error('Debugger is not attached to the tab');
    }
    return {};
  };
  script = ['block', 'ok', 'ok'];
  assert.deepEqual(await w.attach(), {});
  assert.deepEqual(w.steps(), [
    'debugger.attach',
    'tabs.reload',
    'debugger.attach',
    'Page.addScriptToEvaluateOnNewDocument',
    'tabs.reload',
    'debugger.attach',
    'Page.addScriptToEvaluateOnNewDocument',
  ]);
  assert.equal(
    w.sent.some((m) => m.method === 'chrome.debugger.onDetach'),
    false,
  );
  assert.equal(w.sessions.debuggers.recovering.size, 0);
  // blocked on every reload: refused, saying which kind of extension to turn off
  await w.sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: w.tab.id }], 0);
  w.later(RELOAD_AGAIN_MS);
  script = ['block', 'block', 'block'];
  const told: number[] = [];
  w.sessions.debuggers.onBlocked = (tabId: number) => told.push(tabId);
  await assert.rejects(w.attach(), { message: BLOCKED });
  assert.deepEqual(told, [w.tab.id], 'the side panel hears of a block the reloads couldn’t clear');
  // the reload never commits
  w.later(RELOAD_AGAIN_MS);
  script = ['block'];
  w.chrome.reloadFails = true;
  await assert.rejects(w.attach(), { message: BLOCKED });
  w.chrome.reloadFails = false;
  // another failure is its own, first or after the reload
  w.later(RELOAD_AGAIN_MS);
  script = ['block', new Error('No tab with given id')];
  await assert.rejects(w.attach(), { message: 'No tab with given id' });
  script = [new Error('Another debugger is already attached')];
  await assert.rejects(w.attach(), { message: 'Another debugger is already attached' });
  // a detach outside recovery is reported as before
  w.sessions.onDebuggerDetach({ tabId: w.tab.id }, 'target_closed');
  assert.equal(w.sent.at(-1).method, 'chrome.debugger.onDetach');
});

test('attach recovery: a guard that fails while attached lets go first; a tab the user takes back mid-recovery is reloaded no more, and their cancel is reported', async () => {
  const w = await attached();
  const real = w.chrome.debugger.attach;
  let script: any[] = ['block'];
  w.chrome.debugger.attach = async (target: any, version: string) => {
    const next = script.shift() ?? 'ok';
    if (next === 'ok') return real.call(w.chrome.debugger, target, version);
    w.chrome.log.push(['debugger.attach', target, version]);
    throw w.foreign();
  };
  // the page refused the guard with the debugger still on: it is let go before the next reload
  let guards = 0;
  w.chrome.cdp['Page.addScriptToEvaluateOnNewDocument'] = () => {
    if (guards++ === 0) throw new Error('Page is navigating');
    return {};
  };
  assert.deepEqual(await w.attach(), {});
  const detaches = w.chrome.log.filter((c: any[]) => c[0] === 'debugger.detach').length;
  assert.equal(detaches, 1);
  // a detach that fails is logged
  await w.sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: w.tab.id }], 0);
  w.later(RELOAD_AGAIN_MS);
  script = ['block'];
  guards = 0;
  w.chrome.fail['debugger.detach'] = new Error('Debugger is not attached');
  assert.deepEqual(await w.attach(), {});
  assert.ok(w.logged.includes('let go of a tab the guard missed'));
  delete w.chrome.fail['debugger.detach'];
  await w.sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: w.tab.id }], 0);
  // the user cancels the debugging bar during the reload: reported, and no second reload or attach
  w.later(RELOAD_AGAIN_MS);
  script = ['block', 'block'];
  const reload = w.chrome.tabs.reload;
  w.chrome.tabs.reload = async (tabId: number) => {
    w.sessions.onDebuggerDetach({ tabId }, 'canceled_by_user');
    return reload(tabId);
  };
  const reloadsBefore = w.steps().filter((x: string) => x === 'tabs.reload').length;
  await assert.rejects(w.attach(), /no longer belongs/);
  assert.equal(w.steps().filter((x: string) => x === 'tabs.reload').length, reloadsBefore + 1);
  assert.equal(w.sent.at(-1).method, 'chrome.debugger.onDetach');
  // taken back as the blocked attach fails, before any reload: never reloaded
  w.chrome.tabs.reload = reload;
  w.later(RELOAD_AGAIN_MS);
  const fresh = await w.sessions.command('chat-a', 'chrome.tabs.create', [{}], 0);
  const blockedAttach = w.chrome.debugger.attach;
  w.chrome.debugger.attach = async () => {
    w.sessions.onDebuggerDetach({ tabId: fresh.id }, 'canceled_by_user');
    throw w.foreign();
  };
  const before = w.steps().filter((x: string) => x === 'tabs.reload').length;
  await assert.rejects(w.sessions.command('chat-a', 'chrome.debugger.attach', [{ tabId: fresh.id }], 0), /no longer belongs/);
  assert.equal(w.steps().filter((x: string) => x === 'tabs.reload').length, before);
  w.chrome.debugger.attach = blockedAttach;
});

test('attach recovery while another extension’s menu stays present: blocked with the documented error, then cleared on the same tab once the menu goes; the tab, its page and its owner are kept (#2383)', async () => {
  const w = await attached();
  const real = w.chrome.debugger.attach;
  const page = 'https://site.test/login?step=2';
  w.chrome.tabsById.get(w.tab.id).url = page;
  // the menu is there for every native attach until it is dismissed
  let menu = true;
  w.chrome.debugger.attach = async (target: any, version: string) => {
    if (!menu) return real.call(w.chrome.debugger, target, version);
    w.chrome.log.push(['debugger.attach', target, version]);
    throw w.foreign();
  };
  const told: number[] = [];
  w.sessions.debuggers.onBlocked = (tabId: number) => told.push(tabId);
  const kept = () => {
    assert.equal(w.chrome.tabsById.get(w.tab.id)?.url, page);
    assert.equal(w.sessions.chats.get('chat-a')!.tabs.has(w.tab.id), true);
    assert.equal(w.sessions.chats.get('chat-a')!.attached.has(w.tab.id), false);
    assert.equal(w.sessions.debuggers.recovering.size, 0);
    assert.equal(
      w.sent.some((m) => m.method === 'chrome.debugger.onDetach'),
      false,
    );
    assert.equal(
      w.chrome.log.some((c: any[]) => /^tabs\.(remove|update)$/.test(c[0])),
      false,
    );
  };
  // every reload still meets the menu: refused with the external blocker, the side panel told once
  await assert.rejects(w.attach(), { message: BLOCKED });
  assert.deepEqual(w.steps(), ['debugger.attach', 'tabs.reload', 'debugger.attach', 'tabs.reload', 'debugger.attach']);
  assert.deepEqual(told, [w.tab.id]);
  kept();
  // the agent retries within the minute: refused at once, the page not reloaded again
  w.later(RELOAD_AGAIN_MS - 1);
  await assert.rejects(w.attach(), { message: BLOCKED });
  assert.equal(w.steps().filter((s: string) => s === 'tabs.reload').length, 2);
  assert.deepEqual(told, [w.tab.id, w.tab.id]);
  kept();
  // the menu goes: the next attach drives the original tab, with the guard, and no new tab
  menu = false;
  assert.deepEqual(await w.attach(), {});
  assert.deepEqual(w.steps().slice(-2), ['debugger.attach', 'Page.addScriptToEvaluateOnNewDocument']);
  assert.equal(w.sessions.chats.get('chat-a')!.attached.has(w.tab.id), true);
  assert.equal(w.chrome.tabsById.get(w.tab.id)?.url, page);
  assert.equal(w.chrome.log.filter((c: any[]) => c[0] === 'tabs.create').length, 1);
});
