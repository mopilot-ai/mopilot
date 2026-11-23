// Extension cases for pairing through MoPilot's native messaging host (#1632): asking the host while unpaired, the page opened for the host, and what a missing host or a refused claim leaves.
import {
  test,
  assert,
  protocol,
  until,
  tick,
  SECRET,
  FakeWs,
  background,
  ask,
  page,
  startOptions,
  RECONNECT_ALARM,
  handshake,
} from './fixture.ts';

const { askHost, ASK_AGAIN_MS, ASK_FOR_MS, LAUNCH_AGAIN_MS, LAUNCH_FOR_MS }: any = await import(
  '../../../electron/chrome-extension/src/background.mjs'
);
const TOKEN = 'h'.repeat(32);
const CLAIM = `mopilot-claim:1:50003:${TOKEN}`;

/** Answers the claim on the newest socket the extension opened to trade it. */
async function honor(port = 50003) {
  await until(() => FakeWs.all.at(-1)?.url === `ws://127.0.0.1:${port}/mopilot-chrome`);
  const ws = FakeWs.all.at(-1) as FakeWs;
  await ws.from({ type: 'hello', protocol: 1, nonce: 'n' });
  assert.deepEqual(ws.sent.at(-1), { type: 'claim', protocol: 1, token: TOKEN });
  await ws.from({ type: 'paired', code: protocol.pairingCode(port, SECRET) });
}

