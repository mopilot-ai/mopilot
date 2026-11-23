// The journey runner's WebDriverAgent client against a fake: finding, waiting, tapping, scrolling, alerts, and the rule that it touches only our app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wda, tapPoint, labelsOf } from '../scripts/mobile-ios-journey/wda.mjs';
import { fakeWda, wdaOf } from './support/journey-wda.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-wda-test-'));

test('a tap goes near the top-left corner of an element, on screen and clear of a dev client’s gear, and labels are read from the tree', () => {
  assert.deepEqual(tapPoint({ x: 20, y: 100, width: 362, height: 51 }), { x: 30, y: 114 });
  assert.deepEqual(tapPoint({ x: 341, y: 732, width: 51, height: 44 }), { x: 351, y: 746 });
  assert.deepEqual(labelsOf({ label: 'A', children: [{ label: 'B' }, { children: [{ label: 'C' }] }, { label: '' }] }), ['A', 'B', 'C']);
});

test('the client opens a session, finds by id then by label, and says null when nothing matches or the screen changed under it', async () => {
  const f = fakeWda({ screen: [{ label: 'Chats' }, { label: 'Chats, 1 need you' }, { label: "It's here" }] });
  const wda = wdaOf(f);
  assert.equal(wda.base, 'http://wda:8100');
  await wda.open();
  assert.equal(wda.session, 's1');
  assert.deepEqual(
    f.calls.find((c) => c.route === '/session/s1/appium/settings')?.body,
    { settings: { maxTypingFrequency: 8 } },
    'typing is slowed to a person’s pace',
  );
  assert.equal(await wda.find('Chats'), 'e0', 'the exact id wins over a longer label');
  assert.equal(await wda.find('need you'), 'e1');
  assert.equal(await wda.find("It's"), 'e2', 'a quote in the label is escaped');
  assert.equal(await wda.find('nothing'), null);
  const same = await wdaOf(fakeWda({ screen: [{ label: 'Your chats, connected to your computer.' }] })).open();
  assert.equal(await same.find(', Connected'), null, 'a label is matched with its capitals');
  const sentence = await wdaOf(fakeWda({ screen: [{ label: 'open Settings in the app' }, { label: 'Settings' }] })).open();
  assert.equal(await sentence.find('Settings'), 'e1', 'the id wins over a sentence that has the word');
  const only = await wdaOf(fakeWda({ screen: [{ label: 'open Settings in the app' }] })).open();
  assert.equal(await only.find('Settings'), 'e0');
  assert.equal(await only.find('Settings', { exact: true }), null, 'exact means the id, nothing else');
  assert.equal(await only.has('Settings', { exact: true }), false);
  assert.equal(await only.waitForAny(['Sign in', 'Settings']), 'Settings');
  await assert.rejects(
    () => only.waitForAny(['Settings'], { timeoutMs: 1000, intervalMs: 500, exact: true }),
    /none of "Settings" appeared/,
  );
  let ran = 0;
  await only.whenPresent('Settings', async () => void ran++, { exact: true });
  assert.equal(ran, 0);
  assert.equal(await wda.has('Chats'), true);
  assert.equal(await wda.has('nothing'), false);
  f.state.staleOnce = true;
  assert.equal(await wda.find('Chats'), null, 'a label that changed while it was looked up is not there yet');
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    route: '/session',
    body: { capabilities: { alwaysMatch: { bundleId: 'ai.mopilot.phone' } } },
  });
  await new Wda({ base: 'http://wda:8100', bundleId: 'b', fetchImpl: fakeWda({ sessionShape: 'top' }).fetchImpl })
    .open()
    .then((w) => assert.equal(w.session, 's1'));
  const broken = wdaOf(fakeWda({ failElements: 'boom' }));
  broken.session = 's1';
  await assert.rejects(() => broken.find('x'), /WebDriverAgent POST \/session\/s1\/elements: boom/);
  await assert.rejects(() => wdaOf(fakeWda({ plainFail: true })).open(), /WebDriverAgent POST \/session: 500$/);
  const bad = wdaOf(fakeWda({ badBody: true }));
  await assert.rejects(() => bad.open(), /WebDriverAgent POST \/session: 502, not JSON \(not json\)/);
});

