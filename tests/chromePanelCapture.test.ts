// The side panel's screenshot of the tab in front (electron/chrome-extension/src/debuggers.mjs capture and the background's capture message): through the attachment an agent holds, else a short one of its own, in the tab's queue; a page Chrome keeps from extensions says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { background } from './support/extension-background/fixture.ts';

const { Debuggers } = await import('../electron/chrome-extension/src/debuggers.mjs');

/** Debuggers on a fake chrome.debugger that logs each call. */
function debuggers(o: { attach?: () => Promise<void>; detach?: () => Promise<void> } = {}) {
  const log: any[] = [];
  const logged: any[] = [];
  const chrome = {
    debugger: {
      attach: async (t: any, v: string) => (log.push(['attach', t.tabId, v]), o.attach?.()),
      detach: async (t: any) => (log.push(['detach', t.tabId]), o.detach?.()),
      sendCommand: async (t: any, method: string, params: any) => (log.push(['send', t.tabId, method, params]), { data: 'UE5H' }),
    },
  };
  const d = new Debuggers({ chrome, changed: () => undefined, log: (...a: any[]) => logged.push(a) });
  return { d, log, logged };
}

test('a tab no agent holds: attached for the screenshot only, and let go', async () => {
  const { d, log } = debuggers();
  assert.equal(await d.capture(7), 'UE5H');
  assert.deepEqual(log, [
    ['attach', 7, '1.3'],
    ['send', 7, 'Page.captureScreenshot', { format: 'png' }],
    ['detach', 7],
  ]);
});

test('a tab an agent holds: its attachment takes the screenshot, and stays', async () => {
  const { d, log } = debuggers();
  d.held.set(7, { owner: { attached: new Set([7]) }, membership: null, tabId: 7, pending: 0, retired: false });
  assert.equal(await d.capture(7), 'UE5H');
  assert.deepEqual(log, [['send', 7, 'Page.captureScreenshot', { format: 'png' }]]);
  assert.ok(d.held.has(7));
});

test('a page that refuses the debugger fails the screenshot; one that refuses letting go is only logged', async () => {
  const refused = debuggers({ attach: () => Promise.reject(new Error('Cannot access a chrome:// URL')) });
  await assert.rejects(refused.d.capture(7), /chrome:\/\//);
  const sticky = debuggers({ detach: () => Promise.reject(new Error('Detached while handling command.')) });
  assert.equal(await sticky.d.capture(7), 'UE5H');
  assert.equal(sticky.logged[0][0], 'let go of a tab after its screenshot');
});

test('the screenshot waits its turn in the tab’s queue: an attach already under way finishes first', async () => {
  let release: () => void = () => undefined;
  const { d, log } = debuggers({ attach: () => (log.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve()) });
  // one queued native step on the tab (as an agent's attach is)
  const first = d.capture(7);
  const second = d.capture(7);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, [['attach', 7, '1.3']]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    log.map((l) => l[0]),
    ['attach', 'send', 'detach', 'attach', 'send', 'detach'],
  );
});

test('the background: the panel’s capture for the tab in front, as a PNG data: URL; a tab it can’t take says so', async () => {
  const { chrome, bg, warn } = await background({ pairing: `mopilot-chrome:1:47615:${'S'.repeat(43)}` });
  try {
    const own = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` };
    const ask = (m: any) => new Promise<any>((resolve) => chrome.runtime.onMessage.fire(m, own, resolve));
    chrome.debugger.attach = async () => undefined;
    chrome.debugger.detach = async () => undefined;
    chrome.debugger.sendCommand = async () => ({ data: 'UE5H' });
    assert.deepEqual(await ask({ type: 'capture', tabId: 7 }), { dataUrl: 'data:image/png;base64,UE5H' });
    assert.deepEqual(await ask({ type: 'capture', tabId: 'x' }), { error: 'Open a web page to add a screenshot of it.' });
    chrome.debugger.attach = async () => {
      throw new Error('Cannot access a chrome:// URL');
    };
    assert.deepEqual(await ask({ type: 'capture', tabId: 8 }), { error: "MoPilot can't take a screenshot of this page." });
    assert.ok(warn.mock.calls.some((c: any) => /take a screenshot for the side panel/.test(String(c.arguments[0]))));
  } finally {
    bg.client.dispose();
  }
});
