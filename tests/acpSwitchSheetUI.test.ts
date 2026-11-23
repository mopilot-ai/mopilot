// The real ACP switch sheet offers supported context modes and preserves the user's confirmation choices.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount, mockTsx } from './support/composer-kit.ts';
import { createElement } from 'react';
import { stubStore } from './support/stubs.ts';

let kind = 'codex';
let session: any;
let vendor: string | null;
let lines: string[];
stubStore({ chatKind: () => kind, useStore: () => null });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/harness/controllerChanges.ts', { namedExports: { useControllerChanges: () => lines } });
mock.module('../src/harness/registry.ts', { namedExports: { harnessInfo: () => (vendor ? { vendor } : null) } });
mock.module('../src/session/harness/acp.ts', { namedExports: { basicLabel: (id: string) => id } });
mock.module('../src/session/harness/switch.ts', { namedExports: { targetLabel() {} } });
mock.module('../src/session/harness/select.ts', {
  namedExports: { switchAccountLabel() {}, useChatAccount() {}, useEffectiveSelection() {}, useHarnessAccounts() {} },
});
mockTsx(new URL('../src/components/harnessPicker/HarnessPicker.tsx', import.meta.url), {
  HarnessIcon: ({ h }: any) => `[icon ${h}]`,
  BasicHarnessIcon: () => null,
  BasicBadge: () => '[Basic]',
});
const { AcpSwitchSheet } = await import('../src/components/harnessPicker/AcpSwitchSheet.tsx');
beforeEach(() => {
  kind = 'codex';
  session = { goal: null, queue: [] };
  vendor = 'Anomaly';
  lines = [];
});

test('first-tier → ACP confirms in place, offers summary, and carries queued-message choices', async () => {
  session = { goal: { status: 'active' }, queue: [{ text: 'next' }] };
  lines = ['Chrome stays with this chat'];
  const confirmed: any[] = [];
  let cancelled = 0;
  const m = await mount(
    createElement(AcpSwitchSheet, {
      threadId: 'chat',
      target: 'acp:opencode',
      onCancel: () => cancelled++,
      onConfirm: (c) => confirmed.push(c),
    }),
  );
  assert.match(m.host.textContent!, /Continue on opencode/);
  assert.match(m.host.textContent!, /Your conversation and workspace stay in this chat/);
  assert.match(m.host.textContent!, /current goal stays paused/);
  assert.match(m.host.textContent!, /Chrome stays/);
  assert.match(m.host.textContent!, /sent to Anomaly/);
  await click($('.ss-more'));
  assert.equal($$('.ss-opt').length, 3);
  await click($$('.ss-opt')[1].querySelector('input'));
  await click($$('.ss-choice')[1].querySelector('input'));
  await click($('.ss-foot .primary'));
  assert.deepEqual(confirmed, [{ mode: 'summary', queued: 'leave', goal: null, effort: null, multiAgent: false }]);
  await click($$('.ss-opt')[2].querySelector('input'));
  await click($$('.ss-opt')[0].querySelector('input'));
  await click($$('.ss-choice')[0].querySelector('input'));
  await click($('.ss-foot .primary'));
  assert.equal(confirmed[1].mode, 'auto');
  assert.equal(confirmed[1].queued, 'send');
  await click($('.ss-foot .ghost'));
  assert.equal(cancelled, 1);
  await m.unmount();
});

test('ACP → another harness offers automatic and workspace only and defaults to automatic', async () => {
  kind = 'acp:kimi';
  vendor = null;
  lines = ['Chrome moves'];
  const confirmed: any[] = [];
  const m = await mount(
    createElement(AcpSwitchSheet, { threadId: 'chat', target: 'claude', onCancel() {}, onConfirm: (c) => confirmed.push(c) }),
  );
  assert.match(m.host.textContent!, /Continue on Claude Code/);
  assert.match(m.host.textContent!, /sent to Claude Code/);
  assert.doesNotMatch(m.host.textContent!, /\[Basic\]|goal stays|queued messages/);
  await click($('.ss-foot .primary'));
  assert.equal(confirmed[0].mode, 'auto');
  await click($('.ss-more'));
  assert.equal($$('.ss-opt').length, 2);
  await click($$('.ss-opt')[1].querySelector('input'));
  await click($('.ss-foot .primary'));
  assert.equal(confirmed[1].mode, 'workspace');
  assert.match(m.host.textContent!, /Workspace details will be sent/);
  assert.match(m.host.textContent!, /without changing the original session/);
  await m.unmount();
});

test('with nothing at risk the sheet confirms once with the default choices and draws nothing', async () => {
  const confirmed: any[] = [];
  const props = { threadId: 'chat', target: 'claude', onCancel() {}, onConfirm: (c: any) => confirmed.push(c) } as const;
  const m = await mount(createElement(AcpSwitchSheet, props));
  assert.equal(m.host.textContent, '');
  assert.deepEqual(confirmed, [{ mode: 'auto', queued: 'send', goal: null, effort: null, multiAgent: false }]);
  await m.unmount();
  // a finished goal and another session's queued message are nothing to decide
  session = { goal: { status: 'complete' }, queue: [{ text: 'wake', sideSession: { id: 'w' } }] };
  const done = await mount(createElement(AcpSwitchSheet, props));
  assert.equal(done.host.textContent, '');
  await done.unmount();
});

test('a goal, a queued message or a controller change each keep the sheet', async () => {
  const props = { threadId: 'chat', target: 'claude', onCancel() {}, onConfirm: () => assert.fail('confirmed') } as const;
  for (const risk of [
    () => (session = { goal: { status: 'active' }, queue: [] }),
    () => (session = { goal: null, queue: [{ text: 'next' }] }),
    () => (lines = ['Chrome moves']),
  ]) {
    risk();
    const m = await mount(createElement(AcpSwitchSheet, props));
    assert.match(m.host.textContent!, /Continue on Claude Code/);
    await m.unmount();
    session = { goal: null, queue: [] };
    lines = [];
  }
});