test('waiting finds a label that comes later, names the one that never came, and waits for one to go or for the first of several', async () => {
  const f = fakeWda();
  const wda = await wdaOf(f).open();
  let polls = 0;
  const find = wda.find.bind(wda);
  wda.find = async (label: string) => (++polls > 2 ? find(label) : null);
  f.state.screen = [{ label: 'Done' }];
  assert.equal(await wda.waitFor('Done', { timeoutMs: 5000, intervalMs: 100 }), 'e0');
  assert.ok(polls >= 3);
  await assert.rejects(
    () =>
      wdaOf(fakeWda())
        .open()
        .then((w) => w.waitFor('Never', { timeoutMs: 1000, intervalMs: 500 })),
    /"Never" did not appear within 1s/,
  );
  const g = fakeWda({ screen: [{ label: 'Spinner' }] });
  // the spinner goes while the client waits (its sleep is the clock of the fake)
  const gone = await wdaOf(g, { sleep: async () => void (g.state.screen = []) }).open();
  await gone.waitGone('Spinner');
  await assert.rejects(
    () =>
      wdaOf(g)
        .open()
        .then(() =>
          wdaOf(fakeWda({ screen: [{ label: 'Stuck' }] }))
            .open()
            .then((w) => w.waitGone('Stuck', { timeoutMs: 1000, intervalMs: 500 })),
        ),
    /"Stuck" was still there after 1s/,
  );
  const any = await wdaOf(fakeWda({ screen: [{ label: 'B' }] })).open();
  assert.equal(await any.waitForAny(['A', 'B']), 'B');
  await assert.rejects(() => any.waitForAny(['X', 'Y'], { timeoutMs: 1000, intervalMs: 500 }), /none of "X", "Y" appeared within 1s/);
  let ran = 0;
  await any.whenPresent('B', async () => void ran++);
  await any.whenPresent('Z', async () => void ran++);
  assert.equal(ran, 1);
  assert.equal(
    await new Wda({ base: 'x', bundleId: 'b', fetchImpl: f.fetchImpl }).sleep(1),
    undefined,
    'the default sleep is a real timer',
  );
});

