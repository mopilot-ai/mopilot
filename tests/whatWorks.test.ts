// "What works in MoPilot" on a harness's page (#1385): the five items from what main says a new chat gets
// (src/session/harness/whatWorks.ts), the read that asks main and keeps only the newest answer, and the WhatWorks group.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, settingsExports, render, flush } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');

type Pending = { kind: string; resolve: (v: any) => void; reject: (e: unknown) => void };
const asks: Pending[] = [];
let capsChanged: (() => void) | null = null;
let healthChanged: (() => void) | null = null;
installNativeStub({
  session: {
    harnessCaps: (kind: string) => new Promise((resolve, reject) => asks.push({ kind, resolve, reject })),
    onCapsChanged: (cb: () => void) => ((capsChanged = cb), () => {}),
  },
  availability: { onChanged: (cb: () => void) => ((healthChanged = cb), () => (healthChanged = null)) },
});
const navigated: any[] = [];
const store = fakeStore<any>({ basicHarnesses: [] });
stubStore({ useStore: store.useStore, getState: store.getState, navigate: (r: any) => navigated.push(r) });
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
// the per-harness control status (Settings → Computer use): one row per family
let availability: any = null;
mock.module('../src/session/nativeAvailability.ts', { namedExports: { useNativeAvailability: () => availability } });
const { whatWorks, permissionNames, agentModeNames, useHarnessCaps } = await import('../src/session/harness/whatWorks.ts');
const { WhatWorks } = await import('../src/components/harness/WhatWorks.tsx');

const cap = (state: string, why?: any) => ({
  state,
  via: state === 'sage' ? 'polyfill' : state === 'native' ? 'config' : 'none',
  ...(why ? { why } : {}),
});
const caps = (o: any = {}) => ({
  permissions: cap('native'),
  browser: cap('sage'),
  computerUse: cap('sage'),
  ...o,
});
const answer = (o: any = {}) => ({
  kind: 'codex',
  tier: 'first',
  caps: caps(o.caps),
  works: { chat: true, images: true, tools: true, toolsOff: null, ...o.works },
  family: o.family ?? (o.kind?.startsWith('acp:') ? 'acp' : (o.kind ?? 'codex')),
  ...(o.kind ? { kind: o.kind } : {}),
  ...(o.tier ? { tier: o.tier } : {}),
});
const MODE_OPTION = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'Build' },
    { value: 'plan', name: 'Plan' },
    { value: 'yolo', name: 'Yolo' },
  ],
};
const byId = (items: any[]) => Object.fromEntries(items.map((i) => [i.id, i]));

test('the first tier: every item works, with the four permission rows by name', () => {
  const items = whatWorks(answer() as any, 'Codex');
  assert.deepEqual(
    items.map((i) => [i.id, i.ok, i.note]),
    [
      ['chat', true, null],
      ['permissions', true, null],
      ['images', true, null],
      ['tools', true, null],
      ['control', true, null],
    ],
  );
  assert.equal(byId(items).permissions.text, 'Permission modes: Read-only, Ask for approval, Approve for me, Full access');
  assert.equal(byId(items).tools.text, 'MoPilot tools: messages to other chats, scheduled tasks');
  assert.equal(byId(items).control.text, 'Built-in browser, computer use and your Chrome');
});

test('a basic harness: permission modes by row or own name, without repeats; the agent modes on a line of their own (#1875)', () => {
  const c = answer({ kind: 'acp:opencode', tier: 'basic' }) as any;
  const basic = {
    catalog: { modes: null, configOptions: [MODE_OPTION] },
    permissionModes: { plan: 'read-only', yolo: 'full-access' },
    agentModes: ['build'],
  };
  assert.deepEqual(permissionNames(c, basic as any), ['Read-only', 'Full access']);
  assert.deepEqual(agentModeNames(c, basic as any), ['Build']);
  const twice = { ...basic, permissionModes: { plan: 'full-access', yolo: 'full-access' } };
  assert.deepEqual(permissionNames(c, twice as any), ['Full access']);
  // without agent modes, an unmapped mode is a permission mode under its own name
  const noAgents = { ...basic, agentModes: undefined };
  assert.deepEqual(permissionNames(c, noAgents as any), ['Read-only', 'Build', 'Full access']);
  assert.deepEqual(agentModeNames(c, noAgents as any), []);
  const items = whatWorks(c, 'opencode', basic as any);
  assert.deepEqual(
    items.map((i) => i.id),
    ['chat', 'permissions', 'agentModes', 'images', 'tools', 'control'],
  );
  assert.equal(byId(items).permissions.text, 'Permission modes: Read-only, Full access');
  assert.deepEqual(byId(items).agentModes, { id: 'agentModes', text: 'Agent modes: Build', ok: true, note: null });
  // no agent modes: no agent-modes line
  const all = { ...basic, agentModes: [] };
  assert.equal(byId(whatWorks(c, 'opencode', all as any)).agentModes, undefined);
  // a first-tier harness has no agent modes, whatever it is handed
  assert.deepEqual(agentModeNames(answer() as any, basic as any), []);
  // the caps allow modes but their names aren't known yet: it works, unnamed, and no agent modes are claimed
  const none = byId(whatWorks(c, 'opencode'));
  assert.equal(none.permissions.ok, true);
  assert.equal(none.permissions.text, 'Permission modes');
  assert.equal(none.agentModes, undefined);
});

