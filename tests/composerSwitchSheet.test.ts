// The sheet confirming a mid-chat harness switch (src/components/harnessPicker/SwitchSheet.tsx): what it says comes
// along, stays and changes, and the choices it hands back.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fakeStore, mockTsx, mount } from './support/composer-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({});
let session: any;
let status: any;
let source: any;
let vendors: Record<string, any>;
let own: any = null;
let pool: any = {
  active: { id: 'me', email: 'me@x.test' },
  accounts: [
    { id: 'me', email: 'me@x.test' },
    { id: 'work', email: 'work@x.test' },
  ],
};
stubStore({ useStore: store.useStore });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/session/harness/switch.ts', {
  namedExports: { targetLabel: (t: any) => (t.basic ? `Basic ${t.basic}` : `First ${t.family}`) },
});
mock.module('../src/harness/registry.ts', { namedExports: { harnessInfo: (h: string) => vendors[h] } });
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: () => status,
    useEffectiveSelection: () => source,
    useChatAccount: () => own,
    useHarnessAccounts: () => pool,
    switchAccountLabel: (await import('../src/harness/chatAccountLabel.ts')).switchAccountLabel,
  },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { basicLabel: (id: string) => `Basic ${id}` } });
// what main says a switch changes about who controls each surface (its own tests: controllerChangesHook.test.ts)
let controls: string[] = [];
mock.module('../src/harness/controllerChanges.ts', { namedExports: { useControllerChanges: () => controls } });
mockTsx(new URL('../src/components/harnessPicker/HarnessPicker.tsx', import.meta.url), {
  HarnessIcon: ({ h }: any) => `[icon ${h}]`,
  BasicHarnessIcon: () => null,
  BasicBadge: ({ id }: any) => `[badge ${id}]`,
});
// the sheets below are looked at, so the quiet-switch shortcut (src/components/harnessPicker/quickSwitch.ts, its own test)
// is off unless a test turns it on
const realQuick = await import('../src/components/harnessPicker/quickSwitch.ts');
let quick = false;
mock.module('../src/components/harnessPicker/quickSwitch.ts', {
  namedExports: { useQuickSwitch: (q: boolean, c: () => void) => realQuick.useQuickSwitch(q && quick, c) },
});
const { createElement: h } = await import('react');
const { act } = await import('react');
const { SwitchSheet } = await import('../src/components/harnessPicker/SwitchSheet.tsx');

const model = (o: any = {}) => ({ id: 'gpt', label: 'GPT', efforts: ['low', 'high'], defaultEffort: 'high', ...o });
async function sheet(props: any = {}) {
  const out: any = { confirmed: [] as any[], cancelled: 0 };
  const m = await mount(
    h(SwitchSheet, {
      threadId: 'c1',
      from: 'claude',
      target: 'codex',
      model: model(),
      onCancel: () => out.cancelled++,
      onConfirm: (c: any) => out.confirmed.push(c),
      ...props,
    }),
  );
  return Object.assign(out, m);
}

beforeEach(() => {
  session = { queue: [], goal: null, ultracode: null };
  status = { email: 'me@x.test' };
  source = { effort: 'high' };
  vendors = { codex: { vendor: 'OpenAI' }, claude: { vendor: 'Anthropic' } };
  store.reset({ prefs: { permission: 'default' }, segments: {}, runtime: {} });
  controls = [];
  own = null;
  quick = false;
});

test('a first switch carries the conversation, names the account and confirms the defaults', async () => {
  const s = await sheet();
  assert.match($('h5').textContent!, /Continue on Codex · GPT/);
  assert.match($('p').textContent!, /Applies to your next message/);
  assert.equal($('.ss-cols'), null);
  assert.equal($('.ss-privacy').textContent, 'This conversation will be sent to OpenAI.');
  await click($('.btn.primary'));
  assert.deepEqual(s.confirmed, [{ mode: 'auto', goal: null, multiAgent: false, queued: 'send', effort: 'high' }]);
  await click($('.btn.ghost'));
  assert.equal(s.cancelled, 1);
  await s.unmount();
});

test('more options pick the handoff mode', async () => {
  const s = await sheet();
  await click($('.ss-more'));
  const opts = $$('.ss-opt');
  assert.deepEqual(
    opts.map((o) => o.querySelector('b')!.textContent),
    ['Automatic (recommended)', 'Summary', 'Workspace only'],
  );
  assert.match(opts[0].className, /on/);
  await click(opts[2]);
  assert.match($$('.ss-opt')[2].className, /on/);
  await click($('.btn.primary'));
  assert.equal(s.confirmed[0].mode, 'workspace');
  await s.unmount();
});

test('coming back to a harness the chat used resumes it with only what happened since', async () => {
  store.set({
    segments: {
      c1: [
        { harness: 'codex', start: 0, count: 2 },
        { harness: 'claude', start: 2 },
      ],
    },
    runtime: { c1: { turns: [1, 2, 3, 4, 5] } },
  });
  const s = await sheet();
  assert.match($('p').textContent!, /conversation and workspace carry over/);
  assert.equal($('.ss-cols'), null);
  assert.ok(!$('.ss-more'));
  await s.unmount();
  // a segment without a count started the catch-up at its start
  store.set({ segments: { c1: [{ harness: 'codex', start: 4 }] } });
  const s2 = await sheet();
  assert.equal($('.ss-cols'), null);
  await s2.unmount();
});

