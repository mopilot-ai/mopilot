// electron/capabilities/tools/desktopTeach.cjs: teach mode (desktop_request_teach_access, desktop_teach_step,
// desktop_teach_batch) and full control (desktop_request_full_control, desktop_release_full_control).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES, TOOL_NAMES, SPECS, ACTIONS, DesktopControl, rig, rejects, resolveEntry } from './support/desktop-kit.ts';

type Choice = 'next' | 'exit' | 'cancel';

/** A tooltip that answers with the scripted choices (then Next), and notes what it was asked. */
function overlay(choices: Choice[] = []) {
  const o: any = {
    available: true,
    shown: [] as any[],
    workingCalls: [] as string[],
    hidden: [] as string[],
    gate: null as null | Promise<Choice>,
    show: async (chatId: string, view: any) => {
      o.shown.push({ chatId, ...view });
      return o.gate ?? choices.shift() ?? 'next';
    },
    working: (chatId: string) => o.workingCalls.push(chatId),
    hide: (chatId: string) => o.hidden.push(chatId),
    windows: () => [],
    dispose: () => {},
  };
  return o;
}

/** A rig with the tooltip, Notes resolvable, and the teach tour started. */
async function touring(choices: Choice[] = [], apps = [NOTES]) {
  const r = rig();
  const tip = overlay(choices);
  r.d.teachOverlay = tip;
  for (const a of apps) r.helper.resolved.set(a.name, resolveEntry(a));
  await r.call('desktop_screenshot').catch(() => {});
  const out = await r
    .json('desktop_request_teach_access', { apps: apps.map((a) => a.name), reason: 'use Notes' }, { chatId: 'c1' })
    .catch((e) => e);
  return { r, tip, out };
}

const STEP = {
  explanation: 'This is Notes',
  next_preview: "Next: I'll click Send",
  actions: [{ action: 'left_click', coordinate: [100, 50] }],
};

test('specs: the teach and full-control tools are listed; a step takes batch actions except zoom', () => {
  for (const n of [
    'desktop_request_teach_access',
    'desktop_teach_step',
    'desktop_teach_batch',
    'desktop_request_full_control',
    'desktop_release_full_control',
  ])
    assert.ok(TOOL_NAMES.includes(n), n);
  const step = SPECS.find((s: any) => s.name === 'desktop_teach_step');
  assert.deepEqual(step.schema.required, ['explanation', 'next_preview', 'actions']);
  const allowed = step.schema.properties.actions.items.properties.action.enum;
  assert.ok(allowed.includes('left_click') && !allowed.includes('zoom'));
  assert.ok(ACTIONS.includes('zoom'));
  const batch = SPECS.find((s: any) => s.name === 'desktop_teach_batch');
  assert.equal(batch.schema.properties.steps.items.properties.actions.maxItems, 50);
  assert.match(batch.description, /do NOT call again after that/);
});

test('request_teach_access: the teach card asks, the user agrees, the tour starts and the screen consent is given', async () => {
  const { r, out } = await touring();
  assert.equal(out.teachModeActive, true);
  assert.deepEqual(
    out.granted.map((g: any) => g.app),
    ['Notes'],
  );
  assert.match(out.next, /Take a desktop_screenshot, then call desktop_teach_step/);
  const card = r.asks.find((a: any) => a.kind === 'computerAccessSet')!;
  assert.equal(card.params.teach, true);
  assert.equal(card.params.screenControl, true);
  assert.equal(card.params.reason, 'use Notes');
  assert.equal(r.d.session('c1').consent, true);
  assert.deepEqual(r.d.holders(), ['c1'], 'a chat on a tour counts as holding something');
});

