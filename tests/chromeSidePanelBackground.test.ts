// Chrome's side panel in the extension's service worker (src/background.mjs): the panel's requests and MoPilot's updates passed through, the toolbar opening the panel, and Connect starting MoPilot when it isn't running.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask as askBackground, background, FakeWs, handshake, tick } from './support/extension-background/fixture.ts';

const { LAUNCH_AGAIN_MS } = await import('../electron/chrome-extension/src/background.mjs');

test('the background passes the panel’s requests to MoPilot and its updates to the panel; the toolbar opens the panel', async () => {
  const { chrome, bg, warn } = await background({ pairing: `mopilot-chrome:1:47615:${'S'.repeat(43)}` });
  try {
    // one panel per tab: no extension-wide panel, and the toolbar opens the clicked tab's own (#2325)
    assert.ok(chrome.log.some((l: any) => l[0] === 'sidePanel.setPanelBehavior' && l[1].openPanelOnActionClick === false));
    assert.ok(chrome.log.some((l: any) => l[0] === 'sidePanel.setOptions' && l[1].enabled === false && l[1].tabId === undefined));
    chrome.action.onClicked.fire({ id: 31, windowId: 1 });
    assert.deepEqual(
      chrome.log.filter((l: any) => l[0].startsWith('sidePanel.') && l[1].tabId === 31),
      [
        ['sidePanel.setOptions', { tabId: 31, path: 'sidepanel.html?tabId=31', enabled: true }],
        ['sidePanel.open', { tabId: 31 }],
      ],
    );
    const own = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` };
    const ask = (m: any) => new Promise<any>((resolve) => chrome.runtime.onMessage.fire(m, own, resolve));
    // not connected: the panel hears why
    const down = await ask({ type: 'panel', method: 'recent' });
    assert.equal(down.error, "MoPilot isn't connected.");
    const ws = FakeWs.all.at(-1)!;
    await handshake(ws, { secret: 'S'.repeat(43) });
    assert.equal(bg.client.status, 'connected');
    const pending = ask({ type: 'panel', method: 'recent', params: { limit: 2 } });
    await tick();
    const req = ws.sent.at(-1);
    assert.deepEqual(req, { type: 'panel', id: 1, method: 'recent', params: { limit: 2 } });
    await ws.from({ type: 'panel', id: 1, result: { chats: [] } });
    const r = await pending;
    assert.equal(r.status, 'connected');
    assert.deepEqual(r.result, { chats: [] });
    // an update from MoPilot reaches the panel's page; none open is not a failure
    const sends: any[] = [];
    chrome.runtime.sendMessage = async (m: any) => {
      sends.push(m);
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    await ws.from({ type: 'panel', event: { kind: 'turn', chatId: 'c', state: 'running' } });
    await tick();
    assert.deepEqual(sends.at(-1), { type: 'panelEvent', event: { kind: 'turn', chatId: 'c', state: 'running' } });
    assert.equal(warn.mock.calls.filter((c: any) => /side panel/.test(String(c.arguments[0]))).length, 0);
    // any other failure is logged
    chrome.runtime.sendMessage = async () => {
      throw new Error('boom');
    };
    const late = ask({ type: 'panel', method: 'open' });
    await tick();
    // the connection goes: the request ends, and the panel hears of the new status
    ws.onclose?.();
    await tick();
    assert.match((await late).error, /went away/);
    assert.ok(warn.mock.calls.some((c: any) => /tell the side panel what changed/.test(String(c.arguments[0]))));
  } finally {
    bg.client.dispose();
  }
});

test('Connect with MoPilot not running starts it, then asks it for the pairing once it is up', async () => {
  let open: any = { type: 'none', starting: true };
  const asked: string[] = [];
  const { chrome, timers, warn } = await background({
    host: async (m: any) => {
      asked.push(m.type);
      if (m.type === 'open') return open;
      // once it is up, MoPilot asks the user
      return open.type === 'opened' ? { pending: true } : { type: 'none' };
    },
  });
  const r: any = await askBackground(chrome, { type: 'connect' });
  assert.equal(r.starting, true, 'no pairing and no question: it starts MoPilot');
  assert.deepEqual(asked.slice(-2), ['claim', 'open']);
  open = { type: 'opened' };
  const t = timers.timeouts.find((x: any) => x.ms === LAUNCH_AGAIN_MS)!;
  timers.timeouts.splice(timers.timeouts.indexOf(t), 1);
  t.f();
  await tick(5);
  assert.equal(asked.at(-1), 'claim');
  assert.equal(((await askBackground(chrome, { type: 'status' })) as any).asking, true);
  // while MoPilot asks the user, Connect doesn't start it again
  const opens = asked.filter((a) => a === 'open').length;
  await askBackground(chrome, { type: 'connect' });
  assert.equal(asked.filter((a) => a === 'open').length, opens);
  warn.mock.restore();
});

test('Connect when MoPilot is running but refuses the claim does not bring it to the front', async () => {
  const asked: string[] = [];
  const { chrome, warn } = await background({
    host: async (m: any) => {
      asked.push(m.type);
      if (m.type === 'open') return { type: 'opened' };
      // at startup nothing is offered; on Connect, MoPilot offers a claim it then refuses
      return asked.filter((a) => a === 'claim').length > 1
        ? { type: 'claim', code: `mopilot-claim:1:47615:${'t'.repeat(32)}` }
        : { type: 'none' };
    },
  });
  const done = askBackground(chrome, { type: 'connect' });
  // MoPilot is running and refuses the claim on its socket
  let ws: any;
  await waitFor(() => {
    ws = FakeWs.all.filter((w: any) => w.url.includes(':47615')).at(-1);
    return ws;
  }, 'the :47615 socket');
  await ws.from({ type: 'hello', protocol: 1, nonce: 'n'.repeat(32) });
  await ws.from({ type: 'paired', code: 'not a code' });
  await done;
  assert.equal(asked.includes('open'), false);
  warn.mock.restore();
});