test('tap, type, fill, labels, screenshots, alerts and the app’s place in front all reach WebDriverAgent as they should', async () => {
  const f = fakeWda({
    screen: [{ label: 'Pair a computer', rect: { x: 20, y: 200, width: 362, height: 50 } }, { label: 'Safety number 1 2' }],
  });
  const wda = await wdaOf(f).open();
  await wda.tap('Pair a computer');
  const actions = f.calls.find((c) => c.route.endsWith('/actions'))!.body.actions[0].actions;
  assert.deepEqual([actions[0].x, actions[0].y], [30, 214]);
  const lazy = fakeWda({ screen: [{ label: 'Open' }] });
  const second = await wdaOf(lazy).open();
  let taps = 0;
  const lazyCall = second.call.bind(second);
  second.call = async (method: string, route: string, body?: unknown) => {
    // the first tap is lost; the second brings the next screen
    if (route.endsWith('/actions') && ++taps === 2) lazy.state.screen.push({ label: 'Next' });
    return lazyCall(method, route, body);
  };
  assert.equal(await second.tapUntil('Open', 'Next'), 'e1');
  assert.equal(taps, 2, 'a tap that brought nothing is made again');
  await assert.rejects(
    () =>
      wdaOf(fakeWda({ screen: [{ label: 'Open' }] }))
        .open()
        .then((w) => w.tapUntil('Open', 'Never', { tries: 2, timeoutMs: 1000 })),
    /"Never" did not appear within 1s/,
  );
  await wda.pullDown();
  assert.deepEqual(f.calls.find((c) => c.route.endsWith('/wda/dragfromtoforduration'))!.body, {
    fromX: 200,
    fromY: 160,
    toX: 200,
    toY: 650,
    duration: 0.5,
  });
  const lower = fakeWda({ screen: [{ label: 'Load more', rect: { x: 10, y: 1000, width: 300, height: 44 } }] });
  const far = await wdaOf(lower).open();
  let swipes = 0;
  const call = far.call.bind(far);
  far.call = async (method: string, route: string, body?: unknown) => {
    // each swipe moves the element up the screen
    if (route.endsWith('/wda/dragfromtoforduration')) lower.state.screen[0].rect!.y -= 150 * ++swipes;
    return call(method, route, body);
  };
  await far.scrollTo('Load more');
  assert.equal(swipes, 2, 'it swipes until the label is well on screen, not only present');
  const kb = fakeWda({ screen: [{ label: 'Continue', rect: { x: 10, y: 560, width: 300, height: 50 } }] });
  const withKeyboard = await wdaOf(kb).open();
  let moved = 0;
  const kbCall = withKeyboard.call.bind(withKeyboard);
  withKeyboard.call = async (method: string, route: string, body?: unknown) => {
    if (route.endsWith('/wda/dragfromtoforduration')) kb.state.screen[0].rect!.y -= 360 * ++moved;
    return kbCall(method, route, body);
  };
  await withKeyboard.scrollTo('Continue', { maxBottom: 600 });
  const raised = fakeWda({ keyboardTop: 600, screen: [{ label: 'Card', rect: { x: 10, y: 580, width: 300, height: 60 } }] });
  const byKeyboard = await wdaOf(raised).open();
  let pushed = 0;
  const raisedCall = byKeyboard.call.bind(byKeyboard);
  byKeyboard.call = async (method: string, route: string, body?: unknown) => {
    if (route.endsWith('/wda/dragfromtoforduration')) raised.state.screen[0].rect!.y -= 200 * ++pushed;
    return raisedCall(method, route, body);
  };
  await byKeyboard.scrollTo('Card');
  assert.equal(pushed, 1, 'with the keyboard up, the limit is its top edge (580 + 60 is under 600)');
  assert.equal(moved, 1, 'a button whose foot is under the keyboard is scrolled up, not tapped');
  const high = await wdaOf(fakeWda({ screen: [{ label: 'High', rect: { x: 0, y: 100, width: 10, height: 10 } }] })).open();
  await high.scrollTo('High');
  await assert.rejects(
    () =>
      wdaOf(fakeWda())
        .open()
        .then((w) => w.scrollTo('Nowhere', { maxSwipes: 2 })),
    /"Nowhere" did not come into view after 2 swipes/,
  );
  await wda.type('ab');
  assert.deepEqual(f.calls.find((c) => c.route.endsWith('/wda/keys'))!.body, { value: ['a', 'b'] });
  await wda.fill('Pair a computer', 'CODE');
  assert.ok(f.calls.some((c) => c.route.endsWith('/element/active')));
  assert.ok(f.calls.some((c) => c.route.endsWith('/element/ELEMENT/clear') || c.route.endsWith('/element/active/clear')));
  assert.deepEqual(f.calls.find((c) => c.route.endsWith('/element/active/value'))!.body, { text: 'CODE' });
  const w3c = await wdaOf(fakeWda({ screen: [{ label: 'Field' }], elementShape: 'w3c' })).open();
  await w3c.fill('Field', 'x');
  assert.equal(await wda.labelOf('Safety number'), 'Safety number 1 2');
  assert.equal(await wda.labelOf('missing'), null);
  assert.deepEqual(await wda.labels(), ['App', 'One', 'Two']);
  const file = path.join(scratch, 'shots', 'a.png');
  await wda.shot(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'png-bytes');
  assert.equal(await wda.acceptAlert(), true);
  assert.equal(await (await wdaOf(fakeWda({ alert: false })).open()).acceptAlert(), false);
  await wda.background();
  await wda.foreground();
  assert.ok(f.calls.some((c) => c.route === '/wda/homescreen'));
  assert.deepEqual(f.calls.at(-1)!.body, { bundleId: 'ai.mopilot.phone' });
});

const system = (label: string, buttons = ['Cancel', 'Continue']) => ({
  type: 'Application',
  children: [
    { type: 'Other', label: 'MoPilot' },
    {
      type: 'Alert',
      label,
      children: buttons.map((b, i) => ({ type: 'Button', label: b, rect: { x: 100 + i * 150, y: 500, width: 100, height: 40 } })),
    },
  ],
});

