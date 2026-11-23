// Editing the goal's objective in its card (save, refusal, failure, blank, keys, reset per goal), and each harness's
// /goal handlers for edit and the actions it has no form of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, CLAUDE_HANDLERS, CODEX_HANDLERS, claudeCalls, f, fixture, mount, original, setGoalSnapshot } from './support/goal-pills.ts';
import { window } from './support/dom.ts';

test('the objective opens an editor prefilled with the current goal', async (t) => {
  const m = await mount(t);
  await m.editObjective();
  assert.equal(m.input()!.value, original.objective);
  assert.equal(document.activeElement === m.input(), true);
  await m.click('Cancel');
  assert.equal(m.input(), null);
  assert.ok(m.card(), 'Cancel leaves the card open');
  await m.click('Edit goal');
  assert.equal(m.input()!.value, original.objective);
});

test('saving submits the trimmed objective for this chat and closes only after success', async (t) => {
  const m = await mount(t);
  let resolve!: (value: boolean) => void;
  fixture.edit = () =>
    new Promise((r) => {
      resolve = r;
    });
  await m.editObjective();
  await m.change('  New objective\nsecond line  ');
  await m.click('Save');
  assert.deepEqual(fixture.calls, [['edit', 'chat-1', 'New objective\nsecond line']]);
  assert.equal(m.input()!.readOnly, true);
  assert.equal(m.button('Cancel').disabled, true);
  assert.equal(m.button('Clear').disabled, true);
  assert.ok(m.button('Saving…'));
  await act(async () => resolve(true));
  assert.equal(m.input(), null);
});

test('a refused or failed save keeps the draft available to retry', async (t) => {
  const m = await mount(t);
  await m.editObjective();
  await m.change('Keep this draft');
  fixture.edit = async () => false;
  await m.click('Save');
  assert.equal(m.input()!.value, 'Keep this draft');
  assert.equal(m.input()!.readOnly, false);
  fixture.edit = async () => {
    throw new Error('offline');
  };
  await m.click('Save');
  assert.equal(m.input()!.value, 'Keep this draft');
  assert.deepEqual(fixture.notices, ["Couldn't edit goal: offline"]);
  // a rejection that is not an Error is shown as given
  fixture.edit = async () => {
    throw 'lease lost';
  };
  await m.click('Save');
  assert.equal(m.input()!.value, 'Keep this draft');
  assert.deepEqual(fixture.notices, ["Couldn't edit goal: offline", "Couldn't edit goal: lease lost"]);
});

test('blank goals cannot be saved; Cancel sends no request, and Escape closes the card without reaching the composer', async (t) => {
  const m = await mount(t);
  await m.editObjective();
  await m.change(' \n ');
  assert.equal(m.button('Save').disabled, true);
  await m.key('Enter');
  // a submit while blank (the button is disabled, but a form can still be submitted) is refused too
  await act(async () => {
    m.card()!
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any);
  });
  assert.deepEqual(fixture.calls, []);
  await m.change('Discard');
  await m.click('Cancel');
  assert.deepEqual(fixture.calls, []);
  let escaped = 0;
  const listener = () => escaped++;
  document.addEventListener('keydown', listener);
  try {
    await m.editObjective();
    // other keys stay in the editor
    await m.key('a');
    await m.key('Escape');
  } finally {
    document.removeEventListener('keydown', listener);
  }
  assert.equal(m.card(), null);
  assert.equal(escaped, 0, 'no key typed in the card may stop the running goal through the composer');
  assert.deepEqual(fixture.calls, []);
});

test('Enter saves, while Shift+Enter and IME confirmation keep editing', async (t) => {
  const m = await mount(t);
  await m.editObjective();
  await m.change('中文目标');
  await m.key('Enter', { shiftKey: true });
  await m.key('Enter', { isComposing: true });
  await m.key('Enter', { keyCode: 229 });
  assert.deepEqual(fixture.calls, []);
  assert.equal(m.input()!.value, '中文目标');
  await m.key('Enter');
  assert.deepEqual(fixture.calls, [['edit', 'chat-1', '中文目标']]);
  assert.equal(m.input(), null);
});

test('switching chats or replacing a goal closes its card and drops the editor draft', async (t) => {
  const m = await mount(t);
  await m.editObjective();
  await m.change('Old chat draft');
  fixture.goal = { ...original, objective: 'Other chat' };
  await m.render('chat-2');
  assert.equal(m.card(), null);
  await m.editObjective();
  assert.equal(m.input()!.value, 'Other chat');
  fixture.goal = { ...original, createdAt: 2, objective: 'Replacement goal' };
  await m.render('chat-2');
  assert.equal(m.card(), null);
  await m.open();
  assert.equal(m.input(), null);
  assert.equal(m.card()!.querySelector('.goal-objective')?.textContent, 'Replacement goal');
});

test('Codex editing updates only the objective and reports success or request failure', async () => {
  fixture.goal = { ...original };
  await setGoalSnapshot('chat-1', fixture.goal);
  fixture.calls = [];
  fixture.notices = [];
  fixture.request = async () => ({ goal: { ...original, objective: 'New goal' } });
  const call = { chatId: 'chat-1', args: 'edit  New goal ', cap: {} as any };
  assert.equal(await CODEX_HANDLERS.goal!(call), true);
  assert.deepEqual(fixture.calls[0], ['request', 'chat-1', 'thread/goal/set', { threadId: 'native-1', objective: 'New goal' }]);
  assert.deepEqual(fixture.goal, { ...original, objective: 'New goal' });
  fixture.request = async () => {
    throw new Error('offline');
  };
  assert.equal(await CODEX_HANDLERS.goal!(call), false);
  assert.deepEqual(fixture.notices, ["Couldn't edit goal: offline"]);
  assert.equal(fixture.goal.objective, 'New goal');
});

test("a goal action the chat's harness has no form of is refused, never taken as a clear", async () => {
  // a Claude goal's "10 more rounds" on a chat that switched to Codex
  f.calls = [];
  await assert.rejects(async () => CODEX_HANDLERS.goal!({ chatId: 'chat-1', args: 'extend', cap: {} as any }), {
    message: "Codex can't add rounds to this goal. Clear it and set a new one.",
  });
  assert.deepEqual(f.calls, []);
  // a Codex goal's edit or budget on a chat that switched to Claude Code
  for (const [args, action] of [
    ['edit New goal', 'edit'],
    ['budget 5000', 'budget'],
  ]) {
    await assert.rejects(async () => CLAUDE_HANDLERS.goal!({ chatId: 'chat-1', args, cap: {} as any }), {
      message: `Claude Code can't ${action} this goal. Clear it and set a new one.`,
    });
  }
  assert.deepEqual(claudeCalls, []);
  // the actions each harness has still run
  for (const args of ['pause', 'resume', 'extend', 'clear', 'clear human'])
    await CLAUDE_HANDLERS.goal!({ chatId: 'chat-1', args, cap: {} as any });
  assert.deepEqual(claudeCalls, [
    ['pause', 'chat-1'],
    ['resume', 'chat-1'],
    ['extend', 'chat-1'],
    ['clear', 'chat-1', false],
    ['clear', 'chat-1', true],
  ]);
});
