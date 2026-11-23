// Inactive plan recovery uses the shared send path, preserves retries and never updates an unmounted owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, flush } from './support/pages-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { stubStore } from './support/stubs.ts';

let send = async (..._args: any[]): Promise<any> => true;
const calls: any[] = [];
stubStore({
  sendOrDraft: (...args: any[]) => {
    calls.push(args);
    return send(...args);
  },
});
const { createElement: h } = await import('react');
const { TaskPlanRecovery } = await import('../src/components/thread/TaskPlanRecovery.tsx');

test('paused and failed plans name their inactive state; read-only recovery cannot send', async () => {
  const v = await render(h(TaskPlanRecovery, { threadId: 'chat', failed: false, readOnly: true }));
  assert.match(v.host.textContent!, /Paused/);
  assert.equal(v.host.querySelector('button'), null);
  await v.rerender(h(TaskPlanRecovery, { threadId: 'chat', failed: true, readOnly: true }));
  assert.match(v.host.textContent!, /Stopped after an error/);
  await v.rerender(h(TaskPlanRecovery, { threadId: 'chat', failed: false, readOnly: false, waiting: true }));
  assert.match(v.host.textContent!, /Waiting for linked work/);
  assert.equal(v.host.querySelector('button'), null);
  await v.unmount();
});

test('one request stays disabled until accepted, and refusals or errors remain retryable', async () => {
  calls.length = 0;
  const pending = deferred<any>();
  send = () => pending.promise;
  const v = await render(h(TaskPlanRecovery, { threadId: 'opaque:chat', failed: false, readOnly: false }));
  const button = v.host.querySelector('button')!;
  await click(button);
  assert.equal(button.disabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'opaque:chat');
  assert.equal(calls[0][1], 'Continue task');
  assert.deepEqual(calls[0][2], { human: true });
  pending.resolve(false);
  await flush();
  assert.equal(button.disabled, false);
  send = async () => {
    throw new Error('not delivered');
  };
  await click(button);
  assert.equal(v.host.querySelector('[role=alert]')!.textContent, 'not delivered');
  send = async () => true;
  await click(button);
  assert.equal(button.disabled, true);
  assert.equal(v.host.querySelector('[role=alert]'), null);
  await v.unmount();
});

test('late refused or rejected sends after unmount do not update a retired recovery', async () => {
  for (const rejected of [false, true]) {
    const pending = deferred<any>();
    send = () => pending.promise;
    const v = await render(h(TaskPlanRecovery, { threadId: 'old', failed: false, readOnly: false }));
    await click(v.host.querySelector('button')!);
    await v.unmount();
    if (rejected) pending.reject(new Error('old failure'));
    else pending.resolve(false);
    await flush();
  }
});
