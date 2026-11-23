// The card a MoMo chat shows when a tool needs Calendar or Reminders connected (src/components/momo/MomoConnectCard.tsx, #2999), the real component over a fake window.native.momoSources: the question and one line, Connect and Not now, the same phases as setup's rows (macOS's prompt, System Settings when it won't ask, waiting, failure), Not now answering deny, and only a person's click counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { render, flush } from './support/shell-chrome-kit.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const f: any = { calls: [] as any[], listeners: new Set<() => void>(), answers: [] as any[] };
mockSource('src/components/thread/approvals/shared.tsx', {
  answerSageCard: (id: string, r: unknown) => f.answers.push([id, r]),
  humanClick: (fn: () => void) => (e: { nativeEvent: Event }) => {
    if (e.nativeEvent.isTrusted) fn();
  },
});
const ok = (x: object = {}) => ({ ok: true, ...x });
installNativeStub({
  momoSources: {
    list: () => f.list(),
    connect: async (id: string) => (f.calls.push(['connect', id]), f.connectAnswer()),
    openPrivacy: async (id: string) => (f.calls.push(['openPrivacy', id]), f.openPrivacy(id)),
    recheck: async () => (f.calls.push(['recheck', 'calendar']), f.recheck()),
    onChanged: (cb: () => void) => (f.listeners.add(cb), () => void f.listeners.delete(cb)),
  },
});
const { MomoConnectCard } = await import('../src/components/momo/MomoConnectCard.tsx');
const { needsLine, stalledLine, lostLine, WAITING_LINE, ALLOW_LINE, ASK_LINE_DELAY_MS } = await import(
  '../src/components/momo/sourceConnect.ts'
);

function reset() {
  f.calls = [];
  f.answers = [];
  f.waiting = [];
  f.sources = [
    { id: 'calendar', label: 'Calendar', connected: false },
    { id: 'reminders', label: 'Reminders', connected: false },
  ];
  f.connectAnswer = async () => ok({ connected: true, grant: 'granted' });
  f.openPrivacy = async () => ok();
  f.recheck = async () => ok({ connected: false });
  f.list = async () => ok({ available: true, waiting: f.waiting, sources: f.sources });
}
const trusted = (e: Event, value: boolean) => (Object.defineProperty(e, 'isTrusted', { value }), e);
const button = (host: Element, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLElement;
async function press(el: HTMLElement, isTrusted = true) {
  await act(async () => {
    el.dispatchEvent(trusted(new (globalThis as any).window.MouseEvent('click', { bubbles: true, cancelable: true }), isTrusted));
  });
  await flush();
}
async function mount(source: 'calendar' | 'reminders' = 'calendar') {
  const r = await render(createElement(MomoConnectCard, { id: 'sage-momoConnect-1', source }));
  await flush();
  return r;
}
const line = (host: Element) => host.querySelector('p')!.textContent!.trim();

test('the question and one line, Connect and Not now; Reminders asks about Reminders', async () => {
  reset();
  const cal = await mount();
  const card = cal.host.querySelector('[data-kind="momoConnect"]')!;
  assert.equal(card.getAttribute('aria-label'), 'Connect Calendar?');
  assert.equal(line(cal.host), 'MoMo needs it to answer this. It only reads.');
  assert.deepEqual(
    [...cal.host.querySelectorAll('button')].map((b) => b.textContent),
    ['Connect', 'Not now'],
  );
  await cal.unmount();
  const rem = await mount('reminders');
  assert.equal(rem.host.querySelector('h3')!.textContent, 'Connect Reminders?');
  await rem.unmount();
});

test('Connect asks macOS for this source and reads the source again; Not now answers deny', async () => {
  reset();
  const { host, unmount } = await mount('reminders');
  await press(button(host, 'Connect'));
  assert.deepEqual(f.calls, [['connect', 'reminders']]);
  await press(button(host, 'Not now'));
  assert.deepEqual(f.answers, [['sage-momoConnect-1', { decision: 'deny' }]]);
  await unmount();
  assert.equal(f.listeners.size, 0, 'closing stops listening');
});

test('only a person’s click counts', async () => {
  reset();
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'), false);
  await press(button(host, 'Not now'), false);
  assert.deepEqual([f.calls, f.answers], [[], []]);
  await unmount();
});

test('a refusal macOS repeats is a next step: the pane, then waiting, and Open again', async () => {
  reset();
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'));
  assert.equal(line(host), needsLine('calendar'));
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'needs');
  await press(button(host, 'Open System Settings'));
  assert.deepEqual(f.calls.at(-1), ['openPrivacy', 'calendar']);
  await unmount();

  // main is waiting for the switch
  reset();
  f.waiting = ['calendar'];
  const waiting = await mount();
  assert.equal(line(waiting.host), WAITING_LINE);
  await press(button(waiting.host, 'Open again'));
  assert.deepEqual(f.calls.at(-1), ['openPrivacy', 'calendar']);
  await waiting.unmount();
});

