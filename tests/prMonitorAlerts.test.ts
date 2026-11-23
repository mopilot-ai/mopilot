// Auto-fix news told wherever the chat shows (src/components/thread/PrMonitorAlerts.tsx): once per chat, PR and kind, with Retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fx, calls, api, store, base, pr, settle } from './support/pr-monitor-ui.ts';

const { PrMonitorAlerts } = await import('../src/components/thread/PrMonitorAlerts.tsx');
const toasts = () => store.calls.filter((c) => c[0] === 'toast');

async function mount(chatId = 'chat', withApi = true) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(h(PrMonitorAlerts, withApi ? { chatId, api } : { chatId })));
  await settle(act);
  return {
    host,
    close: () => act(async () => root.unmount()),
  };
}

test('a fix that may not have reached the chat is told once, with Retry, even when the chat opens again', async () => {
  store.calls.length = 0;
  calls.length = 0;
  fx.stored = null;
  let m = await mount();
  assert.equal(m.host.innerHTML, '');
  assert.deepEqual(toasts(), []);
  fx.stored = base({ pr: pr(), uncertain: true });
  await act(async () => fx.listener('chat'));
  await settle(act);
  assert.equal(toasts().length, 1);
  const [, text, kind, opts] = toasts()[0] as [string, string, string, any];
  assert.equal(text, 'Auto-fix may not have reached the chat (#12)');
  assert.equal(kind, 'error');
  assert.equal(opts.action.label, 'Retry');
  await act(async () => opts.action.run());
  await settle(act);
  assert.deepEqual(calls.at(-1), ['chat', { retry: true }]);
  // the same news again, or the chat opened again (the native monitor, no api passed), says nothing new
  await act(async () => fx.listener('chat'));
  await settle(act);
  await m.close();
  m = await mount('chat', false);
  assert.equal(toasts().length, 1);
  // once it clears, the next time is news again; so is running out of tries
  fx.stored = base({ pr: pr() });
  await act(async () => fx.listener('chat'));
  await settle(act);
  fx.stored = base({ pr: pr(), uncertain: true, limited: true });
  await act(async () => fx.listener('chat'));
  await settle(act);
  assert.deepEqual(
    toasts().map((c) => c[1]),
    [
      'Auto-fix may not have reached the chat (#12)',
      'Auto-fix may not have reached the chat (#12)',
      'Auto-fix stopped after several tries (#12)',
    ],
  );
  // another chat's monitor is its own
  await m.close();
  fx.stored = base({ chatId: 'other', pr: pr(), limited: true });
  m = await mount('other');
  assert.equal(toasts().at(-1)![1], 'Auto-fix stopped after several tries (#12)');
  assert.equal(toasts().length, 4);
  await m.close();
  fx.stored = null;
});

test('an uncertain PR continuation is identified as that continuation in the global notice', async () => {
  store.calls.length = 0;
  fx.stored = base({ chatId: 'continuation', uncertain: true, continuation: { when: 'merged', message: 'Continue the authorized task' } });
  const m = await mount('continuation');
  assert.equal(toasts().at(-1)![1], 'Continuation may not have reached the chat (#12)');
  await m.close();
  fx.stored = null;
});