test('queued messages can be left behind; a goal can continue; multi-agent carries over to an ultra model', async () => {
  session = { queue: [{ id: 'q1' }, { id: 'q2' }], goal: { objective: 'ship it', status: 'active' }, ultracode: { on: true } };
  const s = await sheet({ model: model({ efforts: ['high', 'ultra'] }) });
  const behind = $('.switch-sheet');
  const [send, leave] = $$('input[type=radio]', behind) as HTMLInputElement[];
  assert.equal(send.checked, true);
  await act(async () => leave.click());
  assert.equal(($$('input[type=radio]', behind)[1] as HTMLInputElement).checked, true);
  await act(async () => send.click());
  await act(async () => leave.click());
  const [goal, multi] = $$('input[type=checkbox]') as HTMLInputElement[];
  assert.equal(multi.disabled, false);
  assert.equal(goal.checked, false, 'a goal continues by default only on the same harness');
  await act(async () => multi.click());
  await act(async () => goal.click());
  await click($('.btn.primary'));
  assert.deepEqual(s.confirmed[0], { mode: 'auto', goal: 'ship it', multiAgent: true, queued: 'leave', effort: 'high' });
  await s.unmount();
});

test('multi-agent cannot carry to a model without ultra; a finished goal is not offered', async () => {
  session = { queue: [], goal: { objective: 'done', status: 'complete' }, ultracode: { on: false } };
  source = { effort: 'ultra' };
  const s = await sheet({ from: 'codex', target: 'claude' });
  assert.equal($$('input[type=checkbox]').length, 0);
  assert.match($('.switch-sheet').textContent!, /Multiple agents will turn off/);
  await click($('.btn.primary'));
  assert.deepEqual(s.confirmed[0], { mode: 'auto', goal: null, multiAgent: false, queued: 'send', effort: 'high' });
  await s.unmount();
});

test('a goal on the same harness continues by default and can be turned off', async () => {
  session = { queue: [], goal: { objective: 'g', status: 'active' } };
  const s = await sheet({ from: 'codex', target: 'codex' });
  const goal = $('input[type=checkbox]') as HTMLInputElement;
  assert.equal(goal.checked, true);
  await click($('.btn.primary'));
  await act(async () => goal.click());
  await click($('.btn.primary'));
  assert.deepEqual(
    s.confirmed.map((c: any) => c.goal),
    ['g', null],
  );
  await s.unmount();
});

test('the account falls back to the plan, then the harness; the vendor to the harness name', async () => {
  status = { plan: 'Pro' };
  let s = await sheet();
  assert.equal($('.ss-cols'), null);
  await s.unmount();
  status = {};
  vendors = {};
  s = await sheet();
  assert.equal($('.ss-cols'), null);
  assert.equal($('.ss-privacy').textContent, 'This conversation will be sent to .');
  await s.unmount();
});

test('switches show stricter permissions only when the target requires approval', async () => {
  store.set({ prefs: { permission: 'auto-review' } });
  const s = await sheet({ target: 'claude', model: model({ autoMode: false }) });
  assert.match($('.switch-sheet').textContent!, /Ask for approval/);
  assert.equal($('.ss-cols'), null);
  await click($('.btn.primary'));
  assert.equal(s.confirmed[0].effort, 'high');
  await s.unmount();
});

test('the sheet lists each surface whose controller the switch changes, as main says', async () => {
  controls = [
    "After the switch, your Chrome is controlled by the Codex Browser plugin instead of Claude in Chrome. Its tabs and site permissions there don't carry over, so it asks again.",
  ];
  await sheet();
  assert.deepEqual(
    $$('.ss-line').map((e) => e.textContent),
    [
      'Effort: High → High',
      "After the switch, your Chrome is controlled by the Codex Browser plugin instead of Claude in Chrome. Its tabs and site permissions there don't carry over, so it asks again.",
    ],
  );
});

test("the Changes column names the account when it is the chat's own there: picked, pinned before, or the one in use for a row click", async () => {
  const accountLine = () => $$('.ss-line').find((l) => l.textContent!.startsWith('Account:'))?.textContent ?? null;
  let s = await sheet({ account: 'work' });
  assert.equal(accountLine(), 'Account: work@x.test · Your next messages and the handoff summary go to OpenAI');
  await s.unmount();
  // opened from a model: the pin the chat has there
  own = { id: 'work', pinned: true, serving: 'work' };
  s = await sheet();
  assert.equal(accountLine(), 'Account: work@x.test · Your next messages and the handoff summary go to OpenAI');
  await s.unmount();
  // placed by the pool, from a model: unnamed
  own = { id: 'work', pinned: false, serving: 'work' };
  s = await sheet();
  assert.equal(accountLine(), null);
  await s.unmount();
  // An explicit Automatic choice is named even when a prior account existed.
  s = await sheet({ account: null });
  assert.equal(accountLine(), 'Account: Automatic · Your next messages and the handoff summary go to OpenAI');
  await s.unmount();
  // Explicit Automatic remains clear when no account is known.
  const known = pool;
  pool = { active: null, accounts: [] };
  s = await sheet({ account: null });
  assert.equal(accountLine(), 'Account: Automatic · Your next messages and the handoff summary go to OpenAI');
  await s.unmount();
  pool = known;
});

test('a switch with nothing at risk applies on the first click; any risk keeps the sheet', async () => {
  quick = true;
  const s = await sheet();
  assert.equal(s.host.textContent, '');
  assert.deepEqual(s.confirmed, [{ mode: 'auto', goal: null, multiAgent: false, queued: 'send', effort: 'high' }]);
  await s.unmount();
  for (const risk of [
    () => (session.goal = { objective: 'Ship', status: 'active' }),
    () => (session.queue = [{ text: 'next' }]),
    () => (controls = ['Chrome moves']),
  ]) {
    risk();
    const kept = await sheet();
    assert.match($('h5').textContent!, /Continue on Codex/);
    assert.deepEqual(kept.confirmed, []);
    await kept.unmount();
    session = { queue: [], goal: null, ultracode: null };
    controls = [];
  }
});