test('an alert of ours is accepted wherever it is, a system one by a tap on its button, and anybody else’s is left alone', async () => {
  const inApp = fakeWda({ alertText: '“MoPilot” Would Like to Send You Notifications' });
  assert.equal(await (await wdaOf(inApp).open()).acceptAlert(), true);
  assert.ok(inApp.calls.some((c) => c.route.endsWith('/alert/accept')));
  await assert.rejects(
    () =>
      wdaOf(fakeWda({ alertText: 'Update Maps?' }))
        .open()
        .then((w) => w.acceptAlert()),
    /an alert that is not ours is in front \("Update Maps\?"\): not accepting it/,
  );
  await assert.rejects(
    () =>
      wdaOf(fakeWda({ alertError: 'boom' }))
        .open()
        .then((w) => w.acceptAlert()),
    /boom/,
  );

  const consent = fakeWda({ alert: false, systemTree: system('“MoPilot” Wants to Use “192.168.86.228” to Sign In') });
  assert.equal(await (await wdaOf(consent).open()).acceptAlert(), true);
  const tap = consent.calls.find((c) => c.route.endsWith('/actions'))!.body.actions[0].actions[0];
  assert.deepEqual([tap.x, tap.y], [300, 520], 'the tap is on Continue, not on Cancel');
  assert.deepEqual(
    consent.calls
      .filter((c) => c.route.endsWith('/appium/settings') && 'defaultActiveApplication' in c.body.settings)
      .map((c) => c.body.settings.defaultActiveApplication),
    ['com.apple.springboard', 'auto'],
    'the session reads SpringBoard only for the dialog, and goes back to the app',
  );
  assert.equal(consent.calls.filter((c) => c.route === '/session').length, 1, 'no second session: WebDriverAgent would end ours');

  const foreign = fakeWda({ alert: false, systemTree: system('“Maps” Wants to Use Location') });
  assert.equal(await (await wdaOf(foreign).open()).acceptAlert(), false);
  assert.equal(
    foreign.calls.some((c) => c.route.endsWith('/actions')),
    false,
    'a dialog of another app is not tapped',
  );
  const unnamed = fakeWda({ alert: false, systemTree: { type: 'Application', children: [{ type: 'Alert' }] } });
  assert.equal(await (await wdaOf(unnamed).open()).acceptAlert(), false, 'a dialog with no text is not ours');
  const noButton = fakeWda({ alert: false, systemTree: system('“MoPilot” Wants to Use X', ['Cancel']) });
  assert.equal(await (await wdaOf(noButton).open()).acceptAlert(), false);
});

test('a tap waits until the element has stopped moving, then goes to where it came to rest', async () => {
  const moving = fakeWda({ screen: [{ label: 'Send', rect: { x: 300, y: 840, width: 44, height: 44 } }] });
  const wda = await wdaOf(moving).open();
  let reads = 0;
  const call = wda.call.bind(wda);
  wda.call = async (method: string, route: string, body?: unknown) => {
    // the composer rises with the keyboard for three reads, then rests
    if (route.endsWith('/rect')) moving.state.screen[0].rect!.y = reads++ < 3 ? 840 - 100 * reads : 520;
    return call(method, route, body);
  };
  await wda.tap('Send');
  const tap = moving.calls.find((c) => c.route.endsWith('/actions'))!.body.actions[0].actions[0];
  assert.deepEqual([tap.x, tap.y], [310, 534], 'the tap is at the resting place (y 520), not where the element was first seen');
  const never = fakeWda({ screen: [{ label: 'Drift', rect: { x: 0, y: 0, width: 10, height: 10 } }] });
  const drifting = await wdaOf(never).open();
  let step = 0;
  const driftCall = drifting.call.bind(drifting);
  drifting.call = async (method: string, route: string, body?: unknown) => {
    if (route.endsWith('/rect')) never.state.screen[0].rect!.y = 10 * ++step;
    return driftCall(method, route, body);
  };
  await drifting.tap('Drift');
  assert.ok(step >= 9, 'an element that never settles is tapped after a bounded wait');
});

