// The switch chip's Options (src/components/harnessPicker/SwitchOptions.tsx): the switch sheet again, with the choices
// applied to the switch that already went ahead.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useState } from 'react';
import { mockStore, autoMock, render, settle, callsTo, moduleCalls } from './support/thread-kit.ts';

let from: string | null = 'codex';
let models: any[] = [];
let fallback: any;
mockStore({ chatFamily: () => from ?? 'acp' });
autoMock('src/session/harness/select.ts', 'sel', { harnessModels: () => models });
autoMock('src/components/harnessPicker/applySwitch.ts', 'apply', {
  switchModel: (target: string, requested: string | null) =>
    target.startsWith('acp:') ? fallback : (models.find((m) => m.id === requested) ?? fallback),
});
autoMock('src/components/ui/Popover.tsx', 'pop', {
  useAnchor: () => {
    const [open, setOpen] = useState(false);
    return { ref: () => {}, anchor: null, open, toggle: () => setOpen((o) => !o), close: () => setOpen(false) };
  },
  Popover: ({ children }: any) => h('div', { className: 'popover' }, children),
});
const sheet = (name: string) => (p: any) =>
  h(
    'div',
    { 'data-sheet': name, 'data-ask': String(p.ask), 'data-account': String(p.account) },
    h('button', { id: 'cancel', onClick: p.onCancel }),
    h('button', { id: 'ok', onClick: () => p.onConfirm({ mode: 'summary', effort: 'low' }) }),
  );
autoMock('src/components/harnessPicker/SwitchSheet.tsx', 'ss', { SwitchSheet: sheet('first') });
autoMock('src/components/harnessPicker/AcpSwitchSheet.tsx', 'acp', { AcpSwitchSheet: sheet('acp') });
const { SwitchOptions } = await import('../src/components/harnessPicker/SwitchOptions.tsx');

const P = { harness: 'claude', model: 'opus', modelLabel: 'Opus', mode: 'auto', goal: null, multiAgent: false, account: null } as any;
const mount = (p: any = P) => render(h(SwitchOptions, { threadId: 'c1', p }));

beforeEach(() => {
  moduleCalls.length = 0;
  from = 'codex';
  models = [{ id: 'opus', label: 'Opus' }];
  fallback = { id: 'default', label: 'Default' };
});

test('Options reopens the first-tier sheet, always asking, and applies the choices on the switch made', async () => {
  const v = await mount({ ...P, automaticAccount: true });
  await settle(() => v.$('button')!.click());
  const s = v.$('[data-sheet]')!;
  assert.deepEqual([s.dataset.sheet, s.dataset.ask, s.dataset.account], ['first', 'true', 'null']);
  await settle(() => v.$('#ok')!.click());
  assert.equal(v.$('[data-sheet]'), null);
  const [thread, args, choices, after] = callsTo('apply:applySwitch')[0];
  assert.deepEqual(
    [thread, args, choices],
    ['c1', { target: 'claude', model: models[0], account: null }, { mode: 'summary', effort: 'low' }],
  );
  after('low');
  assert.deepEqual(callsTo('sel:setSelection'), [['claude', { model: 'opus', effort: 'low' }, null]]);
});

test('Options preserves Automatic on a pending switch even after the target default is pinned elsewhere', async () => {
  fallback = { id: '', label: 'Automatic' };
  const v = await mount({ ...P, model: null });
  await settle(() => v.$('button')!.click());
  await settle(() => v.$('#ok')!.click());
  const [, args, , after] = callsTo('apply:applySwitch')[0];
  assert.equal(args.model.id, '');
  after('low');
  assert.deepEqual(callsTo('sel:setSelection'), [['claude', { model: null, effort: 'low' }, null]]);
});

test('the account picked stays; the chat’s own applies when none was picked', async () => {
  const v = await mount({ ...P, account: 'work' });
  await settle(() => v.$('button')!.click());
  assert.equal(v.$('[data-sheet]')!.dataset.account, 'work');
  await v.unmount();
  const own = await mount({ ...P, account: undefined });
  await settle(() => own.$('button')!.click());
  assert.equal(own.$('[data-sheet]')!.dataset.account, 'undefined');
});

test('a basic harness target uses the ACP sheet and applies no selection', async () => {
  const v = await mount({ ...P, harness: 'acp:gemini' });
  await settle(() => v.$('button')!.click());
  assert.equal(v.$('[data-sheet]')!.dataset.sheet, 'acp');
  await settle(() => v.$('#ok')!.click());
  const [, args, , after] = callsTo('apply:applySwitch')[0];
  assert.deepEqual(args, { target: 'acp:gemini', model: fallback, account: undefined });
  after('low');
  assert.deepEqual(callsTo('sel:setSelection'), []);
  // a chat that is not first-tier asks with the ACP sheet for a first-tier target too
  from = null;
  const acpChat = await mount();
  await settle(() => acpChat.$('button')!.click());
  assert.equal(acpChat.$('[data-sheet]')!.dataset.sheet, 'acp');
});

test('Cancel closes it; without a model the button is disabled', async () => {
  const v = await mount();
  await settle(() => v.$('button')!.click());
  await settle(() => v.$('#cancel')!.click());
  assert.equal(v.$('[data-sheet]'), null);
  assert.equal(callsTo('apply:applySwitch').length, 0);
  await v.unmount();
  models = [];
  fallback = undefined;
  const none = await mount();
  assert.equal((none.$('button') as HTMLButtonElement).disabled, true);
});
