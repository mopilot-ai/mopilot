// Terminal ergonomics on the phone: keys that repeat while held, pinch to resize the text, and long-press to select with Copy.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const g = globalThis as any;
const terminalPath = '../mobile/src/screens/Terminal';
const inputPath = '../mobile/src/components/TerminalInput';
const pinchPath = '../mobile/src/components/usePinchSize';
const { Terminal } = await import(terminalPath);
const { TerminalInput, KEYS, HOLD_MS, REPEAT_EVERY_MS, MAX_REPEATS } = await import(inputPath);
const { pinchedSize, BASE_FONT, MIN_FONT, MAX_FONT } = await import(pinchPath);

const b64 = (s: string) => Buffer.from(s).toString('base64');
const mounted: any[] = [];
async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return { host, root };
}
test.afterEach(async () => {
  mock.timers.reset();
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
  g.__phoneShared = [];
  g.__phoneShareFails = false;
});
const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as any;

test('only Tab and the arrows repeat; the others stay one press', () => {
  assert.deepEqual(
    KEYS.map((k: any) => [k.label, k.repeat]),
    [
      ['Ctrl-C', false],
      ['Tab', true],
      ['Esc', false],
      ['↑', true],
      ['↓', true],
    ],
  );
});

test('a held key sends at once, then every beat until released; a short press is one send; the others never repeat', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const sent: string[] = [];
  const { host } = await mount(createElement(TerminalInput, { write: (d: string) => sent.push(d) }));
  const up = button(host, '↑');
  assert.equal(up.__press.delayLongPress, HOLD_MS, 'a hold starts after a short delay');
  assert.equal(button(host, 'Ctrl-C').__press.onLongPress, undefined);
  assert.equal(button(host, 'Esc').__press.onLongPress, undefined);
  await act(async () => up.click());
  assert.deepEqual(sent, ['\u001b[A'], 'a tap is one press');
  sent.length = 0;
  await act(async () => up.__press.onLongPress());
  assert.equal(sent.length, 1);
  mock.timers.tick(REPEAT_EVERY_MS * 3);
  assert.equal(sent.length, 4);
  await act(async () => up.__press.onPressOut());
  mock.timers.tick(REPEAT_EVERY_MS * 5);
  assert.equal(sent.length, 4, 'letting go stops it');
  await act(async () => up.__press.onPressOut());
  await act(async () => button(host, 'Ctrl-C').__press.onPressOut());
});

test('a hold that is never released stops by itself, a new hold restarts the beat, and leaving the screen stops it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const sent: string[] = [];
  const { host, root } = await mount(createElement(TerminalInput, { write: (d: string) => sent.push(d) }));
  const tab = button(host, 'Tab');
  await act(async () => tab.__press.onLongPress());
  mock.timers.tick(REPEAT_EVERY_MS * (MAX_REPEATS + 50));
  assert.equal(sent.length, MAX_REPEATS, 'no release arrived: it stops after the cap');
  sent.length = 0;
  await act(async () => tab.__press.onLongPress());
  await act(async () => tab.__press.onLongPress());
  mock.timers.tick(REPEAT_EVERY_MS);
  assert.equal(sent.length, 3, 'two holds make one beat, not two');
  await act(async () => root.unmount());
  mock.timers.tick(REPEAT_EVERY_MS * 5);
  assert.equal(sent.length, 3, 'unmounted: nothing more is sent');
  mounted.length = 0;
});

test('pinching resizes by the ratio of the distances, inside the limits', () => {
  assert.deepEqual([MIN_FONT, BASE_FONT, MAX_FONT], [9, 12, 20]);
  assert.equal(pinchedSize(12, 100, 150), 18);
  assert.equal(pinchedSize(12, 100, 100), 12);
  assert.equal(pinchedSize(12, 100, 10), MIN_FONT);
  assert.equal(pinchedSize(12, 10, 1000), MAX_FONT);
  assert.equal(pinchedSize(12, 0, 0), 12, 'fingers that start together change nothing (and never make NaN)');
  assert.equal(pinchedSize(12, 0, 80), 12);
});

