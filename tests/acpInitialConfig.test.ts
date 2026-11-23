// A message sent with a model or effort to a basic harness (a scheduled task's run) sets them on its ACP session before the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyInitialConfig } = require('../electron/harness/acp/initialConfig.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');

function fixture(configOptions: any[] | null = OPTIONS) {
  const changed: any[] = [];
  const chat: any = { key: 'k', harness: 'opencode', sessionId: 's', state: { configOptions } };
  const host: any = {
    label: () => 'OpenCode',
    assertChatCurrent: () => {},
    setConfigOption: async (...a: any[]) => {
      changed.push(a);
    },
  };
  return { host, chat, changed };
}

const OPTIONS = [
  {
    id: 'model',
    type: 'select',
    category: 'model',
    currentValue: 'opencode/big-pickle',
    options: [
      {
        name: 'Zen',
        options: [
          { value: 'opencode/big-pickle', name: 'Big Pickle' },
          { value: 'opencode/glm-5.3-flash-free', name: 'GLM' },
        ],
      },
    ],
  },
  { id: 'think', type: 'select', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
];

test('the model and effort a message names are set on the session; ones already current, or not named, are not', async () => {
  const f = fixture();
  await applyInitialConfig(f.host, f.chat, { model: 'opencode/glm-5.3-flash-free', effort: 'high' });
  assert.deepEqual(f.changed, [
    ['k', 'model', 'opencode/glm-5.3-flash-free'],
    ['k', 'think', 'high'],
  ]);
  const g = fixture();
  await applyInitialConfig(g.host, g.chat, { model: 'opencode/big-pickle' });
  await applyInitialConfig(g.host, g.chat, undefined);
  assert.deepEqual(g.changed, []);
});

test('a model the harness does not offer, or no model setting at all, stops the message with why', async () => {
  const f = fixture();
  await assert.rejects(
    applyInitialConfig(f.host, f.chat, { model: 'gpt-9' }),
    /OpenCode doesn't offer model gpt-9; it offers opencode\/big-pickle, opencode\/glm-5\.3-flash-free/,
  );
  await assert.rejects(
    applyInitialConfig(fixture(null).host, fixture(null).chat, { effort: 'high' }),
    /OpenCode declares no effort setting, so it can't run on high/,
  );
  const n = fixture(null);
  n.chat.state = null;
  await assert.rejects(applyInitialConfig(n.host, n.chat, { model: 'm' }), /declares no model setting/);
  assert.deepEqual(f.changed, []);
});

test('a message stopped while the model was being set does not go on to set the effort', async () => {
  const f = fixture();
  let stopped = false;
  f.host.setConfigOption = async (...a: any[]) => {
    f.changed.push(a);
    stopped = true;
  };
  const current = () => {
    if (stopped) throw new Error('Stopped before the message was sent');
  };
  await assert.rejects(applyInitialConfig(f.host, f.chat, { model: 'opencode/glm-5.3-flash-free', effort: 'high' }, current), /Stopped/);
  assert.equal(f.changed.length, 1);
});

test('sendPrompt sets the message config before the prompt goes, and sends nothing when it is refused', async () => {
  const sent: any[] = [];
  const f = fixture();
  f.chat.agent = { caps: {}, request: (m: string, p: any) => (sent.push([m, p]), new Promise(() => {})) };
  const host = {
    ...f.host,
    starting: new Map(),
    ensure: async () => f.chat,
    quirksOf: () => ({}),
    items: { append: () => {}, readAsync: async () => [] },
    emitEvent: () => {},
    now: () => 0,
    audioDispatch: {},
  };
  await sendPrompt(host, 'k', { blocks: [], config: { model: 'opencode/glm-5.3-flash-free' } });
  assert.deepEqual(f.changed, [['k', 'model', 'opencode/glm-5.3-flash-free']]);
  assert.equal(sent[0][0], 'session/prompt');
  f.chat.prompting = null;
  sent.length = 0;
  await assert.rejects(sendPrompt(host, 'k', { blocks: [], config: { model: 'nope' } }), /doesn't offer model nope/);
  assert.deepEqual(sent, []);
});
