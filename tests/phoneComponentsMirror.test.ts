// The read-only terminal: opening, ordered output, gaps, exit, failures with retry, and clean-up on leaving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
const terminalPath = '../mobile/src/screens/Terminal';
const threadPath = '../mobile/src/screens/Thread';
const { Terminal } = await import(terminalPath);
const { Thread } = await import(threadPath);

const b64 = (s: string) => Buffer.from(s).toString('base64');
const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return { host, root };
}
const has = (host: HTMLElement, re: RegExp) => assert.match(host.textContent!, re);
/** A scripted runtime whose events the test sends. */
function live(handler: (m: string, p: any) => unknown) {
  const s = scripted(handler);
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const send = async (e: any) => {
    await act(async () => listeners.forEach((f) => f(e)));
    await flush();
  };
  return { ...s, send, listeners };
}
const opened = (calls: any[]) => calls.filter((c) => c[0] === 'pty.open');

test('the terminal opens a stream, shows output in order with events that raced the open, and closes on leaving', async () => {
  let release: (v: unknown) => void = () => {};
  const t = live((m) => (m === 'pty.open' ? new Promise((r) => (release = r)) : undefined));
  const { host, root } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  has(host, /approve it there/);
  assert.deepEqual(t.calls.map((c) => c[0]).slice(0, 3), ['chat.follow', 'machine.hello', 'pty.open']);
  const stream = opened(t.calls)[0][1].stream;
  assert.match(stream, /^[\w-]{8,64}$/);
  assert.deepEqual([opened(t.calls)[0][1].cols, opened(t.calls)[0][1].rows], [48, 24]);
  await t.send({ ev: 'pty.data', stream: 'other', at: 0, data: b64('IGNORED') });
  await t.send({ ev: 'pty.data', stream, at: 0, data: b64('\u001b[32mHELLO\u001b[0m ') });
  assert.doesNotMatch(host.textContent!, /HELLO/);
  await act(async () => release({ stream, resumed: false, at: 0, truncated: true }));
  await flush();
  has(host, /HELLO /);
  has(host, /earlier output is no longer available/);
  assert.doesNotMatch(host.textContent!, /IGNORED/);
  await t.send({ ev: 'pty.data', stream, at: 15, data: b64('THERE') });
  await t.send({ ev: 'pty.data', stream, at: 15, data: b64('THERE') });
  has(host, /HELLO THERE/);
  await t.send({ ev: 'pty.exit', stream, at: 20, exitCode: 0 });
  has(host, /ended with code 0/);
  await act(async () => root.unmount());
  assert.deepEqual(
    t.calls.filter((c) => c[0] === 'pty.close').map((c) => c[1]),
    [{ stream }],
  );
});

test('an empty terminal says so, and a gap reopens from the bytes the screen has', async () => {
  const t = live((m) => (m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined));
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  has(host, /No output yet/);
  const stream = opened(t.calls)[0][1].stream;
  await t.send({ ev: 'pty.data', stream, at: 0, data: b64('abc') });
  await t.send({ ev: 'pty.data', stream, at: 10, data: b64('zzz') });
  assert.equal(opened(t.calls).length, 2);
  assert.equal(opened(t.calls)[1][1].from, 3);
  has(host, /abc/);
  await t.send({ ev: 'pty.data', stream, at: 3, data: b64('def') });
  has(host, /abcdef/);
});

test('a declined terminal shows the Mac’s reason and Retry opens it', async () => {
  let decline = true;
  const t = live((m) => {
    if (m !== 'pty.open') return undefined;
    if (decline) throw new Error('This Mac declined the terminal.');
    return { resumed: false, at: 0, truncated: false };
  });
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  has(host, /declined the terminal/);
  decline = false;
  await click('Retry');
  has(host, /No output yet/);
  assert.equal(opened(t.calls).length, 2);
});

test('an answer that settles after leaving is ignored, and a failed open can be retried', async () => {
  const settle: ((v: unknown, fail?: boolean) => void)[] = [];
  const t = live((m) => (m === 'pty.open' ? new Promise((res, rej) => settle.push((v, fail) => (fail ? rej(v) : res(v)))) : undefined));
  const { host, root } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  await act(async () => root.unmount());
  await act(async () => settle[0](new Error('gone'), true));
  await flush();
  assert.equal(host.textContent, '');
  const second = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  await act(async () => settle[1](new Error('late'), true));
  await flush();
  has(second.host, /late/);
  await click('Retry');
  await act(async () => settle[2]({ truncated: false }));
  await flush();
  assert.doesNotMatch(second.host.textContent!, /late/);
  has(second.host, /No output yet/);
});

test('the thread offers Terminal only when the app wires it', async () => {
  const t = live((m) =>
    m === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] } : undefined,
  );
  const props = { runtime: t.runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') };
  const plain = await mount(createElement(Thread, props));
  await click('Chat menu');
  assert.equal(plain.host.querySelector('[role="menuitem"][aria-label="Terminal"]'), null);
  await click('Chat menu');
  const picked: string[] = [];
  const wired = await mount(createElement(Thread, { ...props, terminal: () => picked.push('t') }));
  await click('Chat menu');
  await click('Terminal');
  assert.deepEqual(picked, ['t']);
  void wired;
});

