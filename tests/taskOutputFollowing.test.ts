// Background task output follows layout changes while preserving reading, selection and task ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window, h, act, B, TaskList, sleep, task, mount, click, setTasks, text, outputObservers } from './support/tasks-ui.ts';
import { scrollObserver } from './support/scroll-observer.ts';

test('output: loading, empty, tailed, polled faster or slower by size, retried with backoff, and sticking to the bottom', async (t) => {
  const observer = scrollObserver(t);
  const realSetTimeout = globalThis.setTimeout;
  const polls: { ms: number; fn: () => void }[] = [];
  const POLL = new Set([2000, 5000, 10_000, 20_000, 40_000, 60_000]);
  (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...a: any[]) =>
    ms && POLL.has(ms) ? (polls.push({ ms, fn }), 0) : realSetTimeout(fn, ms, ...a);
  const next = async () => {
    const p = polls.shift()!;
    await act(async () => {
      p.fn();
      await sleep(0);
    });
    return p.ms;
  };
  try {
    const answers: (string | null | Error | Promise<string>)[] = [];
    const reads: string[] = [];
    B.setTaskOutputReaderResolver((chat) =>
      chat === 'c5'
        ? async (t) => {
            reads.push(t.id);
            const a = answers.shift();
            if (a instanceof Error) throw a;
            return a as any;
          }
        : null,
    );
    let hold!: (s: string) => void;
    answers.push(new Promise<string>((r) => (hold = r)));
    await setTasks('c5', [task('sh', { command: 'tail -f log', description: null })]);
    const v = await mount(h(TaskList, { chatId: 'c5' }));
    await click(v.$('.task-opener'));
    assert.equal(text(v.$('.task-output-note')), 'Loading output…');
    await act(async () => {
      hold('');
      await sleep(0);
    });
    assert.equal(text(v.$('.task-output-note')), 'No output yet');
    answers.push('x'.repeat(9000));
    assert.equal(await next(), 2000);
    const pre = v.$('pre.task-output');
    assert.equal(pre.textContent.length, 8000);
    assert.equal(pre.getAttribute('aria-label'), 'Output for tail -f log');
    // big output is read less often
    answers.push('y'.repeat(200 * 1024));
    assert.equal(await next(), 2000);
    answers.push('z'.repeat(600 * 1024));
    assert.equal(await next(), 5000);
    // a failed read keeps what was shown and backs off
    answers.push(new Error('gone'));
    assert.equal(await next(), 10_000);
    assert.ok(v.$('pre.task-output').textContent.startsWith('z'));
    answers.push(new Error('gone'));
    assert.equal(await next(), 10_000);
    answers.push('line 1');
    assert.equal(await next(), 20_000);
    // it sticks to the bottom unless the user scrolled up more than 16 px or selects text
    const el = v.$('pre.task-output');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
    answers.push('line 1\nline 2');
    assert.equal(await next(), 2000);
    assert.equal(el.scrollTop, 500);
    // A viewport-only resize must not turn distance from the new bottom into reader intent.
    el.scrollTop = 400;
    await act(() => el.dispatchEvent(new window.Event('scroll')));
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 50 });
    await act(() => el.dispatchEvent(new window.Event('scroll')));
    observer.notify(el);
    observer.paint();
    assert.equal(el.scrollTop, 500, 'the output follows a viewport resize even with no new polled text');
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
    el.scrollTop = 100;
    await act(() => el.dispatchEvent(new window.Event('scroll')));
    answers.push('line 1\nline 2\nline 3');
    await next();
    assert.equal(el.scrollTop, 100);
    observer.notify(el);
    observer.paint();
    assert.equal(el.scrollTop, 100, 'viewport changes also respect a paused output reader');
    el.scrollTop = 390;
    await act(() => el.dispatchEvent(new window.Event('scroll')));
    window.getSelection()!.selectAllChildren(el);
    answers.push('line 1\nline 2\nline 3\nline 4');
    await next();
    assert.equal(el.scrollTop, 390);
    observer.notify(el);
    observer.paint();
    assert.equal(el.scrollTop, 390, 'a queued resize follow must preserve selected output');
    window.getSelection()!.removeAllRanges();
    answers.push('line 1\nline 2\nline 3\nline 4\nline 5');
    await next();
    assert.equal(el.scrollTop, 500);
    // once it settles it is read once more and polling stops
    // (the card moves to Finished, so it opens again there)
    answers.push('');
    await setTasks('c5', [task('sh', { command: 'tail -f log', status: 'completed' })]);
    await click(v.$('.task-opener'));
    await act(() => sleep(0));
    assert.equal(text(v.$('.task-output-note')), 'No output captured.');
    const pending = polls.length;
    // a read answering after the card closed is dropped
    await setTasks('c5', [task('sh', { command: 'tail -f log', description: null })]);
    let late!: (s: string) => void;
    answers.push(new Promise<string>((r) => (late = r)));
    await click(v.$('.task-opener'));
    await act(() => sleep(0));
    await click(v.$('.task-opener'));
    await act(async () => {
      late('after');
      await sleep(0);
    });
    assert.equal(v.$('.task-body'), null);
    assert.equal(polls.length, pending);
    assert.ok(reads.length > 10);
    await v.unmount();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a reader that has nothing for a running task shows "Output unavailable" and keeps polling', async () => {
  B.setTaskOutputReaderResolver(() => async () => null);
  await setTasks('c8', [task('sh', { command: 'x' })]);
  const v = await mount(h(TaskList, { chatId: 'c8' }));
  await click(v.$('.task-opener'));
  await act(() => sleep(0));
  assert.equal(text(v.$('.task-output-note')), 'Output unavailable');
  await v.unmount();
});

