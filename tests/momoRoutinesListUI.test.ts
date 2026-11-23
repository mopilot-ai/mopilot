// MoMo's routines in Settings › MoMo › Routines (src/components/momo/RoutinesList.tsx, #2293): every approved routine, paused ones too, with Pause or Resume; Edit opens a form with its name, what it does, its schedule (a time and days, or an RRULE when it is no such rule) and the sources it may read, saved as one edit and closed only once main saved it; Cancel changes nothing; Remove only once confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';

// the sources a routine reads, as main has them: Calendar and Reminders connected unless a test says otherwise (RoutineConnectNote.tsx)
const sf: any = {
  calls: [] as any[],
  listeners: new Set<() => void>(),
  connected: new Set(['calendar', 'reminders']),
  waiting: [] as string[],
  known: ['calendar', 'reminders'],
};
sf.connect = async () => ({ ok: true, connected: true, grant: 'granted' });
sf.privacy = async () => ({ ok: true });
const rec =
  (name: string, answer: () => Promise<any>) =>
  async (...a: any[]) => (sf.calls.push([name, ...a]), answer());
installNativeStub({
  momoSources: {
    list: async () => ({
      ok: true,
      available: true,
      waiting: sf.waiting,
      sources: sf.known.map((id: string) =>
        sf.connected.has(id)
          ? { id, label: id, connected: true, connectedAt: 1, level: 'read', ...(sf.ungranted?.has(id) && { needsGrant: true }) }
          : { id, label: id, connected: false },
      ),
    }),
    connect: (id: string) => rec('connect', () => sf.connect(id))(id),
    openPrivacy: (id: string) => rec('openPrivacy', () => sf.privacy(id))(id),
    recheck: async () => ({ ok: true, connected: false }),
    onChanged: (cb: () => void) => (sf.listeners.add(cb), () => void sf.listeners.delete(cb)),
  },
});
const { RoutinesList } = await import('../src/components/momo/RoutinesList.tsx');

const SOURCES = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'files', label: 'Files' },
];
const daily = {
  id: 'momo.a',
  name: 'Morning Feed',
  prompt: 'A short briefing.',
  schedule: 'Every day at 8',
  rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
  parts: { time: '08:00', days: [] as string[] },
  sources: ['files', 'calendar'],
  paused: false,
};
const monthly = {
  id: 'momo.b',
  name: 'Rent',
  prompt: 'Remind me of the rent.',
  schedule: 'Every month on the 1st at 9',
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9',
  parts: null,
  sources: [],
  paused: true,
};