test('a basic harness without an item: not available on it, or on basic harnesses, yet, and where to go instead', () => {
  const c = answer({
    kind: 'acp:kimi',
    tier: 'basic',
    caps: { permissions: cap('absent', { layer: 'harness', code: 'harness.undeclared' }), computerUse: cap('absent') },
    works: { images: false },
  }) as any;
  const items = byId(whatWorks(c, 'Kimi Code'));
  assert.equal(items.permissions.ok, false);
  // what this harness lacks is said of it; what no basic harness has is said of them all
  assert.equal(items.permissions.note, 'Not available on Kimi Code yet. Switch the chat to Codex or Claude Code for this.');
  assert.equal(items.images.note, 'Not available on Kimi Code yet. Switch the chat to Codex or Claude Code for this.');
  assert.equal(items.control.ok, false);
  assert.equal(items.control.note, 'Not available on basic harnesses yet. Switch the chat to Codex or Claude Code for these.');
  // images not known yet: said so, not claimed
  const unknown = byId(whatWorks(answer({ kind: 'acp:kimi', tier: 'basic', works: { images: null } }) as any, 'Kimi Code'));
  assert.equal(unknown.images.ok, false);
  assert.equal(unknown.images.note, 'MoPilot hasn’t checked this yet.');
});

test('tools that do not reach it, and computer use that cannot work on this Mac (its Settings status), say why', () => {
  const bridge = byId(whatWorks(answer({ works: { tools: false, toolsOff: 'No bridge.', toolsOffCode: 'tools.bridge' } }) as any, 'Codex'));
  assert.deepEqual([bridge.tools.ok, bridge.tools.note], [false, 'MoPilot tools can’t connect right now. Restart MoPilot to try again.']);
  assert.deepEqual(
    [bridge.control.ok, bridge.control.note],
    [false, 'MoPilot tools can’t connect right now. Restart MoPilot to try again.'],
  );
  const off = byId(whatWorks(answer({ works: { tools: false } }) as any, 'Codex'));
  assert.equal(off.control.note, 'This feature needs attention. Open its settings to check.');
  const surface = (state: string, detail: string | null = null) => ({
    state,
    label: state === 'permissions' ? 'Needs permission' : 'Label',
    detail,
    reasonCode: state === 'permissions' ? 'computer.screenRecording' : 'computer.build',
    actions: [],
  });
  const helper = byId(whatWorks(answer() as any, 'Claude Code', undefined, surface('unavailable', 'The helper is missing.') as any));
  assert.deepEqual([helper.tools.ok, helper.control.ok, helper.control.note], [true, false, 'Computer use isn’t available in this build.']);
  const permission = byId(whatWorks(answer() as any, 'Claude Code', undefined, surface('permissions') as any));
  assert.equal(permission.control.note, 'Allow Screen Recording for MoPilot in System Settings.');
  // native, MoPilot's own, a fallback or an update under way: it works
  for (const state of ['native', 'mopilot', 'fallback', 'update', 'unknown'])
    assert.equal(byId(whatWorks(answer() as any, 'Codex', undefined, surface(state) as any)).control.ok, true, state);
});

