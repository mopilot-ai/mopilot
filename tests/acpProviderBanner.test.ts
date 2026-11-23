// A basic harness retrying its failing provider, renderer side (src/session/harness/acp.ts, #1534): main's providerError
// becomes the retry banner every harness shows, and a turn stopped meanwhile keeps a note saying why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

const { AcpItems } = createRequire(import.meta.url)('../electron/harness/items/acp.cjs');
const acp = await import('../src/session/harness/acp.ts');
const { PROVIDER_NEXT_STEP } = await import('../shared/acpStop.mjs');

test("providerError shows the harness's words in the retry banner", async () => {
  reset();
  let onEvent: any;
  (globalThis as any).window = new EventTarget();
  fx.native.acp = {
    onEvent: (h: any) => (onEvent = h),
    onItems: () => {},
    onHarnesses: () => {},
    harnesses: async () => [],
    onSignIns: () => {},
    signIns: async () => ({}),
    list: async () => [],
  };
  acp.startAcp();
  await tick();
  const chat = 'acp:kimi:p';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };
  onEvent({ kind: 'providerError', key: chat, turnId: 'T3', error: 'Overloaded' });
  const notes = () => called('applyNotification');
  assert.deepEqual(notes().at(-1), [
    'error',
    {
      threadId: chat,
      turnId: 'T3',
      willRetry: true,
      error: { message: "Kimi Code's provider failed: Overloaded. Kimi Code keeps retrying." },
    },
  ]);
});

test('a Stop after it notes why the turn got nowhere', () => {
  const chat = 'acp:kimi:p';
  const notes: any[] = [];
  const items = new AcpItems({
    chatOf: () => chat,
    nativeOf: () => chat,
    cwdOf: () => '/w',
    emit: (_chat: string, _key: string, method: string, params: any) => notes.push([method, params]),
  });
  items.onEvent({ kind: 'turnStart', key: chat, turnId: 'T3', user: { id: 'u', clientId: 'c', content: [] } });
  items.onEvent({ kind: 'turnEnd', key: chat, turnId: 'T3', stopReason: 'cancelled', error: null, providerError: 'Overloaded' });
  assert.equal(notes.at(-1)[1].turn.status, 'interrupted');
  const note = notes.find((n) => n[0] === 'item/completed' && n[1].item.type === 'statusNote')?.[1].item;
  assert.deepEqual([note.kind, note.text], ['provider', `Stopped while the provider kept failing (Overloaded). ${PROVIDER_NEXT_STEP}`]);
});