const button = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLElement;
const typeArea = async (el: Element, value: string) => {
  const w = (globalThis as any).window;
  await act(async () => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await flush();
};

function rig(saves: boolean[] = []) {
  const edits: any[] = [];
  const removed: string[] = [];
  const el = createElement(RoutinesList, {
    routines: [daily, monthly] as any,
    sources: SOURCES,
    onEdit: async (id: string, e: any) => (edits.push([id, e]), saves.length ? saves.shift()! : true),
    onRemove: (id: string) => removed.push(id),
  });
  return { el, edits, removed };
}

test('none yet: the list draws nothing (the page says none are there)', async () => {
  const { host, unmount } = await render(
    createElement(RoutinesList, { routines: [], sources: SOURCES, onEdit: async () => true, onRemove() {} }),
  );
  assert.equal(host.textContent, '', 'the page, not the list, says there is none');
  await unmount();
});

test('each routine: its schedule or Paused, what it does and reads, Pause or Resume; Remove only once confirmed', async () => {
  const { el, edits, removed } = rig();
  const { host, unmount } = await render(el);
  const [a, b] = [...host.querySelectorAll('section[aria-label]')];
  const when = (c: Element) => c.querySelector('[data-status]')!.textContent;
  const chips = (c: Element) => [...c.querySelectorAll('.hp-badge')].map((x) => x.textContent);
  assert.equal(when(a), 'Every day at 8:00 AM', 'a 24-hour hour read on a 12-hour clock');
  assert.equal(when(b), 'Every month on the 1st at 9:00 AM', 'a rule with one time reads on a 12-hour clock whatever its days');
  // in the order Settings lists the sources; the fake main has Calendar connected and does not list Files
  assert.deepEqual(chips(a), ['Calendar', 'Files · not connected'], 'the sources it uses, each saying whether MoMo can read it');
  assert.deepEqual(chips(b), ['Paused']);
  assert.equal(b.getAttribute('data-paused'), 'true');
  assert.equal(a.querySelector('details p')!.textContent, 'A short briefing.', 'what MoMo will do, behind the disclosure');
  assert.equal(b.querySelector('details p')!.textContent, 'Remind me of the rent.');
  await click(button(a, 'Pause'));
  await click(button(b, 'Resume'));
  assert.deepEqual(edits, [
    ['momo.a', { paused: true }],
    ['momo.b', { paused: false }],
  ]);
  const answers = [false, true];
  const confirm = window.confirm;
  window.confirm = () => answers.shift()!;
  try {
    await click(button(a, 'Remove Morning Feed'));
    assert.deepEqual(removed, [], 'not confirmed: kept');
    await click(button(a, 'Remove Morning Feed'));
  } finally {
    window.confirm = confirm;
  }
  assert.deepEqual(removed, ['momo.a']);
  await unmount();
});

test('Edit: a time and days, what it does and what it reads, saved as one edit; Cancel and Edit again close it', async () => {
  const { el, edits } = rig();
  const { host, unmount } = await render(el);
  const a = host.querySelector('section[aria-label]')!;
  await click(button(a, 'Edit'));
  assert.equal(button(a, 'Edit').getAttribute('aria-expanded'), 'true');
  await click(button(a, 'Edit'));
  assert.equal(a.querySelector('form'), null, 'Edit again closes it');
  await click(button(a, 'Edit'));
  await click(button(a, 'Cancel'));
  assert.equal(a.querySelector('form'), null);
  assert.deepEqual(edits, [], 'Cancel saves nothing');
  await click(button(a, 'Edit'));
  const form = a.querySelector('form')!;
  const [name, time] = [...form.querySelectorAll('input:not([type=checkbox])')];
  assert.equal((time as HTMLInputElement).type, 'time');
  await type(name, 'Morning brief');
  await typeArea(form.querySelector('textarea')!, 'Today in a few lines.');
  await type(time, '07:30');
  await click(button(form, 'Fri'));
  await click(button(form, 'Mon'));
  await click(button(form, 'Fri'));
  await click(button(form, 'Wed'));
  assert.equal(button(form, 'Mon').getAttribute('aria-pressed'), 'true');
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  assert.deepEqual(
    boxes.map((x) => x.checked),
    [true, false, true],
  );
  await click(boxes[1]);
  await click(boxes[2]);
  await click(button(form, 'Save'));
  assert.deepEqual(edits, [
    [
      'momo.a',
      { name: 'Morning brief', prompt: 'Today in a few lines.', time: '07:30', days: ['MO', 'WE'], sources: ['calendar', 'reminders'] },
    ],
  ]);
  assert.equal(a.querySelector('form'), null, 'closed once saved');
  await unmount();
});

test('a rule that is no time and days is edited as its RRULE; a refused save keeps the form and what was typed', async () => {
  const { el, edits } = rig([false, true]);
  const { host, unmount } = await render(el);
  const b = host.querySelectorAll('section[aria-label]')[1];
  await click(button(b, 'Edit'));
  const form = b.querySelector('form')!;
  const inputs = [...form.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];
  assert.deepEqual(
    inputs.map((x) => x.value),
    ['Rent', 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9'],
  );
  assert.equal(form.querySelector('input[type=time]'), null);
  await type(inputs[1], 'FREQ=MONTHLY;BYMONTHDAY=2;BYHOUR=9');
  form.dispatchEvent(new (globalThis as any).window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.ok(b.querySelector('form'), 'refused: still open');
  assert.equal(b.querySelector<HTMLInputElement>('form input:not([type=checkbox])')!.value, 'Rent');
  assert.deepEqual(edits, [['momo.b', { rrule: 'FREQ=MONTHLY;BYMONTHDAY=2;BYHOUR=9' }]], 'only what changed');
  // nothing changed: Save closes it and sends nothing
  const a = host.querySelector('section[aria-label]')!;
  await click(button(a, 'Edit'));
  await click(button(a, 'Save'));
  assert.equal(a.querySelector('form'), null);
  assert.equal(edits.length, 1);
  await unmount();
});

test('a weekly routine: days or sources picked again in another order are no change; a day added is', async () => {
  const edits: any[] = [];
  const weekly = { ...daily, id: 'momo.w', name: 'Weekly', parts: { time: '09:00', days: ['MO', 'FR'] }, sources: ['files', 'calendar'] };
  const { host, unmount } = await render(
    createElement(RoutinesList, {
      routines: [weekly] as any,
      sources: SOURCES,
      onEdit: async (id: string, e: any) => (edits.push([id, e]), true),
      onRemove() {},
    }),
  );
  const li = host.querySelector('section[aria-label]')!;
  await click(button(li, 'Edit'));
  const form = li.querySelector('form')!;
  await click(button(form, 'Mon'));
  await click(button(form, 'Mon'));
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  await click(boxes[0]);
  await click(boxes[0]);
  await click(button(form, 'Save'));
  assert.deepEqual(edits, []);
  await click(button(li, 'Edit'));
  await click(button(li.querySelector('form')!, 'Wed'));
  await click(button(li.querySelector('form')!, 'Save'));
  assert.deepEqual(edits, [['momo.w', { time: '09:00', days: ['MO', 'WE', 'FR'] }]]);
  await unmount();
});

test('a save that ends after another routine’s form was opened leaves that form open', async () => {
  let done: (v: boolean) => void = () => {};
  const el = createElement(RoutinesList, {
    routines: [daily, monthly] as any,
    sources: SOURCES,
    onEdit: () => new Promise<boolean>((r) => (done = r)),
    onRemove() {},
  });
  const { host, unmount } = await render(el);
  const [a, b] = [...host.querySelectorAll('section[aria-label]')];
  await click(button(a, 'Edit'));
  await click(button(a.querySelector('form')!, 'Tue'));
  await click(button(a, 'Save'));
  await click(button(b, 'Edit'));
  await act(async () => done(true));
  await flush();
  assert.equal(a.querySelector('form'), null);
  assert.ok(b.querySelector('form'), 'the other form stays');
  await unmount();
});

const noteOf = (host: Element) => host.querySelector('p[data-tone], p:has(button)') as HTMLElement | null;
const notes = (host: Element) =>
  [...host.querySelectorAll('section[aria-label] > p')].filter((p) => p.querySelector('button')) as HTMLElement[];
const daily1 = (sources: string[]) => ({ ...daily, sources });
function mountList(sources: string[]) {
  return render(
    createElement(RoutinesList, { routines: [daily1(sources)] as any, sources: SOURCES, onEdit: async () => true, onRemove() {} }),
  );
}
function resetSources() {
  sf.calls = [];
  sf.connected = new Set(['calendar', 'reminders']);
  sf.waiting = [];
  sf.ungranted = new Set();
  sf.known = ['calendar', 'reminders'];
  sf.connect = async () => ({ ok: true, connected: true, grant: 'granted' });
  sf.privacy = async () => ({ ok: true });
}

test('a routine that reads Calendar or Reminders not connected says so with Connect; connected sources and Files say nothing', async () => {
  resetSources();
  sf.connected = new Set(['reminders']);
  const { host, unmount } = await mountList(['files', 'calendar', 'reminders']);
  await flush();
  const ns = notes(host);
  assert.equal(ns.length, 1, 'only Calendar is missing');
  assert.match(ns[0].textContent!, /Calendar isn’t connected\. This routine can’t read it yet\./);
  assert.equal(noteOf(host) !== null, true);
  await unmount();
  resetSources();
  const none = await mountList(['files', 'calendar']);
  await flush();
  assert.equal(notes(none.host).length, 0, 'connected: no line');
  await none.unmount();
  // a source main does not list (not read yet) leaves no line either
  sf.known = [];
  sf.connected = new Set();
  const unread = await mountList(['calendar']);
  await flush();
  assert.equal(notes(unread.host).length, 0);
  await unread.unmount();
});

test('Connect asks macOS and the line goes once the source is connected; a refusal sends the user to System Settings, which waits and can open again', async () => {
  resetSources();
  sf.connected = new Set(['reminders']);
  const { host, unmount } = await mountList(['calendar']);
  await flush();
  // connected: main changes and says so
  sf.connect = async () => {
    sf.connected.add('calendar');
    for (const cb of sf.listeners) cb();
    return { ok: true, connected: true, grant: 'granted' };
  };
  await click(button(notes(host)[0], 'Connect'));
  await flush();
  assert.deepEqual(
    sf.calls.filter((c: any[]) => c[0] === 'connect'),
    [['connect', 'calendar']],
  );
  assert.equal(notes(host).length, 0, 'connected: the line is gone');
  await unmount();

  resetSources();
  sf.connected = new Set(['reminders']);
  sf.connect = async () => ({ ok: true, connected: false, grant: 'denied' });
  const denied = await mountList(['calendar']);
  await flush();
  await click(button(notes(denied.host)[0], 'Connect'));
  await flush();
  assert.match(notes(denied.host)[0].textContent!, /Turn on MoPilot under Privacy & Security › Calendars\./);
  await click(button(notes(denied.host)[0], 'Open System Settings'));
  assert.deepEqual(
    sf.calls.filter((c: any[]) => c[0] === 'openPrivacy'),
    [['openPrivacy', 'calendar']],
  );
  await denied.unmount();

  // main is waiting for the switch: the line says so and the button opens the pane again
  resetSources();
  sf.connected = new Set(['reminders']);
  sf.waiting = ['calendar'];
  const waiting = await mountList(['calendar']);
  await flush();
  assert.match(notes(waiting.host)[0].textContent!, /Waiting for you to turn it on…/);
  await click(button(notes(waiting.host)[0], 'Open again'));
  assert.equal(sf.calls.filter((c: any[]) => c[0] === 'openPrivacy').length, 1);
  await waiting.unmount();
});

test('a connect that fails is told in red under the routine and Connect stays', async () => {
  resetSources();
  sf.connected = new Set(['reminders']);
  sf.connect = async () => ({ ok: false, error: 'Calendar can’t be read here' });
  const { host, unmount } = await mountList(['calendar']);
  await flush();
  await click(button(notes(host)[0], 'Connect'));
  await flush();
  const n = notes(host)[0];
  assert.equal(n.getAttribute('data-tone'), 'error');
  assert.match(n.textContent!, /Calendar can’t be read here/);
  assert.ok(button(n, 'Connect'));
  await unmount();
});

test('a source a routine reads that is connected but refused by macOS gets the line too, with Connect', async () => {
  resetSources();
  sf.connected = new Set(['calendar', 'reminders']);
  sf.ungranted = new Set(['calendar']);
  const { host, unmount } = await mountList(['calendar', 'reminders']);
  await flush();
  assert.equal(notes(host).length, 1, 'only the refused source has a line');
  assert.match(notes(host)[0].textContent!, /lost access to Calendar/);
  assert.ok(button(notes(host)[0], 'Connect'));
  await unmount();
});