test('the first tier without an item names the other one; a later layer gives its own reason; switched off says so', () => {
  const c = answer({
    kind: 'claude',
    caps: { browser: cap('disabled', { layer: 'flag', code: 'flag.killed.channel' }), permissions: cap('absent') },
    works: { chat: false, images: false, tools: false },
  }) as any;
  const items = byId(whatWorks(c, 'Claude Code'));
  assert.equal(items.chat.note, 'Turned off by MoPilot for now. It comes back on its own.');
  assert.equal(items.tools.note, 'This feature needs attention. Open its settings to check.');
  assert.equal(items.images.note, 'Not available on Claude Code yet. Switch the chat to Codex for this.');
  assert.equal(items.permissions.note, 'Not available on Claude Code yet. Switch the chat to Codex for this.');
  assert.equal(items.control.ok, false);
  assert.ok(items.control.note && !items.control.note.startsWith('Not available'), items.control.note);
});

test('useHarnessCaps: the newest ask wins; a harness the page left, or an older answer, is dropped', async () => {
  const seen: any[] = [];
  const Probe = ({ kind }: { kind: string }) => (seen.push(useHarnessCaps(kind as any)), null);
  asks.length = 0;
  const v = await render(h(Probe, { kind: 'codex' }));
  assert.deepEqual(
    asks.map((a) => a.kind),
    ['codex'],
  );
  assert.equal(seen.at(-1), null, 'nothing until main answers');
  // the page moves to another harness before the first answer
  await v.rerender(h(Probe, { kind: 'claude' }));
  assert.deepEqual(
    asks.map((a) => a.kind),
    ['codex', 'claude'],
  );
  await act(async () => asks[0].resolve(answer({ kind: 'codex' })));
  assert.equal(seen.at(-1), null, "an answer for the harness the page left isn't shown");
  await act(async () => asks[1].resolve(answer({ kind: 'claude' })));
  assert.equal(seen.at(-1).kind, 'claude');
  // capabilities change: asked again; an older ask settling late (or failing) can't replace the newer answer
  await act(async () => capsChanged!());
  assert.equal(asks.length, 3);
  await act(async () => capsChanged!());
  assert.equal(asks.length, 4);
  await act(async () => asks[3].resolve(answer({ kind: 'claude', works: { tools: false } })));
  await act(async () => asks[2].resolve(answer({ kind: 'claude', works: { tools: true } })));
  assert.equal(seen.at(-1).works.tools, false);
  // the capability health changes: asked again
  await act(async () => healthChanged!());
  assert.equal(asks.length, 5);
  await act(async () => asks[4].resolve(answer({ kind: 'claude', works: { tools: false } })));
  // a failed ask keeps what was known
  await act(async () => capsChanged!());
  await act(async () => asks[5].reject(new Error('main went away')));
  assert.equal(seen.at(-1).works.tools, false);
  await v.unmount();
  assert.equal(healthChanged, null, 'stops following the health once the page is gone');
});

test('useHarnessCaps: a basic harness is asked again when its admission changes, not when another one does', async () => {
  const Probe = ({ kind }: { kind: string }) => (useHarnessCaps(kind as any), null);
  store.setState({ basicHarnesses: [{ id: 'opencode', state: 'checking', catalog: null }] });
  asks.length = 0;
  const v = await render(h(Probe, { kind: 'acp:opencode' }));
  assert.equal(asks.length, 1);
  await act(async () => store.setState({ basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: null, images: true }] }));
  assert.equal(asks.length, 2);
  await act(async () =>
    store.setState({
      basicHarnesses: [
        { id: 'opencode', state: 'admitted', catalog: null, images: true },
        { id: 'kimi', state: 'signin' },
      ],
    }),
  );
  assert.equal(asks.length, 2);
  await v.unmount();
  await flush();
});

