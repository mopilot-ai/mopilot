// The extension's update-required and not-installed states (#1986 PR 5): a protocol mismatch in the client (src/client.mjs), the update applied when idle (src/updates.mjs), the background's answers, and how the side panel and options page show them.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { background, client, FakeWs, handshake, page, startOptions, tick, viewOf, VIEWS } from './support/extension-background/fixture.ts';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';

const { Updates, NO_UPDATE } = await import('../electron/chrome-extension/src/updates.mjs');
const { olderSide } = await import('../electron/chrome-extension/src/client.mjs');
const { stateOf, STATES } = await import('../electron/chrome-extension/src/sidePanel.mjs');
const { DOWNLOAD_URL, askHost, HOST_MISSING } = await import('../electron/chrome-extension/src/background.mjs');
const { PROTOCOL_VERSION } = await import('../electron/chrome-extension/src/protocol.mjs');

const PAIRING = `mopilot-chrome:1:47615:${'S'.repeat(43)}`;
const own = (chrome: any) => ({ id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` });
const asker = (chrome: any) => (m: any) => new Promise<any>((resolve) => chrome.runtime.onMessage.fire(m, own(chrome), resolve));

test('a hello in another protocol version: update-required naming the older side, kept through retries, cleared by a good handshake', async () => {
  assert.equal(olderSide(PROTOCOL_VERSION + 1), 'extension');
  assert.equal(olderSide(PROTOCOL_VERSION - 1), 'app');
  const { c, timers, statuses } = client();
  await c.connect();
  const ws = FakeWs.all[0];
  await ws.from({ type: 'hello', protocol: PROTOCOL_VERSION + 1, nonce: 'a'.repeat(32) });
  assert.equal(c.status, 'update-required');
  assert.equal(c.update, 'extension');
  assert.equal(ws.closed, 1);
  assert.equal(ws.sent.length, 0, 'no proof goes to a peer on another protocol');
  // its close keeps the state, and the next try waits as long as an unauthorized one
  ws.onclose();
  assert.equal(c.status, 'update-required');
  assert.equal(timers.timeouts.at(-1)!.ms, 30_000);
  // the next try doesn't flash Connecting…
  timers.timeouts.at(-1)!.f();
  await tick();
  assert.equal(c.status, 'update-required');
  const next = FakeWs.all[1];
  assert.ok(next);
  // an older MoPilot: the app is the side to update
  await next.from({ type: 'hello', protocol: PROTOCOL_VERSION - 1, nonce: 'b'.repeat(32) });
  assert.equal(c.update, 'app');
  next.onclose();
  timers.timeouts.at(-1)!.f();
  await tick();
  await handshake(FakeWs.all[2]);
  assert.equal(c.status, 'connected');
  assert.equal(c.update, null);
  assert.deepEqual(statuses, ['connecting', 'update-required', 'connected']);
  // a hello with no number is still an impostor, not an update
  const odd = client();
  await odd.c.connect();
  await FakeWs.all.at(-1)!.from({ type: 'hello', protocol: 'two', nonce: 'a'.repeat(32) });
  assert.equal(odd.c.status, 'unauthorized');
});

test('Updates: a downloaded update reloads at once when idle, else on the next apply once no agent holds a tab; Update extension asks Chrome', async () => {
  const chrome: any = fakeChromeApi();
  let idle = false;
  const logged: string[] = [];
  const u = new Updates({ chrome, idle: () => idle, log: (w: string) => logged.push(w) });
  const reloads = () => chrome.log.filter((l: any) => l[0] === 'runtime.reload').length;
  assert.equal(u.apply(), false, 'nothing downloaded');
  chrome.runtime.onUpdateAvailable.fire({ version: '0.3.4' });
  assert.equal(u.pending, true);
  assert.equal(reloads(), 0, 'an agent holds a tab: it waits');
  idle = true;
  assert.equal(u.apply(), true);
  assert.equal(reloads(), 1);
  // Update extension: one downloaded already is applied; none asks Chrome
  assert.equal(await u.check(), null);
  assert.equal(reloads(), 2);
  u.pending = false;
  assert.equal(await u.check(), NO_UPDATE);
  chrome.runtime.updateCheck = { status: 'update_available' };
  assert.equal(await u.check(), null, 'Chrome downloads it; onUpdateAvailable applies it');
  chrome.runtime.updateCheck = { status: 'throttled' };
  assert.equal(await u.check(), NO_UPDATE);
  // an unpacked extension has nothing to check: said, and logged
  chrome.runtime.updateCheck = new Error('no update URL');
  assert.equal(await u.check(), NO_UPDATE);
  assert.deepEqual(logged, ['check for an extension update']);
});

test('the background: update-required in its status with the side to update and a badge; Update extension and Download answer; idle updates apply on the alarm', async () => {
  const { chrome, bg, warn } = await background({ pairing: PAIRING });
  try {
    const ask = asker(chrome);
    const ws = FakeWs.all.at(-1)!;
    await ws.from({ type: 'hello', protocol: PROTOCOL_VERSION + 1, nonce: 'a'.repeat(32) });
    assert.ok(chrome.log.some((l: any) => l[0] === 'action.setBadgeText' && l[1].text === '!'));
    const s = await ask({ type: 'status' });
    assert.equal(s.status, 'update-required');
    assert.equal(s.update, 'extension');
    // Update extension: nothing newer yet, said
    const none = await ask({ type: 'update' });
    assert.equal(none.error, NO_UPDATE);
    chrome.runtime.updateCheck = { status: 'update_available' };
    const updating = await ask({ type: 'update' });
    assert.equal(updating.updating, true);
    assert.equal(updating.error, undefined);
    // Download MoPilot opens its download page
    const d = await ask({ type: 'download' });
    assert.deepEqual(chrome.log.filter((l: any) => l[0] === 'tabs.create').at(-1), ['tabs.create', { url: DOWNLOAD_URL }]);
    assert.equal(d.status, 'update-required');
    // an update Chrome downloaded while no agent holds a tab: applied at once; else on the reconnect alarm once let go
    bg.sessions.owner.set(7, 'chat');
    chrome.runtime.onUpdateAvailable.fire({});
    assert.equal(chrome.log.filter((l: any) => l[0] === 'runtime.reload').length, 0);
    bg.sessions.owner.delete(7);
    chrome.alarms.onAlarm.fire({ name: 'other' });
    assert.equal(chrome.log.filter((l: any) => l[0] === 'runtime.reload').length, 0);
    chrome.alarms.onAlarm.fire({ name: 'mopilot-reconnect' });
    assert.equal(chrome.log.filter((l: any) => l[0] === 'runtime.reload').length, 1);
  } finally {
    warn.mock.restore();
  }
});

test('MoPilot not installed: Chrome finds no native host, so offline or unpaired reads as missing (Download), and Open MoPilot adds no error', async () => {
  assert.ok(HOST_MISSING.test('Specified native messaging host not found.'));
  const missing = mock.fn();
  const chrome: any = fakeChromeApi();
  chrome.runtime.sendNativeMessage = async () => {
    throw new Error('Specified native messaging host not found.');
  };
  assert.equal(await askHost(chrome, { auto: true, missing }), null);
  assert.deepEqual(missing.mock.calls[0].arguments, [true]);
  chrome.runtime.sendNativeMessage = async () => ({ pending: true });
  await askHost(chrome, { missing });
  assert.deepEqual(missing.mock.calls[1].arguments, [false]);

  let host: (m: any) => Promise<any> = async () => {
    throw new Error('Specified native messaging host not found.');
  };
  const { chrome: c2, warn } = await background({ host: (m) => host(m) });
  try {
    const ask = asker(c2);
    const s = await ask({ type: 'status' });
    assert.equal(s.status, 'unpaired');
    assert.equal(s.missing, true);
    const launched = await ask({ type: 'launch' });
    assert.equal(launched.missing, true);
    assert.equal(launched.error, undefined, 'the panel offers Download instead of "Open from Applications"');
    // another failure (the host crashed) isn't "not installed"
    host = async () => {
      throw new Error('Native host has exited.');
    };
    const crashed = await ask({ type: 'launch' });
    assert.equal(crashed.missing, undefined);
    assert.equal(crashed.error, 'Open MoPilot from Applications.');
    // an answer from the host: it is installed
    host = async () => null;
    await ask({ type: 'launch' });
    assert.equal((await ask({ type: 'status' })).missing, undefined);
  } finally {
    warn.mock.restore();
  }
  // connected, missing never shows
  const { chrome: c3, bg, warn: w3 } = await background({ pairing: PAIRING });
  try {
    await handshake(FakeWs.all.at(-1)!, { secret: 'S'.repeat(43) });
    assert.equal(bg.client.status, 'connected');
    assert.equal((await asker(c3)({ type: 'status' })).missing, undefined);
  } finally {
    w3.mock.restore();
  }
});

test('the side panel and options page: each side to update, Updating…, and Get MoPilot, with their one button', async () => {
  assert.equal(stateOf({ status: 'update-required', update: 'extension' }), STATES.updateExtension);
  assert.equal(stateOf({ status: 'update-required', update: 'extension', updating: true }), STATES.updating);
  assert.equal(stateOf({ status: 'update-required', update: 'app' }), STATES.updateApp);
  assert.equal(stateOf({ status: 'offline', missing: true }), STATES.missing);
  assert.equal(stateOf({ status: 'offline', missing: true, starting: true }), STATES.starting);
  assert.equal(STATES.updateExtension.send, 'update');
  assert.equal(STATES.updateApp.send, 'download');
  assert.equal(STATES.missing.send, 'download');
  assert.equal(stateOf({ status: 'connected', update: 'app' }), null);

  assert.equal(viewOf({ status: 'update-required', update: 'extension' }), VIEWS.updateExtension);
  assert.equal(viewOf({ status: 'update-required', update: 'app' }), VIEWS.updateApp);
  assert.equal(viewOf({ status: 'unpaired', missing: true }), VIEWS.missing);
  assert.equal(viewOf({ status: 'update-required', error: NO_UPDATE }).text, NO_UPDATE);

  const p = page();
  p.chrome.reply = (m: any) =>
    m.type === 'update'
      ? { status: 'update-required', update: 'extension', error: NO_UPDATE }
      : { status: 'update-required', update: 'extension' };
  await startOptions(p.g).ready;
  assert.equal(p.els.line.textContent, 'Extension update required.');
  assert.equal(p.els.update.hidden, false);
  assert.equal(p.els.download.hidden, true);
  assert.equal(p.els.connect.hidden, true);
  assert.equal(p.timers.timeouts.at(-1)?.ms, 5_000, 'asked again while it waits for the update');
  await p.els.update.listeners.click();
  assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'update' }]);
  assert.equal(p.els.line.textContent, NO_UPDATE);
  p.chrome.reply = () => ({ status: 'offline', missing: true });
  await p.els.download.listeners.click();
  assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'download' }]);
  assert.equal(p.els.line.textContent, "MoPilot isn't set up on this computer.");
  assert.equal(p.els.download.hidden, false);
  assert.equal(p.els.update.hidden, true);
});

test('the options page tells its settings tabs when the connection comes up, once per time it does', async () => {
  const p = page();
  const onConnected = mock.fn();
  let status = 'unpaired';
  p.chrome.reply = () => ({ status });
  const { refresh } = startOptions(p.g, { onConnected });
  await refresh();
  assert.equal(onConnected.mock.callCount(), 0);
  status = 'connected';
  await refresh();
  await refresh();
  assert.equal(onConnected.mock.callCount(), 1);
  status = 'offline';
  await refresh();
  status = 'connected';
  await refresh();
  assert.equal(onConnected.mock.callCount(), 2);
});