const open = () => ({ resumed: false, at: 0, truncated: false });
function live(handler: (m: string, p: any) => unknown = (m) => (m === 'pty.open' ? open() : undefined)) {
  const s = scripted(handler);
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const send = async (e: any) => {
    await act(async () => listeners.forEach((f) => f(e)));
    await flush();
  };
  return { ...s, send };
}
const touches = (a: number, b?: number) => ({
  nativeEvent: {
    touches: [{ pageX: 0, pageY: 0 }, ...(b === undefined ? [] : [{ pageX: b, pageY: 0 }])].slice(0, b === undefined ? 1 : 2),
  },
});
const outputOf = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].find((s: any) => s.textContent === text) as any;
const fontOf = (el: HTMLElement) => JSON.parse(el.getAttribute('data-style')!).fontSize;
const resizes = (t: any) => t.calls.filter((c: any) => c[0] === 'pty.resize').map((c: any) => c[1].cols);

test('two fingers resize the output and the shell with it; one finger leaves the scrolling alone; the size is kept for the next terminal', async () => {
  g.__phoneWidth = 390;
  const t = live();
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  await t.send({ ev: 'pty.data', stream: t.calls.find((c: any) => c[0] === 'pty.open')![1].stream, at: 0, data: b64('out') });
  assert.equal(fontOf(outputOf(host, 'out')), 12);
  assert.deepEqual(resizes(t), [48]);
  const pan = g.__phonePan;
  assert.equal(pan.onMoveShouldSetPanResponderCapture(touches(0)), false, 'one finger is a scroll');
  assert.equal(pan.onMoveShouldSetPanResponderCapture(touches(0, 100)), true);
  await act(async () => pan.onPanResponderMove(touches(0)));
  assert.equal(fontOf(outputOf(host, 'out')), 12, 'one touch does nothing');
  await act(async () => pan.onPanResponderMove(touches(0, 100)));
  assert.equal(fontOf(outputOf(host, 'out')), 12, 'the first move only marks where the fingers started');
  await act(async () => pan.onPanResponderMove(touches(0, 150)));
  assert.equal(fontOf(outputOf(host, 'out')), 18);
  assert.equal(JSON.parse(outputOf(host, 'out').getAttribute('data-style')).lineHeight, 26, 'the line grows with the text');
  await flush();
  assert.deepEqual(resizes(t), [48], 'the shell is not resized on every step of a pinch');
  await act(async () => pan.onPanResponderRelease());
  await flush();
  assert.equal(resizes(t).at(-1), 32, 'when the fingers lift it is told how many columns now fit');
  const move = (b?: number) => act(async () => g.__phonePan.onPanResponderMove(touches(0, b)));
  await move(100);
  await move(200);
  assert.equal(fontOf(outputOf(host, 'out')), 20, 'from 18 doubled, up to the limit');
  await move();
  await move(300);
  await move(150);
  assert.equal(fontOf(outputOf(host, 'out')), 10, 'a finger lifted mid-pinch: the next two fingers start a new pinch from where they are');
  await act(async () => pan.onPanResponderRelease());
  await move(100);
  await move(50);
  assert.equal(fontOf(outputOf(host, 'out')), 9, 'a new pinch starts from the size the last one left, down to the limit');
  await act(async () => pan.onPanResponderTerminate());
  await move(10);
  await move(40);
  assert.equal(fontOf(outputOf(host, 'out')), 20, 'a cancelled pinch also ends; the next begins afresh');
  await act(async () => pan.onPanResponderRelease());
  const next = live();
  const second = await mount(createElement(Terminal, { runtime: next.runtime, chatId: 'c', back: () => {} }));
  await next.send({ ev: 'pty.data', stream: next.calls.find((c: any) => c[0] === 'pty.open')![1].stream, at: 0, data: b64('again') });
  assert.equal(fontOf(outputOf(second.host, 'again')), 20, 'the next terminal opens at the size left');
  await move(100);
  await move(60);
  await act(async () => g.__phonePan.onPanResponderRelease());
  assert.equal(fontOf(outputOf(second.host, 'again')), 12, 'back to the usual size for the other tests');
  g.__phoneWidth = undefined;
});