test('request_teach_access: a tour that is already on, a decline, an app that cannot be granted and the other cases', async () => {
  const { r, tip } = await touring();
  await rejects(r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'again' }), 'denied', /already active/);
  // another chat cannot start a second tour
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  const asked = r.asks.length;
  await rejects(
    r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'x' }, { chatId: 'c2' }),
    'busy',
    /Another chat is guiding/,
  );
  assert.equal(r.asks.length, asked, 'no card is put up for a tour that cannot start');
  assert.throws(
    () => r.d.startTeach('c2', { granted: [1] }, { decision: 'allow' }),
    (e: any) => e.code === 'busy',
  );
  r.d.endTeach('c1');
  assert.deepEqual(tip.hidden, ['c1']);
  // declined
  r.answers.computerAccessSet = { decision: 'deny' };
  await rejects(
    r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'no' }),
    'denied',
    /declined to start the guided walkthrough/,
  );
  assert.equal(r.d.teaching.size, 0);
  r.answers.computerAccessSet = { decision: 'allow' };
  // nothing grantable: the tour does not start
  const none = await r.json('desktop_request_teach_access', { apps: ['Nothing'], reason: 'x' });
  assert.equal(none.teachModeActive, false);
  assert.match(none.next, /No app could be granted/);
  // a bad reason, a read-only chat and nobody at the screen
  await rejects(r.call('desktop_request_teach_access', { apps: ['Notes'], reason: ' ' }), 'bad_args', /"reason"/);
  r.state.session = { permission: 'plan' };
  await rejects(r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'x' }), 'read_only');
  r.state.session = null;
  r.state.unattended = 'no input for 10 minutes';
  await rejects(r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'x' }), 'unattended', /nobody is here/);
  // no tooltip to draw
  r.d.teachOverlay = { available: false };
  await rejects(r.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'x' }), 'unavailable', /not available in this session/);
});

test('request_teach_access: a tour for an app already granted still asks, and keeps the clicks consent it already had', async () => {
  const r = rig();
  r.d.teachOverlay = overlay();
  await r.ready([NOTES]);
  r.d.session('c1').consent = true;
  const out = await r.json('desktop_request_teach_access', { apps: ['Notes'], reason: 'already there' });
  assert.equal(out.teachModeActive, true);
  assert.equal(r.asks.length, 1, 'the teach card is asked even with nothing new to grant');
  assert.equal(r.asks[0].params.apps.length, 0);
});

test('teach_step: not active, then validation of every field before a tooltip shows', async () => {
  const r = rig();
  r.d.teachOverlay = overlay();
  await rejects(r.call('desktop_teach_step', STEP), 'denied', /Teach mode is not active/);
  await rejects(r.call('desktop_teach_batch', { steps: [STEP] }), 'denied', /Teach mode is not active/);
  const { r: t, tip } = await touring();
  const bad = async (patch: any, re: RegExp) => rejects(t.call('desktop_teach_step', { ...STEP, ...patch }), 'bad_args', re);
  await bad({ explanation: 1 }, /"explanation" must be a string/);
  await bad({ next_preview: undefined }, /"next_preview" must be a string/);
  await bad({ actions: 'x' }, /"actions" must be an array/);
  await bad({ actions: Array(51).fill({ action: 'wait', duration: 0 }) }, /at most 50 actions/);
  await bad({ actions: [null] }, /actions\[0\] must be an object/);
  await bad({ actions: [{ action: 'zoom' }] }, /"zoom" is not allowed/);
  await bad({ anchor: [1] }, /"anchor" must be a \[x, y\]/);
  await bad({ anchor: [1, 'a'] }, /"anchor" must be a \[x, y\]/);
  await rejects(t.call('desktop_teach_step', null as any), 'bad_args');
  assert.equal(tip.shown.length, 0, 'nothing was shown');
});

