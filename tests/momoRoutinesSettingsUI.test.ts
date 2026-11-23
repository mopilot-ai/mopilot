// Settings › MoMo › Routines (src/components/momo/settings/RoutinesSettings.tsx) and its data hook (src/lib/momoRoutines.ts, #2139): the routines MoMo proposed with Approve (as shown, by revision) and Decline, the approved routines below, a load that failed with Try again, a change main refused told and the list read again, the list read again when main says it changed, an older read losing to a newer one, and the listener removed with the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const SOURCES = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'files', label: 'Files' },
];
const routine = {
  id: 'momo.a',
  name: 'Morning briefing',
  prompt: 'A short briefing.',
  schedule: 'Every day at 8',
  rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
  parts: { time: '08:00', days: [] as string[] },
  sources: ['calendar'],
  paused: false,
};
const proposal = {
  id: 'momo.p',
  name: 'Weekly review',
  prompt: 'Summarize my week.',
  schedule: 'Every Friday at 17',
  sources: 'Calendar, Files',
  rev: 3,
};
const bare = { id: 'momo.q', name: 'Rent', prompt: 'Remind me.', schedule: 'Every month on the 1st', sources: '', rev: 1 };

const calls: any[] = [];
let view: () => Promise<any> = async () => ({ proposals: [], routines: [], sources: SOURCES });
let approve: (id: string, rev: number) => Promise<any> = async () => ({ id: 'momo.p', name: 'Weekly review' });
let edit: (id: string, e: any) => Promise<any> = async () => ({ id: 'momo.a' });
let remove: (id: string) => Promise<any> = async () => true;
const listeners = new Set<() => void>();
installNativeStub({
  momoRoutines: {
    view: () => (calls.push(['view']), view()),
    approve: (id: string, rev: number) => (calls.push(['approve', id, rev]), approve(id, rev)),
    edit: (id: string, e: any) => (calls.push(['edit', id, e]), edit(id, e)),
    remove: (id: string) => (calls.push(['remove', id]), remove(id)),
    onChanged: (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb)),
  },
  // Calendar is connected: a routine that reads it has no connect line under it
  momoSources: {
    list: async () => ({
      ok: true,
      available: true,
      waiting: [],
      sources: [{ id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read' }],
    }),
    onChanged: () => () => {},
  },
});
const { RoutinesSettings } = await import('../src/components/momo/settings/RoutinesSettings.tsx');
const { ROUTINES_INTRO, PROPOSED_CHIP, CONNECT_AFTER_APPROVE } = await import('../src/components/momo/routineCopy.ts');

const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const button = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLElement;
const reset = () => {
  calls.length = 0;
  listeners.clear();
  view = async () => ({ proposals: [], routines: [], sources: SOURCES });
  approve = async () => ({ id: 'momo.p', name: 'Weekly review' });
  edit = async () => ({ id: 'momo.a' });
  remove = async () => true;
};
const mount = async () => {
  const r = await render(h(RoutinesSettings));
  await settle();
  return r;
};

test('nothing yet: what a routine is, no card, and what to ask for', async () => {
  reset();
  const { host, unmount } = await mount();
  assert.deepEqual(calls, [['view']]);
  assert.equal(host.querySelectorAll('section[aria-label]').length, 0);
  assert.match(host.textContent!, new RegExp(ROUTINES_INTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(host.textContent!, /No routines yet\. Ask MoMo in Chat to set one up/);
  assert.equal(host.querySelector('[role=alert]'), null);
  await unmount();
});

test('before the first read nothing is drawn; a read that fails says so with Try again, which reads again', async () => {
  reset();
  const first = deferred<any>();
  view = () => first.promise;
  const { host, unmount } = await render(h(RoutinesSettings));
  assert.equal(host.innerHTML, '', 'nothing while the first read runs');
  await act(async () => first.reject(new Error('not_allowed')));
  await settle();
  assert.match(host.textContent!, /Couldn’t load the routines\./);
  view = async () => ({ proposals: [proposal], routines: [routine], sources: SOURCES });
  await click(button(host, 'Try again'));
  await settle();
  assert.equal(calls.filter((c) => c[0] === 'view').length, 2);
  assert.doesNotMatch(host.textContent!, /Couldn’t load/);
  assert.match(host.textContent!, /Weekly review/);
  assert.match(host.textContent!, /Morning briefing/);
  await unmount();
});

test('proposals: what each will do, when and what it reads; Approve passes the revision shown, Decline removes it', async () => {
  reset();
  view = async () => ({ proposals: [proposal, bare], routines: [routine], sources: SOURCES });
  const { host, unmount } = await mount();
  assert.match(host.textContent!, /Nothing runs until you approve it\./);
  const [p, q] = [...host.querySelectorAll('section[aria-label]')];
  const chips = (c: Element) => [...c.querySelectorAll('.hp-badge')].map((x) => x.textContent);
  assert.equal(p.getAttribute('aria-label'), 'Weekly review');
  assert.equal(p.querySelector('[data-status]')!.textContent, 'Every Friday at 5:00 PM');
  // the fake main has Calendar connected and does not list Files: each chip says whether MoMo can read it
  assert.deepEqual(chips(p), [PROPOSED_CHIP, 'Calendar', 'Files · not connected']);
  assert.equal(p.querySelector('details p')!.textContent, 'Summarize my week.');
  assert.equal(p.textContent!.includes(CONNECT_AFTER_APPROVE), false, 'Calendar is connected (Files needs no macOS grant): nothing to say');
  assert.deepEqual(chips(q), [PROPOSED_CHIP], 'no sources named: no Uses line');
  assert.equal(q.textContent!.includes('Uses'), false);
  assert.equal(q.querySelector('details p')!.textContent, 'Remind me.');
  // approved: main has it, so the list is read again, and the proposal is gone from it
  view = async () => ({ proposals: [bare], routines: [routine, { ...routine, id: 'momo.p', name: 'Weekly review' }], sources: SOURCES });
  calls.length = 0;
  await click(button(p, 'Approve'));
  await settle();
  assert.deepEqual(calls, [['approve', 'momo.p', 3], ['view']]);
  const weekly = [...host.querySelectorAll('section[aria-label]')].find((c) => c.getAttribute('aria-label') === 'Weekly review')!;
  assert.equal(weekly.textContent!.includes(PROPOSED_CHIP), false, 'now among the routines, no longer waiting');
  // declined: removed, then read again
  view = async () => ({ proposals: [], routines: [routine], sources: SOURCES });
  calls.length = 0;
  await click(button(host.querySelector('section[aria-label]')!, 'Decline'));
  await settle();
  assert.deepEqual(calls, [['remove', 'momo.q'], ['view']]);
  assert.doesNotMatch(host.textContent!, new RegExp(PROPOSED_CHIP));
  await unmount();
});

test('an Approve main refuses (the routine changed since it was shown) says why, and the list is not left stale', async () => {
  reset();
  view = async () => ({ proposals: [proposal], routines: [], sources: SOURCES });
  const { host, unmount } = await mount();
  approve = async () => {
    throw new Error('That routine changed.');
  };
  view = async () => ({ proposals: [{ ...proposal, rev: 4 }], routines: [], sources: SOURCES });
  calls.length = 0;
  await click(button(host, 'Approve'));
  await settle();
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'Couldn’t save that: That routine changed.');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['approve'],
    'a refusal reads nothing again by itself',
  );
  // a later read that succeeds clears the message and shows the newer revision
  await act(async () => [...listeners].forEach((cb) => cb()));
  await settle();
  assert.equal(host.querySelector('[role=alert]'), null);
  approve = async () => ({ id: 'momo.p', name: 'Weekly review' });
  calls.length = 0;
  await click(button(host, 'Approve'));
  await settle();
  assert.deepEqual(calls[0], ['approve', 'momo.p', 4]);
  await unmount();
});

test('Edit: closed once main saved it and the list was read again; a refused edit keeps the form with what was typed, and says why', async () => {
  reset();
  view = async () => ({ proposals: [], routines: [routine], sources: SOURCES });
  const { host, unmount } = await mount();
  const li = host.querySelector('section[aria-label]')!;
  await click(button(li, 'Edit'));
  const name = li.querySelector('form input:not([type=checkbox])')!;
  await type(name, 'Morning brief');
  edit = async () => {
    throw new Error('Not a time.');
  };
  calls.length = 0;
  await click(button(li, 'Save'));
  await settle();
  assert.deepEqual(calls, [['edit', 'momo.a', { name: 'Morning brief' }]], 'false: no read again');
  assert.ok(li.querySelector('form'), 'refused: the form stays');
  assert.equal(li.querySelector<HTMLInputElement>('form input:not([type=checkbox])')!.value, 'Morning brief');
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'Couldn’t save that: Not a time.');
  edit = async () => ({ id: 'momo.a' });
  view = async () => ({ proposals: [], routines: [{ ...routine, name: 'Morning brief' }], sources: SOURCES });
  calls.length = 0;
  await click(button(li, 'Save'));
  await settle();
  assert.deepEqual(calls, [['edit', 'momo.a', { name: 'Morning brief' }], ['view']]);
  assert.equal(li.querySelector('form'), null, 'saved: closed');
  assert.equal(host.querySelector('[role=alert]'), null);
  assert.match(host.textContent!, /Morning brief/);
  await unmount();
});

