// Setup's second screen (src/components/momo/setup/NotificationsStep.tsx, #2607), the real component over a fake window.native: one card with Notifications, optional; Turn on saves MoMo's switch and shows one notice (which is how macOS asks), a refused save or a failed notice leaves the button; Continue and Not now both go on, and neither can be pressed twice while the work runs. Calendar and Reminders are not on this screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], saveAnswer: true, noticesAnswer: async () => true };
installNativeStub({
  // a new account has no earlier Morning briefing routine (tests/momoEarlierBriefing.test.ts has one)
  momoRoutines: { view: async () => ({ proposals: [], routines: [], sources: [] }), onChanged: () => () => {}, edit: async () => ({}) },
  momoChat: {
    enableNotices: async () => (f.calls.push(['enableNotices']), f.noticesAnswer()),
  },
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({ persona: { name: 'MoMo', color: 'clay' } }),
  saveMomoPref: async (k: string, v: unknown) => (f.calls.push(['pref', k, v]), f.saveAnswer),
});
const { NotificationsStep } = await import('../src/components/momo/setup/NotificationsStep.tsx');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

async function mount(busy = false) {
  const done: number[] = [];
  const host: any = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(NotificationsStep, { busy, onDone: (...args: any[]) => done.push(args.length) } as any)));
  await flush();
  const button = (label: string) => [...host.querySelectorAll('button')].find((b: any) => b.textContent.trim() === label) as any;
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  return { host, done, button, click, close: () => act(async () => root.unmount()) };
}

test('one card with Notifications and the Morning brief and their lines; Calendar and Reminders are not here', async () => {
  f.calls = [];
  const v = await mount();
  assert.equal(v.host.querySelector('h1').textContent, 'Stay in the loop');
  assert.equal(v.host.querySelector('section').getAttribute('aria-labelledby'), 'momo-notify-title');
  assert.equal(v.host.querySelectorAll('.momo-connect-card').length, 1);
  assert.deepEqual(
    [...v.host.querySelectorAll('.momo-connect-title')].map((t: any) => t.textContent),
    ['Notifications', 'Morning brief'],
  );
  assert.equal(v.host.querySelector('.momo-connect-desc').textContent, 'Hear from MoMo when it needs you.');
  assert.deepEqual(
    [...v.host.querySelectorAll('button')].map((b: any) => b.textContent),
    ['Turn on', 'Turn on', 'Continue', 'Not now'],
  );
  assert.match(v.host.textContent, /MoMo asks before it reads your Calendar or Reminders\./);
  assert.deepEqual(f.calls, [], 'looking asks nothing of macOS');
  await v.close();
});

test('Turn on saves MoMo’s switch and shows one notice, then says On; a refused save or a failed notice leaves the button', async () => {
  f.calls = [];
  const v = await mount();
  f.saveAnswer = false;
  await v.click(v.button('Turn on'));
  assert.deepEqual(f.calls, [['pref', 'notify.needsAnswer', true]]);
  assert.ok(v.button('Turn on'), 'the save was refused (and told to the user): still off');
  f.saveAnswer = true;
  f.noticesAnswer = async () => {
    throw new Error('MoMo is not available for this account.');
  };
  await v.click(v.button('Turn on'));
  assert.equal(v.host.querySelector('.momo-connect-desc').textContent, 'MoMo is not available for this account.');
  assert.equal(v.host.querySelector('.momo-connect-desc').getAttribute('data-tone'), 'error');
  assert.ok(v.button('Turn on'));
  f.noticesAnswer = async () => true;
  f.calls = [];
  await v.click(v.button('Turn on'));
  assert.deepEqual(
    f.calls.map((c: any) => c[0]),
    ['pref', 'enableNotices'],
  );
  assert.match(v.host.querySelector('.momo-connect-row').textContent, /On/);
  assert.equal([...v.host.querySelectorAll('button')].filter((b: any) => b.textContent === 'Turn on').length, 1, 'the brief still waits');
  await v.close();
});

test('the Morning brief row: off until Turn on, which saves only brief; a refused save leaves the button; Continue leaves it off', async () => {
  f.calls = [];
  f.saveAnswer = true;
  const v = await mount();
  const row = () => [...v.host.querySelectorAll('.momo-connect-row')].find((r: any) => /Morning brief/.test(r.textContent)) as any;
  assert.equal(row().querySelector('.momo-connect-desc').textContent, 'A short note when quiet hours end.');
  assert.deepEqual(f.calls, [], 'looking saves nothing');
  f.saveAnswer = false;
  await v.click(row().querySelector('button'));
  assert.deepEqual(f.calls, [['pref', 'brief', true]]);
  assert.ok(row().querySelector('button'), 'the save was refused (and told to the user): still off');
  f.saveAnswer = true;
  await v.click(row().querySelector('button'));
  assert.match(row().textContent, /On/);
  assert.equal(row().querySelector('button'), null);
  assert.deepEqual(f.calls.at(-1), ['pref', 'brief', true]);
  assert.equal(
    f.calls.some((c: any) => c[0] === 'enableNotices'),
    false,
    'the brief asks nothing of macOS',
  );
  await v.close();
  f.calls = [];
  const skipped = await mount();
  await skipped.click(skipped.button('Continue'));
  assert.deepEqual(f.calls, [], 'Continue turns nothing on');
  await skipped.close();
});

test('Continue and Not now both go on, with no payload, turned on or not; while the work runs neither can be pressed', async () => {
  const a = await mount();
  await a.click(a.button('Not now'));
  assert.deepEqual(a.done, [0], 'called once, with nothing');
  await a.close();
  const b = await mount();
  await b.click(b.button('Continue'));
  assert.deepEqual(b.done, [0]);
  await b.close();
  const busy = await mount(true);
  assert.equal(busy.button('Continue').disabled, true);
  assert.equal(busy.button('Not now').disabled, true);
  await busy.close();
});
