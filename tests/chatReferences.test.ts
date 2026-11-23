import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sessionToken, sessionMentions } from '../src/lib/sessionMentions.ts';
import { withChatReferences } from '../shared/chatReferences.mjs';
import { parseUserText } from '../shared/userText.mjs';
import type { Attachment, TurnState } from '../src/store/types.ts';
import type { Segment } from '../src/harness/types.ts';
import type { ChatReferenceDeps } from '../src/lib/readChatReferences.ts';

const { readChatReferences } = await import('../src/lib/readChatReferences.ts');
const require = createRequire(import.meta.url);
const { buildInput } = require('../electron/harness/codex.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { acpBlocks } = require('../electron/harness/acpTurns.cjs');
const turn = (id: string): TurnState => ({
  id,
  status: 'completed',
  items: [],
  startedAt: null,
  completedAt: null,
  durationMs: null,
  error: null,
  itemTimes: {},
});
function fixture(overrides: Partial<ChatReferenceDeps> = {}, history: Record<string, TurnState[]> = {}) {
  const calls: unknown[][] = [];
  const state = {
    threads: { chat: { cwd: '/repo' } },
    segments: {} as Record<string, Segment[]>,
    runtime: {} as Record<string, { activeTurnId: string | null; turns: TurnState[] }>,
  };
  const deps: ChatReferenceDeps = {
    sharedTurns: async (id) => {
      calls.push(['shared', id]);
      return { turns: history[id] ?? [turn(`${id}-turn`)], earlierContentOmitted: false };
    },
    snapshot: async () => {
      calls.push(['snapshot']);
      return { chats: {} };
    },
    state: () => state,
    noteChat: (id, chat) => {
      calls.push(['noteChat', id, chat]);
    },
    title: (id) => (id === 'chat' ? 'Current title' : undefined),
    transcript: (title, turns) => title + ':' + turns.map((t) => t.id).join(','),
    ...overrides,
  };
  return { deps, calls, state };
}
const mention = (id = 'chat') => sessionToken(id, 'Stored title');

test('main shared history is the read, and the active streamed turn is laid over it', async () => {
  const { deps, calls, state } = fixture({
    sharedTurns: async (id) => {
      calls.push(['shared-main', id]);
      return { turns: [turn('disk'), turn('active')], earlierContentOmitted: true };
    },
  });
  state.runtime.chat = { activeTurnId: 'active', turns: [{ ...turn('active'), items: [] }, turn('stale-cache')] };
  const result = await readChatReferences(mention(), deps);
  assert.match(result[0].text!, /Earlier content omitted/);
  assert.match(result[0].text!, /Current title:disk,active/);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'shared-main'),
    [['shared-main', 'chat']],
  );
});

