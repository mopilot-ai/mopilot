// Pending panel sends own only their submitted draft and attachment cohort; later typing and conversation selection remain independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelPage } from './support/side-panel-page.ts';
import { tick } from './support/extension-background/fixture.ts';
import { startSidePanel } from '../electron/chrome-extension/src/sidePanel.mjs';
async function setup(existing = false) {
  const p = panelPage();
  await startSidePanel(p.g).ready;
  await tick();
  const submit = () => p.els.composer.listeners.submit({ preventDefault() {} });
  const type = (text: string) => {
    p.els.text.value = text;
    p.els.text.listeners.input();
  };
  if (existing) {
    type('Earlier');
    await submit();
    await tick();
  }
  const base = p.chrome.runtime.sendMessage;
  let finish: any;
  p.chrome.runtime.sendMessage = (m: any) => {
    if (m.method === (existing ? 'send' : 'start'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (m.type === 'capture') return Promise.resolve({ dataUrl: 'data:image/png;base64,c2hvdA==' });
    if (m.method === 'attach')
      return Promise.resolve({ status: 'connected', result: { id: '0000000000000001', name: 'Screenshot.png', kind: 'image' } });
    return base(m);
  };
  const begin = async () => {
    type('Submitted draft A');
    const pending = submit();
    await tick();
    return { pending };
  };
  return { p, type, begin, finish: (result: any) => finish(result) };
}

test('a refused follow-up cannot overwrite typing done while the native operation waited', async () => {
  const f = await setup(true);
  const { pending } = await f.begin();
  f.type('Independent draft B');
  f.finish({ status: 'connected', error: 'Native connection failed' });
  await pending;
  await tick();
  assert.equal(f.p.els.text.value, 'Independent draft B');
  assert.match(f.p.els.error.textContent, /Submitted draft A/);
});

test('a failed message retained outside the composer survives another error and New chat', async () => {
  const f = await setup(true);
  const { pending } = await f.begin();
  f.type('Independent draft B');
  f.finish({ status: 'connected', error: 'Native connection failed' });
  await pending;
  const base = f.p.chrome.runtime.sendMessage;
  f.p.chrome.runtime.sendMessage = (m: any) => (m.method === 'open' ? Promise.resolve({ error: 'Cannot open app' }) : base(m));
  f.p.els.app.listeners.click();
  await tick();
  assert.match(f.p.els.error.textContent, /Submitted draft A/);
  assert.match(f.p.els.error.textContent, /Cannot open app/);
  f.p.els.new.listeners.click();
  assert.match(f.p.els.error.textContent, /Submitted draft A/);
});

test('a newly created chat preserves typing that changed while its initial send waited', async () => {
  const f = await setup();
  const { pending } = await f.begin();
  f.type('Independent draft B');
  f.finish({ status: 'connected', result: { chatId: 'created' } });
  await pending;
  await tick();
  assert.equal(f.p.els.text.value, 'Independent draft B');
});

test('an accepted earlier send clears its own attachment cohort after navigation and still reports a handoff warning', async () => {
  const f = await setup(true);
  f.p.els.shot.listeners.click();
  await tick();
  await tick();
  assert.equal(f.p.els.attached.hidden, false);
  const { pending } = await f.begin();
  f.p.els.new.listeners.click();
  f.type('Independent draft B');
  f.finish({ status: 'connected', result: { warning: 'Page unavailable' } });
  await pending;
  await tick();
  assert.equal(f.p.els.text.value, 'Independent draft B');
  assert.equal(f.p.els.attached.hidden, true);
  assert.equal(f.p.els.error.textContent, 'For the earlier message: Page unavailable');
});

test('a failed earlier send reports its retained text without replacing another conversation’s draft', async () => {
  const f = await setup(true);
  const { pending } = await f.begin();
  f.p.els.new.listeners.click();
  f.type('Independent draft B');
  f.finish({ status: 'connected', error: 'Not connected' });
  await pending;
  await tick();
  assert.equal(f.p.els.text.value, 'Independent draft B');
  assert.match(f.p.els.error.textContent, /Submitted draft A/);
  assert.match(f.p.els.error.textContent, /Not connected/);
});

for (const outcome of ['failed', 'accepted'])
  test(`an earlier initial ${outcome} send reports its outcome after a different view was opened`, async () => {
    const f = await setup();
    const { pending } = await f.begin();
    f.p.els.new.listeners.click();
    f.finish({
      status: 'connected',
      result: { chatId: 'created', ...(outcome === 'failed' ? { error: 'Dispatch unavailable' } : { warning: 'Page unavailable' }) },
    });
    await pending;
    await tick();
    assert.match(
      f.p.els.error.textContent,
      outcome === 'failed' ? /earlier message was not sent.*Dispatch unavailable/s : /earlier message: Page unavailable/,
    );
    assert.equal(f.p.els.text.value, '');
  });

for (const existing of [false, true])
  for (const typed of [false, true])
    test(`unconfirmed delivery never restores a duplicate draft (existing ${existing}, later typing ${typed})`, async () => {
      const f = await setup(existing);
      const { pending } = await f.begin();
      if (typed) f.type('Independent draft B');
      f.finish({
        status: 'connected',
        error: 'Delivery is unconfirmed. Check the chat before sending again.',
        code: 'delivery_unconfirmed',
      });
      await pending;
      await tick();
      assert.equal(f.p.els.text.value, typed ? 'Independent draft B' : '');
      assert.match(f.p.els.error.textContent, /Delivery is unconfirmed/);
      assert.match(f.p.els.error.textContent, /Message: Submitted draft A/);
    });

test('actual panel transport timeout and connection loss distinguish unconfirmed input from a safe-to-retry read', async () => {
  const { PanelLink } = await import('../electron/chrome-extension/src/panelLink.mjs');
  const { fakeTimers } = await import('./support/extension-background/fixture.ts');
  for (const method of ['start', 'send'])
    for (const dropped of [false, true]) {
      const timers: any = fakeTimers();
      const link = new PanelLink({ send: () => {}, connected: () => true, timers });
      const pending = link.request(method);
      const refusal = assert.rejects(pending, { code: 'delivery_unconfirmed', message: /Check the chat/ });
      if (dropped) link.drop();
      else timers.timeouts[0].f();
      await refusal;
    }
});

test('the real worker preserves unconfirmed delivery codes and refuses an older app before handing it a page', async () => {
  const { background, FakeWs, handshake, ask, tick } = await import('./support/extension-background/fixture.ts');
  for (const panelTabs of [false, true]) {
    const { chrome, bg, timers, warn } = await background({ pairing: `mopilot-chrome:1:47615:${'S'.repeat(43)}` });
    try {
      const ws = FakeWs.all.at(-1)!;
      await handshake(ws, { secret: 'S'.repeat(43), panelTabs });
      const tab = chrome.addTab({ url: 'https://example.org/current' });
      const sender = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html?tabId=${tab.id}` };
      const pending = ask(chrome, { type: 'panel', method: 'send', params: { chatId: 'chat', text: 'Read', tab: { id: tab.id } } }, sender);
      await tick();
      if (panelTabs) timers.timeouts.find((v: any) => v.ms === 15_000)!.f();
      const response: any = await pending;
      assert.match(response.error, panelTabs ? /Delivery is unconfirmed/ : /Update MoPilot/);
      assert.equal(response.code, panelTabs ? 'delivery_unconfirmed' : undefined);
      assert.equal(bg.sessions.admissions.grants.size, 0);
      ws.onclose();
      assert.equal(bg.client.panelTabs, false);
    } finally {
      bg.client.dispose();
      warn.mock.restore();
    }
  }
});

for (const existing of [false, true])
  for (const failed of [false, true])
    test(`a context-menu selection arriving during a send remains a new draft (existing ${existing}, failed ${failed})`, async () => {
      const f = await setup(existing);
      const base = f.p.chrome.runtime.sendMessage;
      f.p.chrome.runtime.sendMessage = (m: any) => (m.type === 'takeDraft' ? Promise.resolve({ text: 'Selected after Send' }) : base(m));
      const { pending } = await f.begin();
      f.p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'draft', tabId: 500 } });
      await tick();
      await tick();
      const inserted = f.p.els.text.value;
      assert.ok(inserted.includes('Selected after Send'));
      f.finish({ status: 'connected', ...(failed ? { error: 'Native transport failed' } : { result: { chatId: 'created' } }) });
      await pending;
      await tick();
      assert.equal(f.p.els.text.value, inserted);
    });

test('a fully restored composer never resurrects its submitted saved draft when taking a new context-menu selection', async () => {
  const { PanelTab } = await import('../electron/chrome-extension/src/panelTab.mjs');
  const { fakeChromeApi } = await import('./support/chrome-extension-kit.ts');
  const chrome: any = fakeChromeApi();
  const own = new PanelTab({ chrome, search: '?tabId=500', log: () => {} });
  own.draftReady = true;
  const box = { value: '', focus() {} };
  await own.takeDraft(
    box,
    async () => ({ text: 'Only the new selection' }),
    () => {},
  );
  assert.equal(box.value, 'Only the new selection');
  assert.equal(own.draftRevision, 1);
  assert.equal(chrome.log.filter((c: any) => c[0] === 'storage.session.get').length, 0);
});

for (const url of ['chrome://newtab/', 'chrome://settings/', 'about:blank', ''])
  test(`a non-web panel page (${url}) sends normal initial and follow-up messages without any tab grant`, async () => {
    const p = panelPage({ tab: { id: 500, url, title: 'Non-web tab', active: true } });
    await startSidePanel(p.g).ready;
    await tick();
    for (const text of ['Hello', 'Continue']) {
      p.els.text.value = text;
      p.els.text.listeners.input();
      await p.els.composer.listeners.submit({ preventDefault() {} });
      await tick();
    }
    const sends = p.sent().filter((m: any) => ['start', 'send'].includes(m.method));
    assert.deepEqual(
      sends.map((m: any) => m.method),
      ['start', 'send'],
    );
    assert.ok(sends.every((m: any) => m.params.tab === undefined));
    assert.equal(p.els.error.textContent, '');
  });
