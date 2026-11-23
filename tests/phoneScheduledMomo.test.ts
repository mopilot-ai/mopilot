// The Scheduled destination as one list: MoMo's routines (only for an account MoMo is open to) with the Mac's scheduled chats, proposals to approve, and a routine's Pause, Resume and Run now in a sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const screenPath = '../mobile/src/screens/Scheduled';
const { Scheduled, timedRows, routineLine } = await import(screenPath);

const ROUTINES = {
  proposals: [{ id: 'p1', name: 'Weekly review', prompt: 'Sum up my week', schedule: 'Fridays 5:00 PM', sources: 'Calendar', rev: 3 }],
  routines: [
    { id: 'r2', name: 'Paused digest', schedule: 'Daily 7:00 AM', paused: true },
    { id: 'r1', name: 'Morning brief', schedule: 'Weekdays 8:30 AM', paused: false },
  ],
};
const hello = (momo: boolean) => ({ capabilities: { methods: ['scheduled.list', 'momo.routines.list'], momo } });
const TASKS = { tasks: [{ id: 't1', name: "Check main's CI", next: Date.now() + 90 * 60_000 }] };

const mounted: any[] = [];
async function mount(handler: (m: string, p: any) => unknown, momo: boolean) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const s = scripted(
    (m, p) =>
      handler(m, p) ??
      (m === 'machine.hello' ? hello(momo) : m === 'scheduled.list' ? TASKS : m === 'momo.routines.list' ? ROUTINES : undefined),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let backs = 0;
  await act(async () => root.render(createElement(Scheduled, { runtime: s.runtime, back: () => backs++ })));
  await flush();
  return { host, calls: s.calls, backs: () => backs };
}
const text = (host: HTMLElement) => host.textContent!;

test('routines come first, running before paused, then the Mac’s tasks soonest first; a paused routine says so', () => {
  const rows = timedRows(ROUTINES.routines, [
    { id: 'late', name: 'Late', next: null },
    { id: 'soon', name: 'Soon', next: 5 },
  ]);
  assert.deepEqual(
    rows.map((r: any) => (r.kind === 'routine' ? r.routine.id : r.task.id)),
    ['r1', 'r2', 'soon', 'late'],
  );
  assert.equal(routineLine(ROUTINES.routines[0]), 'MoMo · Paused · Daily 7:00 AM');
  assert.equal(routineLine(ROUTINES.routines[1]), 'MoMo · Weekdays 8:30 AM');
});

test('for a MoMo account the list holds its routines with the Mac’s tasks, and a proposal waits at the top to approve', async () => {
  const { host, calls } = await mount(() => undefined, true);
  assert.match(text(host), /MoMo suggests.*Weekly review.*Fridays 5:00 PM.*Sum up my week.*Reads: Calendar/);
  assert.match(
    text(host),
    /Upcoming.*Morning brief.*MoMo · Weekdays 8:30 AM.*Paused digest.*MoMo · Paused · Daily 7:00 AM.*Check main's CI.*In 1 h/,
  );
  await click('Approve');
  assert.deepEqual(calls.find((c) => c[0] === 'momo.routines.approve')![1], { id: 'p1', seen: 3 });
  assert.equal(calls.filter((c) => c[0] === 'momo.routines.list').length, 2, 'the list is read again after a change');
});

test('a routine opens a sheet: Pause or Resume and Run now, each read back, and a refusal stays in the sheet', async () => {
  let refuse = false;
  const { host, calls } = await mount((m) => {
    if (m === 'momo.routines.run' && refuse) throw new Error('MoMo is paused.');
    return undefined;
  }, true);
  await click('Morning brief');
  assert.match(text(host), /PauseRun now/);
  await click('Pause');
  assert.deepEqual(calls.find((c) => c[0] === 'momo.routines.pause')![1], { id: 'r1' });
  assert.doesNotMatch(text(host), /Run now/, 'done, the sheet closes');
  await click('Paused digest');
  await click('Resume');
  assert.deepEqual(calls.find((c) => c[0] === 'momo.routines.resume')![1], { id: 'r2' });
  refuse = true;
  await click('Morning brief');
  await click('Run now');
  assert.match(text(host), /Run now.*MoMo is paused\./);
  await click('Close');
  assert.doesNotMatch(text(host), /Run now/);
});

test('an account MoMo is not open to sees only the Mac’s tasks and MoMo is never asked; a task row is not a button', async () => {
  const { host, calls } = await mount(() => undefined, false);
  assert.match(text(host), /Check main's CI/);
  assert.doesNotMatch(text(host), /MoMo/);
  assert.ok(!calls.some((c) => c[0].startsWith('momo.')));
  assert.equal(host.querySelector(`button[aria-label="Check main's CI"]`), null);
});

test('a failed MoMo read is shown with Retry, and the Back circle and the back button leave', async () => {
  let fail = true;
  (globalThis as any).__phonePlatform = 'android';
  try {
    const { host, backs } = await mount((m) => {
      if (m === 'momo.routines.list' && fail) throw new Error('MoMo is not set up yet.');
      return undefined;
    }, true);
    assert.match(text(host), /MoMo is not set up yet\./);
    assert.match(text(host), /Check main's CI/);
    fail = false;
    await click('Retry');
    assert.match(text(host), /Morning brief/);
    await click('Back');
    await act(async () => void ((globalThis as any).__phoneBackListeners as Array<() => boolean>).at(-1)!());
    assert.equal(backs(), 2);
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});

test('a press queued while an action is still running is ignored: one approve reaches the Mac', async () => {
  let finish: (v: unknown) => void = () => {};
  const { calls } = await mount((m) => (m === 'momo.routines.approve' ? new Promise((r) => (finish = r)) : undefined), true);
  await click('Approve');
  // the button is disabled now; a tap that was already queued still runs its handler
  const approve = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!;
  const props = (approve as any)[Object.keys(approve).find((k) => k.startsWith('__reactProps'))!];
  await act(async () => props.onClick());
  assert.equal(calls.filter((c) => c[0] === 'momo.routines.approve').length, 1);
  await act(async () => finish({}));
  await flush();
});