test('Pause and Remove go through main and show once the list is read again; Remove only once confirmed', async () => {
  reset();
  view = async () => ({ proposals: [], routines: [routine], sources: SOURCES });
  const { host, unmount } = await mount();
  view = async () => ({ proposals: [], routines: [{ ...routine, paused: true }], sources: SOURCES });
  calls.length = 0;
  await click(button(host, 'Pause'));
  await settle();
  assert.deepEqual(calls, [['edit', 'momo.a', { paused: true }], ['view']]);
  assert.ok(button(host, 'Resume'));
  view = async () => ({ proposals: [], routines: [], sources: SOURCES });
  calls.length = 0;
  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    await click(button(host, 'Remove Morning briefing'));
  } finally {
    window.confirm = confirm;
  }
  await settle();
  assert.deepEqual(calls, [['remove', 'momo.a'], ['view']]);
  assert.match(host.textContent!, /No routines yet/);
  // a remove main refuses is said
  view = async () => ({ proposals: [proposal], routines: [], sources: SOURCES });
  await act(async () => [...listeners].forEach((cb) => cb()));
  await settle();
  remove = async () => {
    throw new Error('Gone already.');
  };
  await click(button(host, 'Decline'));
  await settle();
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'Couldn’t save that: Gone already.');
  await unmount();
});

