// Real Scheduled editor handlers retain current drafts when older saves settle.
import { beforeEach, test } from 'node:test';
import { assert, fx, h, act, calls, Scheduled, render, click, byText, dialog, type, flush, both, task } from './support/scheduled-page.ts';
import { deferred } from './support/async-scenarios.ts';

const { StrictMode } = await import('react');
const { useSched } = await import('../src/components/pages/scheduled/state.ts');
const draft = (host: HTMLElement) => dialog(host)?.querySelector('textarea')?.value;
const notices = () => calls.filter((c) => c[0] === 'toast');
const settle = async (gate: ReturnType<typeof deferred>, outcome: 'success' | 'failure') => {
  await act(async () => (outcome === 'success' ? gate.resolve() : gate.reject(new Error('retired write failed'))));
  await flush();
};
const edit = async (host: HTMLElement) => {
  await click(host.querySelector('[aria-label="Task actions"]'));
  await click(byText(host, 'Edit', '[role=menuitem]'));
};
beforeEach(() => {
  fx.list = [];
  fx.listGate = null;
  fx.saveGate = null;
  fx.saveFail = null;
  calls.length = 0;
  useSched.setState({ list: null, selected: null, editing: null, query: '', filter: 'all' });
});

test('an old save finishing its reload preserves the replacement editor and draft', async (t) => {
  const v = await render(h(Scheduled));
  t.after(() => v.unmount());
  await click(byText(v.host, 'News updates'));
  const gate = deferred();
  fx.listGate = gate.promise;
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(calls.filter((c) => c[0] === 'save').length, 1);
  await click(byText(dialog(v.host)!, 'Cancel'));
  await click(byText(v.host, 'Email monitor'));
  await type(dialog(v.host)!.querySelector('textarea'), 'Keep this replacement draft');
  await settle(gate, 'success');
  assert.ok(dialog(v.host), 'old save dismissed the newer editor');
  assert.equal(draft(v.host), 'Keep this replacement draft');
  assert.equal(useSched.getState().selected, null);
  assert.equal(fx.list.length, 1, 'accepted old write remains durable');
  assert.deepEqual(notices(), []);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`a retired write ${outcome} preserves a replacement save that is still pending`, async (t) => {
    const v = await render(h(Scheduled));
    t.after(() => v.unmount());
    await click(byText(v.host, 'News updates'));
    const old = deferred();
    fx.saveGate = old.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    await click(byText(dialog(v.host)!, 'Cancel'));
    await click(byText(v.host, 'Email monitor'));
    await type(dialog(v.host)!.querySelector('textarea'), 'replacement input');
    const replacement = deferred();
    fx.saveGate = replacement.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    await settle(old, outcome);
    assert.equal(draft(v.host), 'replacement input');
    assert.deepEqual(notices(), []);
    await settle(replacement, 'success');
    assert.equal(dialog(v.host), null);
    assert.equal(useSched.getState().selected, 'made-email-monitor');
    assert.deepEqual(notices(), [['toast', 'Scheduled task saved']]);
    assert.equal(fx.list.length, outcome === 'success' ? 2 : 1);
    assert.equal(calls.filter((c) => c[0] === 'save').length, 2);
  });

  test(`older ${outcome} after newer success cannot replace the newer selection or notice`, async (t) => {
    const v = await render(h(Scheduled));
    t.after(() => v.unmount());
    await click(byText(v.host, 'News updates'));
    const old = deferred();
    fx.saveGate = old.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    await click(byText(dialog(v.host)!, 'Cancel'));
    await click(byText(v.host, 'Email monitor'));
    fx.saveGate = null;
    await click(byText(dialog(v.host)!, 'Create'));
    const expected = notices();
    await settle(old, outcome);
    assert.equal(useSched.getState().selected, 'made-email-monitor');
    assert.deepEqual(notices(), expected);
    assert.equal(fx.list.length, outcome === 'success' ? 2 : 1);
  });

  test(`unmounted editor ${outcome} cannot affect a remounted editor`, async (t) => {
    const v = await render(h(Scheduled));
    await click(byText(v.host, 'News updates'));
    const old = deferred();
    fx.saveGate = old.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    await v.unmount();
    const replacement = await render(h(StrictMode, null, h(Scheduled)));
    t.after(() => replacement.unmount());
    await type(dialog(replacement.host)!.querySelector('textarea'), 'remounted input');
    await settle(old, outcome);
    assert.equal(draft(replacement.host), 'remounted input');
    assert.deepEqual(notices(), []);
    fx.saveGate = null;
    await click(byText(dialog(replacement.host)!, 'Create'));
    assert.equal(dialog(replacement.host), null);
    assert.deepEqual(notices(), [['toast', 'Scheduled task saved']]);
  });
}

test('cancel and reopen the same task object creates a distinct editor owner', async (t) => {
  fx.list = [task('same')];
  const v = await render(both());
  t.after(() => v.unmount());
  await click(byText(v.host, 'Task same', '.sched-row'));
  await edit(v.host);
  const initial = useSched.getState().editing;
  const old = deferred();
  fx.saveGate = old.promise;
  await click(byText(dialog(v.host)!, 'Save'));
  await click(byText(dialog(v.host)!, 'Cancel'));
  await edit(v.host);
  assert.equal(useSched.getState().editing, initial, 'reopens the same list object');
  await type(dialog(v.host)!.querySelector('textarea'), 'same task, new draft');
  await settle(old, 'success');
  assert.equal(draft(v.host), 'same task, new draft');
  assert.deepEqual(notices(), []);
});