test('a long press holds the output still for selecting, offers Copy all through the share sheet, and Done lets it run again', async () => {
  const t = live();
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  const stream = t.calls.find((c: any) => c[0] === 'pty.open')![1].stream;
  await t.send({ ev: 'pty.data', stream, at: 0, data: b64('first') });
  assert.doesNotMatch(host.textContent!, /Copy all|Output is paused/);
  assert.equal(outputOf(host, 'first').getAttribute('data-selectable'), 'false', 'live output redraws, so it is not selectable');
  await act(async () => outputOf(host, 'first').__longPress());
  assert.match(host.textContent!, /Output is paused\. Select text, or copy it all\./);
  assert.equal(outputOf(host, 'first').getAttribute('data-selectable'), 'true');
  await t.send({ ev: 'pty.data', stream, at: 5, data: b64(' second') });
  assert.match(host.textContent!, /Output is paused; there is newer output\./);
  assert.ok(outputOf(host, 'first'), 'the text on screen is the text that was held');
  assert.doesNotMatch(host.textContent!, /second/);
  await act(async () => button(host, 'Copy all').click());
  await flush();
  assert.deepEqual(g.__phoneShared, ['first']);
  g.__phoneShareFails = true;
  await act(async () => button(host, 'Copy all').click());
  await flush();
  assert.match(host.textContent!, /The output could not be copied\./);
  g.__phoneShareFails = false;
  const heldText = () => [...host.querySelectorAll('span')].find((s) => s.textContent === 'first') as HTMLElement;
  assert.equal(heldText().getAttribute('aria-description'), 'Long press to hold the output for selecting');
  assert.equal((heldText() as any).__longPress, undefined, 'while held a long press is the selection’s, not a new snapshot');
  await act(async () => button(host, 'Done').click());
  assert.doesNotMatch(host.textContent!, /could not be copied/, 'Done also clears a failed copy');
  assert.match(host.textContent!, /first second/);
  await act(async () => outputOf(host, 'first second').__longPress());
  await act(async () => button(host, 'Copy all').click());
  await flush();
  assert.deepEqual(g.__phoneShared, ['first', 'first second']);
  assert.doesNotMatch(host.textContent!, /could not be copied/);
  await act(async () => button(host, 'Done').click());
  assert.doesNotMatch(host.textContent!, /Output is paused|Copy all/);
});

test('a held key waits while earlier keys are still on their way; the hints say which keys repeat and that the output can be held', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let idle = true;
  const sent: string[] = [];
  const { host } = await mount(createElement(TerminalInput, { write: (d: string) => sent.push(d), idle: () => idle }));
  await act(async () => button(host, '↓').__press.onLongPress());
  idle = false;
  mock.timers.tick(REPEAT_EVERY_MS * 4);
  assert.equal(sent.length, 1, 'no beat while a write is in flight');
  idle = true;
  mock.timers.tick(REPEAT_EVERY_MS);
  assert.equal(sent.length, 2, 'and it carries on when the link has caught up');
  assert.equal(button(host, '↓').getAttribute('aria-description'), 'Hold to repeat');
  assert.equal(button(host, 'Esc').getAttribute('aria-description'), null);
});

test('in the terminal a held key is paced by the writes the Mac has answered', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let answer!: () => void;
  const t = live((m) => {
    if (m === 'pty.open') return open();
    if (m === 'pty.write') return new Promise<void>((resolve) => (answer = resolve));
    return undefined;
  });
  const { host } = await mount(createElement(Terminal, { runtime: t.runtime, chatId: 'c', back: () => {} }));
  const writes = () => t.calls.filter((c: any) => c[0] === 'pty.write').length;
  await act(async () => button(host, '↑').__press.onLongPress());
  await flush();
  assert.equal(writes(), 1);
  mock.timers.tick(REPEAT_EVERY_MS * 5);
  await flush();
  assert.equal(writes(), 1, 'the first key has not been answered: nothing more is queued behind it');
  await act(async () => answer());
  await flush();
  mock.timers.tick(REPEAT_EVERY_MS);
  await flush();
  assert.equal(writes(), 2);
  await act(async () => button(host, '↑').__press.onPressOut());
  await act(async () => answer());
});