test('teach_step: the tooltip points at the anchor (screenshot pixels as points), Next runs the actions and returns the screenshot', async () => {
  const { r, tip } = await touring();
  const out = await r.call('desktop_screenshot');
  assert.ok(out.length);
  r.helper.calls.length = 0;
  const res = await r.call('desktop_teach_step', { ...STEP, anchor: [100, 50] });
  assert.deepEqual(tip.shown[0].anchor, { x: 200, y: 100 }, 'a pixel is two points on the test display');
  assert.equal(tip.shown[0].explanation, 'This is Notes');
  assert.equal(tip.shown[0].nextPreview, "Next: I'll click Send");
  assert.deepEqual(tip.workingCalls, ['c1']);
  assert.deepEqual(JSON.parse(res[0].text).executed, 1);
  assert.equal(JSON.parse(res[0].text).results[0].effect, 'unverifiable');
  assert.ok(
    res.some((c: any) => c.type === 'image'),
    'the fresh screenshot follows',
  );
  assert.equal(r.callsOf('click').length, 1);
  assert.equal(r.callsOf('screenshot').length, 1);
});

test('teach_step: no anchor, an anchor off the screenshot or before any screenshot centers the tooltip', async () => {
  const { r, tip } = await touring();
  await r.call('desktop_teach_step', { ...STEP, actions: [] });
  assert.equal(tip.shown[0].anchor, null);
  await r.call('desktop_teach_step', { ...STEP, actions: [], anchor: [5000, 5000] });
  assert.equal(tip.shown[1].anchor, null);
  const fresh = rig();
  fresh.d.teachOverlay = overlay();
  fresh.d.teaching.add('c1');
  await fresh.call('desktop_teach_step', { ...STEP, actions: [], anchor: [1, 1] });
  assert.equal(fresh.d.teachOverlay.shown[0].anchor, null);
  assert.equal(fresh.d.teachOverlay.shown[0].near, null);
});

test('teach_step: a step with no actions is explanation only (no screenshot, the tour goes on)', async () => {
  const { r, tip } = await touring();
  const res = await r.call('desktop_teach_step', { ...STEP, actions: [] });
  assert.deepEqual(JSON.parse(res[0].text), { executed: 0, results: [] });
  assert.equal(res.length, 1);
  assert.deepEqual(tip.workingCalls, ['c1']);
  assert.equal(r.d.teaching.has('c1'), true);
});

test('teach_step: Exit ends the tour; a cancelled step does too; the tooltip is hidden', async () => {
  const { r, tip } = await touring(['exit']);
  const res = await r.call('desktop_teach_step', STEP);
  assert.deepEqual(JSON.parse(res[0].text), { exited: true });
  assert.equal(r.d.teaching.has('c1'), false);
  assert.deepEqual(tip.hidden, ['c1']);
  assert.equal(r.callsOf('click').length, 0, 'no action ran');
  await rejects(r.call('desktop_teach_step', STEP), 'denied', /not active/);
  const second = await touring(['cancel']);
  assert.deepEqual(JSON.parse((await second.r.call('desktop_teach_step', STEP))[0].text), { exited: true });
});

test('teach_step: the tour ending while the tooltip waits answers exited; a stopped call hides the tooltip', async () => {
  const { r, tip } = await touring();
  let release: (c: Choice) => void = () => {};
  tip.gate = new Promise<Choice>((res) => (release = res));
  const pending = r.call('desktop_teach_step', STEP);
  await new Promise((res) => setTimeout(res, 5));
  r.d.endTeach('c1');
  release('next');
  assert.deepEqual(JSON.parse((await pending)[0].text), { exited: true });
  assert.deepEqual(tip.workingCalls, []);
  // an abort signal hides the tooltip
  const again = await touring();
  const ac = new AbortController();
  again.tip.gate = new Promise<Choice>(() => {});
  again.tip.show = async (chatId: string) => {
    ac.abort();
    return 'cancel' as Choice;
  };
  again.tip.hide = (chatId: string) => again.tip.hidden.push(chatId);
  const res = await again.r.call('desktop_teach_step', STEP, { chatId: 'c1', signal: ac.signal }).catch((e: any) => e);
  assert.ok(res);
});

