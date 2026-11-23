// Extension page unit cases (the toolbar popup and the options page) using shared fake Chrome, socket, timer, and page fixtures.
import { test, assert, mock, protocol, startOptions, VIEWS, viewOf, tick, SECRET, page } from './fixture.ts';

export function registerOptions() {
  test('the page shows one state at a time: connected hides the offer, the code and Connect; Disconnect only then', async () => {
    const p = page();
    p.chrome.reply = () => ({ status: 'connected', port: 60282 });
    await startOptions(p.g).ready;
    assert.equal(p.els.line.textContent, 'Connected to MoPilot');
    assert.equal(p.els.dot.className, 'dot ok');
    assert.equal(p.els.connect.hidden, true);
    assert.equal(p.els.disconnect.hidden, false);
    assert.equal(p.els.port.textContent, 'Port 60282', 'the port only under Advanced');
    assert.equal(p.els.advanced?.open, undefined, 'Advanced stays closed');
    await p.els.disconnect.listeners.click();
    assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'unpair' }]);
  });

  test('each status reads as one line and one next step; MoPilot asking wins until connected; an error keeps Connect', () => {
    const cases: [any, string, string, boolean][] = [
      [{ status: 'unpaired' }, 'off', 'Not connected', true],
      [{ status: 'unauthorized' }, 'off', 'Not connected', true],
      [{ status: 'connecting' }, 'wait', 'Connecting…', false],
      [{ status: 'offline' }, 'off', "MoPilot isn't open.", false],
      [{ status: 'unpaired', asking: true }, 'wait', 'Allow it in MoPilot to finish connecting.', false],
      [{ status: 'connected', asking: true }, 'ok', 'Connected to MoPilot', false],
      [{ status: 'unpaired', error: 'That code expired. Press Connect.' }, 'error', 'That code expired. Press Connect.', true],
      [{ status: 'weird' }, 'off', '', false],
      [undefined, 'off', '', false],
    ];
    for (const [r, tone, text, connect] of cases) {
      const { launch: _launch, ...v } = viewOf(r);
      assert.deepEqual(v, { tone, text, connect }, JSON.stringify(r));
    }
    // MoPilot isn't open: the page offers to open it, and says so while it starts
    assert.equal(viewOf({ status: 'offline' }).launch, true);
    assert.deepEqual(viewOf({ status: 'offline', starting: true }), VIEWS.starting);
    assert.equal(viewOf({ status: 'connected', starting: true }).text, 'Connected to MoPilot');
    for (const v of Object.values(VIEWS) as any[]) assert.ok(v.text.length <= 48, `short like the vendors': ${v.text}`);
  });

  test('Open MoPilot shows only while it isn’t open; the page follows it while it starts', async () => {
    const p = page();
    p.chrome.reply = (m: any) => (m.type === 'launch' ? { status: 'offline', starting: true } : { status: 'offline', port: 1 });
    await startOptions(p.g).ready;
    assert.equal(p.els.launch.hidden, false);
    await p.els.launch.listeners.click();
    assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'launch' }]);
    assert.equal(p.els.line.textContent, 'Starting MoPilot…');
    assert.equal(p.els.launch.hidden, true);
    assert.equal(p.timers.timeouts.at(-1)?.ms, 1000);
  });

  test('Connect asks MoPilot; the page then says to allow it there', async () => {
    const p = page();
    await startOptions(p.g).ready;
    assert.equal(p.els.connect.hidden, false);
    assert.equal(p.els.disconnect.hidden, true);
    assert.equal(p.els.port.textContent, '');
    p.chrome.reply = (m: any) => (m.type === 'connect' ? { status: 'unpaired', port: null, asking: true } : { status: 'unpaired' });
    await p.els.connect.listeners.click();
    assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'connect' }]);
    assert.equal(p.els.line.textContent, VIEWS.asking.text);
    assert.equal(p.els.connect.hidden, true);
  });

  test('a code MoPilot offered goes into Advanced, opened, out of the address bar; Pair sends it', async () => {
    for (const code of [protocol.pairingCode(47615, SECRET), `mopilot-claim:1:47615:${'t'.repeat(32)}`]) {
      const p = page(`#pair=${encodeURIComponent(code)}`);
      await startOptions(p.g).ready;
      assert.deepEqual(p.history.replaceState.mock.calls[0].arguments, [null, '', '/options.html']);
      assert.equal(p.els.code.value, code);
      assert.equal(p.els.advanced.open, true);
      assert.match(p.els.hint.textContent, /offered this code/);
      await p.els.pair.listeners.click();
      assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'pair', code }]);
    }
    const odd = page('#pair=junk');
    await startOptions(odd.g).ready;
    assert.equal(odd.els.code.value, '');
    assert.equal(odd.els.hint.textContent, "That isn't a MoPilot pairing code.");
    const none = page();
    await startOptions(none.g).ready;
    assert.equal(none.history.replaceState.mock.callCount(), 0);
    const nohash = page();
    (nohash.g.location as any).hash = undefined;
    await startOptions(nohash.g).ready;
  });

  test('the pin tip shows only when Chrome says the extension is off the toolbar; the popup has no Advanced or tip', async () => {
    for (const [settings, hidden] of [
      [{ isOnToolbar: false }, false],
      [{ isOnToolbar: true }, true],
      [undefined, true],
    ] as const) {
      const p = page();
      p.chrome.action.userSettings = settings;
      await startOptions(p.g).ready;
      await tick();
      assert.equal(p.els.pin.hidden, hidden);
    }
    const failing = page();
    failing.chrome.action.getUserSettings = async () => {
      throw new Error('old Chrome');
    };
    const warn = mock.method(console, 'warn', () => undefined);
    await startOptions(failing.g).ready;
    await tick();
    assert.equal(failing.els.pin.hidden, undefined);
    assert.match(String(warn.mock.calls[0].arguments[0]), /on the toolbar/);
    warn.mock.restore();
    // the popup: only the state line, its dot and the two buttons exist
    const popup = page('#pair=junk');
    const only = new Set(['dot', 'line', 'connect', 'disconnect']);
    const get = popup.g.document.getElementById;
    popup.g.document.getElementById = (id: string) => (only.has(id) ? get(id) : null);
    popup.chrome.reply = () => ({ status: 'connected', port: 1 });
    await startOptions(popup.g).ready;
    assert.deepEqual(Object.keys(popup.els).sort(), ['connect', 'disconnect', 'dot', 'line']);
  });

  test('opened on install, the page is a checklist: connected, pinned, Try it, each done as it happens', async () => {
    const p = page('#welcome');
    let reply: any = { status: 'unpaired', port: null };
    p.chrome.reply = (m: any) => (m.type === 'try' ? { status: 'connected', port: 1, opened: true } : reply);
    p.chrome.action.userSettings = { isOnToolbar: false };
    await startOptions(p.g).ready;
    await tick();
    assert.deepEqual(p.history.replaceState.mock.calls[0].arguments, [null, '', '/options.html']);
    assert.equal(p.els.welcome.hidden, false);
    assert.deepEqual([p.els['step-connect'].className, p.els['step-pin'].className, p.els['step-try'].className], ['', '', '']);
    await p.els.try.listeners.click();
    assert.deepEqual(p.chrome.log.at(-1), ['runtime.sendMessage', { type: 'try' }]);
    assert.deepEqual([p.els['step-connect'].className, p.els['step-try'].className], ['done', 'done']);
    // pinned later: read again on the next page that asks; a later answer keeps Try it done
    const pinned = page('#welcome');
    pinned.chrome.action.userSettings = { isOnToolbar: true };
    await startOptions(pinned.g).ready;
    await tick();
    assert.equal(pinned.els['step-pin'].className, 'done');
    // pinned while the page is open, even once connected: the page keeps asking until it is, then stops
    const later = page('#welcome');
    later.chrome.reply = () => ({ status: 'connected', port: 1 });
    later.chrome.action.userSettings = { isOnToolbar: false };
    await startOptions(later.g).ready;
    await tick();
    const follow = () => later.timers.timeouts.at(-1);
    assert.equal(follow()?.ms, 2000);
    later.chrome.action.userSettings = { isOnToolbar: true };
    await follow()!.f();
    await tick(2);
    assert.equal(later.els['step-pin'].className, 'done');
    await follow()!.f();
    await tick(2);
    assert.equal(later.timers.timeouts.length, 0, 'pinned and connected: nothing more to follow');
    // an error stays: no follow-up overwrites it
    later.chrome.reply = () => ({ status: 'unpaired', error: 'x' });
    await later.els.try.listeners.click();
    assert.equal(later.timers.timeouts.length, 0);
    reply = { status: 'unpaired' };
    // without #welcome the checklist stays hidden
    const plain = page();
    await startOptions(plain.g).ready;
    assert.equal(plain.els.welcome, undefined);
  });

  for (const entry of ['options'])
    test(`the ${entry} page entry starts the page on its window`, async () => {
      const p = page();
      // connected: a settled page, so nothing follows on the real timers it uses here
      p.chrome.reply = () => ({ status: 'connected', port: 1 });
      const g = globalThis as any;
      const saved = { chrome: g.chrome, document: g.document, location: g.location, history: g.history };
      Object.assign(g, { chrome: p.g.chrome, document: p.g.document, location: p.g.location, history: p.g.history });
      try {
        await import(`../../../electron/chrome-extension/${entry}.mjs`);
        await tick();
        assert.ok(p.els.connect.listeners.click);
      } finally {
        Object.assign(g, saved);
      }
    });
}
