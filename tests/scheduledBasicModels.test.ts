// Scheduled: a task on a basic harness picks its model from what the harness declared (its catalog), and a harness
// that lists no thought levels has no effort to pick; Codex and Claude Code keep showing a saved effort as is.
import { test } from 'node:test';
import {
  assert,
  act,
  fx,
  store,
  task,
  both,
  dialog,
  pick,
  sel,
  savedTask,
  render,
  click,
  byText,
  flush,
} from './support/scheduled-page.ts';

const model = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'big-pickle',
  options: [
    { value: 'big-pickle', name: 'Big Pickle' },
    { value: 'glm', name: 'GLM' },
  ],
};

const thinking = {
  id: 'variant',
  name: 'Thinking',
  type: 'select',
  category: 'thought_level',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low effort' },
    { value: 'high', name: 'High effort' },
  ],
};

test('an opencode task with thought levels picks one by the names opencode gives them', async () => {
  const before = store.getState().basicHarnesses;
  store.setState({
    basicHarnesses: before.map((b: any) =>
      b.id === 'opencode' ? { ...b, catalog: { modes: null, configOptions: [model, thinking] } } : b,
    ),
  });
  fx.list = [task('t', { harness: 'acp:opencode' })];
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task t', '.sched-row'));
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d = dialog(v.host)!;
  await click(byText(d, 'Advanced'));
  assert.equal(sel(d, 'Reasoning'), 'Low effort');
  await pick(d, 'Reasoning', 'High effort');
  await click(byText(d, 'Save'));
  assert.deepEqual([savedTask().model, savedTask().reasoning_effort], ['big-pickle', 'high']);
  await act(async () => store.setState({ basicHarnesses: before }));
  await v.unmount();
});

test('an opencode task picks among the models its catalog lists, with no effort when it lists no thought levels', async () => {
  const before = store.getState().basicHarnesses;
  store.setState({
    basicHarnesses: before.map((b: any) => (b.id === 'opencode' ? { ...b, catalog: { modes: null, configOptions: [model] } } : b)),
  });
  fx.list = [task('o', { harness: 'acp:opencode' })];
  const v = await render(both());
  await flush();
  await click(byText(v.host, 'Task o', '.sched-row'));
  await click(v.host.querySelector('[aria-label="Task actions"]'));
  await click(byText(v.host, 'Edit', '[role=menuitem]'));
  const d = dialog(v.host)!;
  await click(byText(d, 'Advanced'));
  assert.equal(sel(d, 'Model'), 'Big Pickle');
  assert.equal(d.querySelector('[aria-label="Reasoning"]'), null);
  assert.equal(d.querySelector('.sched-field-note'), null, 'no "Uses the model set in opencode" once it lists models');
  await pick(d, 'Model', 'GLM');
  await click(byText(d, 'Save'));
  assert.deepEqual([savedTask().harness, savedTask().model, savedTask().reasoning_effort], ['acp:opencode', 'glm', undefined]);
  await act(async () => store.setState({ basicHarnesses: before }));
  await v.unmount();
});