test('WhatWorks: a group of checks and dashes with the notes; inline under its own heading; nothing before main answers', async () => {
  store.setState({
    basicHarnesses: [
      {
        id: 'opencode',
        state: 'admitted',
        catalog: { modes: null, configOptions: [MODE_OPTION] },
        permissionModes: { plan: 'read-only' },
        agentModes: ['build', 'yolo'],
      },
    ],
  });
  asks.length = 0;
  const v = await render(h(WhatWorks, { kind: 'codex', label: 'Codex' }));
  assert.equal(v.host.querySelector('[data-works]'), null);
  availability = {
    harnesses: [
      { harness: 'claude', computer: { state: 'unavailable', label: 'Unavailable', detail: 'Not this one.', actions: [] } },
      { harness: 'codex', computer: { state: 'native', label: 'Native', detail: null, actions: [] } },
    ],
  };
  await act(async () => asks[0].resolve(answer({ works: { images: false } })));
  const group = v.host.querySelector('[data-group="What works in MoPilot"]')!;
  const items = [...group.querySelectorAll('[data-work]')];
  assert.deepEqual(
    items.map((i) => [i.getAttribute('data-work'), i.className]),
    [
      ['chat', 'works-item ok'],
      ['permissions', 'works-item ok'],
      ['images', 'works-item off'],
      ['tools', 'works-item ok'],
      ['control', 'works-item ok'],
    ],
  );
  assert.equal(items[0].querySelector('[aria-label]')!.getAttribute('aria-label'), 'Works');
  assert.equal(items[2].querySelector('[aria-label]')!.getAttribute('aria-label'), 'Not available');
  assert.equal(items[2].querySelector('.works-note')!.textContent, 'Not available on Codex yet. Switch the chat to Claude Code for this.');
  assert.equal(items[0].querySelector('.works-note'), null);
  await v.unmount();

  asks.length = 0;
  availability = null;
  const b = await render(h(WhatWorks, { kind: 'acp:opencode', label: 'opencode', inline: true }));
  await act(async () => asks[0].resolve(answer({ kind: 'acp:opencode', tier: 'basic' })));
  assert.equal(b.host.querySelector('[data-group]'), null);
  assert.equal(b.host.querySelector('.works-inline-title')!.textContent, 'What works in MoPilot');
  assert.equal(b.host.querySelector('[data-work="permissions"]')!.textContent, 'Permission modes: Read-only');
  assert.equal(b.host.querySelector('[data-work="agentModes"]')!.textContent, 'Agent modes: Build, Yolo');
  await b.unmount();
});

test('capability diagnostics never appear in the checklist, including unknown or absent codes', () => {
  const raw =
    "MoPilot Computer Use isn't built in this checkout (/Users/private/native/helper/build); rebuild it (node scripts/build-helper.mjs).";
  for (const reasonCode of ['computer.build', 'future.unknown', undefined, 'constructor', ['computer.build']]) {
    const computer = { state: 'unavailable', label: raw, detail: raw, reasonCode, actions: [] };
    const item = byId(whatWorks(answer() as any, 'Claude Code', undefined, computer as any)).control;
    assert.equal(item.ok, false);
    assert.doesNotMatch(item.note, /private|build-helper|checkout/);
  }
  for (const toolsOffCode of ['tools.bridge', 'future.unknown', undefined]) {
    const items = byId(whatWorks(answer({ works: { tools: false, toolsOff: raw, toolsOffCode } }) as any, 'Codex'));
    assert.doesNotMatch(items.tools.note, /private|build-helper|checkout/);
    assert.doesNotMatch(items.control.note, /private|build-helper|checkout/);
  }
});

test('every harness shows safe mapped computer-use copy and opens only the existing settings page', async () => {
  const { CAPABILITY_REASONS, capabilityReasonText } = await import('../shared/capabilityReasons.mjs');
  for (const kind of ['codex', 'claude', 'acp:opencode']) {
    asks.length = 0;
    const family = kind.startsWith('acp:') ? 'acp' : kind;
    availability = {
      harnesses: [
        {
          harness: family,
          computer: { state: 'permissions', reasonCode: 'computer.screenRecording', detail: '/Users/private/helper', actions: [] },
        },
      ],
    };
    const v = await render(h(WhatWorks, { kind: kind as any, label: kind }));
    await act(async () => asks[0].resolve(answer({ kind })));
    const item = v.host.querySelector('[data-work="control"]')!;
    assert.match(item.textContent!, /Allow Screen Recording/);
    assert.doesNotMatch(item.textContent!, /private/);
    navigated.length = 0;
    await act(async () => (item.querySelector('button') as HTMLButtonElement).click());
    assert.deepEqual(navigated, [{ name: 'settings', section: 'computer' }]);
    await v.unmount();
    for (const code of Object.keys(CAPABILITY_REASONS)) {
      const s = { state: 'unavailable', reasonCode: code, detail: '/Users/private/helper', actions: [] };
      const out = byId(whatWorks(answer({ kind }) as any, kind, undefined, s as any));
      assert.equal(out.control.note, capabilityReasonText(code));
      assert.equal(out.control.ok, false);
    }
  }
});
