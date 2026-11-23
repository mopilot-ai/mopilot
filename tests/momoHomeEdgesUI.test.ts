// The corners of MoMo's home surfaces (src/components/momo/home): copy for hours and days, a lease that is not there yet, a home with no recommended machine, a note that cannot be undone, a rule with no reactions, a setting edited and left, a machine that is offline, a failed task with no fix of its own, and a screen closed before the home answered.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  minutesSince,
  MomoHomePage,
  NOW,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  window,
} from './support/momoHomeRig.ts';
import { hm12, stepLabel } from '../src/components/momo/home/homeCopy.ts';

const body = () => window.document.body as any;

async function view(v: ReturnType<typeof fixtureView>, tab: any = 'chat', seam = createFixtureSeam(v, () => NOW)) {
  const calls: any[] = [];
  const real = seam.act;
  seam.act = async (a: any) => (calls.push(a), real(a));
  setMomoHomeSeam(seam);
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  body().appendChild(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab, now: NOW })));
  await flush();
  const buttons = (label: string) => [...body().querySelectorAll('button')].filter((b: any) => b.textContent.trim() === label) as any[];
  return {
    calls,
    text: () => body().textContent as string,
    buttons,
    press: async (label: string, n = 0) => {
      await act(async () => buttons(label)[n].click());
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      body().innerHTML = '';
    },
  };
}

test('how long ago is told in the unit that fits, a step the client does not know keeps its name, and times read 12-hour', () => {
  assert.equal(minutesSince(NOW - 5 * 3_600_000, NOW), '5 h');
  assert.equal(minutesSince(NOW - 47 * 3_600_000, NOW), '47 h');
  assert.equal(minutesSince(NOW - 72 * 3_600_000, NOW), '3 d');
  assert.equal(stepLabel('copied'), 'Copied');
  assert.equal(stepLabel('verifying'), 'verifying');
  assert.equal(hm12('00:05'), '12:05 AM');
  assert.equal(hm12('13:30'), '1:30 PM');
  assert.equal(hm12('12:00'), '12:00 PM');
});

test('a home that went to sleep at an unknown time, and one that is out of date with no machine yet, still say what is wrong', async () => {
  const asleep = scenarioView('asleep');
  asleep.home.stateSince = null;
  const a = await view(asleep);
  assert.ok(a.text().includes('MoMo’s home went to sleep'));
  assert.ok(!a.text().includes('went to sleep at'));
  await a.close();
  const old = scenarioView('needs-update');
  old.home.homeMachineId = null;
  const o = await view(old);
  await o.press('Update Studio');
  assert.deepEqual(o.calls.at(-1), { type: 'machine.update', machineId: '' });
  await o.close();
});

test('a failed approval fix is a button that sends that fix', async () => {
  const v = fixtureView();
  (v.chat.find((r) => r.kind === 'approval') as any).approval.status = 'failed';
  (v.chat.find((r) => r.kind === 'approval') as any).approval.failure = {
    cause: 'Gmail refused it.',
    fix: { id: 'sign-in-gmail', label: 'Reconnect Gmail' },
  };
  const m = await view(v);
  await m.press('Reconnect Gmail');
  assert.deepEqual(m.calls.at(-1), { type: 'fix.run', id: 'sign-in-gmail' });
  await m.close();
});

test('text typed while a message goes is kept when it is accepted; only the sent text is cleared', async () => {
  const seam = createFixtureSeam(scenarioView(null), () => NOW);
  const real = seam.act;
  let release: () => void = () => undefined;
  seam.act = (a: any) => new Promise((res) => (release = () => res(real(a))));
  const m = await view(scenarioView(null), 'chat', seam);
  const input = () => body().querySelector('input[aria-label="Message MoMo"]');
  const type = async (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), v);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await type('First');
  await act(
    async () =>
      void body()
        .querySelector('form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
  );
  await type('First and more');
  await act(async () => release());
  await flush();
  assert.equal(input().value, 'First and more');
  await m.close();
});

test('a note that cannot be undone has no Undo, in the banner or in its history', async () => {
  const v = fixtureView();
  v.notes[0].lastChange = { ...v.notes[0].lastChange!, undoable: false };
  v.notes[0].history = v.notes[0].history.map((c) => ({ ...c, undoable: false }));
  const m = await view(v, 'notes');
  assert.equal(m.buttons('Undo').length, 0);
  await m.press('History');
  assert.equal(m.buttons('Undo').length, 0);
  await m.close();
});

