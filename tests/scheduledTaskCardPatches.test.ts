// Chat-card pause/resume applies only status at the real store's mutation owner.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, byText } from './support/pages-kit.ts';
import { setup, base } from './support/automation-store/fixture.ts';
import { createElement as h, act } from 'react';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const state = fakeStore<any>({ basicHarnesses: [] });
const errors: unknown[] = [];
const patches: unknown[] = [];
let storage: any;
let pendingUpdate: Promise<unknown> | null = null;
let beforeWrite = async () => {};
stubStore({ useStore: state.useStore, navigate: () => {}, toast: (message: unknown) => errors.push(message) });
mock.module('../src/session/scheduledFocus.ts', { namedExports: { showScheduledTask: () => {} } });
installNativeStub({
  automation: {
    list: () => storage.list(),
    save: async (task: any) => {
      await beforeWrite();
      return storage.save(task);
    },
    update: (id: string, patch: any) => {
      patches.push([id, patch]);
      pendingUpdate = (async () => {
        await beforeWrite();
        const task = await storage.update(id, patch);
        if (!task) throw new Error('This scheduled task disappeared; your edit was not saved');
        return task;
      })();
      return pendingUpdate;
    },
  },
});
const { ScheduledTaskCard } = await import('../src/components/thread/ScheduledTaskCard.tsx');

/** Wait for the real mutation and its React continuation, including a rejected write. */
async function toggle(button: HTMLElement) {
  await act(async () => {
    pendingUpdate = null;
    button.click();
    assert.ok(pendingUpdate, 'the click must admit a native update');
    await Promise.allSettled([pendingUpdate]);
  });
}

async function card(t: any, harness = 'codex') {
  storage = setup(t).store;
  errors.length = 0;
  patches.length = 0;
  beforeWrite = async () => {};
  const task = await storage.save({ ...base, id: 'card-task', harness, name: 'Original', computer_control: true });
  const view = await render(
    h(ScheduledTaskCard, { call: { action: 'created', task: { ...task, schedule: task.rrule, runsIn: ['mopilot'] } } }),
  );
  t.after(() => view.unmount());
  return view;
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: pausing from a chat card preserves a newer permission, prompt and name update`, async (t) => {
    const view = await card(t, harness);
    beforeWrite = () => storage.update('card-task', { computer_control: false, prompt: 'New prompt', name: 'New name' });
    await toggle(byText(view.host, 'Pause'));
    const task = await storage.get('card-task');
    assert.equal(task.status, 'PAUSED');
    assert.equal(task.computer_control, false);
    assert.equal(task.prompt, 'New prompt');
    assert.equal(task.name, 'New name');
    assert.deepEqual(errors, []);
    assert.deepEqual(patches, [['card-task', { status: 'PAUSED' }]]);
  });
}

test('a chat card cannot resurrect a task deleted before its pause is admitted', async (t) => {
  const view = await card(t);
  beforeWrite = () => storage.remove('card-task');
  await toggle(byText(view.host, 'Pause'));
  assert.equal(await storage.get('card-task'), null);
  assert.match(String(errors[0]), /disappeared/);
  assert.ok(byText(view.host, 'Pause'), 'rejected edit retains the shown status');
});

test('a rejected pause keeps the status for retry, then resume changes only status', async (t) => {
  const view = await card(t);
  beforeWrite = async () => {
    throw new Error('write failed');
  };
  await toggle(byText(view.host, 'Pause'));
  assert.equal(errors[0], 'write failed');
  assert.equal((await storage.get('card-task')).status, 'ACTIVE');
  beforeWrite = async () => {};
  await toggle(byText(view.host, 'Pause'));
  await storage.update('card-task', { computer_control: false, prompt: 'Later prompt' });
  await toggle(byText(view.host, 'Resume'));
  const task = await storage.get('card-task');
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.computer_control, false);
  assert.equal(task.prompt, 'Later prompt');
});
