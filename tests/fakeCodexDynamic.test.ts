// Scripted dynamic-tool records match the real ThreadItem contract and feed actual panel step/media consumers only when requested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { callDynamicTool, callDynamicTools } from './e2e/fixtures/fake-codex-dynamic.mjs';
const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');

test('the actual scripted turn route enables native records only with CUSTEPS and keeps goal/title gating', async () => {
  for (const [text, rec, user, expected, records] of [
    ['CUCALL chrome_read_page {}', {}, true, 1, 0],
    ['CUSTEPS\nCUCALL chrome_read_page {}\nCUCALL chrome_computer {"action":"screenshot"}', {}, true, 2, 2],
    ['CUSTEPS\nCUCALL chrome_read_page {}', { title: true }, true, 0, 0],
    ['CONTINUE\nCUCALL chrome_read_page {}', { goalRounds: 1 }, false, 0, 0],
    ['CONTINUE\nCUCALL chrome_read_page {}', { goalRounds: 2 }, false, 1, 0],
    ['CONTINUE\nCUCALL chrome_read_page {}', { goalRounds: 2 }, true, 0, 0],
  ] as const) {
    let calls = 0;
    const turn = { items: user ? ([{ type: 'userMessage' }] as any[]) : ([] as any[]) };
    await callDynamicTools({
      text,
      rec,
      turn,
      threadId: 'chat',
      turnId: 'turn',
      notify: () => {},
      ask: async () => {
        calls++;
        return { result: { success: true, contentItems: [] } };
      },
    });
    assert.equal(calls, expected);
    assert.equal(turn.items.filter((item) => item.type === 'dynamicToolCall').length, records);
  }
});

test('CUSTEPS records the actual dynamic call identity, native output and panel Chrome preview', async () => {
  const turn = { id: 'turn', items: [] as any[] };
  const events: any[] = [];
  let time = 100;
  const output = [
    { type: 'inputText', text: 'Page read' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,AAA=' },
  ];
  const text = await callDynamicTool({
    turn,
    threadId: 'chat',
    turnId: 'turn',
    tool: 'chrome_computer',
    args: { action: 'screenshot' },
    steps: true,
    id: () => '00000000-0000-4000-8000-000000000000',
    now: () => (time += 25),
    notify: (method: string, params: any) => events.push([method, structuredClone(params)]),
    ask: async (method: string, params: any, timeout: number) => {
      assert.equal(method, 'item/tool/call');
      assert.equal(params.callId, '00000000-0000-4000-8000-000000000000');
      assert.equal(timeout, 60_000);
      return { result: { success: true, contentItems: output } };
    },
  });
  assert.equal(text, ' [cu: Page read <image>]');
  assert.equal(events[0][1].item.status, 'inProgress');
  assert.equal(events[0][1].item.contentItems, null);
  assert.deepEqual(turn.items[0], {
    type: 'dynamicToolCall',
    id: '00000000-0000-4000-8000-000000000000',
    namespace: null,
    tool: 'chrome_computer',
    arguments: { action: 'screenshot' },
    status: 'completed',
    contentItems: output,
    success: true,
    durationMs: 25,
  });
  assert.equal(events[1][1].item.id, '00000000-0000-4000-8000-000000000000');
  const row = rowsOf([turn]).rows[0];
  assert.equal(row.surface, 'chrome');
  assert.equal(row.thumbnail, 'data:image/png;base64,AAA=');
});

test('default CUCALL keeps its prior no-item behavior; refusals retain the native failed outcome', async () => {
  for (const response of [
    { result: { success: false, contentItems: [{ type: 'text', text: 'denied' }] } },
    { error: { message: 'failed' } },
    {},
  ]) {
    for (const steps of [false, true]) {
      const turn = { items: [] as any[] };
      const events: any[] = [];
      const text = await callDynamicTool({
        turn,
        threadId: 'chat',
        turnId: 'turn',
        tool: 'chrome_read_page',
        args: {},
        steps,
        ask: async () => response,
        notify: (...event: any[]) => events.push(event),
      });
      assert.match(text, /denied|failed|no answer/);
      assert.equal(turn.items.length, steps ? 1 : 0);
      assert.equal(events.length, steps ? 2 : 0);
      if (steps) assert.equal(turn.items[0].status, 'failed');
    }
  }
});
