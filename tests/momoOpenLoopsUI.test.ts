// MoMo's open loops in the window (#2139 P4): the Memory tab's Open loops (src/components/momo/OpenLoops.tsx) with each loop's words, day said, due day, Unsure and Nudged chips and Done, Snooze, Dismiss, the closed ones with Reopen; and a nudge's card in MoMo's chat (NudgeCard.tsx) showing MoMo's line, its why on a click and the loop's buttons, a failure said in place; nothing while MoMo is not allowed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
const ok = (x: object = {}) => ({ ok: true, ...x });
mock.module('../src/store/send.ts', {
  namedExports: { sendMessage: async (...a: any[]) => (f.calls.push(['sendMessage', ...a]), f.sendAnswer(...a)) },
});
f.sendAnswer = async () => undefined;
f.native = {
  momoChat: { mainChat: async () => (f.calls.push(['mainChat']), f.mainAnswer()) },
  momoMemory: {
    loops: async () => (f.calls.push(['loops']), f.loopsAnswer()),
    loopAct: async (id: string, a: any) => (f.calls.push(['loopAct', id, a]), f.actAnswer(id, a)),
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
};
installNativeStub(f.native);
const { OpenLoops } = await import('../src/components/momo/OpenLoops.tsx');
const { NudgeCard } = await import('../src/components/momo/NudgeCard.tsx');
const { loopState, saidLine, loopPrompt } = await import('../src/components/momo/loopActions.tsx');

const SAID = new Date(2030, 2, 4, 10).getTime();
const loop = (id: string, over: any = {}) => ({
  id,
  kind: 'todo',
  text: `Loop ${id}`,
  quote: `words of ${id}`,
  source: { chatId: 'm', harness: 'claude', turnId: 't' },
  saidAt: SAID,
  tz: 'UTC',
  confidence: 'sure',
  lastMentionedAt: SAID,
  state: 'open',
  nudged: [],
  ...over,
});
function reset() {
  f.calls = [];
  f.sendAnswer = async () => undefined;
  f.mainAnswer = async () => ({ chatId: 'MAIN', warning: null });
  f.open = [
    loop('L1', {
      dueAt: new Date(2030, 2, 6, 23, 59).getTime(),
      dueDay: '2030-03-06',
      nudged: [
        { at: 1, trigger: 'due', key: 'k' },
        { at: 2, trigger: 'declined', key: 'j' },
      ],
    }),
    loop('L2', { confidence: 'likely', dueAt: new Date(2030, 2, 9, 15).getTime(), snoozedUntil: new Date(2030, 2, 25).getTime() }),
  ];
  f.closed = [loop('L3', { state: 'done', closedAt: 5 })];
  f.loopsAnswer = async () => ok({ open: f.open, closed: f.closed, now: SAID });
  f.actAnswer = async (id: string, a: any) =>
    ok({
      loop: {
        ...loop(id),
        state: a.action === 'done' ? 'done' : a.action === 'dismiss' ? 'dismissed' : 'open',
        ...(a.action === 'snooze' ? { snoozedUntil: Date.now() + 86_400_000 } : {}),
      },
    });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function mount(el: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(el));
  await flush();
  const q = (sel: string, at: any = host) => at.querySelector(sel);
  const all = (sel: string, at: any = host) => [...at.querySelectorAll(sel)];
  const button = (label: string, at: any = host) => all('button', at).find((b: any) => b.textContent === label);
  const click = async (b: any) => {
    await act(async () => b.click());
    await flush();
  };
  return { host, q, all, button, click, close: () => act(async () => root.unmount()) };
}

test('Open loops lists each loop with its words, day said, due day and chips; closed ones under Closed with Reopen', async () => {
  reset();
  const v = await mount(createElement(OpenLoops));
  const row = (id: string) => v.q(`[data-loop="${id}"]`);
  assert.ok(row('L1').textContent.includes('Loop L1'));
  assert.equal(v.q('.momo-loop-quote', row('L1')).textContent, '“words of L1” · said 2030-03-04');
  assert.deepEqual(
    v.all('.momo-chip', row('L1')).map((c: any) => c.textContent),
    ['Due 2030-03-06', 'Nudged 1×'],
    'a declined nudge isn’t counted',
  );
  assert.deepEqual(
    v.all('.momo-chip', row('L2')).map((c: any) => c.textContent),
    ['Due 2030-03-09', 'Unsure: no nudges', 'Snoozed to 2030-03-25'],
  );
  assert.deepEqual(
    v.all('button', row('L1')).map((b: any) => b.textContent),
    ['Done', 'Snooze', 'Dismiss', 'Add to Calendar', 'Remind me'],
  );
  assert.equal(v.q('.momo-loops-closed summary').textContent, 'Closed (1)');
  assert.deepEqual(
    v.all('button', row('L3')).map((b: any) => b.textContent),
    ['Reopen'],
  );
  assert.deepEqual(
    v.all('.momo-chip', row('L3')).map((c: any) => c.textContent),
    ['Done'],
  );
  await v.click(v.button('Snooze', row('L1')));
  await v.click(v.button('Dismiss', row('L2')));
  await v.click(v.button('Reopen', row('L3')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'loopAct'),
    [
      ['loopAct', 'L1', { action: 'snooze', snooze: 'day' }],
      ['loopAct', 'L2', { action: 'dismiss' }],
      ['loopAct', 'L3', { action: 'reopen' }],
    ],
  );
  // main says the memory changed: read again
  f.open = [];
  f.closed = [];
  await act(async () => {
    for (const cb of f.listeners) cb();
  });
  await flush();
  assert.equal(v.q('.settings-row-title')?.textContent, 'Nothing open');
  assert.equal(v.q('.momo-loops-closed'), null);
  await v.close();
});

test('a failed read says why with Retry; a refused action says why in place; nothing while MoMo is not allowed', async () => {
  reset();
  f.loopsAnswer = async () => ({ ok: false, error: 'busy' });
  const v = await mount(createElement(OpenLoops));
  assert.match(v.q('[role="alert"]').textContent, /Couldn't read the open loops: busy/);
  f.loopsAnswer = async () => ok({ open: f.open, closed: [], now: SAID });
  await v.click(v.button('Retry'));
  f.actAnswer = async () => ({ ok: false, error: 'No such open loop' });
  await v.click(v.button('Done', v.q('[data-loop="L1"]')));
  assert.equal(v.q('[data-loop="L1"] [role="alert"]').textContent, 'No such open loop');
  f.actAnswer = async () => {
    throw new Error('bridge gone');
  };
  await v.click(v.button('Done', v.q('[data-loop="L1"]')));
  assert.match(v.q('[data-loop="L1"] [role="alert"]').textContent, /bridge gone/);
  await v.close();
  f.loopsAnswer = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  const off = await mount(createElement(OpenLoops));
  assert.equal(off.host.textContent, '');
  await off.close();
});

const NUDGE = {
  loopId: 'L1',
  title: 'Renew the lease',
  quote: 'renew the lease by Friday',
  saidAt: SAID,
  trigger: 'due',
  why: 'due Fri 2030-03-08 23:59',
};

test('a nudge’s card shows MoMo’s line, its why on a click, and the loop’s buttons; what was done shows in their place', async () => {
  reset();
  const v = await mount(createElement(NudgeCard, { text: 'The lease is due Friday.', nudge: NUDGE }));
  assert.ok(v.q('.momo-nudge').textContent.startsWith('The lease is due Friday.'));
  assert.equal(v.q('.momo-nudge-why'), null);
  await v.click(v.button('Why'));
  assert.deepEqual(
    v.all('.momo-nudge-why > span').map((s: any) => s.textContent),
    ['Renew the lease', '“renew the lease by Friday” · said 2030-03-04', 'due Fri 2030-03-08 23:59'],
  );
  await v.click(v.button('Done'));
  assert.deepEqual(f.calls.at(-1), ['loopAct', 'L1', { action: 'done' }]);
  assert.equal(v.q('.momo-nudge-actions').textContent, 'Done');
  assert.equal(v.button('Snooze'), undefined);
  await v.close();
  const s = await mount(createElement(NudgeCard, { text: 'x', nudge: NUDGE }));
  await s.click(s.button('Snooze'));
  assert.match(s.q('.momo-nudge-actions').textContent, /^Snoozed to \d{4}-\d{2}-\d{2}$/);
  await s.close();
  f.actAnswer = async (id: string) => ok({ loop: loop(id) });
  const r = await mount(createElement(NudgeCard, { text: 'x', nudge: NUDGE }));
  await r.click(r.button('Dismiss'));
  assert.equal(r.q('.momo-nudge-actions').textContent, 'Reopened', 'main answered with the loop open');
  await r.close();
});

test('the shared copy: a loop’s words and day said, and its state', () => {
  assert.equal(saidLine('call mum', SAID), '“call mum” · said 2030-03-04');
  assert.equal(loopState({ state: 'done' }, 0), 'Done');
  assert.equal(loopState({ state: 'dismissed' }, 0), 'Dismissed');
  assert.equal(loopState({ state: 'open' }, 0), null);
  assert.equal(loopState({ state: 'open', snoozedUntil: 5 }, 10), null, 'a snooze that ended');
});

test('Add to Calendar and Remind me send an ordinary user message to MoMo’s main chat, with the due time; nothing else is written', async () => {
  reset();
  f.open = [
    loop('L1', { text: 'Renew the lease', dueAt: new Date(2030, 2, 6, 23, 59).getTime(), dueDay: '2030-03-06' }),
    loop('L2', { text: 'Call Sam', dueAt: new Date(2030, 2, 9, 15, 5).getTime() }),
    loop('L4', { text: 'Water plants' }),
    loop('L5', { text: '   ' }),
  ];
  const v = await mount(createElement(OpenLoops));
  const row = (id: string) => v.q(`[data-loop="${id}"]`);
  await v.click(v.button('Add to Calendar', row('L1')));
  await v.click(v.button('Remind me', row('L2')));
  await v.click(v.button('Add to Calendar', row('L4')));
  await v.click(v.button('Remind me', row('L4')));
  const sent = f.calls.filter((c: any) => c[0] === 'sendMessage');
  assert.deepEqual(
    sent.map((c: any) => [c[1], c[2], c[3], c[4]]),
    [
      ['MAIN', 'Add “Renew the lease” to my Calendar, due 2030-03-06', [], { human: true }],
      ['MAIN', 'Remind me about “Call Sam”, due 2030-03-09 15:05', [], { human: true }],
      ['MAIN', 'Add “Water plants” to my Calendar', [], { human: true }],
      ['MAIN', 'Remind me about “Water plants”', [], { human: true }],
    ],
  );
  assert.equal(
    f.calls.some((c: any) => c[0] === 'loopAct'),
    false,
    'the click itself writes nothing',
  );
  assert.equal(v.button('Remind me', row('L5')), undefined, 'no usable title: no buttons');
  await v.close();
});

test('a refused or failed send is said in place; closed loops and nudge cards follow the same rules', async () => {
  reset();
  const v = await mount(createElement(OpenLoops));
  const row = v.q('[data-loop="L1"]');
  f.sendAnswer = async () => false;
  await v.click(v.button('Remind me', row));
  assert.equal(v.q('[role="alert"]', row).textContent, "Couldn't send to MoMo. Try again.");
  f.sendAnswer = async () => true;
  await v.click(v.button('Remind me', row));
  assert.equal(v.q('[role="alert"]', row), null);
  f.mainAnswer = async () => {
    throw new Error('MoMo is off');
  };
  await v.click(v.button('Add to Calendar', row));
  assert.match(v.q('[role="alert"]', row).textContent, /MoMo is off/);
  assert.equal(v.button('Add to Calendar', v.q('[data-loop="L3"]')), undefined, 'a closed loop only reopens');
  await v.close();
  reset();
  const n = await mount(createElement(NudgeCard, { text: 'x', nudge: NUDGE }));
  await n.click(n.button('Add to Calendar'));
  assert.deepEqual(f.calls.at(-1).slice(1, 3), ['MAIN', 'Add “Renew the lease” to my Calendar']);
  await n.close();
});

test('the request names the loop as the user said it, with the due day the loop shows or the local day, and the time unless the day ends at 23:59', () => {
  const at = new Date(2026, 10, 12, 15, 5).getTime();
  const endOfDay = new Date(2026, 10, 12, 23, 59).getTime();
  assert.equal(loopPrompt('calendar', 'Call the landlord'), 'Add “Call the landlord” to my Calendar');
  assert.equal(loopPrompt('reminder', 'Call the landlord'), 'Remind me about “Call the landlord”');
  assert.equal(loopPrompt('calendar', 'Call', at, '2026-11-13'), 'Add “Call” to my Calendar, due 2026-11-13 15:05');
  assert.equal(loopPrompt('reminder', 'Call', at), 'Remind me about “Call”, due 2026-11-12 15:05');
  assert.equal(loopPrompt('reminder', 'Call', endOfDay), 'Remind me about “Call”, due 2026-11-12');
});