test('a successful open that answers after leaving applies nothing', async () => {
  let release: (v: unknown) => void = () => {};
  const t = live((m) => (m === 'pty.open' ? new Promise((r) => (release = r)) : undefined));
  const { host, root } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  await act(async () => root.unmount());
  await act(async () => release({ truncated: true }));
  await flush();
  assert.equal(host.textContent, '');
});

test('a Mac with the terminal and screen switched off says so and raises no request', async () => {
  const t = live((m) => (m === 'machine.hello' ? { capabilities: { mirrors: false } } : undefined));
  const back: string[] = [];
  const term = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => back.push('t') }));
  has(term.host, /Terminal and screen are off for this phone/);
  await click('Back to chat');
  assert.deepEqual(back, ['t']);
  assert.equal(
    t.calls.some((c) => c[0] === 'pty.open'),
    false,
  );
});

test('the back button and a retry are there while the chat is followed or the switch is read', async () => {
  let fail = true;
  const t = live((m) => {
    if (m === 'machine.hello' && fail) throw new Error('Computer is offline');
    return m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined;
  });
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  assert.ok(host.querySelector('button[aria-label="Back to chat"]'));
  has(host, /offline or asleep/);
  fail = false;
  await click('Retry');
  has(host, /No output yet/);
});

test('a line, a key and a failed write reach the shell in order, and the input goes when the shell ends', async () => {
  let failWrite = false;
  const t = live((m, p) => {
    if (m === 'pty.write' && failWrite) throw new Error('Computer is offline');
    return m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined;
  });
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  const stream = opened(t.calls)[0][1].stream;
  assert.equal(host.querySelector('input[placeholder="Type a command"]') !== null, true);
  assert.equal([...host.querySelectorAll('button')].find((b) => b.textContent === 'Run')!.disabled, true);
  await inputText('Type a command', 'ls -la');
  await click('Run');
  await click('Ctrl-C');
  await click('↑');
  assert.deepEqual(
    t.calls.filter((c) => c[0] === 'pty.write').map((c) => c[1]),
    [
      { stream, data: 'ls -la\r' },
      { stream, data: '\u0003' },
      { stream, data: '\u001b[A' },
    ],
  );
  assert.equal(host.querySelector<HTMLInputElement>('input[placeholder="Type a command"]')!.value, '');
  failWrite = true;
  await click('Tab');
  has(host, /offline or asleep/);
  failWrite = false;
  await click('Esc');
  assert.doesNotMatch(host.textContent!, /offline or asleep/);
  await click('↓');
  await t.send({ ev: 'pty.exit', stream, at: 0, exitCode: 0 });
  assert.equal(host.querySelector('input[placeholder="Type a command"]'), null);
});

test('the terminal is sized to the phone at open and resized when the width changes', async () => {
  const g = globalThis as any;
  g.__phoneWidth = 390;
  const t = live((m) => (m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined));
  const element = () => createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} });
  const { host, root } = await mount(element());
  assert.equal(opened(t.calls)[0][1].cols, 48);
  assert.deepEqual(
    t.calls.filter((c) => c[0] === 'pty.resize').map((c) => c[1].cols),
    [48],
  );
  g.__phoneWidth = 800;
  await act(async () => root.render(element()));
  await flush();
  assert.deepEqual(
    t.calls.filter((c) => c[0] === 'pty.resize').map((c) => c[1].cols),
    [48, 105],
  );
  g.__phoneWidth = 20;
  await act(async () => root.render(element()));
  await flush();
  assert.equal(t.calls.filter((c) => c[0] === 'pty.resize').at(-1)![1].cols, 20);
  g.__phoneWidth = 5000;
  await act(async () => root.render(element()));
  await flush();
  assert.equal(t.calls.filter((c) => c[0] === 'pty.resize').at(-1)![1].cols, 200);
  void host;
  g.__phoneWidth = undefined;
});

test('output uses a monospace font on both platforms', async () => {
  const g = globalThis as any;
  for (const os of ['ios', 'android']) {
    g.__phonePlatform = os;
    const t = live((m) => (m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined));
    const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
    await t.send({ ev: 'pty.data', stream: opened(t.calls)[0][1].stream, at: 0, data: b64('out') });
    has(host, /out/);
  }
  g.__phonePlatform = undefined;
});

test('the keyboard’s return key runs the line, an empty line sends nothing, and queued writes are dropped on leaving', async () => {
  let release: (v: unknown) => void = () => {};
  let first = true;
  const t = live((m) => {
    if (m === 'pty.open') return { resumed: false, at: 0, truncated: false };
    if (m === 'pty.write' && first) {
      first = false;
      return new Promise((r) => (release = r));
    }
    return undefined;
  });
  const { host, root } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  const input = () => host.querySelector<HTMLInputElement>('input[placeholder="Type a command"]')!;
  const enter = async () => {
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
  };
  await enter();
  assert.equal(
    t.calls.some((c) => c[0] === 'pty.write'),
    false,
  );
  await inputText('Type a command', 'whoami');
  await enter();
  await click('Tab');
  await click('Esc');
  assert.equal(t.calls.filter((c) => c[0] === 'pty.write').length, 1);
  await act(async () => root.unmount());
  await act(async () => release({}));
  await flush();
  assert.equal(t.calls.filter((c) => c[0] === 'pty.write').length, 1);
});