test('a failed connect is told in red and Connect stays; the button can’t be pressed twice while it runs', async () => {
  reset();
  let release: (v: unknown) => void = () => {};
  f.connectAnswer = () => new Promise((resolve) => (release = resolve));
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'));
  assert.equal((button(host, 'Connect') as HTMLButtonElement).disabled, true);
  await act(async () => release({ ok: false, error: 'Calendar can’t be read here' }));
  await flush();
  const alert = host.querySelector('[role=alert]')!;
  assert.equal(alert.textContent!.trim(), 'Calendar can’t be read here');
  assert.equal((button(host, 'Connect') as HTMLButtonElement).disabled, false);
  await unmount();
});

const focus = () => act(async () => window.dispatchEvent(new window.Event('focus')));
const recheckCalls = () => f.calls.filter((c: any) => c[0] === 'recheck');

test('while macOS asks the line says where to allow, not at once; once connected the card says so and the source is read again', async () => {
  reset();
  let release: (v: unknown) => void = () => {};
  f.connectAnswer = () => new Promise((resolve) => (release = resolve));
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'));
  assert.notEqual(line(host), ALLOW_LINE, 'not before macOS had time to answer');
  await act(async () => new Promise((r) => setTimeout(r, ASK_LINE_DELAY_MS + 100)));
  assert.equal(line(host), ALLOW_LINE);
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'asking');
  f.sources[0] = { id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read' };
  await act(async () => release({ ok: true, connected: true, grant: 'granted' }));
  await flush();
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'connected');
  assert.equal(line(host), 'MoMo needs it to answer this. It only reads.');
  await unmount();
});

test('back in the app after System Settings: a card waiting for the switch reads the grant at once; others are left alone', async () => {
  reset();
  const { host, unmount } = await mount();
  await focus();
  assert.deepEqual(recheckCalls(), [], 'nothing is pending: no read');
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied', asked: true });
  await press(button(host, 'Connect'));
  f.calls = [];
  await focus();
  await flush();
  assert.deepEqual(recheckCalls(), [['recheck', 'calendar']]);
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'needs', 'not on yet: the card stays');
  // a read that fails is not shown, and the next return asks again
  f.recheck = async () => {
    throw new Error('helper gone');
  };
  await focus();
  await flush();
  f.recheck = async () => {
    f.sources[0] = { id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read' };
    return ok({ connected: true });
  };
  f.calls = [];
  // two returns while a read runs: one read
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
    window.dispatchEvent(new window.Event('focus'));
  });
  await flush();
  assert.deepEqual(recheckCalls(), [['recheck', 'calendar']]);
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'connected', 'the source was read again');
  await unmount();
});

test('other ways a connect ends are one short line and Connect stays; a pane that did not open says why', async () => {
  reset();
  const { host, unmount } = await mount();
  f.connectAnswer = async () => ok({ connected: false, grant: 'restricted' });
  await press(button(host, 'Connect'));
  assert.equal(line(host), 'A setting on this Mac blocks Calendar.');
  f.connectAnswer = async () => {
    throw new Error('helper gone');
  };
  await press(button(host, 'Connect'));
  assert.equal(line(host), 'helper gone');
  f.connectAnswer = async () => ok({ connected: false, grant: 'granted' });
  await press(button(host, 'Connect'));
  assert.equal(line(host), 'Connecting was cancelled.');
  // macOS did not ask: nothing is decided, so the pane has no entry for MoPilot and is no way out (#2999): one line, Connect stays
  f.connectAnswer = async () => ok({ connected: false, grant: 'notDetermined', asked: true, noPrompt: true, reset: true });
  await press(button(host, 'Connect'));
  assert.equal(
    line(host),
    "macOS didn't show its Calendar prompt. Restart MoPilot and Connect again; if it still doesn't appear, update MoPilot.",
  );
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'idle');
  assert.equal(button(host, 'Open System Settings'), undefined);
  // a refusal the pane can switch is the way
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  await press(button(host, 'Connect'));
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'needs');
  // the pane did not open: said, in red; and a bridge that throws too
  f.openPrivacy = async () => ({ ok: false, error: 'No macOS setting for this' });
  await press(button(host, 'Open System Settings'));
  assert.equal(line(host), 'No macOS setting for this');
  f.openPrivacy = async () => {
    throw new Error('bridge gone');
  };
  await press(button(host, 'Open System Settings'));
  assert.equal(line(host), 'bridge gone');
  await unmount();
});