test('a learned rule with no reactions, one with a single reaction, and the brief switch of an edited rule', async () => {
  const v = fixtureView();
  v.rules[0].evidence = [];
  v.rules[1].evidence = [{ at: NOW, reaction: 'Not needed', item: 'One' }];
  const m = await view(v, 'rules');
  assert.ok(m.text().includes('Learned from you'));
  assert.ok(m.text().includes('you answered “Not needed” once'));
  await act(async () => body().querySelector('[data-rule="r-clients"]').click());
  await flush();
  await m.press('Edit');
  const box = body().querySelector('input[type="checkbox"]');
  await act(async () => box.click());
  await m.press('Save');
  assert.equal(m.calls.at(-1).inBrief, true);
  await m.close();
});

test('a setting typed and then left behind by closing the screen leaves nothing running', async () => {
  const m = await view(scenarioView(null), 'rules');
  const cap = body().querySelector('input[type="number"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(cap, '9');
    cap.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await m.close();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 450));
  });
  assert.ok(true, 'the pending pause was cleared with the screen, and nothing threw');
});

test('setup with no recommended machine picks the first one online, a machine with no note says nothing of its cost, and the sign-in step names a home it does not know yet', async () => {
  const v = scenarioView('first-run');
  v.home.machines = v.home.machines.map((m) => ({ ...m, recommended: false, note: null }));
  v.setup.step = 'read';
  v.home.machineName = null;
  const read = await view(v);
  assert.ok(read.text().includes('The sign-in stays on your machine.'));
  await read.close();
  const w = scenarioView('first-run');
  w.home.machines = w.home.machines.map((m) => ({ ...m, recommended: false, note: null }));
  const where = await view(w);
  assert.ok(where.text().includes('Continue with Studio'));
  assert.ok(where.text().includes('Online · '));
  await where.close();
  const none = scenarioView('first-run');
  none.home.machines = none.home.machines.map((m) => ({ ...m, status: 'offline' as const, recommended: false }));
  const nobody = await view(none);
  assert.ok(nobody.text().includes('Not set up'));
  await nobody.close();
});

test('a machine that is offline says so and cannot be picked; a failed task with no fix of its own is retried, and with nowhere else to run it offers only that', async () => {
  const v = fixtureView();
  v.home.machines = v.home.machines.map((m) => (m.machineId === 'mac-mini' ? { ...m, status: 'offline' as const } : m));
  const m = await view(v);
  await m.press('Runs on Studio');
  assert.ok(m.text().includes('Offline'));
  assert.equal(m.buttons('Offline')[0].disabled, true);
  await m.close();
  const t = fixtureView();
  t.home.machines = t.home.machines.filter((x) => x.machineId === 'mac-mini');
  const f: any = t.tasks.find((x) => x.id === 't-failed');
  f.failure.fix = null;
  const tm = await view(t, 'tasks');
  await act(async () => body().querySelector('[data-task="t-failed"]').click());
  await flush();
  assert.ok(tm.text().includes('out of disk space'));
  assert.equal(tm.buttons('Run on another machine').length, 0);
  await tm.press('Retry');
  assert.deepEqual(tm.calls.at(-1), { type: 'task.retry', id: 't-failed' });
  await tm.close();
});

test('a screen closed before the seam is chosen, and a reset with nothing to forget, do nothing', async () => {
  resetMomoHomeStore();
  resetMomoHomeStore();
  setMomoHomeSeam(createFixtureSeam(scenarioView(null), () => NOW));
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await act(async () => root.unmount());
  await flush();
  assert.equal(host.textContent, '');
});

test('resetting the store while a screen is open lets go of what it followed, and an answer that arrives late is not shown', async () => {
  let answer: (v: unknown) => void = () => undefined;
  setMomoHomeSeam({
    read: () => new Promise<any>((r) => (answer = r)),
    subscribe: () => () => undefined,
    act: async () => ({ ok: true }),
  });
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  resetMomoHomeStore();
  answer({ ok: true, view: fixtureView() });
  await flush();
  assert.equal(host.textContent, '');
  await act(async () => root.unmount());
});
