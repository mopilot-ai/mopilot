// "Allow Chrome to connect?" as a notification (electron/app/chromeAskNotice.cjs): through the app's one notifier as an approval of its own group, retracted when answered, and a click opens Browser settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chromeRelayNotices, CHROME_NOTICE, TITLE, BODY, TRY_PROMPT }: any = await import('../electron/app/chromeAskNotice.cjs');
const { notificationTarget }: any = await import('../electron/app/computerAccess.cjs');
const { Notifier }: any = await import('../electron/platform/notify.cjs');

test('the question is an approval of its own group; answering retracts it; the state change is passed on', () => {
  const calls: any[] = [];
  const notifier = { notify: (...a: any[]) => calls.push(['notify', ...a]), retract: (id: string) => calls.push(['retract', id]) };
  const n = chromeRelayNotices({ changed: () => calls.push(['changed']), notifier: () => notifier });
  n.onStatus();
  n.onAsk(true);
  n.onAsk(false);
  assert.deepEqual(calls, [
    ['changed'],
    ['notify', 'approval', CHROME_NOTICE, { title: TITLE, body: BODY, group: 'chrome' }],
    ['retract', CHROME_NOTICE],
  ]);
  // before the notifier is registered: nothing to notify, nothing thrown
  const early = chromeRelayNotices({ changed: () => undefined, notifier: () => null });
  early.onAsk(true);
  early.onAsk(false);
});

test('the window comes forward with the question, never with its withdrawal, and with no notifier registered yet too', () => {
  const calls: string[] = [];
  const appWindows = { commandMainWindow: async () => undefined, showMainWindow: () => calls.push('show') };
  const notifier = { notify: () => calls.push('notify'), retract: () => calls.push('retract') };
  const n = chromeRelayNotices({ changed: () => undefined, notifier: () => notifier, appWindows });
  // Chrome is in front when the extension asks, and its page says "click Allow in MoPilot": the dialog must be seen
  n.onAsk(true);
  n.onAsk(false);
  assert.deepEqual(calls, ['notify', 'show', 'retract']);
  // before the notifier is registered (a notification is optional, the dialog is not)
  calls.length = 0;
  chromeRelayNotices({ changed: () => undefined, notifier: () => null, appWindows }).onAsk(true);
  assert.deepEqual(calls, ['show']);
  // raised again (stale then re-asked, an untaken Allow, Chrome started again): not again within the cooldown, again after it
  let t = 1_000_000;
  const again: string[] = [];
  const windows = { commandMainWindow: async () => undefined, showMainWindow: () => again.push('show') };
  const timed = chromeRelayNotices({ changed: () => undefined, notifier: () => notifier, appWindows: windows, now: () => t });
  timed.onAsk(true);
  timed.onAsk(false);
  t += 60_000;
  timed.onAsk(true);
  t += 9 * 60_000 - 1;
  timed.onAsk(true);
  assert.deepEqual(again, ['show'], 'once within the ten minutes');
  t += 1;
  timed.onAsk(true);
  assert.deepEqual(again, ['show', 'show']);
  // a raise with no window wiring does not use up the cooldown
  const early = chromeRelayNotices({ changed: () => undefined, notifier: () => notifier, now: () => t });
  early.onAsk(true);
  assert.equal(again.length, 2);
  // no window wiring (the early start): nothing to show, nothing thrown
  assert.doesNotThrow(() => chromeRelayNotices({ changed: () => undefined, notifier: () => notifier }).onAsk(true));
});

test('the real notifier shows it under the Notifications setting, closes it when retracted, and a click opens Browser settings', () => {
  const shown: any[] = [];
  const closed: string[] = [];
  for (const [mode, expected] of [
    ['never', 0],
    ['needed', 1],
  ] as const) {
    shown.length = 0;
    const notifier = new Notifier({
      getMode: () => mode,
      show: (m: any) => (shown.push(m), { close: () => closed.push(m.id) }),
    });
    const n = chromeRelayNotices({ changed: () => undefined, notifier: () => notifier });
    n.onAsk(true);
    assert.equal(shown.length, expected, mode);
    n.onAsk(false);
  }
  assert.equal(shown[0].title, TITLE);
  assert.equal(closed.length, 1, 'answered: the notification goes');
  assert.deepEqual(notificationTarget(null, CHROME_NOTICE), ['settings', 'browser']);
  assert.deepEqual(notificationTarget(null, 'chat-1'), ['open-chat', 'chat-1']);
  assert.deepEqual(notificationTarget({ get: () => ({}) }, 'owner'), ['settings', 'computer-access']);
});

test('Try it opens a new chat with main’s sample task drafted; anything else, or no window, opens nothing', async () => {
  const commands: unknown[][] = [];
  let fail = false;
  const appWindows = {
    showMainWindow: () => commands.push(['show']),
    commandMainWindow: async (...a: unknown[]) => {
      commands.push(a);
      if (fail) throw new Error('no window');
    },
  };
  const n = chromeRelayNotices({ changed: () => undefined, notifier: () => null, appWindows });
  assert.equal(n.onOpen('try'), true);
  assert.deepEqual(commands, [['new-chat-draft', TRY_PROMPT]]);
  for (const what of ['settings', undefined, { url: 'https://evil.example' }]) assert.equal(n.onOpen(what), false);
  assert.equal(commands.length, 1, 'the page names what to open, never the text');
  // "Open MoPilot" from Chrome: the window comes forward
  assert.equal(n.onOpen('app'), true);
  assert.deepEqual(commands.at(-1), ['show']);
  commands.pop();
  fail = true;
  assert.equal(n.onOpen('try'), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(chromeRelayNotices({ changed: () => undefined, notifier: () => null }).onOpen('try'), false);
});

test('Review on a page "Waiting for your OK" opens its chat; a failed open is noted; no window opens nothing', async () => {
  const commands: unknown[][] = [];
  let fail = false;
  const appWindows = {
    showMainWindow: () => undefined,
    commandMainWindow: async (...a: unknown[]) => {
      commands.push(a);
      if (fail) throw new Error('no window');
    },
  };
  const n = chromeRelayNotices({ changed: () => undefined, notifier: () => null, appWindows });
  n.openChat('c1');
  assert.deepEqual(commands, [['open-chat', 'c1']]);
  fail = true;
  n.openChat('c2');
  await new Promise((r) => setImmediate(r));
  const { recentIgnored }: any = await import('../electron/ignored.cjs');
  assert.ok(recentIgnored().some((e: any) => /open a chat from Chrome/.test(JSON.stringify(e))));
  chromeRelayNotices({ changed: () => undefined, notifier: () => null }).openChat('c3');
});
