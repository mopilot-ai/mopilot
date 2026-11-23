// The Switch host dialog's question about uncommitted changes: what is listed, carry or go without, a refused plan or carry, and the lost-host yes that comes first.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, mount, texts } from './support/composer-kit.ts';
import type { SwitchMachine } from '../src/lib/hostSwitch.ts';

const { SwitchHostDialog } = await import('../src/components/composer/SwitchHostDialog.tsx');

const FLEET: SwitchMachine[] = [
  { id: 'local', name: 'This Mac', status: 'online', note: 'Browser, Computer use' },
  { id: 'box', name: 'build-box', status: 'offline', note: 'Offline' },
  { id: 'dev', name: 'dev-vm', status: 'online', note: 'SSH · Codex' },
];
const calls: any[] = [];
let closed = 0;
const base = (over: Record<string, any> = {}): Record<string, any> => ({
  chatId: 'c1',
  project: '/work/app',
  ownerId: 'local',
  ownerLost: false,
  machines: FLEET,
  turnRunning: false,
  onContinue: async (req: unknown) => void calls.push(req),
  onClose: () => void closed++,
  ...over,
});
beforeEach(() => {
  calls.length = 0;
  closed = 0;
  localStorage.clear();
});
const dirInput = () => $('input[aria-label="Folder on the host"]') as HTMLInputElement;
const submit = () => $$('.acct-dialog-actions button').find((b) => /Switch host|Switching/.test(b.textContent!))!;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const open = async (over: Record<string, any> = {}) => mount(createElement(SwitchHostDialog, base(over) as any));
const refusal = (code: string, message = 'raw message') => Object.assign(new Error(message), { code });

const NEW_FILES = Array.from({ length: 10 }, (_, i) => `src/new${i}.ts`);
const plan = (over: Record<string, unknown> = {}) => ({
  plan: { untracked: NEW_FILES, skipped: ['.env'], files: 12, changed: [], unpushed: 0, remote: 'github.com/org/app', ...over },
});
const buttons = () => $$('.acct-dialog-actions button').map((b) => b.textContent);

test('uncommitted changes are asked about before the chat moves: the new files, the skipped ones, then carry, go without, or back', async () => {
  const asks: unknown[] = [];
  const m = await open({
    onPlan: async (req: unknown) => (asks.push(req), plan()),
  });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.deepEqual(asks, [{ chatId: 'c1', targetHostId: 'dev', cwd: '/srv/app' }]);
    assert.equal(calls.length, 0, 'nothing moves before the answer');
    assert.equal($('.acct-dialog-hint').textContent, '12 files have uncommitted changes. Carry them to dev-vm?');
    assert.deepEqual(texts('[aria-label="New files"] li'), NEW_FILES.slice(0, 8));
    assert.ok($('.switch-host-files').textContent!.includes('and 2 more'));
    assert.ok($('[role=dialog]').textContent!.includes('Never sent, the names look like secrets: .env'));
    assert.deepEqual(buttons(), ['Back', 'Continue without changes', 'Carry changes']);
    await click($$('.acct-dialog-actions button')[0]);
    assert.equal(dirInput().value, '/srv/app', 'Back keeps the form');
    await click(submit());
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(
      calls,
      [{ chatId: 'c1', targetHostId: 'dev', cwd: '/srv/app', lostHostConfirmed: false }],
      'without changes: no carry',
    );
    assert.equal(closed, 1);
  } finally {
    await m.unmount();
  }
  calls.length = 0;
  closed = 0;
  const carry = await open({ onPlan: async () => plan() });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    await click($$('.acct-dialog-actions button')[2]);
    assert.deepEqual(calls, [
      {
        chatId: 'c1',
        targetHostId: 'dev',
        cwd: '/srv/app',
        lostHostConfirmed: false,
        carry: { confirmed: true, untracked: NEW_FILES, unpushed: 0 },
      },
    ]);
    assert.equal(closed, 1);
  } finally {
    await carry.unmount();
  }
});

test('the question reads right for one file, no new files and nothing skipped', async () => {
  const m = await open({ onPlan: async () => plan({ untracked: [], skipped: [], files: 1 }) });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.equal($('.acct-dialog-hint').textContent, '1 file has uncommitted changes. Carry it to dev-vm?');
    assert.equal($('.switch-host-files'), null);
    assert.ok(!$('[role=dialog]').textContent!.includes('Never sent'));
  } finally {
    await m.unmount();
  }
});

test('nothing to carry, or no plan to ask for, moves the chat at once', async () => {
  for (const onPlan of [async () => ({ plan: null }), async () => null, undefined]) {
    calls.length = 0;
    closed = 0;
    const m = await open({ onPlan });
    try {
      await type(dirInput(), '/srv/app');
      await click(submit());
      assert.deepEqual(calls, [{ chatId: 'c1', targetHostId: 'dev', cwd: '/srv/app', lostHostConfirmed: false }]);
      assert.equal(closed, 1);
    } finally {
      await m.unmount();
    }
  }
});

