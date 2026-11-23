// Held keys and mouse buttons on a browser tab (electron/capabilities/browser/heldInput.cjs) and chords as the key
// events a keyboard sends (keys.cjs chordEvents): what is down, letting go, the hold wait and the hold length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HOLD_MS_MAX,
  noteInput,
  isHolding,
  releaseHeld,
  forgetHeld,
  holdFor,
  holdMs,
} = require('../electron/capabilities/browser/heldInput.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { chordEvents } = require('../electron/capabilities/browser/keys.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

const recorder = () => {
  const sent: any[] = [];
  return { sent, send: async (...a: any[]) => void sent.push(a) };
};

test('noteInput: downs are held until their own up; other commands and moves hold nothing', async () => {
  const tab = {};
  assert.equal(isHolding(tab), false);
  noteInput(tab, 'Runtime.evaluate', { expression: '1' });
  noteInput(tab, 'Input.insertText', { text: 'a' });
  assert.equal(isHolding(tab), false);
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'char', key: 'a' });
  assert.equal(isHolding(tab), true);
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  assert.equal(isHolding(tab), false);
  // a key without a code is known by its key; a press without a button is the left one
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Unidentified' });
  noteInput(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  noteInput(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', deltaY: 5 });
  const r = recorder();
  await releaseHeld(tab, r.send);
  assert.deepEqual(r.sent, [
    // no point was ever given: the button comes up at the origin
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: 0, y: 0 }],
    [
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'Unidentified',
        code: undefined,
        windowsVirtualKeyCode: undefined,
        nativeVirtualKeyCode: undefined,
        modifiers: 0,
      },
    ],
  ]);
  assert.equal(isHolding(tab), false);
  // nothing held: nothing sent
  await releaseHeld(tab, r.send);
  await releaseHeld({}, r.send);
  assert.equal(r.sent.length, 2);
  noteInput(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'middle', clickCount: 2 });
  noteInput(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'middle' });
  assert.equal(isHolding(tab), false);
});

test('holdFor: the whole time, or cut short by a stop, a turn that ended, or a call already stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tick = async (ms: number) => {
    for (let i = 0; i < ms / 50; i++) {
      t.mock.timers.tick(50);
      await Promise.resolve();
    }
  };
  // outside any call it waits the whole time
  const whole = holdFor(250);
  await tick(250);
  assert.equal(await whole, true);
  // the call's abort signal (Stop)
  const ac = new AbortController();
  const stopped = guarded({ signal: ac.signal }, () => holdFor(10_000));
  await tick(100);
  ac.abort();
  assert.equal(await stopped, false);
  // the turn's token stops being current: seen within 100 ms
  let current = true;
  const ended = guarded({ token: { chatId: 'c', turn: 1 }, current: () => current }, () => holdFor(10_000));
  await tick(100);
  current = false;
  await tick(100);
  assert.equal(await ended, false);
  // already stopped, either way
  const gone = new AbortController();
  gone.abort();
  assert.equal(await guarded({ signal: gone.signal }, () => holdFor(1000)), false);
  assert.equal(await guarded({ token: { chatId: 'c', turn: 1 }, current: () => false }, () => holdFor(1000)), false);
  // the action's own cut (a dialog opened under it), during the hold or before it
  const cut = new AbortController();
  const dialog = guarded({ signal: new AbortController().signal }, () => holdFor(10_000, cut.signal));
  await tick(50);
  cut.abort();
  assert.equal(await dialog, false);
  assert.equal(await holdFor(1000, cut.signal), false);
});

test('holdMs: seconds or ms to a hold length, nothing for no value, at most 30 s', () => {
  assert.equal(HOLD_MS_MAX, 30_000);
  for (const v of [undefined, null, 0, -1, 'x', Number.NaN]) assert.equal(holdMs(v, 1000), 0, String(v));
  assert.equal(holdMs(2.5, 1000), 2500);
  assert.equal(holdMs('3', 1000), 3000);
  assert.equal(holdMs(400, 1), 400);
  assert.equal(holdMs(99, 1000), 30_000);
});

test('chordEvents: modifiers go down in the order named and come up in reverse; a repeated modifier goes down once', () => {
  const keys = (spec: string) => {
    const e = chordEvents(spec, 'linux');
    return [...e.downs, ...e.ups].map((k: any) => `${k.type} ${k.key} ${k.modifiers}`);
  };
  assert.deepEqual(keys('Enter'), ['keyDown Enter 0', 'keyUp Enter 0']);
  assert.deepEqual(keys('cmd+alt+x'), [
    'rawKeyDown Meta 4',
    'rawKeyDown Alt 5',
    'rawKeyDown x 5',
    'keyUp x 5',
    'keyUp Alt 4',
    'keyUp Meta 0',
  ]);
  assert.deepEqual(keys('shift+shift+a'), ['rawKeyDown Shift 8', 'keyDown A 8', 'keyUp A 8', 'keyUp Shift 0']);
  // "ctrl++": the plus key with Control held
  assert.deepEqual(keys('ctrl++'), ['rawKeyDown Control 2', 'rawKeyDown + 2', 'keyUp + 2', 'keyUp Control 0']);
  assert.deepEqual(chordEvents('shift+a', 'linux').downs[0].code, 'ShiftLeft');
  assert.throws(() => chordEvents('hyper+a', 'linux'), { code: 'bad_args' });
});

test('releaseHeld: every let-go goes out in order; one that throws at once or rejects is noted and the rest still go', async () => {
  const tab = {};
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft' });
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA' });
  noteInput(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
  const sent: string[] = [];
  clearIgnored();
  await releaseHeld(tab, (_m: string, p: any) => {
    sent.push(`${p.type} ${p.key ?? p.button}`);
    if (p.key === 'a') throw new Error('detached');
    if (p.button) return Promise.reject(new Error('gone'));
    return {};
  });
  assert.deepEqual(sent, ['mouseReleased left', 'keyUp a', 'keyUp Shift']);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.message),
    ['gone', 'detached'],
  );
  // forgetting sends nothing
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'b', code: 'KeyB' });
  forgetHeld(tab);
  assert.equal(isHolding(tab), false);
});

test('releaseNow: lets go through the tab debugger at once, bounded; nothing held, a gone page or a detached debugger sends nothing', async () => {
  const { releaseNow } = require('../electron/capabilities/browser/heldInput.cjs');
  const sent: any[] = [];
  let answer: () => Promise<unknown> = () => Promise.resolve({});
  const tab: any = {
    get backend() {
      return this.wc;
    },
    wc: {
      gone: false,
      isDestroyed() {
        return this.gone;
      },
      debugger: {
        attached: true,
        isAttached() {
          return this.attached;
        },
        sendCommand: (m: string, p: any) => (sent.push([m, p.type]), answer()),
      },
    },
  };
  await releaseNow(tab);
  assert.deepEqual(sent, [], 'nothing held');
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft' });
  await releaseNow(tab);
  assert.deepEqual(sent, [['Input.dispatchKeyEvent', 'keyUp']]);
  // a page that never answers: given up after ms
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft' });
  answer = () => new Promise(() => {});
  const at = Date.now();
  await releaseNow(tab, 20);
  assert.ok(Date.now() - at < 1000);
  // a detached debugger or a gone page: nothing goes out
  noteInput(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft' });
  sent.length = 0;
  tab.wc.debugger.attached = false;
  await releaseNow(tab);
  tab.wc.gone = true;
  await releaseNow(tab);
  assert.deepEqual(sent, []);
});