for (const order of ['older-first', 'newer-first'] as const) {
  test(`competing saves in one editor retain both writes and only latest UI (${order})`, async (t) => {
    const v = await render(h(Scheduled));
    t.after(() => v.unmount());
    await click(byText(v.host, 'News updates'));
    const older = deferred();
    fx.saveGate = older.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    await type(dialog(v.host)!.querySelector('textarea'), 'newer input');
    const newer = deferred();
    fx.saveGate = newer.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    if (order === 'older-first') {
      await settle(older, 'success');
      assert.equal(draft(v.host), 'newer input');
      assert.deepEqual(notices(), []);
      await settle(newer, 'success');
    } else {
      await settle(newer, 'success');
      await settle(older, 'success');
    }
    assert.equal(dialog(v.host), null);
    assert.equal(calls.filter((c) => c[0] === 'save').length, 2);
    assert.equal(calls.filter((c) => c[0] === 'list').length, 2, 'both accepted writes refresh shared state');
    assert.deepEqual(notices(), [['toast', 'Scheduled task saved']]);
  });
}

test('current failure preserves input and retry succeeds after Strict Mode effect replay', async (t) => {
  const v = await render(h(StrictMode, null, h(Scheduled)));
  t.after(() => v.unmount());
  await click(byText(v.host, 'News updates'));
  await type(dialog(v.host)!.querySelector('textarea'), 'retry this draft');
  fx.saveFail = new Error('disk full');
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(draft(v.host), 'retry this draft');
  assert.deepEqual(notices(), [['toast', "Couldn't save the task: disk full", 'error']]);
  fx.saveFail = null;
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(dialog(v.host), null);
  assert.equal(fx.list[0].prompt, 'retry this draft');
  assert.equal(useSched.getState().selected, 'made-news-updates');
});

test('new-scheduled-task replaces an open editor with fresh input and retires old completion', async (t) => {
  const v = await render(h(Scheduled));
  t.after(() => v.unmount());
  await click(byText(v.host, 'News updates'));
  await type(dialog(v.host)!.querySelector('textarea'), 'old private draft');
  const old = deferred();
  fx.saveGate = old.promise;
  await click(byText(dialog(v.host)!, 'Create'));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('new-scheduled-task', {
        detail: { name: 'Replacement', cwd: '/replacement', threadId: 'thread-b' },
      }),
    ),
  );
  assert.equal(draft(v.host), '', 'replacement must not inherit the old local input');
  await type(dialog(v.host)!.querySelector('textarea'), 'replacement prompt');
  await settle(old, 'success');
  assert.equal(draft(v.host), 'replacement prompt');
  fx.saveGate = null;
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(fx.list.find((a) => a.id === 'made-replacement')!.prompt, 'replacement prompt');
  assert.equal(fx.list.find((a) => a.id === 'made-replacement')!.target_thread_id, 'thread-b');
});

test('selecting another task while reload is pending retires the old editor selection', async (t) => {
  fx.list = [task('a'), task('b')];
  const v = await render(both());
  t.after(() => v.unmount());
  await click(byText(v.host, 'Task a', '.sched-row'));
  await edit(v.host);
  const old = deferred();
  fx.listGate = old.promise;
  await click(byText(dialog(v.host)!, 'Save'));
  await click(byText(v.host, 'Task b', '.sched-row'));
  await settle(old, 'success');
  assert.equal(useSched.getState().selected, 'b');
  assert.equal(dialog(v.host), null);
  assert.deepEqual(notices(), []);
});

for (const cancel of ['close', 'escape', 'backdrop'] as const) {
  test(`${cancel} retires an editor before its pending save completes`, async (t) => {
    const v = await render(h(Scheduled));
    t.after(() => v.unmount());
    await click(byText(v.host, 'News updates'));
    const old = deferred();
    fx.saveGate = old.promise;
    await click(byText(dialog(v.host)!, 'Create'));
    if (cancel === 'close') await click(dialog(v.host)!.querySelector('[aria-label="Close dialog"]'));
    else if (cancel === 'escape') {
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    } else {
      await act(async () => v.host.querySelector('.sched-dialog-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    }
    assert.equal(dialog(v.host), null);
    await settle(old, 'success');
    assert.equal(useSched.getState().selected, null);
    assert.deepEqual(notices(), []);
    assert.equal(fx.list.length, 1);
  });
}

test('unmount during shared reload retires UI completion but preserves the accepted task', async () => {
  const v = await render(h(Scheduled));
  await click(byText(v.host, 'News updates'));
  const old = deferred();
  fx.listGate = old.promise;
  await click(byText(dialog(v.host)!, 'Create'));
  await v.unmount();
  await settle(old, 'success');
  assert.equal(fx.list.length, 1);
  assert.equal(useSched.getState().list?.length, 1, 'shared list still refreshes after disposal');
  assert.equal(useSched.getState().selected, null);
  assert.deepEqual(notices(), []);
});