test('teach_step: an action that fails stops the step and says what ran, what failed and what is left', async () => {
  const { r } = await touring();
  await r.call('desktop_screenshot');
  r.helper.fail.click = new Error('boom');
  const res = await r.call('desktop_teach_step', {
    ...STEP,
    actions: [
      { action: 'wait', duration: 0 },
      { action: 'left_click', coordinate: [100, 50] },
      { action: 'wait', duration: 0 },
    ],
  });
  const body = JSON.parse(res[0].text);
  assert.equal(body.executed, 1);
  assert.equal(body.failed.effect, 'refused');
  assert.equal(body.remaining, 1);
  assert.equal(body.results.length, 1);
  assert.equal(body.stoppedAt, undefined);
});

test('teach_batch: validates every step first, runs them in order and ends with one screenshot', async () => {
  const { r, tip } = await touring();
  await r.call('desktop_screenshot');
  await rejects(r.call('desktop_teach_batch', { steps: [] }), 'bad_args', /non-empty array/);
  await rejects(r.call('desktop_teach_batch', { steps: 'x' }), 'bad_args', /non-empty array/);
  await rejects(r.call('desktop_teach_batch', { steps: [STEP, { ...STEP, explanation: 2 }] }), 'bad_args', /steps\[1\]: "explanation"/);
  assert.equal(tip.shown.length, 0, 'a typo in step 2 errors before any tooltip shows');
  r.helper.calls.length = 0;
  const res = await r.call('desktop_teach_batch', {
    steps: [
      STEP,
      { ...STEP, explanation: 'Second', anchor: [10, 10], actions: [{ action: 'wait', duration: 0 }] },
      { ...STEP, actions: [] },
    ],
  });
  const body = JSON.parse(res[0].text);
  assert.equal(body.stepsCompleted, 3);
  assert.equal(body.results.length, 3);
  assert.deepEqual(
    tip.shown.map((s: any) => s.explanation),
    ['This is Notes', 'Second', 'This is Notes'],
  );
  assert.equal(r.callsOf('screenshot').length, 1, 'one screenshot for the whole batch');
  assert.ok(res.some((c: any) => c.type === 'image'));
});

test('teach_batch: explanation-only steps return no screenshot; Exit and a failed action stop the batch', async () => {
  const { r } = await touring();
  const plain = await r.call('desktop_teach_batch', { steps: [{ ...STEP, actions: [] }] });
  assert.equal(plain.length, 1);
  assert.deepEqual(JSON.parse(plain[0].text), { stepsCompleted: 1, results: [{ executed: 0, results: [] }].map((x) => x.results) });
  // Exit at the second step
  const exiting = await touring(['next', 'exit']);
  await exiting.r.call('desktop_screenshot');
  const out = await exiting.r.call('desktop_teach_batch', { steps: [{ ...STEP, actions: [] }, STEP] });
  assert.deepEqual(JSON.parse(out[0].text), { exited: true, stepsCompleted: 1 });
  // a failed action in step 1
  const failing = await touring();
  await failing.r.call('desktop_screenshot');
  failing.r.helper.fail.click = new Error('boom');
  const f = JSON.parse((await failing.r.call('desktop_teach_batch', { steps: [STEP, STEP] }))[0].text);
  assert.equal(f.stepsCompleted, 0);
  assert.equal(f.stepFailed, 0);
  assert.equal(f.failed.effect, 'refused');
  assert.deepEqual(f.results, []);
});

test('teach_batch: a screenshot that fails after the steps says so', async () => {
  const { r } = await touring();
  await r.call('desktop_screenshot');
  r.helper.fail.screenshot = new Error('no display');
  const res = await r.call('desktop_teach_batch', { steps: [STEP] });
  assert.match(res[1].text, /No screenshot after the steps: No display\./);
});