const changed = () => act(async () => void f.listeners.forEach((cb: () => void) => cb()));

test('a wait that ended without the switch says it is still off; Open System Settings starts it again', async () => {
  reset();
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied', asked: true });
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'));
  await press(button(host, 'Open System Settings'));
  // main waits for the switch, then gives up
  f.waiting = ['calendar'];
  await changed();
  await flush();
  assert.equal(line(host), WAITING_LINE);
  f.waiting = [];
  await changed();
  await flush();
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'stalled');
  assert.equal(line(host), stalledLine('calendar'));
  await unmount();
});

test('the source is read from main: a read that fails, one without this source and one that is stale change nothing', async () => {
  reset();
  // main says no: the card still offers Connect
  f.list = async () => ({ ok: false, error: 'MoMo is not available' });
  const { host, unmount } = await mount();
  assert.ok(button(host, 'Connect'));
  // a read that throws is noted, not shown
  f.list = async () => {
    throw new Error('bridge gone');
  };
  await changed();
  await flush();
  assert.ok(button(host, 'Connect'));
  // a list without this source and without waiting
  f.list = async () => ok({ available: true, sources: [] });
  await changed();
  await flush();
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'idle');
  // two reads in flight: the newer answer wins even when the older one settles last
  const slow: ((v: unknown) => void)[] = [];
  f.list = () => new Promise((resolve) => slow.push(resolve));
  await changed();
  await changed();
  const connected = ok({
    available: true,
    waiting: [],
    sources: [{ id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read' }],
  });
  await act(async () => slow[1](connected));
  await act(async () => slow[0](ok({ available: true, waiting: [], sources: [{ id: 'calendar', label: 'Calendar', connected: false }] })));
  await flush();
  assert.equal(host.querySelector('[data-kind]')!.getAttribute('data-phase'), 'connected');
  await unmount();
});

test('a source connected in MoMo that macOS refuses says it lost access and offers Connect; a refusal after it is the pane; granting clears the card', async () => {
  reset();
  const refused = { id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read', needsGrant: true };
  f.sources[0] = refused;
  const { host, unmount } = await mount();
  const phase = () => host.querySelector('[data-kind]')!.getAttribute('data-phase');
  assert.equal(phase(), 'lost');
  assert.equal(line(host), lostLine('calendar'));
  assert.deepEqual(
    [...host.querySelectorAll('button')].map((b) => b.textContent),
    ['Connect', 'Not now'],
  );
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  await press(button(host, 'Connect'));
  assert.equal(phase(), 'needs');
  assert.equal(line(host), needsLine('calendar'));
  // the switch went on: main says the list changed and the source no longer needs the grant
  f.sources[0] = { ...refused, needsGrant: undefined };
  await changed();
  await flush();
  assert.equal(phase(), 'connected');
  await unmount();
});

test('a lost-access card whose Connect fails says why in red and keeps Connect', async () => {
  reset();
  f.sources[0] = { id: 'calendar', label: 'Calendar', connected: true, connectedAt: 1, level: 'read', needsGrant: true };
  f.connectAnswer = async () => ({ ok: false, error: 'The helper is not running' });
  const { host, unmount } = await mount();
  await press(button(host, 'Connect'));
  assert.equal(line(host), 'The helper is not running');
  assert.equal(host.querySelector('p')!.getAttribute('data-tone'), 'error');
  assert.ok(button(host, 'Connect'));
  await unmount();
});
