// Linked ACP prompts apply a known permission cap once, preserve later native choices and cannot dispatch after cancellation during preparation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyLinkedPermission } = require('../electron/harness/acp/linkedSettings.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');

function fixture() {
  const changed: any[] = [];
  const chat: any = {
    key: 'child',
    harness: 'kimi',
    sessionId: 'native',
    state: { modes: { currentModeId: 'yolo', availableModes: [{ id: 'yolo' }, { id: 'default' }, { id: 'plan' }, { id: 'unknown' }] } },
  };
  const host: any = {
    items: { readAsync: async () => [] },
    assertChatCurrent: () => {},
    quirksOf: () => ({ anchors: { yolo: 'full', default: 'ask', plan: 'readOnly' } }),
    setMode: async (...a: any[]) => {
      changed.push(['mode', ...a]);
    },
    setConfigOption: async (...a: any[]) => {
      changed.push(['config', ...a]);
    },
  };
  return { host, chat, changed };
}

test('native modes and config-based modes inherit a safe cap; absent or incompatible capabilities block before prompting', async () => {
  const f = fixture();
  await applyLinkedPermission(f.host, f.chat, undefined);
  assert.deepEqual(f.changed, []);
  await applyLinkedPermission(f.host, f.chat, 'read-only');
  assert.deepEqual(f.changed, [['mode', 'child', 'plan']]);
  f.chat.state.modes.currentModeId = 'plan';
  await applyLinkedPermission(f.host, f.chat, 'read-only');
  assert.equal(f.changed.length, 1);
  f.chat.state = {
    configOptions: [
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        currentValue: 'yolo',
        options: [{ value: 'yolo' }, { value: 'default' }, { value: 'plan' }],
      },
    ],
  };
  await applyLinkedPermission(f.host, f.chat, 'default');
  assert.deepEqual(f.changed.at(-1), ['config', 'child', 'mode', 'default']);
  f.chat.state = null;
  await assert.rejects(applyLinkedPermission(f.host, f.chat, 'read-only'), /cannot inherit/);
  f.chat.state = fixture().chat.state;
  f.host.quirksOf = () => null;
  await assert.rejects(applyLinkedPermission(f.host, f.chat, 'default'), /cannot inherit/);
  f.host.items.readAsync = async () => [{ t: 'user' }];
  await applyLinkedPermission(f.host, f.chat, 'read-only');
  assert.equal(f.changed.length, 2, 'an existing chat keeps later user choices');
});

test('retiring the input or native session during a settings read cannot change a mode', async () => {
  const f = fixture();
  await assert.rejects(
    applyLinkedPermission(f.host, f.chat, 'plan', () => {
      throw new Error('input retired');
    }),
    /input retired/,
  );
  f.host.assertChatCurrent = () => {
    throw new Error('session retired');
  };
  await assert.rejects(applyLinkedPermission(f.host, f.chat, 'plan'), /session retired/);
  assert.deepEqual(f.changed, []);
});

test('Stop during linked permission preparation prevents the real prompt dispatch', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  f.host.starting = new Map();
  f.host.ensure = async () => f.chat;
  f.host.items.readAsync = async () => {
    await pending;
    return [];
  };
  const request = sendPrompt(f.host, 'child', { blocks: [], initialPermission: 'plan' });
  await new Promise((r) => setImmediate(r));
  f.host.starting.get('child').cancelled = true;
  release();
  await assert.rejects(request, /Stopped before/);
  assert.deepEqual(f.changed, []);
  assert.equal(f.host.starting.size, 0);
});

test('prompt dispatch refuses overlap, normalizes empty payloads and preserves native failure text', async () => {
  const f = fixture();
  const rows: any[] = [];
  const finished: any[] = [];
  f.host.starting = new Map();
  f.host.ensure = async () => f.chat;
  f.host.label = () => 'Harness';
  f.host.now = () => 1;
  f.host.items.append = (...a: any[]) => rows.push(a);
  f.host.emitEvent = () => {};
  f.host.signedInFn = () => {};
  f.host.finish = (...a: any[]) => {
    finished.push(a);
    f.chat.prompting = null;
  };
  f.host.authFailed = (_h: string, cause: unknown) => cause;
  f.chat.prompting = {};
  await assert.rejects(sendPrompt(f.host, 'child', {}), /still working/);
  f.chat.prompting = null;
  f.chat.agent = { caps: { image: false }, request: async () => undefined };
  await sendPrompt(f.host, 'child', { blocks: null, display: null }, { uuid: 'first' });
  await Promise.resolve();
  assert.deepEqual(rows[0][1].user.content, []);
  assert.equal(finished[0][1], 'end_turn');
  f.chat.agent.request = async () => {
    throw 'native failure';
  };
  await sendPrompt(f.host, 'child', { blocks: [null] });
  await Promise.resolve();
  assert.equal(finished.at(-1)[2], 'native failure');
});