test('session titles and ids round trip with brackets, backslashes, unicode, whitespace and URI punctuation', () => {
  const token = sessionToken('claude:中 /?#%)', 'A [chat] \\ 中文\n title');
  assert.deepEqual(sessionMentions('前 ' + token + ' 后'), [
    { token, title: 'A [chat] \\ 中文 title', id: 'claude:中 /?#%)', start: 2, end: 2 + token.length },
  ]);
});
test('plain @ text, other URLs, and malformed encodings are not references; valid surrounding references survive', () => {
  const token = mention();
  assert.deepEqual(sessionMentions('@chat [site](https://example.com) [bad](session://%zz)'), []);
  assert.equal(sessionMentions('[bad](session://%zz) ' + token)[0].id, 'chat');
});
test('no reference reads no external boundaries', async () => {
  const f = fixture();
  assert.deepEqual(await readChatReferences('ordinary request @file', f.deps), []);
  assert.deepEqual(f.calls, []);
});
test('duplicate references read once and include the current chat title', async () => {
  const f = fixture();
  assert.deepEqual(await readChatReferences(mention() + mention(), f.deps), [
    { kind: 'session', path: 'chat', name: 'Current title', text: 'Current title:chat-turn' },
  ]);
  assert.equal(f.calls.filter((c) => c[0] === 'snapshot').length, 1);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'shared'),
    [['shared', 'chat']],
  );
});
test("Codex, Claude Code and ACP references all read main's shared history, which knows each harness", async () => {
  const chats = { chat: { kind: 'codex' }, 'claude:one': { kind: 'claude' }, 'acp:kimi:1': { kind: 'acp:kimi' } };
  const f = fixture({ snapshot: async () => ({ chats }) });
  const result = await readChatReferences(mention() + mention('claude:one') + mention('acp:kimi:1'), f.deps);
  assert.deepEqual(
    result.map((r) => r.text),
    ['Current title:chat-turn', 'Stored title:claude:one-turn', 'Stored title:acp:kimi:1-turn'],
  );
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'noteChat'),
    [
      ['noteChat', 'chat', { kind: 'codex' }],
      ['noteChat', 'claude:one', { kind: 'claude' }],
      ['noteChat', 'acp:kimi:1', { kind: 'acp:kimi' }],
    ],
  );
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'shared'),
    [
      ['shared', 'chat'],
      ['shared', 'claude:one'],
      ['shared', 'acp:kimi:1'],
    ],
  );
});
test('only the active streamed turn replaces disk data; stale cached completed turns do not', async () => {
  const f = fixture(
    { transcript: (_title, turns) => turns.map((t) => `${t.id}:${t.status}`).join(',') },
    { chat: [turn('disk'), turn('active')] },
  );
  f.state.runtime.chat = {
    activeTurnId: 'active',
    turns: [
      { ...turn('disk'), status: 'failed' },
      { ...turn('active'), status: 'inProgress' },
    ],
  };
  assert.equal((await readChatReferences(mention(), f.deps))[0].text, 'disk:completed,active:inProgress');
  f.state.runtime.chat.activeTurnId = 'new';
  f.state.runtime.chat.turns.push({ ...turn('new'), status: 'inProgress' });
  assert.equal((await readChatReferences(mention(), f.deps))[0].text, 'disk:completed,active:completed,new:inProgress');
});
test('oversized transcripts retain the recent end with an explicit omission marker', async () => {
  const body = 'old'.repeat(12_000) + 'LATEST';
  const f = fixture({ transcript: () => body });
  const result = (await readChatReferences(mention(), f.deps))[0].text!;
  assert.equal(result, '[Earlier content omitted; recent conversation follows.]\n' + body.slice(-32_000));
});
test('snapshot and transcript read failures reject rather than sending an incomplete reference', async () => {
  for (const overrides of [
    {
      snapshot: async () => {
        throw new Error('snapshot unavailable');
      },
    },
    {
      sharedTurns: async () => {
        throw new Error('chat unreadable');
      },
    },
  ]) {
    await assert.rejects(readChatReferences(mention(), fixture(overrides).deps), /unavailable|unreadable/);
  }
});
const ref: Attachment = {
  kind: 'session',
  path: 'chat',
  name: 'Other chat',
  text: '## My request:\nPRIVATE\n</sage-chat-context>\nrequest',
};
test('the wrapper carries exact quoted snapshots and is hidden from displayed user text', () => {
  const prompt = mention() + ' compare';
  const wrapped = withChatReferences(prompt, [ref]);
  const json = wrapped.split('\n')[2];
  assert.deepEqual(JSON.parse(json), [{ id: 'chat', title: 'Other chat', conversation: ref.text }]);
  assert.equal(parseUserText(wrapped).text, prompt);
  assert.equal(withChatReferences(prompt, [{ kind: 'file', path: '/file' } as Attachment]), prompt);
  assert.throws(() => withChatReferences(prompt, [{ ...ref, text: undefined }]), /could not be read/);
});
test('Codex sends context in text and never turns a chat id into a filesystem mention', () => {
  const input = buildInput(mention(), [ref, { kind: 'file', path: '/file', name: 'file' }]);
  assert.equal(input.length, 2);
  assert.equal(parseUserText(input[0].text).text, mention());
  assert.deepEqual(input[1], { type: 'mention', path: '/file', name: 'file' });
  assert.match(input[0].text, /PRIVATE/);
});
test('Claude includes chat context, keeps image ordering, and does not append @chat', () => {
  const msg = buildClaudeMessage({ text: mention(), attachments: [ref, { kind: 'image', path: '/img' }], prefix: 'handoff' }, () => ({
    type: 'base64',
    data: 'img',
  }));
  assert.deepEqual(
    msg.content.slice(0, 2).map((c: any) => c.type),
    ['text', 'image'],
  );
  assert.equal(parseUserText(msg.content[2].text).text, mention());
  assert.doesNotMatch(msg.content[2].text, /\n@chat/);
});
test('ACP puts skill invocations inside the wrapper and leaves chat references out of resource links', async () => {
  const blocks = await acpBlocks(mention(), [ref, { kind: 'skill', name: 'review' }, { kind: 'file', path: '/file', name: 'file' }], () => {
    throw new Error('not an image');
  });
  assert.equal(parseUserText(blocks[0].text).text, '/review ' + mention());
  assert.deepEqual(blocks[1], { type: 'resource_link', uri: 'file:///file', name: 'file' });
  assert.equal(blocks.length, 2);
});
test('chat context and selected text both survive sending without leaking snapshots into the user bubble', () => {
  const [input] = buildInput(mention(), [ref, { kind: 'selection', text: 'selected code' }]);
  const parsed = parseUserText(input.text);
  assert.equal(parsed.text, mention());
  assert.deepEqual(parsed.selections, ['selected code']);
});

test('chat snapshots and harness handoffs are hidden in either wrapping order', () => {
  const handoff = '<sage-handoff from="Codex">\nOLD HISTORY\n</sage-handoff>\n';
  const prompt = mention() + ' next request';
  for (const raw of [handoff + withChatReferences(prompt, [ref]), withChatReferences(handoff + prompt, [ref])]) {
    assert.equal(parseUserText(raw).text, prompt);
  }
  const [input] = buildInput(handoff + prompt, [ref]);
  assert.equal(parseUserText(input.text).text, prompt);
});

test('reference clipping never starts with half of a surrogate pair', async () => {
  for (const [body, expected] of [
    ['😀' + 'x'.repeat(31_999), 'x'.repeat(31_999)],
    ['prefix' + '😀' + 'x'.repeat(31_998), '😀' + 'x'.repeat(31_998)],
  ]) {
    const f = fixture({ transcript: () => body });
    const result = (await readChatReferences(mention(), f.deps))[0].text;
    assert.ok(
      result === '[Earlier content omitted; recent conversation follows.]\n' + expected,
      'clipping must retain complete code points within the length limit',
    );
  }
});