test('a tap waits for a screen that is still moving up for the keyboard, and is refused when the element stays under it', async () => {
  const kb = fakeWda({ keyboardTop: 600, screen: [{ label: 'Run', rect: { x: 300, y: 780, width: 44, height: 44 } }] });
  const wda = await wdaOf(kb).open();
  let looks = 0;
  const call = wda.call.bind(wda);
  wda.call = async (method: string, route: string, body?: unknown) => {
    // the bar has not moved for the first looks, then rises above the keyboard
    if (route.endsWith('/element/e0/rect')) kb.state.screen[0].rect!.y = ++looks < 7 ? 780 : 540;
    return call(method, route, body);
  };
  await wda.tap('Run');
  const tap = kb.calls.find((c) => c.route.endsWith('/actions'))!.body.actions[0].actions[0];
  assert.deepEqual([tap.x, tap.y], [310, 554], 'the tap went to the bar after it rose');
  const stuck = await wdaOf(
    fakeWda({ keyboardTop: 600, screen: [{ label: 'Card', rect: { x: 0, y: 800, width: 300, height: 100 } }] }),
  ).open();
  await assert.rejects(() => stuck.tap('Card'), /under the keyboard \(from 600\): scroll it into view first/);
});

test('a tap that would land under the keyboard is refused, and one above it is made', async () => {
  const typing = await wdaOf(fakeWda({ keyboardTop: 600 })).open();
  await assert.rejects(
    () => typing.tapXY({ x: 50, y: 650 }),
    /the point \(50, 650\) is under the keyboard \(from 600\): scroll it into view first/,
  );
  await typing.tapXY({ x: 50, y: 300 });
  assert.equal(await typing.keyboardTop(), 600);
  assert.equal(await (await wdaOf(fakeWda()).open()).keyboardTop(), null, 'no keyboard, nothing to avoid');
});

test('the keyboard edge is read once the keyboard has stopped sliding in, so a button it will cover is scrolled up rather than tapped', async () => {
  assert.equal(await (await wdaOf(fakeWda({ keyboardRise: [943, 800, 623] })).open()).keyboardTop(), 623);
  assert.equal(await (await wdaOf(fakeWda({ keyboardTop: 600, elementShape: 'w3c' })).open()).keyboardTop(), 600);
  const rising = fakeWda({ keyboardRise: [943, 623], screen: [{ label: 'Continue', rect: { x: 20, y: 599, width: 388, height: 47 } }] });
  const wda = await wdaOf(rising).open();
  let moved = 0;
  const call = wda.call.bind(wda);
  wda.call = async (method: string, route: string, body?: unknown) => {
    if (route.endsWith('/wda/dragfromtoforduration')) rising.state.screen[0].rect!.y -= 100 * ++moved;
    return call(method, route, body);
  };
  await wda.scrollTo('Continue');
  assert.equal(moved, 1, 'read mid-slide (943) the button looks clear of the keyboard; at rest (623) it is not');
});

test('a keyboard that goes away while it is being measured is no keyboard, and any other failure is not hidden', async () => {
  const gone = await wdaOf(
    fakeWda({ keyboardTop: 600, keyboardRectError: 'The previously found element is not present in the current view anymore' }),
  ).open();
  assert.equal(await gone.keyboardTop(), null);
  const broken = await wdaOf(fakeWda({ keyboardTop: 600, keyboardRectError: 'WebDriverAgent is busy' })).open();
  await assert.rejects(() => broken.keyboardTop(), /WebDriverAgent is busy/);
});

test('a gesture by coordinates or keys is refused unless our app is the one in front', async () => {
  const other = await wdaOf(fakeWda({ front: 'com.apple.springboard', screen: [{ label: 'Done' }] })).open();
  const refused = /the app in front is com\.apple\.springboard, not ai\.mopilot\.phone: not touching it/;
  await assert.rejects(() => other.tapXY({ x: 1, y: 1 }), refused);
  await assert.rejects(() => other.tap('Done'), refused);
  await assert.rejects(() => other.type('x'), refused);
  await assert.rejects(() => other.pullDown(), refused);
  await assert.rejects(() => other.scrollTo('Missing', { maxSwipes: 1 }), refused);
});
