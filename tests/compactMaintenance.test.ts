// Real adapter boundaries preserve native maintenance commands without memory decoration or arbitrary attached commands.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment, tick } from './support/controller/fixture';
import { momoBlock } from '../shared/momoContext.mjs';

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { claudeTurnInput } = require('../electron/harness/claude/turnStart.cjs');
const { buildUserMessage } = require('../electron/harness/claude/sessionOptions.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');
afterEach(() => setMomoContextProvider(null));

const compact = { id: 'compact', text: '/compact', attachments: [], opts: { human: true, compact: { args: '' } } };

test('real Claude compaction stays a native command and leaves memory for the next actual message', async () => {
  const { c, state, claudeSends } = setup();
  let reads = 0;
  setMomoContextProvider(() => (reads++, momoBlock({ facts: ['Keep this memory'] })));
  c.claudeTurns = new ClaudeAdapter({
    api: {
      isLive: () => false,
      sessionCwd: async () => '/w',
      accounts: () => ({ active: 'default', accounts: [{ id: 'default', loggedIn: true }] }),
      metered: () => false,
    },
    state,
    prefs: () => ({ permission: 'default' }),
    send: (...args: any[]) => c.claudeSend(...args),
    enqueue: () => undefined,
    chatOf: (id: string) => c.chatOf(id),
    ref: (id: string) => c.ref(id),
    emit: () => true,
    setGoal: () => false,
  });
  const receipt = await c.send('claude:s', compact, 1, true);
  assert.equal(receipt.action, 'started');
  const [, , message, , meta] = claudeSends[0];
  assert.equal(message.content, '/compact');
  assert.equal(reads, 0);
  assert.equal(buildUserMessage(message, { ...meta, literal: true }).message.content, '/compact');
  c.end('claude:s', { drain: false });
  await c.send('claude:s', { id: 'next', text: 'hello', opts: { human: true } }, 1, true);
  assert.equal(reads, 1);
  assert.match(claudeSends[1][2].content, /Keep this memory/);
});

test('real ACP compaction carries only its declared command and retains tool notes and memory for actual input', async () => {
  const { c, chats, state } = setup();
  selectSegment(c, chats, 'chat', [['acp:kimi', 's']]);
  state.patch('chat', { acp: { commands: ['compress'] } });
  let reads = 0;
  const sent: any[] = [];
  setMomoContextProvider(() => (reads++, momoBlock({ facts: ['Keep this memory'] })));
  c.acpTurns = new AcpTurns({
    send: async (...args: any[]) => (sent.push(args), { turnId: 'native' }),
    rename: () => {},
    readImage: async () => null,
    named: () => true,
    toolsNote: () => 'Tools available for actual input',
  });
  assert.equal((await c.send('chat', compact, 1, true)).action, 'started');
  assert.deepEqual(sent[0][2].blocks, [{ type: 'text', text: '/compress' }]);
  assert.deepEqual(sent[0][3].compact, { args: '' });
  assert.equal(reads, 0);
  c.end('chat', { drain: false });
  await c.send('chat', { text: 'hello', opts: {} }, 1, true);
  assert.equal(sent[1][2].blocks[0].text, 'Tools available for actual input');
  assert.match(sent[1][2].blocks[1].text, /Keep this memory/);
});

test('structured compaction rejects attached skills before any native or command dispatch', async () => {
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    const { c, chats, state, execs, s } = setup();
    selectSegment(c, chats, 'chat', [[kind, 's']]);
    state.patch('chat', { acp: { commands: ['compress'] } });
    const receipt = await c.send(
      'chat',
      {
        ...compact,
        attachments: [{ kind: 'skill', name: 'clear', path: '/skill' }],
      },
      1,
      true,
    );
    assert.equal(receipt.action, 'queued');
    assert.equal(execs.length, 0);
    assert.match(s('chat').crashed, /cannot include attachments/);
  }
});

test('Claude turn preparation preserves ordinary metadata, attachments and handoff attribution', async () => {
  assert.deepEqual(claudeTurnInput({}, 'empty'), {
    content: { text: '', attachments: [] },
    meta: { human: false, uuid: 'empty' },
  });
  const result = claudeTurnInput(
    {
      text: 'hello',
      attachments: [{ kind: 'image', path: '/image', previewUrl: 'preview' }],
      opts: { human: true, prefix: 'handoff' },
    },
    'id',
  );
  assert.deepEqual(result, {
    content: { text: 'hello', attachments: [{ kind: 'image', path: '/image' }], prefix: 'handoff' },
    meta: { human: false, uuid: 'id' },
  });
  await tick();
});