export function registerNativeHost() {
  test('askHost: the host’s claim code, or null for no host, no offer, or an answer that isn’t one', async () => {
    const chrome: any = { runtime: { sendNativeMessage: async (name: string, m: any) => ({ name, m }) } };
    const answers: [any, any][] = [
      [
        { type: 'claim', code: CLAIM },
        { port: 50003, token: TOKEN },
      ],
      [{ type: 'claim', code: 'mopilot-chrome:1:1:x' }, null],
      [{ type: 'none', reason: 'MoPilot is not offering a pairing now' }, null],
      [{ type: 'none', pending: true }, { pending: true }],
      [undefined, null],
    ];
    for (const [answer, expected] of answers) {
      const asked: any[] = [];
      chrome.runtime.sendNativeMessage = async (name: string, m: any) => (asked.push([name, m]), answer);
      assert.deepEqual(await askHost(chrome), expected);
      assert.deepEqual(asked, [['ai.mopilot.code.chrome', { type: 'claim', protocol: 1, auto: false }]]);
    }
    // asking by itself says so: MoPilot then answers only an offer the user made in its Settings
    chrome.runtime.sendNativeMessage = async (_name: string, m: any) => ({ type: 'claim', code: m.auto ? CLAIM : 'x' });
    assert.deepEqual(await askHost(chrome, { auto: true }), { port: 50003, token: TOKEN });
    chrome.runtime.sendNativeMessage = async () => {
      throw new Error('Specified native messaging host not found.');
    };
    assert.equal(await askHost(chrome), null);
    // a Chrome without the API (no nativeMessaging permission)
    assert.equal(await askHost({ runtime: {} }), null);
  });

  test('unpaired at start, the extension pairs through the host by itself; paired, it never asks', async () => {
    const asked: any[] = [];
    const host = async (m: any) => (asked.push(m), { type: 'claim', code: CLAIM });
    const starting = background({ host });
    await honor();
    const { chrome, bg, warn } = await starting;
    assert.equal(chrome.store.local.pairing, protocol.pairingCode(50003, SECRET));
    assert.equal(bg.client.status, 'connecting');
    assert.equal(asked.length, 1);
    // connecting now: the alarm reconnects but doesn't ask the host
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    chrome.runtime.onStartup.fire();
    await tick(5);
    assert.equal(asked.length, 1);
    warn.mock.restore();
  });

  test('the host offering nothing leaves it unpaired until the alarm finds an offer; overlapping asks share one', async () => {
    let answer: any = { type: 'none' };
    let asked = 0;
    let release: () => void = () => undefined;
    const host = async () => {
      asked++;
      await new Promise<void>((r) => (release = r));
      return answer;
    };
    const starting = background({ host });
    await until(() => asked === 1);
    release();
    const { chrome, bg, warn } = await starting;
    assert.equal(bg.client.status, 'unpaired');
    assert.equal(chrome.store.local.pairing, undefined);
    // MoPilot offers a pairing now: the alarm and Chrome's startup both ask, as one request
    answer = { type: 'claim', code: CLAIM };
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    chrome.runtime.onStartup.fire();
    await until(() => asked === 2);
    await tick(5);
    assert.equal(asked, 2);
    release();
    await honor();
    await until(() => chrome.store.local.pairing === protocol.pairingCode(50003, SECRET));
    warn.mock.restore();
  });

  test('while MoPilot asks the user, the extension asks again every 2 s for 2 minutes, says so, and pairs on Allow', async () => {
    let now = 1_000;
    let answer: any = { type: 'none', pending: true, reason: 'Waiting for the user to allow it in MoPilot' };
    let asked = 0;
    const { chrome, bg, timers, warn } = await background({ host: async () => (asked++, answer), now: () => now });
    const again = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    assert.equal(asked, 1);
    assert.equal(again().length, 1);
    assert.deepEqual(await ask(chrome, { type: 'status' }), { status: 'unpaired', port: null, asking: true });
    // one timer at a time: the alarm asking meanwhile arms no second one
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    await until(() => asked === 2);
    assert.equal(again().length, 1);
    const fire = async () => {
      const t = again()[0];
      timers.timeouts.splice(timers.timeouts.indexOf(t), 1);
      const before = asked;
      t.f();
      await until(() => asked === before + 1);
      await tick(2);
    };
    await fire();
    assert.equal(again().length, 1, 'still pending: asked again shortly');
    // two minutes after the first pending answer it stops asking on its own; the alarm still asks
    now += ASK_FOR_MS;
    await fire();
    assert.equal(again().length, 0);
    // the user allowed it: the next ask takes the claim and the page no longer says it is waiting
    answer = { type: 'claim', code: CLAIM };
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    await honor();
    await until(() => chrome.store.local.pairing === protocol.pairingCode(50003, SECRET));
    assert.equal(((await ask(chrome, { type: 'status' })) as any).asking, false);
    assert.equal(bg.client.status, 'connecting');
    warn.mock.restore();
  });

  test('a pending answer with the service worker’s own clock still asks again', async () => {
    const { chrome, timers, warn } = await background({ host: async () => ({ type: 'none', pending: true }) });
    assert.equal(timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS).length, 1);
    assert.equal(((await ask(chrome, { type: 'status' })) as any).asking, true);
    warn.mock.restore();
  });

  test('a stored code MoPilot no longer knows (unauthorized) makes the extension ask its host by itself', async () => {
    const asked: any[] = [];
    const host = async (m: any) => (asked.push(m), { type: 'none' });
    const { bg, warn } = await background({ pairing: protocol.pairingCode(50004, SECRET), host });
    assert.deepEqual(asked, [], 'a stored code connects first');
    await handshake(FakeWs.all[0], { badWelcome: true });
    await until(() => bg.client.status === 'unauthorized');
    await until(() => asked.length === 1);
    assert.deepEqual(asked[0], { type: 'claim', protocol: 1, auto: true });
    warn.mock.restore();
  });

  test('a pairing through the host that fails to be kept is logged, not thrown, on the alarm path', async () => {
    const { chrome, warn } = await background({ host: async () => ({ type: 'none' }) });
    chrome.runtime.sendNativeMessage = async () => ({ type: 'claim', code: CLAIM });
    chrome.storage.local.set = async () => {
      throw new Error('disk full');
    };
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    await honor();
    await until(() => warn.mock.calls.some((c: any) => String(c.arguments[0]).includes("pair through MoPilot's native host")));
    warn.mock.restore();
  });

  test('Connect (or a page MoPilot opened for its host) asks the host now; Disconnect holds the asks until Connect', async () => {
    let answer: any = { type: 'none', pending: true };
    let asked = 0;
    const { chrome, bg, warn } = await background({ host: async () => (asked++, answer) });
    assert.equal(asked, 1);
    assert.deepEqual(await ask(chrome, { type: 'connect' }), { status: 'unpaired', port: null, asking: true });
    assert.equal(asked, 2);
    // Disconnect: kept across restarts, and neither the alarm nor startup asks
    await ask(chrome, { type: 'unpair' });
    assert.equal(chrome.store.local.held, true);
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    chrome.runtime.onStartup.fire();
    await tick(5);
    assert.equal(asked, 2);
    // Connect lifts it and asks; the user allows it in MoPilot
    answer = { type: 'claim', code: CLAIM };
    const connecting = ask(chrome, { type: 'connect' });
    await honor();
    assert.deepEqual(await connecting, { status: 'connecting', port: 50003, asking: false });
    assert.equal(chrome.store.local.held, undefined);
    assert.equal(bg.client.status, 'connecting');
    warn.mock.restore();
  });

  test('a Disconnect kept from before holds the asks at startup; a pair by code lifts it', async () => {
    let asked = 0;
    const { chrome, warn } = await background({ held: true, host: async () => (asked++, { type: 'none', pending: true }) });
    assert.equal(asked, 0);
    await ask(chrome, { type: 'pair', code: protocol.pairingCode(50005, SECRET) });
    assert.equal(chrome.store.local.held, undefined);
    warn.mock.restore();
  });

  test('Try it asks MoPilot to open its sample chat; no host or no answer says to open MoPilot', async () => {
    const asked: any[] = [];
    let answer: any = { type: 'opened' };
    const { chrome, warn } = await background({
      host: async (m: any) => {
        asked.push(m);
        if (answer instanceof Error) throw answer;
        return m.type === 'open' ? answer : { type: 'none' };
      },
    });
    assert.deepEqual(await ask(chrome, { type: 'try' }), { status: 'unpaired', port: null, asking: false, opened: true });
    assert.deepEqual(asked.at(-1), { type: 'open', protocol: 1, what: 'try' });
    for (const a of [{ type: 'none' }, new Error('Specified native messaging host not found.')]) {
      answer = a;
      assert.equal(((await ask(chrome, { type: 'try' })) as any).error, "Couldn't reach MoPilot. Open it, then try again.");
    }
    warn.mock.restore();
  });

  test('Open MoPilot: opened connects now; starting asks again every second for 30 s; no app says where to open it', async () => {
    let now = 1_000;
    let answer: any = { type: 'none', starting: true, reason: 'Starting MoPilot' };
    const asked: any[] = [];
    const { chrome, timers, warn } = await background({
      pairing: protocol.pairingCode(50006, SECRET),
      now: () => now,
      host: async (m: any) => (asked.push(m), m.type === 'open' ? answer : { type: 'none' }),
    });
    const again = () => timers.timeouts.filter((t: any) => t.ms === LAUNCH_AGAIN_MS);
    const r: any = await ask(chrome, { type: 'launch' });
    assert.deepEqual([r.starting, r.error], [true, undefined]);
    assert.deepEqual(asked.at(-1), { type: 'open', protocol: 1, what: 'app' });
    assert.equal(again().length, 1);
    // still starting: asked again; it is up: connected at once, nothing more to ask
    const fire = async () => {
      const t = again()[0];
      timers.timeouts.splice(timers.timeouts.indexOf(t), 1);
      t.f();
      await tick(3);
    };
    await fire();
    assert.equal(again().length, 1);
    const sockets = FakeWs.all.length;
    answer = { type: 'opened' };
    await fire();
    assert.equal(again().length, 0);
    assert.ok(FakeWs.all.length > sockets, 'it connects as soon as MoPilot is up');
    assert.equal(((await ask(chrome, { type: 'status' })) as any).starting, undefined);
    // starting for 30 s: it stops asking; no app (a developer build) or no host: where to open it
    answer = { type: 'none', starting: true };
    await ask(chrome, { type: 'launch' });
    now += LAUNCH_FOR_MS;
    await fire();
    assert.equal(again().length, 0);
    for (const a of [{ type: 'none', reason: "MoPilot isn't running" }, new Error('no host')]) {
      answer = a instanceof Error ? undefined : a;
      if (a instanceof Error)
        chrome.runtime.sendNativeMessage = async () => {
          throw a;
        };
      assert.equal(((await ask(chrome, { type: 'launch' })) as any).error, 'Open MoPilot from Applications.');
    }
    warn.mock.restore();
  });

  test('Open MoPilot with the service worker’s own clock: the first "starting" keeps asking', async () => {
    const { chrome, timers, warn } = await background({
      host: async (m: any) => (m.type === 'open' ? { type: 'none', starting: true } : { type: 'none' }),
    });
    const r: any = await ask(chrome, { type: 'launch' });
    assert.deepEqual([r.starting, r.error], [true, undefined]);
    assert.equal(timers.timeouts.filter((t: any) => t.ms === LAUNCH_AGAIN_MS).length, 1);
    warn.mock.restore();
  });

  test('the options page opened with #pair=host: no code anywhere, and it asks the host at once', async () => {
    const p = page('#pair=host');
    p.chrome.reply = (m: any) =>
      m.type === 'connect' ? { status: 'unpaired', port: null, asking: true } : { status: 'unpaired', port: null };
    await startOptions(p.g).ready;
    assert.deepEqual(p.history.replaceState.mock.calls[0].arguments, [null, '', '/options.html']);
    assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'connect' }]);
    assert.equal(p.els.code?.value, undefined, 'the page never touched the code field');
    assert.equal(p.els.line.textContent, 'Allow it in MoPilot to finish connecting.');
  });
}
