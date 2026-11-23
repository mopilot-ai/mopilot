// A MoMo chat's "/" menu and typed commands (shared/momoCommands.mjs): Feedback only, as in the reference agent app;
// any other typed command (/new, /plan, /model) goes out as plain text, with no command run and no note. A coding chat
// on the same harness keeps every entry.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act } from 'react';
import { $, $$ } from './support/composer-kit.ts';
import { all, events, fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const heard = (name: string) => {
  const seen: any[] = [];
  window.addEventListener(name, (e: any) => seen.push(e.detail ?? true));
  return seen;
};

for (const [label, fixture] of [
  ['Codex', {}],
  ['a basic harness', { basicOf: { t1: 'kimi', t2: 'kimi' } }],
] as const) {
  test(`a MoMo chat on ${label}: the / menu is Feedback alone; a coding chat keeps the rest`, async () => {
    store.set({ ...fixture, momoChats: { t1: 'main' } });
    // a basic harness's menu: MoPilot's own commands and the harness's
    fx.acpRegistry = {
      menu: ['feedback', 'bug', 'new', 'plan', 'model', 'init'].map((name) => ({ name, description: name, dispatch: 'ui' })),
    };
    const momo = await mountComposer({ threadId: 't1' });
    try {
      await momo.type('/');
      assert.deepEqual(
        titles().map((t) => t?.replace(/^\//, '').toLowerCase()),
        ['feedback'],
      );
    } finally {
      await momo.unmount();
    }
    const coding = await mountComposer({ threadId: 't2' });
    try {
      await coding.type('/');
      assert.ok(titles().length > 1, 'a coding chat keeps its commands');
    } finally {
      await coding.unmount();
    }
  });
}

test('a MoMo chat sends a typed /new, /plan and /model as plain text, and /feedback still opens the report', async () => {
  store.set({ momoChats: { t1: 'main' } });
  const model = heard('open-model-picker');
  const report = heard('open-bug-report');
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const typed of ['/new', '/plan', '/model', '/clear', '/compact']) {
      events.length = 0;
      await m.type(typed);
      await m.key('Enter');
      await settle();
      assert.deepEqual(
        all('send').map((e) => e[2]),
        [typed],
        `${typed} goes out as typed`,
      );
      assert.equal(last('navigate'), undefined, `${typed} opens nothing`);
      assert.equal(last('toast'), undefined, `${typed} says nothing`);
    }
    assert.equal(model.length, 0);
    assert.equal(store.get().sessions?.t1?.plan ?? false, false, 'plan mode stays off');
    events.length = 0;
    await m.type('/feedback');
    await m.key('Enter');
    await settle();
    assert.deepEqual(report, [{ threadId: 't1' }]);
    assert.equal(all('send').length, 0);
  } finally {
    await m.unmount();
  }
});

test('a coding chat still runs /new as a command', async () => {
  store.set({ momoChats: { t1: 'main' } });
  const m = await mountComposer({ threadId: 't2' });
  try {
    await m.type('/new');
    await m.key('Enter');
    await settle();
    assert.deepEqual(last('navigate'), ['navigate', { name: 'home' }]);
    assert.equal(all('send').length, 0);
  } finally {
    await m.unmount();
  }
});

test('the project-picker shortcut opens no project menu in a MoMo chat; a coding chat’s opens', async () => {
  store.set({ momoChats: { t1: 'main' } });
  for (const [threadId, opens] of [
    ['t1', false],
    ['t2', true],
  ] as const) {
    const m = await mountComposer({ threadId });
    try {
      await act(async () => void window.dispatchEvent(new Event('open-project-menu')));
      assert.equal(!!$('.stub-project-menu'), opens, threadId);
    } finally {
      await m.unmount();
    }
  }
});

test('a MoMo chat sends `!cmd` as text: no shell runs, even where MoPilot runs one for the harness', async () => {
  fx.caps.shell = 'sage';
  store.set({
    harnessOf: { t1: 'claude', t2: 'claude' },
    threads: { t1: { cwd: '/proj' }, t2: { cwd: '/proj' } },
    momoChats: { t1: 'main' },
  });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('!git status');
    await m.key('Enter');
    await settle();
    assert.equal(last('shell'), undefined);
    assert.deepEqual(
      all('send').map((e) => e[2]),
      ['!git status'],
    );
  } finally {
    await m.unmount();
  }
});