test('a turn that ends or is stopped ends the tour and hides the tooltip; so does forgetting the chat', async () => {
  const a = await touring();
  await a.r.d.turnEnded('c1');
  assert.deepEqual(a.tip.hidden, ['c1']);
  assert.equal(a.r.d.teaching.size, 0);
  const b = await touring();
  b.r.d.interrupt('c1');
  assert.deepEqual(b.tip.hidden, ['c1']);
  const c = await touring();
  await c.r.d.forget('c1');
  assert.deepEqual(c.tip.hidden, ['c1']);
  // ending a chat that has no tour is a no-op
  c.r.d.endTeach('c9');
  assert.deepEqual(c.tip.hidden, ['c1']);
});

test('quitting disposes the tooltip', async () => {
  const r = rig();
  let disposed = 0;
  r.d.teachOverlay = { dispose: () => disposed++ };
  await r.d.letGoAll();
  assert.equal(disposed, 1);
});

test('request_full_control: asks the takeover card once with the reason, then it is already approved', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const first = await r.text('desktop_request_full_control');
  assert.match(first, /^Full-screen control approved for this chat\. The screen tools \(desktop_screenshot/);
  assert.match(first, /lasts until the chat ends/);
  const card = r.asks.find((a: any) => a.kind === 'computerTakeover')!;
  assert.match(card.params.reason, /real pointer and keyboard/);
  assert.equal(r.d.session('c1').consent, true);
  const again = await r.text('desktop_request_full_control');
  assert.match(again, /already available for this chat/);
  assert.equal(r.asks.filter((a: any) => a.kind === 'computerTakeover').length, 1);
});