test('a detached output owner rejects late follow reads while text elsewhere is selected', async () => {
  B.setTaskOutputReaderResolver(() => async () => 'Output');
  await setTasks('retired', [task('same')]);
  const v = await mount(h(TaskList, { chatId: 'retired' }));
  await click(v.$('.task-opener'));
  await act(() => sleep(0));
  const owner = outputObservers.at(-1)!;
  assert.equal(owner.follows(), true);
  const elsewhere = window.document.createElement('p');
  elsewhere.textContent = 'Selected outside the task output';
  window.document.body.append(elsewhere);
  window.getSelection()!.selectAllChildren(elsewhere);
  await v.unmount();
  assert.equal(owner.follows(), false, 'late callbacks cannot act on a detached pre or throw while checking selection');
  window.getSelection()!.removeAllRanges();
  elsewhere.remove();
});

test('the same task id in another chat starts its own following output', async () => {
  B.setTaskOutputReaderResolver((chatId) => async () => `${chatId} output`);
  await setTasks('first', [task('same')]);
  const v = await mount(h(TaskList, { chatId: 'first' }));
  await click(v.$('.task-opener'));
  await act(() => sleep(0));
  const first = v.$('pre.task-output');
  Object.defineProperty(first, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(first, 'clientHeight', { configurable: true, value: 300 });
  first.scrollTop = 700;
  await act(() => first.dispatchEvent(new window.Event('scroll')));
  first.scrollTop = 200;
  await act(() => first.dispatchEvent(new window.Event('scroll')));
  assert.equal(outputObservers.at(-1)!.follows(), false);
  await setTasks('second', [task('same')]);
  await v.rerender(h(TaskList, { chatId: 'second' }));
  await act(() => sleep(0));
  assert.equal(text(v.$('pre.task-output')), 'second output');
  assert.equal(v.$('pre.task-output') === first, false);
  assert.equal(outputObservers.at(-1)!.follows(), true);
  let previous = v.$('pre.task-output');
  for (const kind of ['codex', 'claude', 'acp']) {
    await setTasks('second', [task('same', { source: { kind, key: 'native-session' } })]);
    await act(() => sleep(0));
    const current = v.$('pre.task-output');
    assert.equal(current === previous, false, `${kind} gets its own output owner for the reused task id`);
    assert.equal(outputObservers.at(-1)!.follows(), true);
    Object.defineProperty(current, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(current, 'clientHeight', { configurable: true, value: 300 });
    current.scrollTop = 700;
    await act(() => current.dispatchEvent(new window.Event('scroll')));
    current.scrollTop = 200;
    await act(() => current.dispatchEvent(new window.Event('scroll')));
    assert.equal(outputObservers.at(-1)!.follows(), false);
    previous = current;
  }
  await v.unmount();
});