test('main says the routines changed (a run, a proposal, another window): the list is read again; an older read settling later changes nothing', async () => {
  reset();
  const { host, unmount } = await mount();
  assert.equal(listeners.size, 1);
  const slow = deferred<any>();
  view = () => slow.promise;
  await act(async () => [...listeners].forEach((cb) => cb()));
  view = async () => ({ proposals: [], routines: [{ ...routine, name: 'Newer' }], sources: SOURCES });
  await act(async () => [...listeners].forEach((cb) => cb()));
  await settle();
  assert.match(host.textContent!, /Newer/);
  await act(async () => slow.resolve({ proposals: [], routines: [{ ...routine, name: 'Older' }], sources: SOURCES }));
  await settle();
  assert.match(host.textContent!, /Newer/);
  assert.doesNotMatch(host.textContent!, /Older/);
  // an older failure says nothing either
  const stale = deferred<any>();
  view = () => stale.promise;
  await act(async () => [...listeners].forEach((cb) => cb()));
  view = async () => ({ proposals: [], routines: [{ ...routine, name: 'Newest' }], sources: SOURCES });
  await act(async () => [...listeners].forEach((cb) => cb()));
  await settle();
  await act(async () => stale.reject(new Error('old')));
  await settle();
  assert.equal(host.querySelector('[role=alert]'), null);
  assert.match(host.textContent!, /Newest/);
  await unmount();
});

test('closing the page stops listening, and a read still running then changes nothing', async () => {
  reset();
  const late = deferred<any>();
  view = () => late.promise;
  const { unmount } = await render(h(RoutinesSettings));
  assert.equal(listeners.size, 1);
  await unmount();
  assert.equal(listeners.size, 0, 'unsubscribed');
  await act(async () => late.resolve({ proposals: [], routines: [], sources: SOURCES }));
  const bad = deferred<any>();
  view = () => bad.promise;
  const second = await render(h(RoutinesSettings));
  await second.unmount();
  await act(async () => bad.reject(new Error('late')));
  await settle();
});

test('a proposal that reads Calendar or Reminders not connected says what approving does about it; a connected one says nothing', async () => {
  reset();
  // main lists every source a routine may read
  const ALL = [...SOURCES, { id: 'reminders', label: 'Reminders' }];
  const bills = { id: 'momo.r', name: 'Bills', prompt: 'Check the bills.', schedule: 'Every day at 9', sources: 'Reminders', rev: 2 };
  view = async () => ({ proposals: [bills], routines: [], sources: ALL });
  const { host, unmount } = await mount();
  // the fake main lists Calendar only: Reminders is not there to read
  assert.ok(host.textContent!.includes(CONNECT_AFTER_APPROVE));
  assert.ok(host.textContent!.includes('Reminders · not connected'));
  await unmount();
  view = async () => ({ proposals: [{ ...bills, sources: 'Calendar' }], routines: [], sources: ALL });
  const calendar = await mount();
  assert.equal(calendar.host.textContent!.includes(CONNECT_AFTER_APPROVE), false);
  await calendar.unmount();
});