test('a plan that is refused shows its reason on the form; a carry that is refused keeps the question, and the chat can still go without', async () => {
  let refuseCarry = true;
  const m = await open({
    onPlan: async () => {
      if (calls.length === 0 && !refuseCarry) throw refusal('directory_missing');
      return plan();
    },
    onContinue: async (req: any) => {
      calls.push(req);
      if (req.carry) throw refusal('carry_conflict');
    },
  });
  try {
    await type(dirInput(), '/srv/app');
    refuseCarry = false;
    await click(submit());
    assert.equal($('[role=alert]').textContent, "That folder doesn't exist on dev-vm.");
    assert.equal(dirInput().value, '/srv/app');
    assert.equal(calls.length, 0);
    refuseCarry = true;
    await click(submit());
    await click($$('.acct-dialog-actions button')[2]);
    assert.equal(
      $('[role=alert]').textContent,
      "The changes don't apply to the folder on dev-vm. Try again, or continue without the changes.",
    );
    assert.deepEqual(buttons(), ['Back', 'Continue without changes', 'Carry changes'], 'the question stays');
    assert.equal(closed, 0);
    await click($$('.acct-dialog-actions button')[1]);
    assert.equal(calls.at(-1).carry, undefined);
    assert.equal(closed, 1);
  } finally {
    await m.unmount();
  }
});

test("the lost-host yes comes first and travels with the carry question's answer; a target that goes meanwhile ends the question", async () => {
  const m = await open({ ownerId: 'box', ownerLost: true, onPlan: async () => plan() });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(buttons(), ['Back', 'Continue without changes', 'Carry changes']);
    await m.render(
      createElement(SwitchHostDialog, base({ ownerId: 'box', ownerLost: true, machines: [FLEET[1]], onPlan: async () => plan() }) as any),
    );
    assert.equal($('[role=radiogroup]') !== null, true, 'the question is gone with its target: the form is back');
    assert.equal(dirInput(), null);
  } finally {
    await m.unmount();
  }
  const again = await open({ ownerId: 'box', ownerLost: true, onPlan: async () => plan() });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    await click($$('.acct-dialog-actions button')[1]);
    await click($$('.acct-dialog-actions button')[2]);
    assert.equal(calls.at(-1).lostHostConfirmed, true);
    assert.equal(calls.at(-1).carry.confirmed, true);
  } finally {
    await again.unmount();
  }
});

test('commits origin lacks are named before the carry and the count the user was told goes with it', async () => {
  for (const [unpushed, line] of [
    [1, '1 unpushed commit will be pushed to github.com/org/app with the changes.'],
    [3, '3 unpushed commits will be pushed to github.com/org/app with the changes.'],
  ] as const) {
    calls.length = 0;
    const m = await open({ onPlan: async () => plan({ unpushed }) });
    try {
      await type(dirInput(), '/srv/app');
      await click(submit());
      assert.ok($('[role=dialog]').textContent!.includes(line));
      await click($$('.acct-dialog-actions button')[2]);
      assert.equal((calls[0] as any).carry.unpushed, unpushed, 'the carry agrees to publish exactly what was named');
    } finally {
      await m.unmount();
    }
  }
});

test('a push address that is not known reads as origin, and nothing is said when no commit is unpushed', async () => {
  const none = await open({ onPlan: async () => plan() });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.ok(!$('[role=dialog]').textContent!.includes('unpushed'));
  } finally {
    await none.unmount();
  }
  const m = await open({ onPlan: async () => plan({ unpushed: 1, remote: '' }) });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.ok($('[role=dialog]').textContent!.includes('1 unpushed commit will be pushed to origin with the changes.'));
  } finally {
    await m.unmount();
  }
});

test('the files git already knew are named before the new ones, with the rest counted', async () => {
  const changed = Array.from({ length: 11 }, (_, i) => `src/mod${i}.ts`);
  const m = await open({ onPlan: async () => plan({ files: 13, untracked: ['src/new.ts'], changed }) });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.deepEqual(texts('[aria-label="Changed files"] li'), changed.slice(0, 8));
    assert.deepEqual(texts('[aria-label="New files"] li'), ['src/new.ts']);
    const text = $('[role=dialog]').textContent!;
    assert.ok(text.includes('Changed files that would be sent:') && text.includes('and 4 more'), 'a dozen files: 8 named, 12 - 8 more');
  } finally {
    await m.unmount();
  }
  // a Host from before the plan named them, or nothing changed but new files: no empty list
  const old = await open({ onPlan: async () => ({ plan: { untracked: ['a.ts'], skipped: [], files: 1, unpushed: 0, remote: '' } }) });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.equal($('[aria-label="Changed files"]'), null);
  } finally {
    await old.unmount();
  }
});