test('request_full_control: needs no granted app, says so, and a decline is told in its own words', async () => {
  const r = rig();
  const text = await r.text('desktop_request_full_control');
  assert.match(text, /No app is granted yet, so request access to the apps you need next/);
  const d = rig();
  d.answers.computerTakeover = { decision: 'deny' };
  await rejects(
    d.call('desktop_request_full_control'),
    'denied',
    /Full-screen control was not approved \(declined or not confirmed\)\. Stay with the desktop_app_\* tools/,
  );
  assert.equal(d.d.session('c1').consent, false);
  // the plain takeover refusal keeps its own words
  await d.ready([NOTES]);
  await rejects(d.call('desktop_key', { text: 'a' }), 'denied', /didn't allow MoPilot to control the screen/);
  // read-only and unattended
  const ro = rig();
  ro.state.session = { permission: 'plan' };
  await rejects(ro.call('desktop_request_full_control'), 'read_only');
  const un = rig();
  un.state.unattended = 'no input for 10 minutes';
  await rejects(un.call('desktop_request_full_control'), 'unattended', /needs the user's OK once per chat/);
  assert.equal(un.paused[0].deferred.kind, 'computerTakeover');
});

test('release_full_control: lets go of the desktop and the consent, and the next screen input asks again', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.text('desktop_request_full_control');
  await r.call('desktop_mouse_move', { coordinate: [10, 10] });
  assert.equal(r.cu.controlling, 'c1');
  const text = await r.text('desktop_release_full_control');
  assert.match(
    text,
    /^Released full-screen control\. The screen overlay is off\. Keep going with the desktop_app_\* tools; ask for full-screen control again/,
  );
  assert.equal(r.cu.controlling, null);
  assert.equal(r.d.session('c1').consent, false);
  assert.deepEqual(r.released, ['c1']);
  r.asks.length = 0;
  await r.call('desktop_key', { text: 'a' });
  assert.equal(r.asks.filter((a: any) => a.kind === 'computerTakeover').length, 1, 'asked again');
  // with no app granted
  const none = rig();
  assert.match(await none.text('desktop_release_full_control'), /No app is granted for background control yet/);
});

test('the Electron modules give the control its clipboard and the teach tooltip; without them neither exists', () => {
  const base: any = { helper: {}, cu: {}, grants: null, broker: null };
  const clipboard = { readText: () => '', writeText: () => {} };
  const electron: any = { BrowserWindow: class {}, screen: {}, clipboard };
  const withElectron = new DesktopControl({ ...base, electron });
  assert.equal(withElectron.clipboard, clipboard);
  assert.equal(withElectron.teachOverlay.available, true);
  const own = { readText: () => 'own', writeText: () => {} };
  assert.equal(new DesktopControl({ ...base, electron, clipboard: own }).clipboard, own);
  const bare = new DesktopControl(base);
  assert.equal(bare.clipboard, null);
  assert.equal(bare.teachOverlay.available, false);
  assert.equal(new DesktopControl({ ...base, electron: { BrowserWindow: class {}, screen: {} } }).clipboard, null);
});

test('teach_step: a call that is already stopped shows nothing, and a Next after the stop runs nothing', async () => {
  const { r, tip } = await touring();
  const done = new AbortController();
  done.abort();
  const res = await r.call('desktop_teach_step', STEP, { chatId: 'c1', signal: done.signal });
  assert.deepEqual(JSON.parse(res[0].text), { exited: true });
  assert.equal(tip.shown.length, 0);
  // stopped while the tooltip waited: its Next does not run the actions
  const live = new AbortController();
  tip.show = async () => {
    live.abort();
    return 'next' as Choice;
  };
  const late = await r.call('desktop_teach_step', STEP, { chatId: 'c1', signal: live.signal });
  assert.deepEqual(JSON.parse(late[0].text), { exited: true });
  assert.equal(r.callsOf('click').length, 0);
});

test('teach_step: a step that throws (a missing permission) ends the tour with it', async () => {
  const { r, tip } = await touring();
  r.d.batch = async () => {
    throw new Error('permission');
  };
  await assert.rejects(r.call('desktop_teach_step', STEP), /permission/);
  assert.equal(r.d.teaching.has('c1'), false);
  assert.deepEqual(tip.hidden, ['c1']);
});

test('teach_batch: a failed step reports its own results apart from the earlier steps, and the screen as it was left', async () => {
  const { r } = await touring();
  await r.call('desktop_screenshot');
  const two = [
    { ...STEP, actions: [{ action: 'wait', duration: 0 }] },
    {
      ...STEP,
      actions: [
        { action: 'wait', duration: 0 },
        { action: 'left_click', coordinate: [100, 50] },
        { action: 'wait', duration: 0 },
      ],
    },
  ];
  r.helper.fail.click = new Error('boom');
  const res = await r.call('desktop_teach_batch', { steps: two });
  const body = JSON.parse(res[0].text);
  assert.equal(body.stepsCompleted, 1);
  assert.equal(body.stepFailed, 1);
  assert.equal(body.executed, 1);
  assert.equal(body.remaining, 1);
  assert.equal(body.stepResults.length, 1, "the failed step's own completed actions");
  assert.equal(body.results.length, 1, 'the earlier steps');
  assert.ok(
    res.some((c: any) => c.type === 'image'),
    'the screen as the failure left it',
  );
});

test('release_full_control ends a tour that ran on the screen; request_full_control in a read-only chat is refused even with consent', async () => {
  const { r, tip } = await touring();
  await r.text('desktop_release_full_control');
  assert.equal(r.d.teaching.has('c1'), false);
  assert.deepEqual(tip.hidden, ['c1']);
  const ro = rig();
  ro.d.session('c1').consent = true;
  ro.state.session = { permission: 'plan' };
  await rejects(ro.call('desktop_request_full_control'), 'read_only');
});

test('teach_batch: with a settle time the closing screenshot waits for the screen', async () => {
  const r = rig({ settleMs: 5 });
  r.d.teachOverlay = overlay();
  r.d.teaching.add('c1');
  r.d.settle = async () => {
    r.helper.calls.push({ method: 'settle', args: [] });
  };
  const res = await r.call('desktop_teach_batch', { steps: [{ ...STEP, actions: [{ action: 'wait', duration: 0 }] }] });
  assert.ok(res.length >= 1);
  assert.ok(r.helper.calls.some((c: any) => c.method === 'settle'));
});
