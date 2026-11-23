// Chrome refuses every debugger call (attach, detach, sendCommand) on a tab that has another extension's frame in it, so a detach in an attach's path can say it too: the extension drops the stale ownership and recovers like a blocked attach instead of handing Chrome's raw refusal to the chat (cuj-chrome-foreign-frame, #2325).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debuggers } from '../electron/chrome-extension/src/debuggers.mjs';
import { BLOCKED } from '../electron/chrome-extension/src/frameGuard.mjs';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';

const TAB = 7;
const REFUSAL = 'Cannot access a chrome-extension:// URL of different extension';

/** A Chrome whose tab has another extension's frame in it (`frame.in`) until a reload, and which refuses every debugger call while it does. */
function chromeWithFrame({ reloadClears = true } = {}) {
  const chrome: any = fakeChromeApi({ id: 'own' });
  const frame = { in: true };
  const commit: Function[] = [];
  chrome.webNavigation.onCommitted = {
    addListener: (f: Function) => commit.push(f),
    removeListener: (f: Function) => commit.splice(commit.indexOf(f), 1),
  };
  chrome.tabs.reload = async (tabId: number) => {
    chrome.log.push(['tabs.reload', tabId]);
    if (reloadClears) frame.in = false;
    for (const f of [...commit]) f({ tabId, frameId: 0 });
  };
  for (const method of ['attach', 'detach', 'sendCommand'] as const) {
    const native = chrome.debugger[method];
    chrome.debugger[method] = async (...args: any[]) => {
      if (frame.in) throw (chrome.log.push([`debugger.${method}`, ...args]), new Error(REFUSAL));
      return native.apply(chrome.debugger, args);
    };
  }
  const steps = () => chrome.log.map((c: any[]) => (c[0] === 'debugger.sendCommand' ? c[2] : c[0]));
  return { chrome, frame, steps };
}

function debuggersOn(chrome: any) {
  const logged: string[] = [];
  const debuggers = new Debuggers({ chrome, changed: () => undefined, log: (what: string) => logged.push(what), now: () => 1_000_000 });
  const owner = { attached: new Set<number>() };
  const attach = (membership: object) => debuggers.attach(owner, TAB, '1.3', () => true, membership);
  return { debuggers, owner, logged, attach };
}

test('a stale attachment whose detach Chrome refuses for a foreign frame does not fail the next attach: the tab is reloaded and attached clear', async () => {
  const { chrome, frame, steps } = chromeWithFrame();
  const { debuggers, owner, attach } = debuggersOn(chrome);
  frame.in = false;
  await attach({});
  assert.equal(owner.attached.has(TAB), true);
  // the frame arrives; Chrome detached us (the extension was told nothing here: the ownership is stale) and refuses everything
  frame.in = true;
  chrome.log.length = 0;
  assert.deepEqual(await attach({}), {});
  assert.deepEqual(steps(), [
    'debugger.detach', // the stale attachment's release: refused, dropped
    'debugger.detach', // let go of again before the attach: refused
    'debugger.attach', // refused
    'tabs.reload',
    'debugger.detach', // the frame is gone: our debugger Chrome would not let go of is released
    'debugger.attach',
    'Page.addScriptToEvaluateOnNewDocument',
  ]);
  assert.equal(owner.attached.has(TAB), true);
  assert.equal(debuggers.refusedDetach.size, 0);
});

test('a release Chrome refuses for a foreign frame drops the ownership and remembers the debugger may be on the tab; Chrome telling us it detached forgets that', async () => {
  const { chrome, frame } = chromeWithFrame();
  const { debuggers, owner, attach } = debuggersOn(chrome);
  frame.in = false;
  await attach({});
  frame.in = true;
  assert.deepEqual(await debuggers.release(owner, TAB), {});
  assert.equal(owner.attached.has(TAB), false);
  assert.equal(debuggers.held.has(TAB), false);
  assert.equal(debuggers.refusedDetach.has(TAB), true);
  debuggers.forget(TAB);
  assert.equal(debuggers.refusedDetach.has(TAB), false);
});

test('a frame the reload does not clear ends the attach with the guided message, not Chrome’s refusal', async () => {
  const { chrome } = chromeWithFrame({ reloadClears: false });
  const { debuggers, attach } = debuggersOn(chrome);
  const told: number[] = [];
  debuggers.onBlocked = (tabId: number) => told.push(tabId);
  await assert.rejects(attach({}), { message: BLOCKED });
  assert.deepEqual(told, [TAB]);
});

test('letting go of a debugger Chrome refused to release fails quietly and the attach goes on', async () => {
  const { chrome, frame, steps } = chromeWithFrame();
  const { debuggers, logged, attach } = debuggersOn(chrome);
  frame.in = false;
  debuggers.refusedDetach.add(TAB);
  chrome.fail['debugger.detach'] = new Error('Debugger is busy');
  assert.deepEqual(await attach({}), {});
  assert.deepEqual(logged, ['let go of a tab after its frame left']);
  // the failure left the debugger unconfirmed gone: the next attach lets go of it again
  assert.equal(debuggers.refusedDetach.has(TAB), true);
  assert.deepEqual(steps(), ['debugger.detach', 'debugger.attach', 'Page.addScriptToEvaluateOnNewDocument']);
});

test('a detach Chrome answers with a terminal absence (an Error or a bare string) is a release; another failure is the caller’s', async () => {
  const { chrome, frame } = chromeWithFrame();
  const { debuggers, owner, attach } = debuggersOn(chrome);
  frame.in = false;
  await attach({});
  chrome.fail['debugger.detach'] = `No tab with given id ${TAB}.` as unknown as Error;
  assert.deepEqual(await debuggers.release(owner, TAB), {});
  assert.equal(debuggers.refusedDetach.size, 0);
  await attach({});
  chrome.fail['debugger.detach'] = new Error('Debugger is busy');
  await assert.rejects(debuggers.release(owner, TAB), { message: 'Debugger is busy' });
});

test('a command Chrome refuses for a foreign frame says what attach says, to the chat and to the side panel; other results and failures pass through', async () => {
  const { chrome, frame } = chromeWithFrame();
  const sent: any[] = [];
  const sessions = new Sessions({ chrome, storage: chrome.storage.session, send: (m: any) => sent.push(m), log: () => undefined });
  await sessions.open('chat-a', {});
  const tab = await sessions.command('chat-a', 'chrome.tabs.create', [{}], 0);
  const told: number[] = [];
  sessions.debuggers.onBlocked = (tabId: number) => told.push(tabId);
  const command = (target: object = { tabId: tab.id }) =>
    sessions.command('chat-a', 'chrome.debugger.sendCommand', [target, 'Runtime.evaluate', { expression: '1' }], 0);
  await assert.rejects(command(), { message: BLOCKED });
  assert.deepEqual(told, [tab.id]);
  frame.in = false;
  chrome.cdp['Runtime.evaluate'] = { result: { value: 1 } };
  assert.deepEqual(await command({ tabId: tab.id, sessionId: 'child' }), { result: { value: 1 } });
  assert.deepEqual(chrome.log.at(-1).slice(0, 2), ['debugger.sendCommand', { tabId: tab.id, sessionId: 'child' }]);
  chrome.cdp['Runtime.evaluate'] = new Error('Debugger is not attached to the tab with id: 1.');
  await assert.rejects(command(), { message: 'Debugger is not attached to the tab with id: 1.' });
  assert.equal(told.length, 1);
});
