// Scheduled-page identity collisions fail closed without mounting the wrong task and recover after canonical refresh.
import { test } from 'node:test';
import { assert, h, act, calls, Scheduled, task, render } from './support/scheduled-page.ts';

test('ambiguous selection shows an alert without details and recovers when the canonical list becomes unique', async () => {
  const { useSched } = await import('../src/components/pages/scheduled/state.ts');
  const first = task('collision', { name: 'Codex task', harness: 'codex' });
  const second = task('collision', { name: 'Claude task', harness: 'claude' });
  await act(async () => useSched.setState({ list: [first, second], selected: 'collision', editing: null }));
  calls.length = 0;
  const view = await render(h(Scheduled));
  try {
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /ambiguous/);
    assert.equal(view.host.querySelector('.task-detail'), null);
    assert.equal(
      calls.some((call) => ['runs', 'run', 'save', 'delete'].includes(call[0])),
      false,
    );
    assert.equal(useSched.getState().selected, 'collision');
    await act(async () => useSched.setState({ list: [second, first] }));
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /ambiguous/);
    assert.equal(view.host.querySelector('.task-detail'), null);
    await act(async () => useSched.setState({ list: [second] }));
    assert.equal(view.host.querySelector('[role="alert"]'), null);
    assert.equal(view.host.querySelector('.page-title')?.textContent, 'Claude task');
    await act(async () => useSched.setState({ selected: 'missing' }));
    assert.equal(view.host.querySelector('[role="alert"]'), null);
    assert.equal(view.host.querySelector('.task-detail'), null);
    assert.match(view.host.textContent ?? '', /Schedule a task/);
  } finally {
    await view.unmount();
    await act(async () => useSched.setState({ list: null, selected: null, editing: null }));
  }
});
